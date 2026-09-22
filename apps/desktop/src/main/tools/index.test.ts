import { describe, expect, it } from 'vitest'
import {
  ToolRegistry,
  type CommandRunner,
  type FilePort,
  type OpenPort,
  type SettingsToolPort,
  type SettingsWriteOutcome,
} from '@aurora/agent-core'
import {
  COMPUTER_TOOL_NAMES,
  createDefaultSettings,
  createMemoryLogger,
  type Settings,
} from '@aurora/shared'
import { registerComputerTools, registerSettingsTool } from './index.js'

const HOME = 'C:\\Users\\tester'

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
    settingsPort: port,
  })
  return { tools, registry, port }
}

describe('registerComputerTools', () => {
  it('全开时注册全部 5 个工具，顺序与 COMPUTER_TOOL_NAMES 一致', () => {
    const { tools, registry } = setup(makeSettings())
    expect(registry.sync()).toEqual([...COMPUTER_TOOL_NAMES])
    expect(tools.list().map((tool) => tool.name)).toEqual([...COMPUTER_TOOL_NAMES])
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

  it('关掉终端 → 只剩 4 个，run_command 消失', () => {
    const settings = makeSettings()
    settings.agent.tools.terminal.enabled = false
    const { tools, registry } = setup(settings)
    const names = registry.sync()
    expect(names).toHaveLength(4)
    expect(names).not.toContain('run_command')
    expect(tools.get('run_command')).toBeUndefined()
  })

  it('关掉文件 → read/write/list 消失但 open_path 还在', () => {
    const settings = makeSettings()
    settings.agent.tools.files.enabled = false
    const { tools, registry } = setup(settings)
    const names = registry.sync()
    expect(names).toEqual(['run_command', 'open_path'])
    expect(tools.get('read_file')).toBeUndefined()
    expect(tools.get('write_file')).toBeUndefined()
    expect(tools.get('list_dir')).toBeUndefined()
    expect(tools.get('open_path')).toBeDefined()
  })

  it('关掉「打开」→ open_path 消失，其余 4 个还在', () => {
    const settings = makeSettings()
    settings.agent.tools.open.enabled = false
    const { tools, registry } = setup(settings)
    const names = registry.sync()
    expect(names).toHaveLength(4)
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
      settingsPort: port,
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
