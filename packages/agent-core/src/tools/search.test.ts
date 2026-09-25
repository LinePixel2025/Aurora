/**
 * 搜索类工具的纯逻辑单测（docs/06 §11.5、§20）。
 *
 * 全部用内存假端口，**没有真实 IO**：递归遍历的真实实现在主进程
 * （`apps/desktop/src/main/tools/file-port.test.ts` 覆盖）。这里钉的是内核这一侧的口径：
 * 「参数非法不触碰端口」「结果文本逐字渲染」「三种尾部标注」「description 契约」。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SEARCH_MAX_RESULTS,
  MAX_MATCH_LINE_CHARS,
  MAX_SEARCH_MAX_RESULTS,
} from './files.js'
import type {
  FilePort,
  FindFilesOptions,
  FindFilesResult,
  SearchMatch,
  SearchTextOptions,
  SearchTextResult,
} from './files.js'
import { MAX_GLOB_LENGTH } from './globPattern.js'
import { createSearchTools, MAX_GREP_PATTERN_LENGTH } from './search.js'
import type { SearchToolOptions } from './search.js'
import type { ToolContext, ToolDefinition } from './registry.js'

const ctx: ToolContext = { sessionId: 'test-session' }

/** 端口回带的搜索根（**已是绝对路径**：解析在主进程，内核只把它渲染进「搜索根」行） */
const ROOT = 'D:\\work'
/** 装配层注入的缺省搜索根（对应 `agent.tools.workspaceDir`） */
const DEFAULT_ROOT = 'D:\\work'

interface FakeCalls {
  findFiles: FindFilesOptions[]
  searchText: SearchTextOptions[]
}

interface Fakes {
  files: FilePort
  calls: FakeCalls
}

/**
 * 内存假端口：只实现搜索两件事，其余方法**遇调用即抛错**
 * （内核走错端口的话用例立刻变红，比断言"没被调用"更早暴露问题）。
 */
function createFakes(): Fakes {
  const calls: FakeCalls = { findFiles: [], searchText: [] }
  const files: FilePort = {
    readText: async () => {
      throw new Error('内核不该调用 readText')
    },
    readWholeText: async () => {
      throw new Error('内核不该调用 readWholeText')
    },
    writeText: async () => {
      throw new Error('内核不该调用 writeText')
    },
    list: async () => {
      throw new Error('内核不该调用 list')
    },
    async findFiles(options) {
      calls.findFiles.push(options)
      return {
        root: options.root,
        files: [],
        truncated: false,
        scannedFiles: 0,
        budgetExceeded: false,
      }
    },
    async searchText(options) {
      calls.searchText.push(options)
      return {
        root: options.root,
        matches: [],
        truncated: false,
        scannedFiles: 0,
        skippedBinary: 0,
        budgetExceeded: false,
      }
    },
  }
  return { files, calls }
}

/** 造一份 `grep` 端口返回值：只关心命中与标注时用它（扫描数给中性值 12） */
function searchResult(
  matches: SearchMatch[],
  overrides: Partial<SearchTextResult> = {},
): SearchTextResult {
  return {
    root: ROOT,
    matches,
    truncated: false,
    scannedFiles: 12,
    skippedBinary: 0,
    budgetExceeded: false,
    ...overrides,
  }
}

/** 造一份 `glob` 端口返回值 */
function findResult(files: string[], overrides: Partial<FindFilesResult> = {}): FindFilesResult {
  return {
    root: ROOT,
    files,
    truncated: false,
    scannedFiles: files.length,
    budgetExceeded: false,
    ...overrides,
  }
}

/** 端口桩：把两个搜索方法替换成回带给定结果（同时记录内核传来的参数） */
function searchFakes(search?: SearchTextResult, found?: FindFilesResult): Fakes {
  const fakes = createFakes()
  if (search !== undefined) {
    fakes.files.searchText = async (options) => {
      fakes.calls.searchText.push(options)
      return search
    }
  }
  if (found !== undefined) {
    fakes.files.findFiles = async (options) => {
      fakes.calls.findFiles.push(options)
      return found
    }
  }
  return fakes
}

/** 组一份 2 工具（默认 maxResults = 200，搜索根缺省 `DEFAULT_ROOT`） */
function toolsOf(fakes: Fakes, options: Partial<SearchToolOptions> = {}): ToolDefinition[] {
  return createSearchTools({
    files: fakes.files,
    maxResults: options.maxResults ?? 200,
    defaultRoot: options.defaultRoot ?? DEFAULT_ROOT,
  })
}

function toolOf(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((tool) => tool.name === name)
  if (found === undefined) throw new Error(`工具不存在：${name}`)
  return found
}

describe('createSearchTools', () => {
  it('返回恰好 grep / glob 两个工具，都是 safe 且禁止额外字段', () => {
    const tools = toolsOf(createFakes())

    expect(tools.map((tool) => tool.name)).toEqual(['grep', 'glob'])
    expect(tools.map((tool) => tool.sensitivity)).toEqual(['safe', 'safe'])
    for (const tool of tools) {
      expect(tool.parameters.additionalProperties).toBe(false)
      expect(tool.parameters.type).toBe('object')
    }
    expect(toolOf(tools, 'grep').parameters.required).toEqual(['pattern'])
    expect(toolOf(tools, 'glob').parameters.required).toEqual(['pattern'])
    expect(toolOf(tools, 'glob').parameters.properties?.['limit']).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 200,
    })
  })

  it('maxResults 在工厂里钳到 1–MAX_SEARCH_MAX_RESULTS，两个工具共用同一个值', async () => {
    const huge = createFakes()
    const bigTools = toolsOf(huge, { maxResults: 99_999 })
    await toolOf(bigTools, 'grep').execute({ pattern: 'foo' }, ctx)
    await toolOf(bigTools, 'glob').execute({ pattern: '*.ts' }, ctx)
    expect(huge.calls.searchText.map((call) => call.maxResults)).toEqual([MAX_SEARCH_MAX_RESULTS])
    expect(huge.calls.findFiles.map((call) => call.maxResults)).toEqual([MAX_SEARCH_MAX_RESULTS])

    const zero = createFakes()
    await toolOf(toolsOf(zero, { maxResults: 0 }), 'grep').execute({ pattern: 'foo' }, ctx)
    expect(zero.calls.searchText.map((call) => call.maxResults)).toEqual([1])

    const broken = createFakes()
    await toolOf(toolsOf(broken, { maxResults: Number.NaN }), 'grep').execute(
      { pattern: 'foo' },
      ctx,
    )
    expect(broken.calls.searchText.map((call) => call.maxResults)).toEqual([
      DEFAULT_SEARCH_MAX_RESULTS,
    ])
  })
})

describe('grep 参数校验', () => {
  it('空 pattern / 非字符串 / 非法正则 / 超长一律 isError 且不触碰端口', async () => {
    const fakes = createFakes()
    const grep = toolOf(toolsOf(fakes), 'grep')

    const cases: Array<[unknown, string]> = [
      [{}, '缺少参数 pattern'],
      [null, '缺少参数 pattern'],
      [{ pattern: 42 }, '缺少参数 pattern'],
      [{ pattern: '   ' }, '缺少参数 pattern'],
      [{ pattern: '(' }, '正则不合法'],
      [{ pattern: 'a'.repeat(MAX_GREP_PATTERN_LENGTH + 1) }, '超长'],
    ]
    for (const [input, fragment] of cases) {
      const result = await grep.execute(input, ctx)
      expect(result.isError).toBe(true)
      expect(result.content).toContain(fragment)
    }
    expect(fakes.calls.searchText).toEqual([])
  })

  it('正则不合法时回带具体原因（端口仍不会被调用）', async () => {
    const fakes = createFakes()
    const grep = toolOf(toolsOf(fakes), 'grep')

    const result = await grep.execute({ pattern: 'a[' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content.startsWith('正则不合法：')).toBe(true)
    expect(result.summary).toBe('正则不合法')
    expect(fakes.calls.searchText).toEqual([])
  })

  it('path 缺省用 defaultRoot，显式传入时交给端口（pattern 与 include 原样透传）', async () => {
    const fakes = createFakes()
    const grep = toolOf(toolsOf(fakes), 'grep')

    await grep.execute({ pattern: 'foo' }, ctx)
    await grep.execute({ pattern: 'foo', path: '  D:\\other  ', include: '*.{ts,tsx}' }, ctx)

    expect(fakes.calls.searchText).toEqual([
      // 缺省根来自装配层注入的 defaultRoot；`include` 没传时**不带这个键**（端口按缺省不过滤处理）
      { root: DEFAULT_ROOT, pattern: 'foo', maxResults: 200 },
      { root: 'D:\\other', pattern: 'foo', maxResults: 200, include: '*.{ts,tsx}' },
    ])
  })

  it('include 超长（超 MAX_GLOB_LENGTH）→ isError 且不触碰端口；恰好等于上限则照常放行', async () => {
    const fakes = createFakes()
    const grep = toolOf(toolsOf(fakes), 'grep')

    const tooLong = await grep.execute(
      { pattern: 'foo', include: '*'.repeat(MAX_GLOB_LENGTH + 1) },
      ctx,
    )
    expect(tooLong.isError).toBe(true)
    // 与 pattern 的 200 字符上限对称：include 也是 glob 模式
    expect(tooLong.content).toContain('模式过长')
    expect(tooLong.content).toContain(String(MAX_GLOB_LENGTH))
    expect(tooLong.summary).toBe('include 参数超长')
    expect(fakes.calls.searchText).toEqual([])

    // 边界不放宽：恰好等于上限是合法的（否则 off-by-one 会把正常模式也拒掉）
    const atLimit = '*'.repeat(MAX_GLOB_LENGTH)
    const ok = await grep.execute({ pattern: 'foo', include: atLimit }, ctx)
    expect(ok.isError).toBeUndefined()
    expect(fakes.calls.searchText.map((call) => call.include)).toEqual([atLimit])
  })
})

describe('grep 正则嵌套无界量词静态过滤', () => {
  it('(a+)+$ / ^(\\s*[\\w-]+\\s*)+$ / (\\w+\\s+)+= / (a*)* / (x+){2,} → isError 且端口未被调用', async () => {
    const fakes = createFakes()
    const grep = toolOf(toolsOf(fakes), 'grep')

    const patterns = ['(a+)+$', '^(\\s*[\\w-]+\\s*)+$', '(\\w+\\s+)+=', '(a*)*', '(x+){2,}']
    for (const pattern of patterns) {
      const result = await grep.execute({ pattern }, ctx)
      expect(result.isError).toBe(true)
      // 文案要给出可操作的替换建议，不能只说「不行」
      expect(result.content).toContain('灾难性回溯')
      expect(result.content).toContain('避免在量词内部再用量词')
      expect(result.summary).toBe('正则含嵌套无界量词')
    }
    expect(fakes.calls.searchText).toEqual([])
  })

  it('(ab)+ / (a|b)+ / (a+) / (\\d{3})+ / a+ / .* / [a-z]* / ([*+])+ → 不因这条规则被拒（端口确实被调用）', async () => {
    const patterns = [
      '(ab)+',
      '(a|b)+',
      '(a+)',
      '(\\d{3})+',
      'a+',
      '.*',
      '[a-z]*',
      // 字符类里的 `*` / `+` 是字面字符，不是量词
      '([*+])+',
    ]
    for (const pattern of patterns) {
      const fakes = createFakes()
      const result = await toolOf(toolsOf(fakes), 'grep').execute({ pattern }, ctx)

      expect(result.isError).toBeUndefined()
      expect(fakes.calls.searchText.map((call) => call.pattern)).toEqual([pattern])
    }
  })

  it('只判「无界 × 无界」：外层有界（(a+){2}）放行，惰性无界（(a+)+?）仍拒绝', async () => {
    const bounded = createFakes()
    const boundedResult = await toolOf(toolsOf(bounded), 'grep').execute(
      { pattern: '(a+){2}' },
      ctx,
    )
    expect(boundedResult.isError).toBeUndefined()
    expect(bounded.calls.searchText).toHaveLength(1)

    const lazy = createFakes()
    const lazyResult = await toolOf(toolsOf(lazy), 'grep').execute({ pattern: '(a+)+?' }, ctx)
    expect(lazyResult.isError).toBe(true)
    expect(lazy.calls.searchText).toEqual([])
  })
})

describe('grep 结果渲染', () => {
  it('命中行渲染成「路径:行号: 内容」，头部回带绝对搜索根与计数（逐字断言）', async () => {
    const fakes = searchFakes(
      searchResult(
        [
          { path: 'src/a.ts', line: 3, text: 'const foo = 1' },
          { path: 'src/b.ts', line: 9, text: 'foo()' },
        ],
        { scannedFiles: 42 },
      ),
    )

    const result = await toolOf(toolsOf(fakes), 'grep').execute({ pattern: 'foo' }, ctx)

    expect(result.isError).toBeUndefined()
    expect(result.content).toBe(
      '搜索根：D:\\work（匹配 2 处，已扫描 42 个文件）\n\nsrc/a.ts:3: const foo = 1\nsrc/b.ts:9: foo()',
    )
    expect(result.summary).toBe('找到 2 处匹配')
  })

  it('同一行多次命中只输出一条（端口按行去重，内核不展开也不重复计数）', async () => {
    const fakes = searchFakes(searchResult([{ path: 'src/a.ts', line: 3, text: 'foo foo foo' }]))

    const result = await toolOf(toolsOf(fakes), 'grep').execute({ pattern: 'foo' }, ctx)

    expect(result.content).toContain('（匹配 1 处，已扫描 12 个文件）')
    const hit = result.content.split('\n').filter((line) => line === 'src/a.ts:3: foo foo foo')
    expect(hit).toHaveLength(1)
  })

  it('命中行超长时截断并标注，行首空白原样保留（截断判断用 trim 后的长度）', async () => {
    const indented = '    const a = 1'
    const over = 'z'.repeat(MAX_MATCH_LINE_CHARS + 1)
    // 前后都是空白、真正的字符只有一个：按 trim 后的长度算，**不该**被截断
    const padded = `${' '.repeat(MAX_MATCH_LINE_CHARS)}x`
    const fakes = searchFakes(
      searchResult([
        { path: 'a.ts', line: 1, text: indented },
        { path: 'a.ts', line: 2, text: over },
        { path: 'a.ts', line: 3, text: padded },
      ]),
    )

    const result = await toolOf(toolsOf(fakes), 'grep').execute({ pattern: 'foo' }, ctx)

    expect(result.content).toContain('a.ts:1:     const a = 1')
    expect(result.content).toContain(
      `a.ts:2: ${'z'.repeat(MAX_MATCH_LINE_CHARS)}…（本行超长已截断）…`,
    )
    expect(result.content.split('\n')).toContain(`a.ts:3: ${padded}`)
  })

  it('无命中不是错误，回带未找到匹配的说明', async () => {
    const fakes = searchFakes(searchResult([], { scannedFiles: 5 }))

    const result = await toolOf(toolsOf(fakes), 'grep').execute({ pattern: 'foo' }, ctx)

    expect(result.isError).toBeUndefined()
    expect(result.content).toBe(
      '搜索根：D:\\work（匹配 0 处，已扫描 5 个文件）\n\n未找到匹配「foo」的内容。',
    )
    expect(result.summary).toBe('未找到匹配')
  })
})

describe('grep 尾部标注', () => {
  it('结果达上限时标注 truncated 并提示缩小 pattern / include', async () => {
    const fakes = searchFakes(
      searchResult([{ path: 'a.ts', line: 1, text: 'foo' }], { truncated: true, scannedFiles: 7 }),
    )

    const result = await toolOf(toolsOf(fakes), 'grep').execute({ pattern: 'foo' }, ctx)

    expect(result.content).toContain('a.ts:1: foo')
    expect(result.content).toContain(
      '…（结果已达上限 200 条，可能还有更多；请缩小 pattern 或 include）…',
    )
  })

  it('搜索预算用完时标注 budgetExceeded 与已扫描文件数', async () => {
    const fakes = searchFakes(
      searchResult([{ path: 'a.ts', line: 1, text: 'foo' }], {
        budgetExceeded: true,
        scannedFiles: 20_000,
      }),
    )

    const result = await toolOf(toolsOf(fakes), 'grep').execute({ pattern: 'foo' }, ctx)

    expect(result.content).toContain('…（搜索预算已用完，仅扫描了 20000 个文件，结果可能不完整）…')
  })

  it('跳过二进制文件时回带跳过数量', async () => {
    const fakes = searchFakes(
      searchResult([{ path: 'a.ts', line: 1, text: 'foo' }], { skippedBinary: 3 }),
    )

    const result = await toolOf(toolsOf(fakes), 'grep').execute({ pattern: 'foo' }, ctx)

    expect(result.content).toContain('（已跳过 3 个二进制文件）')
  })
})

describe('glob', () => {
  it('命中文件渲染成一行一个相对路径，头部回带绝对搜索根与计数（逐字断言）', async () => {
    const fakes = searchFakes(undefined, findResult(['src/a.ts', 'src/b.ts'], { scannedFiles: 9 }))

    const result = await toolOf(toolsOf(fakes), 'glob').execute({ pattern: '**/*.ts' }, ctx)

    expect(result.isError).toBeUndefined()
    expect(result.content).toBe('搜索根：D:\\work（匹配 2 个文件）\n\nsrc/a.ts\nsrc/b.ts')
    expect(result.summary).toBe('找到 2 个文件')
    expect(fakes.calls.findFiles).toEqual([
      { root: DEFAULT_ROOT, pattern: '**/*.ts', maxResults: 200 },
    ])
  })

  it('空 pattern / 超长 / 花括号不配对一律 isError 且不触碰端口', async () => {
    const fakes = createFakes()
    const glob = toolOf(toolsOf(fakes), 'glob')

    const cases: Array<[unknown, string]> = [
      [{}, '缺少参数 pattern'],
      [{ pattern: 'a{b' }, '花括号不配对'],
      [{ pattern: 'a'.repeat(MAX_GLOB_LENGTH + 1) }, '超长'],
    ]
    for (const [input, fragment] of cases) {
      const result = await glob.execute(input, ctx)
      expect(result.isError).toBe(true)
      expect(result.content).toContain(fragment)
    }
    expect(fakes.calls.findFiles).toEqual([])
  })

  it('limit 钳到 1–maxResults：缺省与超上限都取 maxResults，0 / 负数钳到 1', async () => {
    const fakes = createFakes()
    const glob = toolOf(toolsOf(fakes, { maxResults: 50 }), 'glob')

    await glob.execute({ pattern: '*.ts' }, ctx)
    await glob.execute({ pattern: '*.ts', limit: 10_000 }, ctx)
    await glob.execute({ pattern: '*.ts', limit: -1 }, ctx)
    await glob.execute({ pattern: '*.ts', limit: 3.9 }, ctx)

    expect(fakes.calls.findFiles.map((call) => call.maxResults)).toEqual([50, 50, 1, 3])
  })

  it('limit 非数字时报错且不触碰端口', async () => {
    const fakes = createFakes()
    const glob = toolOf(toolsOf(fakes, { maxResults: 50 }), 'glob')

    const result = await glob.execute({ pattern: '*.ts', limit: 'many' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('参数 limit 必须是数字')
    expect(fakes.calls.findFiles).toEqual([])
  })

  it('无命中不是错误，回带未找到匹配的文件说明', async () => {
    const fakes = searchFakes(undefined, findResult([]))

    const result = await toolOf(toolsOf(fakes), 'glob').execute({ pattern: '**/*.rs' }, ctx)

    expect(result.isError).toBeUndefined()
    expect(result.content).toBe(
      '搜索根：D:\\work（匹配 0 个文件）\n\n未找到匹配「**/*.rs」的文件。',
    )
    expect(result.summary).toBe('未找到匹配')
  })

  it('达上限时标注 truncated 并回带本次生效的 limit', async () => {
    const fakes = searchFakes(undefined, findResult(['a.ts'], { truncated: true, scannedFiles: 5 }))

    const result = await toolOf(toolsOf(fakes), 'glob').execute(
      { pattern: '**/*.ts', limit: 5 },
      ctx,
    )

    expect(result.content).toContain('a.ts')
    expect(result.content).toContain('…（已达上限 5 个，可能还有更多）…')
  })

  it('遍历预算触顶时同样如实标注（结果是稳定前缀，不能当完整）', async () => {
    const fakes = searchFakes(
      undefined,
      findResult(['a.ts'], { budgetExceeded: true, scannedFiles: 20_000 }),
    )

    const result = await toolOf(toolsOf(fakes), 'glob').execute({ pattern: '**/*.ts' }, ctx)

    expect(result.content).toContain('a.ts')
    expect(result.content).toContain('…（搜索预算已用完，仅扫描了 20000 个文件，结果可能不完整）…')
  })
})

describe('端口错误统一判定', () => {
  it('搜索端口抛错时折成 isError，异常不冒泡', async () => {
    const failing = async (): Promise<never> => {
      throw new Error('遍历炸了')
    }
    const fakes = createFakes()
    fakes.files.searchText = failing
    fakes.files.findFiles = failing
    const tools = toolsOf(fakes)

    const grepResult = await toolOf(tools, 'grep').execute({ pattern: 'foo' }, ctx)
    const globResult = await toolOf(tools, 'glob').execute({ pattern: '**/*.ts' }, ctx)

    expect(grepResult.isError).toBe(true)
    expect(grepResult.content).toBe('搜索失败：遍历炸了')
    expect(globResult.isError).toBe(true)
    expect(globResult.content).toBe('查找文件失败：遍历炸了')
  })
})

describe('description 契约（§20）', () => {
  it('grep 说清正则检索 / 路径与行号 / include 模式 / 跳过目录，且不承诺计数', () => {
    const grep = toolOf(toolsOf(createFakes()), 'grep')

    expect(grep.description).toContain('正则')
    expect(grep.description).toContain('文件路径 + 行号 + 命中行')
    expect(grep.description).toContain('include')
    expect(grep.description).toContain('*.js')
    expect(grep.description).toContain('*.{ts,tsx}')
    expect(grep.description).toContain('node_modules')
    expect(grep.description).toContain('.git')
    expect(grep.description).toContain('只读工具，不弹确认')
    // 对照表的不采纳结论：不承诺计数能力，要统计改用逐次确认的 run_command
    expect(grep.description).toContain('不提供计数功能')
    expect(grep.description).toContain('run_command')
  })

  it('glob 说清模式语法 / 只回路径不回内容 / 找内容用 grep', () => {
    const glob = toolOf(toolsOf(createFakes()), 'glob')

    expect(glob.description).toContain('**/*.js')
    expect(glob.description).toContain('src/**/*.ts')
    expect(glob.description).toContain('{a,b}')
    expect(glob.description).toContain('?')
    expect(glob.description).toContain('只回路径、不回内容')
    expect(glob.description).toContain('grep')
    expect(glob.description).toContain('node_modules')
    expect(glob.description).toContain('.git')
  })
})
