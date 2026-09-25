import { describe, expect, it } from 'vitest'
import {
  ToolRegistry,
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
 * 本列表是「`registerComputerTools` 眼下真的能造出来的子集」——`grep` / `glob` 由 step 3、
 * `edit_file` 由 step 4 交付，在那之前它们不在注册结果里。显式列出而不写死长度：
 * 新增工具时同步加名字，断言仍逐条精确（不用 `toContain` 这类弱断言）。
 */
const IMPLEMENTED_COMPUTER_TOOLS = [
  'run_command',
  'read_file',
  'write_file',
  'list_dir',
  'open_path',
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

/** 不改真实文件系统：记录调用即可（本文件只验证"按开关注册哪些工具"） */
function fakeFilePort(): FilePort {
  return {
    async readText(path) {
      return { absolutePath: `C:\\abs\\${path}`, text: 'ok', truncated: false, bytes: 2 }
    },
    async writeText(path) {
      return { absolutePath: `C:\\abs\\${path}`, bytes: 2 }
    },
    async list(path) {
      return { absolutePath: `C:\\abs\\${path}`, entries: [], truncated: false }
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

function setup(settings: Settings, runner: CommandRunner = fakeRunner()) {
  const tools = new ToolRegistry()
  const port = fakeSettingsPort()
  const registry = registerComputerTools({
    tools,
    getSettings: () => settings,
    logger: createMemoryLogger(),
    homeDir: () => HOME,
    run: runner,
    files: fakeFilePort(),
    open: fakeOpenPort(),
  })
  return { tools, registry, port }
}

describe('registerComputerTools', () => {
  it('全开时注册当前已实现的全部工具，顺序与 COMPUTER_TOOL_NAMES 一致', () => {
    const { tools, registry } = setup(makeSettings())
    expect(registry.sync()).toEqual([...IMPLEMENTED_COMPUTER_TOOLS])
    expect(tools.list().map((tool) => tool.name)).toEqual([...IMPLEMENTED_COMPUTER_TOOLS])
  })

  it('工具默认使用注入的主目录作为工作目录（空串 = 用户主目录）', async () => {
    const runner = fakeRunner()
    const { tools, registry } = setup(makeSettings(), runner)
    registry.sync()
    await tools.get('run_command')!.execute({ command: 'echo hi' }, { sessionId: 't' })
    expect((runner.calls[0] as { cwd?: string }).cwd).toBe(HOME)
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
    expect(tools.get('list_dir')).toBeUndefined()
    expect(tools.get('open_path')).toBeUndefined()
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

  it('关掉文件 → read/write/list 消失但 open_path 还在', () => {
    const settings = makeSettings()
    settings.agent.tools.files.enabled = false
    const { tools, registry } = setup(settings)
    const names = registry.sync()
    // 文件类三件消失（open_path 归 `agent.tools.open` 开关，不受 files.enabled 影响）
    expect(names).toEqual(
      IMPLEMENTED_COMPUTER_TOOLS.filter(
        (name) => name !== 'read_file' && name !== 'write_file' && name !== 'list_dir',
      ),
    )
    expect(tools.get('read_file')).toBeUndefined()
    expect(tools.get('write_file')).toBeUndefined()
    expect(tools.get('list_dir')).toBeUndefined()
    expect(tools.get('open_path')).toBeDefined()
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

  function setupCore(tools = new ToolRegistry()) {
    const todoPort = memoryTodoPort()
    const registry = registerAgentCoreTools({
      tools,
      logger: createMemoryLogger(),
      todoPort,
      // create() 只在 task 执行时被调用，注册期不需要真实 provider
      provider: { create: () => undefined } satisfies AgentProviderFactory,
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

  it('不受 agent.tools.enabled 门控（装配器没有配置依赖，与 set_setting / 扩展工具同级）', () => {
    const { tools, registry } = setupCore()
    expect(registry.sync()).toEqual([...AGENT_CORE_TOOL_NAMES])
    expect(AGENT_CORE_TOOL_NAMES.every((name) => tools.get(name) !== undefined)).toBe(true)
  })
})
