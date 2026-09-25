/**
 * 文件与「打开」类工具的纯逻辑单测（docs/06 §11、§20）。
 *
 * 全部用内存假端口，**没有真实 IO**：真实系统调用由主进程端口承担
 * （`apps/desktop/src/main/tools/file-port.test.ts`）。
 * `read_file` 的结果文本按新契约**逐字**断言：头部
 * `文件：…（共 N 行 / M 字节；本次显示第 x–y 行）` + `<行号>: 内容` 行（段间 `\n\n` 连接），
 * 窗口为空 / 空文件 / 命中扫描上限各有一支专属文案。
 */
import { describe, expect, it } from 'vitest'
import { COMPUTER_TOOL_NAMES } from '@aurora/shared'
import {
  createFileTools,
  createOpenTool,
  DEFAULT_READ_LINES,
  MAX_LINE_CHARS,
  MAX_READ_LINES,
  MAX_READ_SCAN_BYTES,
} from './files.js'
import type {
  DirEntry,
  FilePort,
  FileToolOptions,
  OpenPort,
  ReadLine,
  ReadTextOptions,
  ReadTextResult,
} from './files.js'
import type { ToolContext, ToolDefinition } from './registry.js'

const ctx: ToolContext = { sessionId: 'test-session' }

const CWD = 'D:\\work'

/** 端口回带的条目（内核负责渲染成 `[DIR]` / `[FILE]` 行） */
const SAMPLE_ENTRIES: DirEntry[] = [
  { name: 'docs', type: 'dir', modifiedAt: '2026-09-20T17:10:00' },
  { name: 'note.txt', type: 'file', sizeBytes: 1234, modifiedAt: '2026-09-20T17:10:00' },
]

interface FakeCalls {
  readText: Array<{ path: string; options: ReadTextOptions }>
  writeText: Array<{ path: string; content: string; mode: 'overwrite' | 'append' }>
  list: Array<{ path: string; limit: number }>
  open: string[]
}

interface Fakes {
  files: FilePort
  open: OpenPort
  calls: FakeCalls
}

/** 内存假端口：记录调用参数，便于断言「钳制后的值真的传下去了」 */
function createFakes(
  overrides: Partial<FilePort> = {},
  openImpl?: (target: string) => Promise<void>,
): Fakes {
  const calls: FakeCalls = { readText: [], writeText: [], list: [], open: [] }
  const files: FilePort = {
    async readText(path, options) {
      calls.readText.push({ path, options })
      return {
        absolutePath: `${CWD}\\${path}`,
        lines: [{ number: 1, text: '正文' }],
        totalLines: 1,
        truncated: false,
        bytes: 6,
        totalBytes: 6,
      }
    },
    async writeText(path, content, mode) {
      calls.writeText.push({ path, content, mode })
      return { absolutePath: `${CWD}\\${path}`, bytes: Buffer.byteLength(content, 'utf8') }
    },
    async list(path, limit) {
      calls.list.push({ path, limit })
      return { absolutePath: `${CWD}\\${path}`, entries: SAMPLE_ENTRIES, truncated: false }
    },
    ...overrides,
  }
  const open: OpenPort = {
    async open(target) {
      calls.open.push(target)
      if (openImpl !== undefined) await openImpl(target)
    },
  }
  return { files, open, calls }
}

/**
 * 造一份端口返回值：`lines` 是端口**已经按 `offsetLines` / `limitLines` 裁好**的窗口
 * （行号相对文件开头，不随 `offset` 改变），其余字段给中性缺省。
 *
 * `overrides` 里显式写 `totalLines: undefined`（扫描上限场景）也能生效 ——
 * 对象展开只看键在不在，不看值是不是 `undefined`。
 */
function readResultOf(lines: ReadLine[], overrides: Partial<ReadTextResult> = {}): ReadTextResult {
  // 桩里的 `bytes` 按字符数估即可：内核只渲染 `totalBytes`，不渲染窗口字节数
  const bytes = lines.reduce((sum, line) => sum + line.text.length, 0)
  return {
    absolutePath: `${CWD}\\a.txt`,
    lines,
    totalLines: lines.length,
    truncated: false,
    bytes,
    totalBytes: bytes,
    ...overrides,
  }
}

/** 造 `from`–`to` 的连续行（内容 `line-<行号>`）：需要行号与内容连续的窗口时用它 */
function lineRange(from: number, to: number): ReadLine[] {
  const lines: ReadLine[] = []
  for (let number = from; number <= to; number += 1) lines.push({ number, text: `line-${number}` })
  return lines
}

/** 端口桩：`readText` 回带给定行窗口，同时记录内核传来的参数（断言钳制结果的唯一途径） */
function windowFakes(result: ReadTextResult): Fakes {
  const fakes = createFakes()
  fakes.files.readText = async (path, options) => {
    fakes.calls.readText.push({ path, options })
    return result
  }
  return fakes
}

/** 组一份 4 工具（默认 maxReadBytes = 64 KiB，与配置上限量级一致） */
function toolsOf(fakes: Fakes, options: Partial<FileToolOptions> = {}): ToolDefinition[] {
  return createFileTools({
    files: fakes.files,
    open: fakes.open,
    maxReadBytes: options.maxReadBytes ?? 65_536,
    listLimit: options.listLimit,
  })
}

function toolOf(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((tool) => tool.name === name)
  if (found === undefined) throw new Error(`工具不存在：${name}`)
  return found
}

/**
 * `createFileTools` 交付的**文件类**工具（显式列出，不写死长度）。
 *
 * 刻意不用「`COMPUTER_TOOL_NAMES` 去掉 `run_command`」这种全局过滤：v12 的常量有 8 个名字，
 * 其中 `edit_file`（step 4 交付）、`grep` / `glob`（step 3 交付）都不由本工厂创建，
 * 过滤条件必须显式说清「哪些是文件类」而不是「除了谁都是文件类」。
 */
const FILE_TOOL_NAMES = ['read_file', 'write_file', 'list_dir', 'open_path'] as const

describe('createFileTools', () => {
  it('返回恰好这 4 个文件类工具，名字与 COMPUTER_TOOL_NAMES 的对应子集一致', () => {
    const tools = toolsOf(createFakes())
    const names = tools.map((tool) => tool.name)

    expect(names).toEqual([...FILE_TOOL_NAMES])
    expect(tools).toHaveLength(FILE_TOOL_NAMES.length)
    // 与共享常量同源：这份显式列表的名字必须都在 `COMPUTER_TOOL_NAMES` 里，
    // 且按常量顺序筛出来与工具名逐条一致 —— 改名字漏改常量会在这里炸
    expect(
      COMPUTER_TOOL_NAMES.filter((name) => FILE_TOOL_NAMES.some((file) => file === name)),
    ).toEqual([...FILE_TOOL_NAMES])
    const sensitivities = tools.map((tool) => tool.sensitivity)
    expect(sensitivities).toEqual(['safe', 'confirm', 'safe', 'confirm'])
  })

  it('每个工具都禁止额外字段，required 只含真实必填项', () => {
    const tools = toolsOf(createFakes())
    for (const tool of tools) {
      expect(tool.parameters.additionalProperties).toBe(false)
      expect(tool.parameters.type).toBe('object')
    }
    expect(toolOf(tools, 'read_file').parameters.required).toEqual(['path'])
    expect(toolOf(tools, 'write_file').parameters.required).toEqual(['path', 'content'])
    expect(toolOf(tools, 'list_dir').parameters.required).toEqual(['path'])
    expect(toolOf(tools, 'open_path').parameters.required).toEqual(['target'])
  })
})

describe('参数校验', () => {
  it('read_file / list_dir 缺参或空白路径时报错且不触碰端口', async () => {
    const fakes = createFakes()
    const tools = toolsOf(fakes)
    for (const input of [{}, { path: '   ' }, { path: 42 }, null, ['a.txt']]) {
      const readResult = await toolOf(tools, 'read_file').execute(input, ctx)
      expect(readResult.isError).toBe(true)
      const listResult = await toolOf(tools, 'list_dir').execute(input, ctx)
      expect(listResult.isError).toBe(true)
    }
    expect(fakes.calls.readText).toEqual([])
    expect(fakes.calls.list).toEqual([])
  })

  it('write_file 缺 path / 缺 content / mode 非法时报错且不触碰端口', async () => {
    const fakes = createFakes()
    const write = toolOf(toolsOf(fakes), 'write_file')

    const noPath = await write.execute({ content: 'x' }, ctx)
    const noContent = await write.execute({ path: 'a.txt' }, ctx)
    const badMode = await write.execute({ path: 'a.txt', content: 'x', mode: 'truncate' }, ctx)
    expect([noPath.isError, noContent.isError, badMode.isError]).toEqual([true, true, true])
    expect(fakes.calls.writeText).toEqual([])

    // 空内容是合法写入（清空文件），不应被当成缺参
    const empty = await write.execute({ path: 'a.txt', content: '' }, ctx)
    expect(empty.isError).toBeUndefined()
    expect(fakes.calls.writeText).toEqual([{ path: 'a.txt', content: '', mode: 'overwrite' }])
  })

  it('open_path 缺 target 时报错且不触碰端口', async () => {
    const fakes = createFakes()
    const tool = toolOf(toolsOf(fakes), 'open_path')
    for (const input of [{}, { target: '  ' }, { target: 7 }]) {
      const result = await tool.execute(input, ctx)
      expect(result.isError).toBe(true)
    }
    expect(fakes.calls.open).toEqual([])
  })
})

describe('read_file', () => {
  it('maxBytes 按钳制后的值传给端口', async () => {
    const fakes = createFakes()
    const read = toolOf(toolsOf(fakes, { maxReadBytes: 8_192 }), 'read_file')

    await read.execute({ path: 'a.txt' }, ctx)
    await read.execute({ path: 'a.txt', maxBytes: 10 }, ctx)
    await read.execute({ path: 'a.txt', maxBytes: 999_999 }, ctx)
    await read.execute({ path: 'a.txt', maxBytes: 2048.7 }, ctx)

    const sent = fakes.calls.readText.map((call) => call.options.maxBytes)
    expect(sent).toEqual([8_192, 1_024, 8_192, 2_048])
    expect(fakes.calls.readText.every((call) => call.path === 'a.txt')).toBe(true)
  })

  it('offset 非数字 / 小于 1 时钳到 1，端口收到的仍是合法值', async () => {
    const fakes = createFakes()
    const read = toolOf(toolsOf(fakes), 'read_file')

    await read.execute({ path: 'a.txt', offset: '3' }, ctx)
    await read.execute({ path: 'a.txt', offset: 0 }, ctx)
    await read.execute({ path: 'a.txt', offset: -5 }, ctx)
    await read.execute({ path: 'a.txt', offset: 2.7 }, ctx)

    const sent = fakes.calls.readText.map((call) => call.options.offsetLines)
    expect(sent).toEqual([1, 1, 1, 2])
    expect(sent.every((value) => value !== undefined && value >= 1)).toBe(true)
  })

  it('limit 非数字回落缺省值、负数钳到 1、超上限钳到 MAX_READ_LINES', async () => {
    const fakes = createFakes()
    const read = toolOf(toolsOf(fakes), 'read_file')

    await read.execute({ path: 'a.txt' }, ctx)
    await read.execute({ path: 'a.txt', limit: 'many' }, ctx)
    await read.execute({ path: 'a.txt', limit: -1 }, ctx)
    await read.execute({ path: 'a.txt', limit: 0 }, ctx)
    await read.execute({ path: 'a.txt', limit: 1_000_000 }, ctx)
    await read.execute({ path: 'a.txt', limit: 3.9 }, ctx)

    const sent = fakes.calls.readText.map((call) => call.options.limitLines)
    expect(sent).toEqual([DEFAULT_READ_LINES, DEFAULT_READ_LINES, 1, 1, MAX_READ_LINES, 3])
    expect(
      sent.every((value) => value !== undefined && value >= 1 && value <= MAX_READ_LINES),
    ).toBe(true)
  })

  it('maxBytes 非数字时报错且不触碰端口', async () => {
    const fakes = createFakes()
    const read = toolOf(toolsOf(fakes, { maxReadBytes: 8_192 }), 'read_file')

    const result = await read.execute({ path: 'a.txt', maxBytes: 'big' }, ctx)
    expect(result.isError).toBe(true)
    expect(fakes.calls.readText).toEqual([])
  })

  it('把行窗口渲染成 `<行号>: 内容` 行，段间空行分隔，头部交代总行数与本次窗口', async () => {
    const fakes = windowFakes(
      readResultOf(
        [
          { number: 1, text: 'foo' },
          { number: 2, text: 'bar' },
        ],
        { totalBytes: 8 },
      ),
    )
    const read = toolOf(toolsOf(fakes), 'read_file')

    const result = await read.execute({ path: 'a.txt' }, ctx)

    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('1: foo')
    expect(result.content).toContain('2: bar')
    // 逐字对齐新契约：头部 + 空行 + 行号前缀；端口说没有更多内容，因此没有尾注
    expect(result.content).toBe(
      '文件：D:\\work\\a.txt（共 2 行 / 8 字节；本次显示第 1–2 行）\n\n1: foo\n\n2: bar',
    )
    expect(result.summary).toBe('读取第 1–2 行 / 共 2 行')
  })

  it('offset: 3 / limit: 2 时头部显示 本次显示第 3–4 行，且两个参数原样透传端口', async () => {
    const fakes = windowFakes(
      readResultOf(
        [
          { number: 3, text: 'c' },
          { number: 4, text: 'd' },
        ],
        { totalLines: 10, totalBytes: 100, truncated: true },
      ),
    )
    const read = toolOf(toolsOf(fakes), 'read_file')

    const result = await read.execute({ path: 'a.txt', offset: 3, limit: 2 }, ctx)

    expect(result.content).toContain(
      '文件：D:\\work\\a.txt（共 10 行 / 100 字节；本次显示第 3–4 行）',
    )
    expect(result.content).toContain('3: c')
    expect(result.content).toContain('4: d')
    expect(result.content).toContain('…（还有 6 行未显示，用 offset 继续读）…')
    expect(fakes.calls.readText).toEqual([
      { path: 'a.txt', options: { offsetLines: 3, limitLines: 2, maxBytes: 65_536 } },
    ])
  })

  it('offset 超出文件末尾时回带空窗口并说明，不置 isError', async () => {
    const fakes = windowFakes(readResultOf([], { totalLines: 5, totalBytes: 40 }))
    const read = toolOf(toolsOf(fakes), 'read_file')

    const result = await read.execute({ path: 'a.txt', offset: 99 }, ctx)

    expect(result.isError).toBeUndefined()
    expect(result.content).toBe(
      '文件：D:\\work\\a.txt（共 5 行 / 40 字节）\n\noffset 超出文件末尾（共 5 行）',
    )
    expect(result.summary).toBe('未读到内容（offset 超出文件末尾）')
  })

  it('空文件回带 共 0 行 并标注（空文件），不是错误', async () => {
    const fakes = windowFakes(readResultOf([], { totalLines: 0, totalBytes: 0 }))
    const read = toolOf(toolsOf(fakes), 'read_file')

    const result = await read.execute({ path: 'a.txt' }, ctx)

    expect(result.isError).toBeUndefined()
    expect(result.content).toBe('文件：D:\\work\\a.txt（共 0 行 / 0 字节）\n\n（空文件）')
    expect(result.summary).toBe('空文件')
  })

  it('截断时尾部标注剩余行数，summary 保持短句', async () => {
    const fakes = windowFakes(
      readResultOf(lineRange(12, 13), { totalLines: 31, totalBytes: 1_024, truncated: true }),
    )
    const read = toolOf(toolsOf(fakes), 'read_file')

    const result = await read.execute({ path: 'a.txt', offset: 12 }, ctx)

    expect(result.isError).toBeUndefined()
    expect(result.content).toContain(
      '文件：D:\\work\\a.txt（共 31 行 / 1024 字节；本次显示第 12–13 行）',
    )
    expect(result.content).toContain('12: line-12')
    expect(result.content).toContain('13: line-13')
    expect(result.content).toContain('…（还有 18 行未显示，用 offset 继续读）…')
    expect(result.summary).toBe('读取第 12–13 行 / 共 31 行')
  })

  it('命中扫描上限时头部与尾注都提示文件过大，不给出假的 totalLines', async () => {
    const mib = Math.round(MAX_READ_SCAN_BYTES / 1024 / 1024)
    const fakes = windowFakes(
      readResultOf([{ number: 1, text: 'head' }], {
        absolutePath: 'D:\\work\\big.log',
        totalLines: undefined,
        totalBytes: 20_000_000,
        truncated: true,
        scanLimitHit: true,
      }),
    )
    const read = toolOf(toolsOf(fakes), 'read_file')

    const result = await read.execute({ path: 'big.log' }, ctx)

    expect(result.content).toContain(
      `文件：D:\\work\\big.log（20000000 字节；文件超过 ${mib} MiB 只解析了开头，建议用 grep 定位）`,
    )
    expect(result.content).toContain(
      `…（文件超过 ${mib} MiB，仅解析了开头；请用 grep 定位或改用 run_command）…`,
    )
    expect(result.content).toContain('…（还有未显示的内容，可用更大的 offset 继续读）…')
    expect(result.summary).toBe('读取第 1–1 行（文件过大仅开头）')
  })

  it('单行超过 MAX_LINE_CHARS 时截断，并在该行标注原长', async () => {
    const long = 'x'.repeat(MAX_LINE_CHARS + 1)
    const fakes = windowFakes(readResultOf([{ number: 7, text: long }]))
    const read = toolOf(toolsOf(fakes), 'read_file')

    const result = await read.execute({ path: 'a.txt' }, ctx)

    expect(result.content).toContain(
      `7: ${'x'.repeat(MAX_LINE_CHARS)}…（本行共 ${MAX_LINE_CHARS + 1} 字符已截断）…`,
    )
  })

  it('单行恰好 MAX_LINE_CHARS 时不截断（边界）', async () => {
    const exact = 'x'.repeat(MAX_LINE_CHARS)
    const fakes = windowFakes(readResultOf([{ number: 1, text: exact }]))
    const read = toolOf(toolsOf(fakes), 'read_file')

    const result = await read.execute({ path: 'a.txt' }, ctx)

    expect(result.content).toContain(`1: ${exact}`)
    expect(result.content).not.toContain('已截断')
  })

  it('端口对二进制文件抛错时折成 isError 并回带原因，异常不冒泡', async () => {
    const fakes = createFakes({
      readText: async () => {
        throw new Error('这是二进制文件（含 NUL 字节），无法按文本读取')
      },
    })
    const read = toolOf(toolsOf(fakes), 'read_file')

    // 没有 rejects 也没有 try/catch：能拿到返回值本身就证明异常被折成了结果
    const result = await read.execute({ path: 'a.bin' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toBe('读取文件失败：这是二进制文件（含 NUL 字节），无法按文本读取')
    expect(result.summary).toBe('读取文件失败')
  })

  it('端口对目录抛错时折成 isError，并回带改用 list_dir 的提示', async () => {
    const fakes = createFakes({
      readText: async () => {
        throw new Error('EISDIR: D:\\work\\sub 是目录，请改用 list_dir')
      },
    })
    const read = toolOf(toolsOf(fakes), 'read_file')

    const result = await read.execute({ path: 'sub' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toBe('读取文件失败：EISDIR: D:\\work\\sub 是目录，请改用 list_dir')
    expect(result.summary).toBe('读取文件失败')
  })

  it('description 写清行号前缀、offset 续读与 glob / grep 定位（§20 契约）', () => {
    const read = toolOf(toolsOf(createFakes()), 'read_file')

    expect(read.description).toContain('行号')
    expect(read.description).toContain('offset')
    expect(read.description).toContain('glob')
    expect(read.description).toContain('grep')
    expect(read.description).toContain('二进制')
    expect(read.parameters.properties?.['offset']).toMatchObject({ type: 'integer', minimum: 1 })
    expect(read.parameters.properties?.['limit']).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: MAX_READ_LINES,
    })
  })

  it('导出的行窗口常量与 §20 契约一致（step 3 / 4 与文档都引用它们）', () => {
    expect(DEFAULT_READ_LINES).toBe(2_000)
    expect(MAX_READ_LINES).toBe(5_000)
    expect(MAX_LINE_CHARS).toBe(2_000)
    expect(MAX_READ_SCAN_BYTES).toBe(16 * 1024 * 1024)
  })
})

describe('write_file', () => {
  it('按 UTF-8 字节数回带绝对路径与 mode', async () => {
    const fakes = createFakes()
    const write = toolOf(toolsOf(fakes), 'write_file')

    const overwrite = await write.execute({ path: 'a.txt', content: '数学' }, ctx)
    expect(overwrite.content).toBe('D:\\work\\a.txt（写入 6 字节，mode=overwrite）')

    const append = await write.execute({ path: 'a.txt', content: 'x', mode: 'append' }, ctx)
    expect(append.content).toBe('D:\\work\\a.txt（写入 1 字节，mode=append）')
    expect(fakes.calls.writeText).toEqual([
      { path: 'a.txt', content: '数学', mode: 'overwrite' },
      { path: 'a.txt', content: 'x', mode: 'append' },
    ])
  })

  it('端口抛错时回带 isError', async () => {
    const fakes = createFakes({
      writeText: async () => {
        throw new Error('EACCES: permission denied')
      },
    })
    const write = toolOf(toolsOf(fakes), 'write_file')

    const result = await write.execute({ path: 'C:\\Windows\\x.txt', content: 'x' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('EACCES')
  })
})

describe('list_dir', () => {
  it('limit 按钳制后的值传给端口', async () => {
    const fakes = createFakes()
    const list = toolOf(toolsOf(fakes, { listLimit: 50 }), 'list_dir')

    await list.execute({ path: '.' }, ctx)
    await list.execute({ path: '.', limit: 0 }, ctx)
    await list.execute({ path: '.', limit: 100_000 }, ctx)
    await list.execute({ path: '.', limit: 3.9 }, ctx)

    expect(fakes.calls.list.map((call) => call.limit)).toEqual([50, 1, 500, 3])
  })

  it('limit 缺省为 200，listLimit 可覆盖默认值', async () => {
    const defaults = createFakes()
    const list = toolOf(toolsOf(defaults), 'list_dir')
    await list.execute({ path: '.' }, ctx)
    expect(defaults.calls.list.map((call) => call.limit)).toEqual([200])

    const limited = createFakes()
    const list20 = toolOf(toolsOf(limited, { listLimit: 20 }), 'list_dir')
    await list20.execute({ path: '.' }, ctx)
    expect(limited.calls.list.map((call) => call.limit)).toEqual([20])
  })

  it('输出包含 [DIR] / [FILE] 前缀，目录在前', async () => {
    const list = toolOf(toolsOf(createFakes()), 'list_dir')

    const result = await list.execute({ path: '.' }, ctx)
    expect(result.content).toContain('[DIR]  docs')
    expect(result.content).toContain('[FILE] note.txt  1234 字节')
    expect(result.content).toContain('2026-09-20 17:10')
    expect(result.content.indexOf('[DIR]')).toBeLessThan(result.content.indexOf('[FILE]'))
  })

  it('截断时给出提示，空目录给出明确说明', async () => {
    const truncated = createFakes({
      list: async () => ({ absolutePath: 'D:\\work', entries: SAMPLE_ENTRIES, truncated: true }),
    })
    const shortResult = await toolOf(toolsOf(truncated), 'list_dir').execute(
      { path: '.', limit: 2 },
      ctx,
    )
    expect(shortResult.content).toContain('还有更多条目，已按 limit 截断')

    const empty = createFakes({
      list: async () => ({ absolutePath: 'D:\\work\\empty', entries: [], truncated: false }),
    })
    const emptyResult = await toolOf(toolsOf(empty), 'list_dir').execute({ path: 'empty' }, ctx)
    expect(emptyResult.content).toContain('（空目录）')
  })

  it('端口抛错时回带 isError', async () => {
    const fakes = createFakes({
      list: async () => {
        throw new Error('ENOENT: no such file or directory')
      },
    })
    const list = toolOf(toolsOf(fakes), 'list_dir')

    const result = await list.execute({ path: 'nope' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('ENOENT')
  })
})

describe('open_path', () => {
  it('收到未去空白的 target 时先 trim 再交给端口', async () => {
    const fakes = createFakes()
    const tool = toolOf(toolsOf(fakes), 'open_path')

    const result = await tool.execute({ target: '  https://example.com/a b  ' }, ctx)
    expect(fakes.calls.open).toEqual(['https://example.com/a b'])
    expect(result.content).toBe('已打开：https://example.com/a b')
    expect(result.isError).toBeUndefined()
  })

  it('description 写清支持的目标类型与默认程序处理', () => {
    const tool = createOpenTool({ open: createFakes().open })
    expect(tool.name).toBe('open_path')
    expect(tool.sensitivity).toBe('confirm')
    expect(tool.description).toContain('Windows 默认程序')
    expect(tool.description).toContain('文件夹')
    expect(tool.description).toContain('程序名')
  })

  it('端口抛错时回带 isError', async () => {
    const fakes = createFakes({}, async () => {
      throw new Error('打开失败：找不到关联程序')
    })
    const tool = createOpenTool({ open: fakes.open })

    const result = await tool.execute({ target: 'D:\\x.yyy' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('找不到关联程序')
  })
})

describe('端口错误统一判定', () => {
  it('四个工具的端口抛错一律 isError，且回带原因文本', async () => {
    const failure = async (): Promise<never> => {
      throw new Error('磁盘炸了')
    }
    const fakes = createFakes({ readText: failure, writeText: failure, list: failure }, failure)
    const tools = toolsOf(fakes)
    const cases: Array<[string, unknown]> = [
      ['read_file', { path: 'a.txt' }],
      ['write_file', { path: 'a.txt', content: 'x' }],
      ['list_dir', { path: '.' }],
      ['open_path', { target: 'D:\\x.yyy' }],
    ]
    for (const [name, input] of cases) {
      const result = await toolOf(tools, name).execute(input, ctx)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('磁盘炸了')
    }
  })
})
