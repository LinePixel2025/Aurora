/**
 * 文件与「打开」类工具的纯逻辑单测（docs/06 §11）。
 *
 * 全部用内存假端口，**没有真实 IO**：真实系统调用由主进程端口承担
 * （`apps/desktop/src/main/tools/file-port.test.ts`）。
 */
import { describe, expect, it } from 'vitest'
import { COMPUTER_TOOL_NAMES } from '@aurora/shared'
import { createFileTools, createOpenTool } from './files.js'
import type { DirEntry, FilePort, FileToolOptions, OpenPort } from './files.js'
import type { ToolContext, ToolDefinition } from './registry.js'

const ctx: ToolContext = { sessionId: 'test-session' }

const CWD = 'D:\\work'

/** 端口回带的条目（内核负责渲染成 `[DIR]` / `[FILE]` 行） */
const SAMPLE_ENTRIES: DirEntry[] = [
  { name: 'docs', type: 'dir', modifiedAt: '2026-09-20T17:10:00' },
  { name: 'note.txt', type: 'file', sizeBytes: 1234, modifiedAt: '2026-09-20T17:10:00' },
]

interface FakeCalls {
  readText: Array<{ path: string; maxBytes: number }>
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
    async readText(path, maxBytes) {
      calls.readText.push({ path, maxBytes })
      return { absolutePath: `${CWD}\\${path}`, text: '正文', truncated: false, bytes: 6 }
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

    const sent = fakes.calls.readText.map((call) => call.maxBytes)
    expect(sent).toEqual([8_192, 1_024, 8_192, 2_048])
    expect(fakes.calls.readText.every((call) => call.path === 'a.txt')).toBe(true)
  })

  it('maxBytes 非数字时报错且不触碰端口', async () => {
    const fakes = createFakes()
    const read = toolOf(toolsOf(fakes, { maxReadBytes: 8_192 }), 'read_file')

    const result = await read.execute({ path: 'a.txt', maxBytes: 'big' }, ctx)
    expect(result.isError).toBe(true)
    expect(fakes.calls.readText).toEqual([])
  })

  it('成功时回带绝对路径头与正文，截断时尾部标注', async () => {
    const fakes = createFakes({
      readText: async () => ({
        absolutePath: 'D:\\work\\a.txt',
        text: 'AAA',
        truncated: true,
        bytes: 1_024,
      }),
    })
    const read = toolOf(toolsOf(fakes), 'read_file')

    const result = await read.execute({ path: 'a.txt' }, ctx)
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('文件：D:\\work\\a.txt（1024 字节）')
    expect(result.content).toContain('AAA')
    expect(result.content).toContain('…（已按 maxBytes 截断）…')
  })

  it('端口抛错时回带 isError 与原因', async () => {
    const fakes = createFakes({
      readText: async () => {
        throw new Error('这是二进制文件，无法按文本读取')
      },
    })
    const read = toolOf(toolsOf(fakes), 'read_file')

    const result = await read.execute({ path: 'a.bin' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('这是二进制文件')
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
