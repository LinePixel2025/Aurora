/**
 * `edit_file` 的纯逻辑单测（docs/06 §11.6）。
 *
 * 全部用内存假端口，**没有真实 IO**：真实整文件读 / 原子写由主进程端口承担
 * （`apps/desktop/src/main/tools/file-port.test.ts`）。
 *
 * 本文件的取材原则是「把每一条『写坏用户文件』的路径都钉一个用例」：
 * 找不到 / 多处命中 / 空 `oldString` / 新旧相同 / 孤立 `\r` / 混合行尾 / 二进制 / 超上限，
 * 这些分支一概断言 **`isError` 且 `writeText` 一次都没被调用**；
 * 成功的分支则按**逐字节**断言写回内容（含行尾风格），不用 `toContain` 放松。
 *
 * 另有一条隐性契约靠假端口本身守着：`readText` / `list` / `findFiles` / `searchText`
 * 一律**抛错**——`edit_file` 走行窗口读（截断后写回）是本工具最必须堵死的损坏路径。
 */
import { describe, expect, it } from 'vitest'
import { createEditTool } from './edit.js'
import type { EditToolOptions, ReadTracker } from './edit.js'
import { MAX_EDIT_BYTES } from './files.js'
import type { FilePort } from './files.js'
import type { ToolContext, ToolDefinition, ToolResult } from './registry.js'

const ctx: ToolContext = { sessionId: 'session-a' }
const CWD = 'D:\\work'
const ABS = `${CWD}\\a.txt`

interface FakeCalls {
  readWholeText: Array<{ path: string; maxBytes: number }>
  writeText: Array<{ path: string; content: string; mode: 'overwrite' | 'append' }>
  /** 除 `readWholeText` 之外被碰到的端口方法（碰了就是契约被破坏，非空即失败） */
  forbidden: string[]
}

interface Fakes {
  files: FilePort
  calls: FakeCalls
}

interface FakeOptions {
  /** 端口回带的整文件内容（缺省空串）；写盘成功后会被替换成写回的内容，便于连改两次 */
  text?: string
  bytes?: number
  refused?: boolean
  absolutePath?: string
  readError?: Error
  writeError?: Error
}

function createFakes(options: FakeOptions = {}): Fakes {
  const calls: FakeCalls = { readWholeText: [], writeText: [], forbidden: [] }
  let current = options.text ?? ''
  const absolutePath = options.absolutePath ?? ABS
  const files: FilePort = {
    // 行窗口 API 一律抛错并留痕：edit_file 只准用整文件读（截断后写回 = 静默丢内容）
    async readText() {
      calls.forbidden.push('readText')
      throw new Error('edit_file 不得使用行窗口 API（readText）')
    },
    async readWholeText(path, maxBytes) {
      calls.readWholeText.push({ path, maxBytes })
      if (options.readError !== undefined) throw options.readError
      return {
        absolutePath,
        text: current,
        bytes: options.bytes ?? Buffer.byteLength(current, 'utf8'),
        refused: options.refused === true,
      }
    },
    async writeText(path, content, mode) {
      calls.writeText.push({ path, content, mode })
      if (options.writeError !== undefined) throw options.writeError
      current = content
      return { absolutePath: `${CWD}\\${path}`, bytes: Buffer.byteLength(content, 'utf8') }
    },
    async list() {
      calls.forbidden.push('list')
      throw new Error('edit_file 不得调用 list')
    },
    async findFiles() {
      calls.forbidden.push('findFiles')
      throw new Error('edit_file 不得调用 findFiles')
    },
    async searchText() {
      calls.forbidden.push('searchText')
      throw new Error('edit_file 不得调用 searchText')
    },
  }
  return { files, calls }
}

/**
 * 假守卫：内存集合 + 三个方法的调用留痕。
 * 键用 `sessionId` + 绝对路径的复合串，正好把「按会话隔离」与「按绝对路径为键」两条口径分开验。
 */
interface TrackerFakes {
  tracker: ReadTracker
  calls: { has: string[]; mark: string[]; clear: string[] }
}

function createTracker(marked: Array<[string, string]> = []): TrackerFakes {
  const keys = new Set(marked.map(([sessionId, path]) => `${sessionId}\u0000${path}`))
  const calls: TrackerFakes['calls'] = { has: [], mark: [], clear: [] }
  return {
    calls,
    tracker: {
      has(sessionId, absolutePath) {
        calls.has.push(`${sessionId}\u0000${absolutePath}`)
        return keys.has(`${sessionId}\u0000${absolutePath}`)
      },
      mark(sessionId, absolutePath) {
        calls.mark.push(`${sessionId}\u0000${absolutePath}`)
        keys.add(`${sessionId}\u0000${absolutePath}`)
      },
      clear(sessionId, absolutePath) {
        calls.clear.push(`${sessionId}\u0000${absolutePath}`)
        keys.delete(`${sessionId}\u0000${absolutePath}`)
      },
    },
  }
}

function toolOf(fakes: Fakes, options: Partial<EditToolOptions> = {}): ToolDefinition {
  return createEditTool({ files: fakes.files, ...options })
}

/** 断言「一次都没写盘」——拒绝路径的每条用例都要过这一关 */
function expectNoWrite(fakes: Fakes): void {
  expect(fakes.calls.writeText).toEqual([])
}

/** 取出唯一一次写盘调用（不是恰好一次就让用例直接炸） */
function soleWrite(fakes: Fakes): { path: string; content: string; mode: string } {
  expect(fakes.calls.writeText).toHaveLength(1)
  const call = fakes.calls.writeText[0]
  if (call === undefined) throw new Error('没有任何写盘调用')
  return call
}

/** 命中若干处的文件内容：`foo` 各占一行，便于计数与断言 */
const THREE_HITS = 'foo\nbar\nfoo\nbar\nfoo\n'

describe('createEditTool 工具定义', () => {
  it('name / sensitivity / required / additionalProperties 符合 §11.6 契约', () => {
    const tool = toolOf(createFakes())

    expect(tool.name).toBe('edit_file')
    // 与 write_file 同族：每次调用都要过 confirmTool 钩子
    expect(tool.sensitivity).toBe('confirm')
    expect(tool.parameters.type).toBe('object')
    expect(tool.parameters.required).toEqual(['path', 'oldString', 'newString'])
    expect(tool.parameters.additionalProperties).toBe(false)
    expect(Object.keys(tool.parameters.properties ?? {}).sort()).toEqual([
      'newString',
      'oldString',
      'path',
      'replaceAll',
    ])
    // replaceAll 只在多处命中时才是必填，因此不进 required
    expect(tool.parameters.properties?.['newString']).toMatchObject({ type: 'string' })
    expect(tool.parameters.properties?.['replaceAll']).toMatchObject({ type: 'boolean' })
  })

  it('description 写清读前守卫、唯一性、replaceAll 与行号前缀（§20.1 措辞规范）', () => {
    const tool = toolOf(createFakes())

    expect(tool.description).toContain('改前必须先用 read_file 读过')
    expect(tool.description).toContain('oldString 要带足上下文保证唯一')
    expect(tool.description).toContain('要全局改名用 replaceAll')
    expect(tool.description).toContain('在 oldString 里带上 read_file 的行号前缀')
    // 数字引用内核常量（§20.1）：默认上限 1 MiB
    expect(tool.description).toContain('1048576 字节（1 MiB）')
    expect(tool.description).toContain('run_command')
  })
})

describe('edit_file 参数校验', () => {
  it('缺 path / 空白 path / 缺 oldString / 缺 newString / 非字符串 → isError 且不触碰端口', async () => {
    const fakes = createFakes({ text: THREE_HITS })
    const tool = toolOf(fakes)
    const badInputs: unknown[] = [
      {},
      { path: '   ' },
      { path: 42, oldString: 'foo', newString: 'x' },
      { path: 'a.txt', newString: 'x' },
      { path: 'a.txt', oldString: 'foo' },
      { path: 'a.txt', oldString: 7, newString: 'x' },
      { path: 'a.txt', oldString: 'foo', newString: null },
      null,
      ['a.txt'],
    ]
    for (const input of badInputs) {
      const result = await tool.execute(input, ctx)
      expect(result.isError).toBe(true)
      expect(result.summary).toBeTypeOf('string')
    }
    // 参数非法时连整文件读都不做（与 run_command「参数非法不触碰端口」同一口径）
    expect(fakes.calls.readWholeText).toEqual([])
    expectNoWrite(fakes)
  })

  it('oldString 为空串 → isError 且未写盘（空串会在任意位置匹配）', async () => {
    const fakes = createFakes({ text: THREE_HITS })
    const tool = toolOf(fakes)

    const result = await tool.execute({ path: 'a.txt', oldString: '', newString: 'x' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('oldString 不能为空')
    expect(fakes.calls.readWholeText).toEqual([])
    expectNoWrite(fakes)
  })

  it('oldString === newString → isError 且未写盘（无意义改动）', async () => {
    const fakes = createFakes({ text: THREE_HITS })
    const tool = toolOf(fakes)

    const result = await tool.execute({ path: 'a.txt', oldString: 'foo', newString: 'foo' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('新旧内容相同')
    expect(fakes.calls.readWholeText).toEqual([])
    expectNoWrite(fakes)
  })

  it('replaceAll 传非布尔真值（字符串 "true"）按 false 处理：多处命中仍拒绝', async () => {
    const fakes = createFakes({ text: THREE_HITS })
    const tool = toolOf(fakes)

    const result = await tool.execute(
      { path: 'a.txt', oldString: 'foo', newString: 'x', replaceAll: 'true' },
      ctx,
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('命中 3 处')
    expectNoWrite(fakes)
  })
})

describe('edit_file 唯一命中与替换', () => {
  it('唯一命中 → 成功，写回内容与预期逐字节相同（mode=overwrite）', async () => {
    const original = 'alpha\nbeta\ngamma\n'
    const expected = 'alpha\nBETA\ngamma\n'
    const fakes = createFakes({ text: original })
    const tool = toolOf(fakes)

    const result = await tool.execute({ path: 'a.txt', oldString: 'beta', newString: 'BETA' }, ctx)

    expect(result.isError).toBeUndefined()
    const write = soleWrite(fakes)
    expect(write.path).toBe('a.txt')
    expect(write.mode).toBe('overwrite')
    // 整串相等：文件其余部分逐字节不变
    expect(write.content).toBe(expected)
    expect(result.content).toBe(
      `已修改：${ABS}（替换 1 处，共 ${Buffer.byteLength(expected, 'utf8')} 字节）`,
    )
    expect(result.summary).toBe('替换 1 处')
    expect(fakes.calls.forbidden).toEqual([])
  })

  it('多行 oldString 命中 → 成功（跨行替换可用）', async () => {
    const original = 'head\none\ntwo\ntail\n'
    const expected = 'head\nONE\nTWO\ntail\n'
    const fakes = createFakes({ text: original })
    const tool = toolOf(fakes)

    const result = await tool.execute(
      { path: 'a.txt', oldString: 'one\ntwo', newString: 'ONE\nTWO' },
      ctx,
    )

    expect(result.isError).toBeUndefined()
    expect(soleWrite(fakes).content).toBe(expected)
    expect(result.summary).toBe('替换 1 处')
  })

  it('newString 传空串 → 成功删除该片段（与空 oldString 不同，这是允许的）', async () => {
    const fakes = createFakes({ text: 'keep\ndrop\nkeep2\n' })
    const tool = toolOf(fakes)

    const result = await tool.execute({ path: 'a.txt', oldString: 'drop\n', newString: '' }, ctx)

    expect(result.isError).toBeUndefined()
    expect(soleWrite(fakes).content).toBe('keep\nkeep2\n')
    expect(result.content).toBe(
      `已修改：${ABS}（替换 1 处，共 ${Buffer.byteLength('keep\nkeep2\n')} 字节）`,
    )
  })

  it('未找到 oldString → isError 且未写盘，文案给出两条排查方向', async () => {
    const fakes = createFakes({ text: 'alpha\nbeta\n' })
    const tool = toolOf(fakes)

    const result = await tool.execute({ path: 'a.txt', oldString: 'gamma', newString: 'x' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('未找到 oldString')
    // 两条排查方向：行号前缀 / 行尾归一 —— 少一条模型就会去猜别的原因
    expect(result.content).toContain('read_file 确认原文')
    expect(result.content).toContain('不要带 "N: " 行号前缀')
    expect(result.content).toContain('比对已按 LF 归一，行尾差异不是原因')
    expectNoWrite(fakes)
  })

  it('命中 3 处且未传 replaceAll → isError，文案含 3，未写盘', async () => {
    const fakes = createFakes({ text: THREE_HITS })
    const tool = toolOf(fakes)

    const result = await tool.execute({ path: 'a.txt', oldString: 'foo', newString: 'x' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('命中 3 处')
    expect(result.content).toContain('扩大 oldString 的上下文使其唯一')
    expect(result.content).toContain('replaceAll: true')
    expect(result.summary).toBe('命中 3 处，未替换')
    expectNoWrite(fakes)
  })

  it('replaceAll: true → 3 处全替换，文案回报 3 处', async () => {
    const fakes = createFakes({ text: THREE_HITS })
    const tool = toolOf(fakes)

    const result = await tool.execute(
      { path: 'a.txt', oldString: 'foo', newString: 'X', replaceAll: true },
      ctx,
    )

    expect(result.isError).toBeUndefined()
    expect(soleWrite(fakes).content).toBe('X\nbar\nX\nbar\nX\n')
    expect(result.content).toBe(
      `已修改：${ABS}（替换 3 处，共 ${Buffer.byteLength('X\nbar\nX\nbar\nX\n')} 字节）`,
    )
    expect(result.summary).toBe('替换 3 处')
  })

  it('正则元字符按字面处理：a.b 只替换 a.b，axb 不受影响', async () => {
    const fakes = createFakes({ text: 'a.b\naxb\n' })
    const tool = toolOf(fakes)

    const result = await tool.execute({ path: 'a.txt', oldString: 'a.b', newString: 'A.B' }, ctx)

    expect(result.isError).toBeUndefined()
    // 走正则的话 axb 会被一起改掉；逐字节断言把这条钉死
    expect(soleWrite(fakes).content).toBe('A.B\naxb\n')
  })

  it('edit_file 不碰行窗口读与其它端口方法（readText / list / 搜索一律未被调用）', async () => {
    const fakes = createFakes({ text: 'a\nb\n' })
    const tool = toolOf(fakes)

    await tool.execute({ path: 'a.txt', oldString: 'a', newString: 'A' }, ctx)

    expect(fakes.calls.readWholeText).toEqual([{ path: 'a.txt', maxBytes: MAX_EDIT_BYTES }])
    expect(fakes.calls.forbidden).toEqual([])
  })
})

describe('edit_file 行尾保真', () => {
  it('CRLF 保真：LF 形态的 oldString 也命中，写回仍是 CRLF 且没有孤立的 \\n', async () => {
    const fakes = createFakes({ text: 'line1\r\nline2\r\n' })
    const tool = toolOf(fakes)

    const result = await tool.execute(
      { path: 'a.txt', oldString: 'line2', newString: 'LINE2' },
      ctx,
    )

    expect(result.isError).toBeUndefined()
    const out = soleWrite(fakes).content
    expect(out).toBe('line1\r\nLINE2\r\n')
    // 结果里不存在不跟在 \r 后面的 \n（把 CRLF 全摘掉后不该还剩 \n）
    expect(out.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('LF 保真：写回结果不含任何 \\r', async () => {
    const fakes = createFakes({ text: 'a\nb\n' })
    const tool = toolOf(fakes)

    const result = await tool.execute({ path: 'a.txt', oldString: 'a', newString: 'A' }, ctx)

    expect(result.isError).toBeUndefined()
    const out = soleWrite(fakes).content
    expect(out).toBe('A\nb\n')
    expect(out.includes('\r')).toBe(false)
  })

  it('CRLF 文件里的多行替换：LF 形态的 oldString / newString 写回后仍是 CRLF', async () => {
    const fakes = createFakes({ text: 'a\r\nb\r\nc\r\n' })
    const tool = toolOf(fakes)

    const result = await tool.execute({ path: 'a.txt', oldString: 'b\nc', newString: 'B\nC' }, ctx)

    expect(result.isError).toBeUndefined()
    const out = soleWrite(fakes).content
    expect(out).toBe('a\r\nB\r\nC\r\n')
    expect(out.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('LF 文件里的多行替换不引入 \\r（归一匹配 + 按原行尾还原）', async () => {
    const fakes = createFakes({ text: 'a\nb\nc\n' })
    const tool = toolOf(fakes)

    const result = await tool.execute({ path: 'a.txt', oldString: 'b\nc', newString: 'B\nC' }, ctx)

    expect(result.isError).toBeUndefined()
    expect(soleWrite(fakes).content).toBe('a\nB\nC\n')
  })

  it('孤立 \\r（旧 Mac 行尾）→ isError 且未写盘', async () => {
    const fakes = createFakes({ text: 'a\rb\n' })
    const tool = toolOf(fakes)

    const result = await tool.execute({ path: 'a.txt', oldString: 'a', newString: 'A' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('孤立的回车符')
    expect(result.summary).toBe('行尾异常，已放弃改动')
    expectNoWrite(fakes)
  })

  it('混合行尾（同时含 CRLF 与 LF）→ isError 且未写盘', async () => {
    const fakes = createFakes({ text: 'a\r\nb\nc\r\n' })
    const tool = toolOf(fakes)

    const result = await tool.execute({ path: 'a.txt', oldString: 'b', newString: 'B' }, ctx)

    // 放行这条文件会把所有 LF 行也改成 CRLF = 整个文件每一行的行尾都被改写
    expect(result.isError).toBe(true)
    expect(result.content).toContain('文件行尾不一致')
    expect(result.content).toContain('请先统一行尾')
    expect(result.summary).toBe('行尾不一致，已放弃改动')
    expectNoWrite(fakes)
  })
})

describe('edit_file 端口错误与单文件上限', () => {
  it('二进制（端口因 NUL 抛错）→ isError 且未写盘', async () => {
    const fakes = createFakes({
      readError: new Error('这是二进制文件，无法按文本编辑'),
    })
    const tool = toolOf(fakes)

    // 没有 rejects 也没有 try/catch：拿到返回值本身就证明异常被折成了结果
    const result = await tool.execute({ path: 'a.png', oldString: 'x', newString: 'y' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toBe('读取文件失败：这是二进制文件，无法按文本编辑')
    expect(result.summary).toBe('读取文件失败')
    expectNoWrite(fakes)
  })

  it('refused: true（超过 maxEditBytes）→ isError 且未写盘', async () => {
    const fakes = createFakes({ text: '', bytes: 2_000_000, refused: true })
    const tool = toolOf(fakes, { maxEditBytes: 16 })

    const result = await tool.execute({ path: 'big.txt', oldString: 'x', newString: 'y' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('无法整体替换')
    expect(result.content).toContain('run_command')
    expect(result.content).toContain('write_file')
    expect(result.summary).toBe('文件过大，已放弃改动')
    expect(fakes.calls.readWholeText).toEqual([{ path: 'big.txt', maxBytes: 16 }])
    expectNoWrite(fakes)
  })

  it('maxEditBytes 缺省时把内核常量 MAX_EDIT_BYTES 传给端口', async () => {
    const fakes = createFakes({ text: 'a\n' })
    const tool = toolOf(fakes)

    await tool.execute({ path: 'a.txt', oldString: 'a', newString: 'A' }, ctx)

    expect(fakes.calls.readWholeText).toEqual([{ path: 'a.txt', maxBytes: MAX_EDIT_BYTES }])
    expect(MAX_EDIT_BYTES).toBe(1_048_576)
  })

  it('写盘抛错 → isError 回带原因，异常不冒泡进工具循环', async () => {
    const fakes = createFakes({
      text: 'a\n',
      writeError: new Error('EACCES: permission denied'),
    })
    const tool = toolOf(fakes)

    const result = await tool.execute({ path: 'a.txt', oldString: 'a', newString: 'A' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toBe('写入文件失败：EACCES: permission denied')
    expect(result.summary).toBe('写入文件失败')
  })
})

describe('edit_file 读前守卫', () => {
  it('未读过 → isError 且未写盘，文案含解析后的绝对路径', async () => {
    const fakes = createFakes({ text: 'a\n' })
    const { tracker, calls } = createTracker()
    const tool = toolOf(fakes, { readTracker: tracker })

    const result = await tool.execute({ path: 'a.txt', oldString: 'a', newString: 'A' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain(`修改前必须先用 read_file 读过 ${ABS}`)
    expect(result.summary).toBe('未读过该文件')
    // 守卫按**端口回带的绝对路径**查询，不是模型传入的原始串
    expect(calls.has).toEqual([`${ctx.sessionId}\u0000${ABS}`])
    expectNoWrite(fakes)
  })

  it('mark 之后 → 放行并成功写盘', async () => {
    const fakes = createFakes({ text: 'a\n' })
    const { tracker } = createTracker([[ctx.sessionId, ABS]])
    const tool = toolOf(fakes, { readTracker: tracker })

    const result = await tool.execute({ path: 'a.txt', oldString: 'a', newString: 'A' }, ctx)

    expect(result.isError).toBeUndefined()
    expect(soleWrite(fakes).content).toBe('A\n')
  })

  it('未注入守卫 → 不拦截（供直接调用工具的单测使用）', async () => {
    const fakes = createFakes({ text: 'a\n' })
    const tool = toolOf(fakes)

    const result = await tool.execute({ path: 'a.txt', oldString: 'a', newString: 'A' }, ctx)

    expect(result.isError).toBeUndefined()
    expect(soleWrite(fakes).content).toBe('A\n')
  })

  it('按 sessionId 隔离：会话 A 标记过，会话 B 仍被拒', async () => {
    const fakes = createFakes({ text: 'a\n' })
    const { tracker } = createTracker([['session-a', ABS]])
    const tool = toolOf(fakes, { readTracker: tracker })

    const other: ToolResult = await tool.execute(
      { path: 'a.txt', oldString: 'a', newString: 'A' },
      { sessionId: 'session-b' },
    )
    expect(other.isError).toBe(true)
    expect(other.content).toContain('修改前必须先用 read_file 读过')
    expectNoWrite(fakes)

    const self = await tool.execute({ path: 'a.txt', oldString: 'a', newString: 'A' }, ctx)
    expect(self.isError).toBeUndefined()
    expect(soleWrite(fakes).content).toBe('A\n')
  })

  it('以端口回带的绝对路径为键：模型传相对路径时标记与判定对得上', async () => {
    const fakes = createFakes({ text: 'a\n', absolutePath: ABS })
    const { tracker, calls } = createTracker([[ctx.sessionId, ABS]])
    const tool = toolOf(fakes, { readTracker: tracker })

    // 模型传的是相对路径 'a.txt'，端口回带 D:\work\a.txt —— 标记按后者查
    const result = await tool.execute({ path: 'a.txt', oldString: 'a', newString: 'A' }, ctx)

    expect(result.isError).toBeUndefined()
    expect(fakes.calls.readWholeText).toEqual([{ path: 'a.txt', maxBytes: MAX_EDIT_BYTES }])
    expect(calls.has).toEqual([`${ctx.sessionId}\u0000${ABS}`])
    expect(soleWrite(fakes).content).toBe('A\n')
  })

  it('成功路径保留标记、也不调用 mark / clear（clear 只属于 write_file）', async () => {
    const fakes = createFakes({ text: 'a\n' })
    const { tracker, calls } = createTracker([[ctx.sessionId, ABS]])
    expect(typeof tracker.mark).toBe('function')
    expect(typeof tracker.clear).toBe('function')
    const tool = toolOf(fakes, { readTracker: tracker })

    await tool.execute({ path: 'a.txt', oldString: 'a', newString: 'A' }, ctx)
    // 模型刚主动改过它，知道当前内容：清掉只会逼它白读一次
    expect(calls.clear).toEqual([])
    expect(calls.mark).toEqual([])

    const again = await tool.execute({ path: 'a.txt', oldString: 'A', newString: 'AA' }, ctx)
    expect(again.isError).toBeUndefined()
    expect(fakes.calls.writeText).toHaveLength(2)
  })
})
