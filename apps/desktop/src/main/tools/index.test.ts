import { describe, expect, it } from 'vitest'
import {
  ToolRegistry,
  effectiveWorkspaceDir,
  type AgentProviderFactory,
  type ClipboardPort,
  type CommandRunner,
  type FilePort,
  type ImageGenPort,
  type NotifyPort,
  type OpenPort,
  type SettingsToolPort,
  type SettingsWriteOutcome,
  type TodoItem,
  type TodoPort,
  type WebFetchPort,
} from '@aurora/agent-core'
import {
  COMPUTER_TOOL_NAMES,
  createDefaultSettings,
  createMemoryLogger,
  type Settings,
} from '@aurora/shared'
import {
  AGENT_CORE_TOOL_NAMES,
  EXTENSION_TOOL_NAMES,
  registerAgentCoreTools,
  registerComputerTools,
  registerExtensionTools,
  registerSettingsTool,
} from './index.js'

const HOME = 'C:\\Users\\tester'

/**
 * 当前装配器能**真正创建出来**的电脑操控工具（顺序照 `COMPUTER_TOOL_NAMES`）。
 *
 * 与 `COMPUTER_TOOL_NAMES`（v12 起 8 个名字）刻意区分开：常量是「对外承诺的工具名全集」，
 * 本列表是「`registerComputerTools` 眼下真的能造出来的子集」——v12 起 8 个全部交付
 * （`grep` / `glob` 由 step 3、`edit_file` 由 step 4），两者一致但**仍然显式列出**：
 * 新增工具时同步加名字，断言保持逐条精确（不用 `toContain` 这类弱断言）。
 */
const IMPLEMENTED_COMPUTER_TOOLS = [
  'run_command',
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'open_path',
  'grep',
  'glob',
] as const

function makeSettings(): Settings {
  return structuredClone(createDefaultSettings())
}

/** `set_setting` 的假端口：只记录调用，本文件验证的是"装配与摘除"，不是真实写盘 */
function fakeSettingsPort(): SettingsToolPort & { writes: unknown[][] } {
  const writes: unknown[][] = []
  return {
    writes,
    snapshot: () => ({}),
    read: () => undefined,
    writable: () => ({ ok: true }),
    async write(paths): Promise<SettingsWriteOutcome> {
      writes.push(paths)
      return { ok: true, message: 'ok', applied: paths.map((item) => item.path) }
    },
  }
}

/**
 * 不改真实文件系统：记录调用即可（本文件只验证"按开关注册哪些工具"与守卫的接线）。
 *
 * `wholeText` 是**整文件读**（`edit_file` 走的 `readWholeText`）返回的内容：守卫用例需要
 * 一段「读得到、也换得掉」的中性文本，而「按开关注册哪些工具」的用例不关心内容（缺省空串）。
 * 注意端口回带的绝对路径是 `C:\\abs\\<path>` 形式，因此守卫的键由**同一个 path 参数**决定
 * ——「读」与「改」必须用同一个 path，否则键对不上。
 */
function fakeFilePort(wholeText = ''): FilePort & {
  written: string[]
  searchRoots: string[]
  findRoots: string[]
} {
  const written: string[] = []
  // 「缺省工作目录三级回落」用例要看**端口实际收到的 root**（执行端证据，不是注册断言）
  const searchRoots: string[] = []
  const findRoots: string[] = []
  return {
    written,
    searchRoots,
    findRoots,
    async readText(path) {
      // 形状按 `ReadTextResult`：v12 起 `read_file` 走「行窗口」读，不再返回整篇 text
      return {
        absolutePath: `C:\\abs\\${path}`,
        lines: [{ number: 1, text: 'ok' }],
        totalLines: 1,
        truncated: false,
        bytes: 2,
        totalBytes: 2,
      }
    },
    async readWholeText(path) {
      // 行窗口读（`readText`）**之外**的独立入口，`refused: false` = 拿到了全文
      return {
        absolutePath: `C:\\abs\\${path}`,
        text: wholeText,
        bytes: wholeText.length,
        refused: false,
      }
    },
    async writeText(path, content) {
      written.push(content)
      return { absolutePath: `C:\\abs\\${path}`, bytes: 2 }
    },
    async list(path) {
      return { absolutePath: `C:\\abs\\${path}`, entries: [], truncated: false }
    },
    async findFiles(options) {
      findRoots.push(options.root)
      // 本文件只验证「按开关注册哪些工具」，搜索行为由 file-port.test.ts / search.test.ts 覆盖
      return {
        root: `C:\\abs\\${options.root}`,
        files: [],
        truncated: false,
        scannedFiles: 0,
        budgetExceeded: false,
      }
    },
    async searchText(options) {
      searchRoots.push(options.root)
      return {
        root: `C:\\abs\\${options.root}`,
        matches: [],
        truncated: false,
        scannedFiles: 0,
        skippedBinary: 0,
        budgetExceeded: false,
      }
    },
  }
}

function fakeOpenPort(): OpenPort {
  return { async open() {} }
}

function fakeRunner(stdout = 'AURORA_FAKE_OK'): CommandRunner & { calls: unknown[] } {
  const calls: unknown[] = []
  const runner = (async (request) => {
    calls.push(request)
    return {
      exitCode: 0,
      stdout,
      stderr: '',
      timedOut: false,
      aborted: false,
      durationMs: 7,
      cwd: request.cwd ?? HOME,
    }
  }) as CommandRunner & { calls: unknown[] }
  runner.calls = calls
  return runner
}

/** 内存版 TodoPort：只记录读写，本文件验证的是"装配接线"，不是落盘（见 todo-port.test.ts） */
function memoryTodoPort(): TodoPort & { data: Map<string, TodoItem[]> } {
  const data = new Map<string, TodoItem[]>()
  return {
    data,
    async read(sessionId) {
      return [...(data.get(sessionId) ?? [])]
    },
    async write(sessionId, todos) {
      data.set(sessionId, todos)
    },
  }
}

function setup(
  settings: Settings,
  runner: CommandRunner = fakeRunner(),
  files: FilePort = fakeFilePort(),
  projectRoot: () => string | undefined = () => undefined,
) {
  const tools = new ToolRegistry()
  const port = fakeSettingsPort()
  const registry = registerComputerTools({
    tools,
    getSettings: () => settings,
    logger: createMemoryLogger(),
    homeDir: () => HOME,
    projectRoot,
    // 与生产装配同一条回落链（会话级解析器在 session-project.ts；本 helper 不带会话绑定）
    sessionWorkspaceDir: () => effectiveWorkspaceDir(settings, projectRoot(), HOME),
    run: runner,
    files,
    open: fakeOpenPort(),
  })
  return { tools, registry, port }
}

describe('registerComputerTools', () => {
  it('全开时注册当前已实现的全部工具，顺序与 COMPUTER_TOOL_NAMES 一致', () => {
    const { tools, registry } = setup(makeSettings())
    // `sync()` 的返回值按 `COMPUTER_TOOL_NAMES` 顺序；`tools.list()` 是**注册顺序**
    // （open_path 归独立开关、在最后单独注册），两者顺序本就不同，这里比集合。
    // 真正面向模型的 tools 数组顺序由 step 6 的 `toLlmTools()` 统一排序。
    expect(registry.sync()).toEqual([...IMPLEMENTED_COMPUTER_TOOLS])
    expect([...tools.list().map((tool) => tool.name)].sort()).toEqual(
      [...IMPLEMENTED_COMPUTER_TOOLS].sort(),
    )
  })

  it('工具默认使用注入的主目录作为工作目录（空串 = 用户主目录）', async () => {
    const runner = fakeRunner()
    const { tools, registry } = setup(makeSettings(), runner)
    registry.sync()
    await tools.get('run_command')!.execute({ command: 'echo hi' }, { sessionId: 't' })
    expect((runner.calls[0] as { cwd?: string }).cwd).toBe(HOME)
  })

  it('会话绑定项目时缺省 cwd 按会话解析（两个会话各用各的根，docs/06 §5.1）', async () => {
    const runner = fakeRunner()
    const tools = new ToolRegistry()
    const roots: Record<string, string> = { s1: 'D:\\proj-a', s2: 'D:\\proj-b' }
    const registry = registerComputerTools({
      tools,
      getSettings: () => makeSettings(),
      logger: createMemoryLogger(),
      homeDir: () => HOME,
      projectRoot: () => undefined,
      // 与生产装配同款：按会话即时解析（getter 注入，杜绝「改绑定要重建工具」）
      sessionWorkspaceDir: (sessionId) =>
        (sessionId !== undefined ? roots[sessionId] : undefined) ?? HOME,
      run: runner,
      files: fakeFilePort(),
      open: fakeOpenPort(),
    })
    registry.sync()
    await tools.get('run_command')!.execute({ command: 'echo hi' }, { sessionId: 's1' })
    await tools.get('run_command')!.execute({ command: 'echo hi' }, { sessionId: 's2' })
    expect((runner.calls[0] as { cwd?: string }).cwd).toBe('D:\\proj-a')
    expect((runner.calls[1] as { cwd?: string }).cwd).toBe('D:\\proj-b')
  })

  it('总开关关闭时一个工具都不注册，且不影响其它工具（use_skill 仍在）', () => {
    const settings = makeSettings()
    settings.agent.tools.enabled = false
    const { tools, registry } = setup(settings)
    tools.register({
      name: 'use_skill',
      description: '占位',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return { content: '' }
      },
    })

    expect(registry.sync()).toEqual([])
    expect(tools.get('run_command')).toBeUndefined()
    expect(tools.get('read_file')).toBeUndefined()
    expect(tools.get('write_file')).toBeUndefined()
    expect(tools.get('edit_file')).toBeUndefined()
    expect(tools.get('list_dir')).toBeUndefined()
    expect(tools.get('open_path')).toBeUndefined()
    expect(tools.get('grep')).toBeUndefined()
    expect(tools.get('glob')).toBeUndefined()
    expect(tools.get('use_skill')).toBeDefined()
  })

  it('关掉终端 → run_command 消失，其余已实现工具仍注册', () => {
    const settings = makeSettings()
    settings.agent.tools.terminal.enabled = false
    const { tools, registry } = setup(settings)
    const names = registry.sync()
    expect(names).toEqual(IMPLEMENTED_COMPUTER_TOOLS.filter((name) => name !== 'run_command'))
    expect(names).not.toContain('run_command')
    expect(tools.get('run_command')).toBeUndefined()
  })

  it('关掉文件 → read/write/edit/list 消失但 open_path 还在', () => {
    const settings = makeSettings()
    settings.agent.tools.files.enabled = false
    const { tools, registry } = setup(settings)
    const names = registry.sync()
    // 文件类四个消失（open_path 归 `agent.tools.open` 开关，不受 files.enabled 影响）；
    // `edit_file` **不单独设开关**，与 read_file / write_file 同受这一个开关（docs/06 §11、docs/08 §1）
    expect(names).toEqual(
      IMPLEMENTED_COMPUTER_TOOLS.filter(
        (name) =>
          name !== 'read_file' &&
          name !== 'write_file' &&
          name !== 'edit_file' &&
          name !== 'list_dir',
      ),
    )
    expect(tools.get('read_file')).toBeUndefined()
    expect(tools.get('write_file')).toBeUndefined()
    expect(tools.get('edit_file')).toBeUndefined()
    expect(tools.get('list_dir')).toBeUndefined()
    expect(tools.get('open_path')).toBeDefined()
  })

  it('关掉文件检索 → grep / glob 消失，其余已实现工具仍注册', () => {
    const settings = makeSettings()
    settings.agent.tools.search.enabled = false
    const { tools, registry } = setup(settings)
    const names = registry.sync()
    expect(names).toEqual(
      IMPLEMENTED_COMPUTER_TOOLS.filter((name) => name !== 'grep' && name !== 'glob'),
    )
    expect(tools.get('grep')).toBeUndefined()
    expect(tools.get('glob')).toBeUndefined()
    expect(tools.get('run_command')).toBeDefined()
    expect(tools.get('read_file')).toBeDefined()
  })

  it('文件检索默认开启 → grep / glob 都在，且敏感级为 safe', () => {
    const settings = makeSettings()
    expect(settings.agent.tools.search.enabled).toBe(true)
    const { tools, registry } = setup(settings)
    expect(registry.sync()).toContain('grep')
    expect(registry.sync()).toContain('glob')
    expect(tools.get('grep')?.sensitivity).toBe('safe')
    expect(tools.get('glob')?.sensitivity).toBe('safe')
  })

  it('关掉文件检索后总开关再打开也不会把 grep / glob 带回来（开关相互独立）', () => {
    const settings = makeSettings()
    settings.agent.tools.search.enabled = false
    settings.agent.tools.enabled = false
    const { tools, registry } = setup(settings)
    registry.sync()
    settings.agent.tools.enabled = true
    registry.sync()
    expect(tools.get('grep')).toBeUndefined()
    expect(tools.get('glob')).toBeUndefined()
    expect(tools.get('run_command')).toBeDefined()
  })

  it('关掉「打开」→ open_path 消失，其余已实现工具仍在', () => {
    const settings = makeSettings()
    settings.agent.tools.open.enabled = false
    const { tools, registry } = setup(settings)
    const names = registry.sync()
    expect(names).toEqual(IMPLEMENTED_COMPUTER_TOOLS.filter((name) => name !== 'open_path'))
    expect(names).not.toContain('open_path')
    expect(tools.get('open_path')).toBeUndefined()
  })

  it('sync 幂等：连续两次结果一致，工具表长度不变（不重复注册）', () => {
    const { tools, registry } = setup(makeSettings())
    const first = registry.sync()
    const sizeAfterFirst = tools.list().length
    const second = registry.sync()
    expect(second).toEqual(first)
    expect(tools.list().length).toBe(sizeAfterFirst)
  })

  it('上限改完再 sync 立即生效（工具实例按新配置重建）', async () => {
    const settings = makeSettings()
    settings.agent.tools.terminal.maxOutputChars = 100_000
    const { tools, registry } = setup(settings, fakeRunner('x'.repeat(5_000)))
    registry.sync()

    const before = await tools.get('run_command')!.execute({ command: 'echo' }, { sessionId: 't' })
    expect(before.content).not.toContain('已截断')

    settings.agent.tools.terminal.maxOutputChars = 500
    registry.sync()

    const after = await tools.get('run_command')!.execute({ command: 'echo' }, { sessionId: 't' })
    expect(after.content).toContain('已截断')
  })

  it('文件工具默认开启 → edit_file 在表里，敏感级为 confirm（不单独设开关，确认卡片是它的安全边界）', () => {
    const settings = makeSettings()
    expect(settings.agent.tools.files.enabled).toBe(true)
    const { tools, registry } = setup(settings)
    expect(registry.sync()).toContain('edit_file')
    expect(tools.get('edit_file')?.sensitivity).toBe('confirm')
  })

  it('读前守卫跨 sync() 存活：读过的文件在工具重建后仍被 edit_file 放行', async () => {
    // 假端口的整文件读给一段「读得到、也换得掉」的中性文本
    const files = fakeFilePort('目标行\n')
    const { tools, registry } = setup(makeSettings(), fakeRunner(), files)
    registry.sync()
    const context = { sessionId: 'main' }
    // 「读」与「改」必须用**同一个 path**：守卫的键是端口回带的绝对路径（`C:\abs\<path>`），
    // 两处 path 不一致时键对不上，断言会假红
    const params = { path: 'C:\\work\\note.txt', oldString: '目标行', newString: '改过的行' }

    // ① 本会话没读过 → 守卫拒绝，且一个字都不写盘
    const blocked = await tools.get('edit_file')!.execute(params, context)
    expect(blocked.isError).toBe(true)
    expect(blocked.content).toContain('必须先')
    expect(files.written).toEqual([])

    // ② 用 read_file 真读一次（装配层把标记打在守卫上）
    const read = await tools.get('read_file')!.execute({ path: params.path }, context)
    expect(read.isError).toBeUndefined()

    // ③ 关键时序：`settings:changed` 会触发 `sync()` 重建全部工具实例
    //    —— 守卫若跟着重建，② 的标记就被清空，下一步会退化成 ①（用户看到的是「工具坏了」）
    registry.sync()

    // ④ 读记录仍在 → 放行到真正写盘
    const edited = await tools.get('edit_file')!.execute(params, context)
    expect(edited.isError).toBeUndefined()
    expect(edited.content).toContain('已修改')
    expect(files.written).toEqual(['改过的行\n'])
  })
})

describe('registerSettingsTool', () => {
  function setupSettings() {
    const tools = new ToolRegistry()
    const port = fakeSettingsPort()
    const registry = registerSettingsTool({ tools, port, logger: createMemoryLogger() })
    return { tools, registry, port }
  }

  it('注册 set_setting，且敏感级为 confirm（改配置必须过确认卡片）', () => {
    const { tools, registry } = setupSettings()
    expect(registry.sync()).toEqual(['set_setting'])
    expect(tools.get('set_setting')?.sensitivity).toBe('confirm')
  })

  it('sync 幂等：重复调用不会留下两个实例', () => {
    const { tools, registry } = setupSettings()
    registry.sync()
    const first = tools.get('set_setting')
    registry.sync()
    expect(tools.list().filter((tool) => tool.name === 'set_setting')).toHaveLength(1)
    // 重建是刻意的（工具闭包按当前配置取值），但名字与敏感级必须一致
    expect(tools.get('set_setting')?.sensitivity).toBe(first?.sensitivity)
  })

  it('不受 agent.tools.enabled 影响：总开关关掉后电脑操控工具全没了，set_setting 仍在', () => {
    const settings = makeSettings()
    const tools = new ToolRegistry()
    const port = fakeSettingsPort()
    const computerRegistry = registerComputerTools({
      tools,
      getSettings: () => settings,
      logger: createMemoryLogger(),
      homeDir: () => HOME,
      projectRoot: () => undefined,
      sessionWorkspaceDir: () => HOME,
      run: fakeRunner(),
      files: fakeFilePort(),
      open: fakeOpenPort(),
    })
    const settingsRegistry = registerSettingsTool({
      tools,
      port,
      logger: createMemoryLogger(),
    })

    computerRegistry.sync()
    settingsRegistry.sync()
    expect(tools.get('set_setting')).toBeDefined()

    settings.agent.tools.enabled = false
    computerRegistry.sync()
    settingsRegistry.sync()

    expect(COMPUTER_TOOL_NAMES.every((name) => tools.get(name) === undefined)).toBe(true)
    expect(tools.get('set_setting')).toBeDefined()
    expect(port.writes).toEqual([])
  })

  it('黑名单被清空也照样注册（「Schema 必须识别路径」这条兜底永远生效）', () => {
    // 装配本身不看 `advanced.readonlyPrefixes`：黑名单为空 ≠ 全部可写，
    // 端口侧还有 `canWriteSettingPath` 的「Schema 必须识别该路径」兜底。
    const { tools, registry } = setupSettings()
    expect(registry.sync()).toEqual(['set_setting'])
    expect(tools.get('set_setting')).toBeDefined()
  })
})

describe('registerExtensionTools', () => {
  function fakePorts() {
    return {
      webFetch: { fetch: async () => ({ status: 200, text: '' }) } as WebFetchPort,
      clipboard: { read: async () => '', write: async () => undefined } as ClipboardPort,
      notify: { show: async () => undefined } as NotifyPort,
      imageGen: { generate: async () => ({ filePath: 'C:\\g\\1.png' }) } as ImageGenPort,
    }
  }

  function setupExtension(tools = new ToolRegistry()) {
    const registry = registerExtensionTools({ tools, logger: createMemoryLogger(), ...fakePorts() })
    return { tools, registry }
  }

  it('注册扩展工具五件套，敏感级与文档一致（clipboard / generate_image = confirm）', () => {
    const { tools, registry } = setupExtension()
    expect(registry.sync()).toEqual([...EXTENSION_TOOL_NAMES])
    expect(tools.get('web_fetch')?.sensitivity).toBe('safe')
    expect(tools.get('notify_user')?.sensitivity).toBe('safe')
    expect(tools.get('clipboard_read')?.sensitivity).toBe('confirm')
    expect(tools.get('clipboard_write')?.sensitivity).toBe('confirm')
    expect(tools.get('generate_image')?.sensitivity).toBe('confirm')
  })

  it('不受 agent.tools.enabled 门控（与 set_setting 同级），且不影响其它工具', () => {
    const settings = makeSettings()
    settings.agent.tools.enabled = false
    const tools = new ToolRegistry()
    tools.register({
      name: 'use_skill',
      description: '占位',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return { content: '' }
      },
    })
    const computerRegistry = registerComputerTools({
      tools,
      getSettings: () => settings,
      logger: createMemoryLogger(),
      homeDir: () => HOME,
      projectRoot: () => undefined,
      sessionWorkspaceDir: () => HOME,
      run: fakeRunner(),
      files: fakeFilePort(),
      open: fakeOpenPort(),
    })
    const extensionRegistry = registerExtensionTools({
      tools,
      logger: createMemoryLogger(),
      ...fakePorts(),
    })

    computerRegistry.sync()
    extensionRegistry.sync()
    expect(COMPUTER_TOOL_NAMES.every((name) => tools.get(name) === undefined)).toBe(true)
    expect(EXTENSION_TOOL_NAMES.every((name) => tools.get(name) !== undefined)).toBe(true)
    expect(tools.get('use_skill')).toBeDefined()

    // 电脑操控开关回开后，扩展工具不被误摘
    settings.agent.tools.enabled = true
    computerRegistry.sync()
    extensionRegistry.sync()
    expect(EXTENSION_TOOL_NAMES.every((name) => tools.get(name) !== undefined)).toBe(true)
  })

  it('sync 幂等：重复调用不产生重复注册', () => {
    const { tools, registry } = setupExtension()
    registry.sync()
    const sizeAfterFirst = tools.list().length
    registry.sync()
    expect(tools.list().length).toBe(sizeAfterFirst)
    expect(tools.list().filter((tool) => tool.name === 'web_fetch')).toHaveLength(1)
  })
})

describe('registerAgentCoreTools', () => {
  function setupCore(tools = new ToolRegistry(), settings?: Settings) {
    const todoPort = memoryTodoPort()
    const registry = registerAgentCoreTools({
      tools,
      logger: createMemoryLogger(),
      todoPort,
      // create() 只在 task 执行时被调用，注册期不需要真实 provider
      provider: { create: () => undefined } satisfies AgentProviderFactory,
      // 不传 settings 时**不注入** `getSettings`：覆盖「未注入 = 按 confirm 档处理」的缺省路径
      ...(settings === undefined ? {} : { getSettings: () => settings }),
    })
    return { tools, registry, todoPort }
  }

  it('注册 todo_write / todo_read / task 三个工具，敏感级均为 safe', () => {
    const { tools, registry } = setupCore()
    expect(registry.sync()).toEqual([...AGENT_CORE_TOOL_NAMES])
    expect(tools.get('todo_write')?.sensitivity).toBe('safe')
    expect(tools.get('todo_read')?.sensitivity).toBe('safe')
    expect(tools.get('task')?.sensitivity).toBe('safe')
  })

  it('readonly 档摘掉 todo_write、保留 todo_read（落盘的那半边才是有系统副作用的）', () => {
    const settings = makeSettings()
    settings.agent.permissionMode = 'readonly'
    const { tools, registry } = setupCore(new ToolRegistry(), settings)

    // `todo_write` 的 sensitivity 是 `safe`，但它会往 <userData>/todos/<sid>.json 落盘 ——
    // 档位叫「只读」就必须真的没有系统副作用，否则口号是假的；
    // `todo_read` 只读文件、`task` 只派生上下文隔离的子代理（子代理的工具面从**父表**过滤）、
    // `ask_user` 只推一张问题卡片（不写盘、不执行命令，"危险"只是打扰用户），
    // 三者都不碰系统，照常注册。
    expect(registry.sync()).toEqual(['todo_read', 'task', 'ask_user'])
    expect(tools.get('todo_write')).toBeUndefined()
    expect(tools.get('todo_read')).toBeDefined()
    expect(tools.get('task')).toBeDefined()
  })

  it('未注入 getSettings 时按 confirm 档处理：todo_write 照常注册（缺省 = 三档之前的行为）', () => {
    const { tools, registry } = setupCore()
    expect(registry.sync()).toEqual([...AGENT_CORE_TOOL_NAMES])
    expect(tools.get('todo_write')).toBeDefined()
  })

  it('sync 幂等：unregister + 重建后三个工具仍在，且不重复注册', () => {
    const { tools, registry } = setupCore()
    registry.sync()
    const sizeAfterFirst = tools.list().length
    registry.sync()
    expect(tools.list().length).toBe(sizeAfterFirst)
    for (const name of AGENT_CORE_TOOL_NAMES) {
      expect(tools.list().filter((tool) => tool.name === name)).toHaveLength(1)
    }
  })

  it('todo 工具经注入的 TodoPort 读写（装配接线验证）', async () => {
    const { tools, registry, todoPort } = setupCore()
    registry.sync()
    const result = await tools
      .get('todo_write')!
      .execute({ todos: [{ content: '第一步', status: 'in_progress' }] }, { sessionId: 'main' })
    expect(result.isError).toBeUndefined()
    expect(todoPort.data.get('main')).toEqual([
      { id: 't1', content: '第一步', status: 'in_progress' },
    ])

    const read = await tools.get('todo_read')!.execute({}, { sessionId: 'main' })
    expect(read.content).toContain('第一步')
  })

  it('task 工具存在（父表含 confirm 敏感工具时照常注册；过滤细节在 agent-core task.test.ts）', () => {
    const tools = new ToolRegistry()
    tools.register({
      name: 'run_command',
      description: '假敏感工具占位',
      parameters: { type: 'object', properties: {} },
      sensitivity: 'confirm',
      async execute() {
        return { content: '' }
      },
    })
    const { registry } = setupCore(tools)
    expect(registry.sync()).toEqual([...AGENT_CORE_TOOL_NAMES])
    expect(tools.get('task')).toBeDefined()
    // 装配层不动父表：confirm 工具仍留给主代理
    expect(tools.get('run_command')?.sensitivity).toBe('confirm')
  })

  it('不受 agent.tools.enabled 门控（读配置只为判定 readonly 档，与 agent.tools.* 开关无关）', () => {
    const { tools, registry } = setupCore()
    expect(registry.sync()).toEqual([...AGENT_CORE_TOOL_NAMES])
    expect(AGENT_CORE_TOOL_NAMES.every((name) => tools.get(name) !== undefined)).toBe(true)
  })
})

/**
 * 只读档（`agent.permissionMode = 'readonly'`）的注册口径：**写 / 执行 / 有系统副作用的工具
 * 根本不注册**，而不是「注册好、调用时再拒绝」—— 模型在工具清单里看不到它们，
 * 就不会先答应用户、再在调用时报错。
 *
 * 接线与 `main/index.ts` 同款：三个装配器共用同一个工具表；`settings` 由 live getter 现读，
 * 因此「改档位 → 再 sync 立即生效」在这里能被直接断言。
 */
describe('readonly 档（只读 = 不进工具表）', () => {
  /** 只读档下**仍在表里**的电脑操控工具：8 个里只剩这 4 个（都是只读的） */
  const READONLY_COMPUTER_TOOLS = ['read_file', 'list_dir', 'grep', 'glob'] as const
  /** 只读档下**被摘掉**的：写 / 执行 / 有系统副作用 */
  const READONLY_BLOCKED_TOOLS = [
    'run_command',
    'write_file',
    'edit_file',
    'open_path',
    // `todo_write` 的 sensitivity 是 `safe`，但它往 <userData>/todos/<sid>.json 落盘
    'todo_write',
  ] as const

  function setupAll(settings = makeSettings()) {
    const tools = new ToolRegistry()
    const computer = registerComputerTools({
      tools,
      getSettings: () => settings,
      logger: createMemoryLogger(),
      homeDir: () => HOME,
      projectRoot: () => undefined,
      sessionWorkspaceDir: () => HOME,
      run: fakeRunner(),
      files: fakeFilePort(),
      open: fakeOpenPort(),
    })
    const core = registerAgentCoreTools({
      tools,
      logger: createMemoryLogger(),
      todoPort: memoryTodoPort(),
      provider: { create: () => undefined } satisfies AgentProviderFactory,
      getSettings: () => settings,
    })
    const settingsTool = registerSettingsTool({
      tools,
      port: fakeSettingsPort(),
      logger: createMemoryLogger(),
    })
    /** 三个装配器一起 sync，等价于 `main/index.ts` 的 `syncToolRegistries()` */
    const syncAll = (): string[] => [...computer.sync(), ...core.sync(), ...settingsTool.sync()]
    return { tools, computer, core, settingsTool, syncAll }
  }

  it('只注册只读清单里的工具：不含写 / 执行 / 有系统副作用的任何一个', () => {
    const settings = makeSettings()
    settings.agent.permissionMode = 'readonly'
    const { tools, syncAll } = setupAll(settings)

    // 顺序：`COMPUTER_TOOL_NAMES` 过滤后在前，`AGENT_CORE_TOOL_NAMES` 过滤后在后，
    // `set_setting` 最后（`task` / `ask_user` 也在表里：前者不碰系统、子代理的工具面执行时从这张
    // **已收窄的**父表过滤；后者只是问一句，见 registerAgentCoreTools 的注释）。
    expect(syncAll()).toEqual([
      ...READONLY_COMPUTER_TOOLS,
      'todo_read',
      'task',
      'ask_user',
      'set_setting',
    ])
    for (const name of READONLY_BLOCKED_TOOLS) {
      expect(tools.get(name)).toBeUndefined()
    }
    // 只读的那几个一个都不能少（否则「只读档」变成了「什么都干不了」）
    for (const name of ['read_file', 'list_dir', 'grep', 'glob', 'todo_read']) {
      expect(tools.get(name)).toBeDefined()
    }
  })

  it('readonly + 总开关关闭 → 电脑操控工具一个都不注册（既有第一条分支优先级更高）', () => {
    const settings = makeSettings()
    settings.agent.permissionMode = 'readonly'
    settings.agent.tools.enabled = false
    const { tools, computer, core } = setupAll(settings)

    expect(computer.sync()).toEqual([])
    expect(COMPUTER_TOOL_NAMES.every((name) => tools.get(name) === undefined)).toBe(true)
    // 总开关管的是 8 个电脑操控工具，不碰 Agent 内核工具（既有口径，与档位无关）
    expect(core.sync()).toEqual(['todo_read', 'task', 'ask_user'])
  })

  it('confirm 档注册集合与改动前完全一致（回归基线；档位显式钉住，别吃默认值）', () => {
    const settings = makeSettings()
    // 默认档 2026-09-29 起是 auto —— 本用例测的是 confirm 档的注册集合，
    // 因此显式切过去（镜像规则：两条一起写），不依赖出厂默认值
    settings.agent.permissionMode = 'confirm'
    settings.advanced.confirmSensitiveTools = true
    expect(settings.agent.permissionMode).toBe('confirm')
    const { tools, syncAll } = setupAll(settings)

    expect(syncAll()).toEqual([
      ...IMPLEMENTED_COMPUTER_TOOLS,
      ...AGENT_CORE_TOOL_NAMES,
      'set_setting',
    ])
    // 整张表逐条对齐：写类工具一个都没被档位逻辑误摘
    expect([...tools.list().map((tool) => tool.name)].sort()).toEqual(
      [...IMPLEMENTED_COMPUTER_TOOLS, ...AGENT_CORE_TOOL_NAMES, 'set_setting'].sort(),
    )
  })

  it('auto 档注册集合与 confirm 一致（注册层不看 confirm / auto 的差别）', () => {
    const settings = makeSettings()
    settings.agent.permissionMode = 'auto'
    const { syncAll } = setupAll(settings)

    expect(syncAll()).toEqual([
      ...IMPLEMENTED_COMPUTER_TOOLS,
      ...AGENT_CORE_TOOL_NAMES,
      'set_setting',
    ])
  })

  it('只读优先：advanced.confirmSensitiveTools = false 也放宽不了只读档', () => {
    const settings = makeSettings()
    settings.agent.permissionMode = 'readonly'
    settings.advanced.confirmSensitiveTools = false
    const { tools, syncAll } = setupAll(settings)

    expect(syncAll()).toEqual([
      ...READONLY_COMPUTER_TOOLS,
      'todo_read',
      'task',
      'ask_user',
      'set_setting',
    ])
    expect(tools.get('write_file')).toBeUndefined()
  })

  it('切换档位后 sync() 立即生效：切到 readonly 写类工具当场消失，切回来又回来', () => {
    const settings = makeSettings()
    const { tools, syncAll } = setupAll(settings)

    syncAll()
    for (const name of [...IMPLEMENTED_COMPUTER_TOOLS, 'todo_write']) {
      expect(tools.get(name)).toBeDefined()
    }

    // 用户在设置页改成「只读」→ `settings:changed` → 再 sync 一次（档位必须**现读**，不许缓存）
    settings.agent.permissionMode = 'readonly'
    expect(syncAll()).toEqual([
      ...READONLY_COMPUTER_TOOLS,
      'todo_read',
      'task',
      'ask_user',
      'set_setting',
    ])
    for (const name of READONLY_BLOCKED_TOOLS) {
      expect(tools.get(name)).toBeUndefined()
    }

    // 改回 confirm：工具表跟着放宽（这条反过来证明档位没有被装配时算死）
    settings.agent.permissionMode = 'confirm'
    syncAll()
    for (const name of IMPLEMENTED_COMPUTER_TOOLS) {
      expect(tools.get(name)).toBeDefined()
    }
    expect(tools.get('todo_write')).toBeDefined()
  })
})

/**
 * 缺省工作目录三级回落（docs/06 §5.1，2026-09 接线修复）：**当前项目根 > `agent.tools.workspaceDir` > 主目录**。
 *
 * 断言的是**端口实际收到的参数**（runner 的 `cwd`、file 端口的 `root`）—— 即"命令到底跑在哪 /
 * 检索到底扫哪"的执行端证据；判定端由 `agent-host.test.ts`「auto 档 + run_command 不带显式 cwd」
 * 用例钉住（同一"缺省=项目根"前提），两者配对构成「判定 ↔ 执行一致」的报障修复证明。
 * 无项目的两条用例同时锁定"行为与接线前逐字一致"。
 */
describe('缺省工作目录三级回落', () => {
  const PROJECT = 'C:\\proj-root'

  function withProject(workspaceDir: string): Settings {
    const settings = makeSettings()
    settings.projects.current = 'p'
    // list 里的 root 刻意与 getter 返回值**不同字**：若装配丢掉 `deps.projectRoot()`（第一级），
    // `effectiveWorkspaceDir` 的第②级会现查 list 拿到 `C:\list-root` —— 用例当场变红。
    // （第②级不做绝对化，生产侧绝对路径根只能来自 `resolveProject` 的 getter，2026-09 审查加固）
    settings.projects.list = [{ id: 'p', name: 'x', root: 'C:\\list-root' }]
    settings.agent.tools.workspaceDir = workspaceDir
    return settings
  }

  /** 装一遍工具并各执行一次**不传 cwd / path** 的调用，回传端口实际收到的目录 */
  async function defaultTargets(settings: Settings, projectRoot: () => string | undefined) {
    const runner = fakeRunner()
    const files = fakeFilePort()
    const { tools, registry } = setup(settings, runner, files, projectRoot)
    registry.sync()
    await tools.get('run_command')!.execute({ command: 'echo hi' }, { sessionId: 't' })
    await tools.get('grep')!.execute({ pattern: 'x' }, { sessionId: 't' })
    await tools.get('glob')!.execute({ pattern: 'x' }, { sessionId: 't' })
    return {
      cwd: (runner.calls[0] as { cwd?: string }).cwd,
      grepRoot: files.searchRoots[0],
      globRoot: files.findRoots[0],
    }
  }

  it('配了当前项目：缺省 cwd 与缺省搜索根都落项目根（报障现场的反面）', async () => {
    // 接线前这里看到的是 HOME —— 三级回落纯函数在生产代码零消费方，项目根从不参与
    const targets = await defaultTargets(withProject(''), () => PROJECT)
    expect(targets.cwd).toBe(PROJECT)
    expect(targets.grepRoot).toBe(PROJECT)
    expect(targets.globRoot).toBe(PROJECT)
  })

  it('项目根优先于 workspaceDir（第二级不得盖过第一级）', async () => {
    const targets = await defaultTargets(withProject('D:\\elsewhere'), () => PROJECT)
    expect(targets.cwd).toBe(PROJECT)
    expect(targets.grepRoot).toBe(PROJECT)
    expect(targets.globRoot).toBe(PROJECT)
  })

  it('无项目 + workspaceDir 空串：回落主目录（与接线前逐字一致）', async () => {
    const targets = await defaultTargets(makeSettings(), () => undefined)
    expect(targets.cwd).toBe(HOME)
    expect(targets.grepRoot).toBe(HOME)
    expect(targets.globRoot).toBe(HOME)
  })

  it('无项目 + 设了 workspaceDir：第二级直接生效（与接线前逐字一致）', async () => {
    const settings = makeSettings()
    settings.agent.tools.workspaceDir = 'D:\\ws'
    const targets = await defaultTargets(settings, () => undefined)
    expect(targets.cwd).toBe('D:\\ws')
    expect(targets.grepRoot).toBe('D:\\ws')
    expect(targets.globRoot).toBe('D:\\ws')
  })

  it('空白项目根（只有空格）视为无项目：按后续级别回落', async () => {
    // `effectiveWorkspaceDir` 的 normalize 只 trim；不新增"相对根"用例，因为生产侧
    // `resolveProject` 已把根归一成绝对路径，装配器拿不到相对根。
    const targets = await defaultTargets(makeSettings(), () => '  ')
    expect(targets.cwd).toBe(HOME)
    expect(targets.grepRoot).toBe(HOME)
    expect(targets.globRoot).toBe(HOME)
  })
})
