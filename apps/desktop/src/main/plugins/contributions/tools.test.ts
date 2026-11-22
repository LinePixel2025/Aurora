import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '@aurora/agent-core'
import { createDefaultSettings, createMemoryLogger, type Settings } from '@aurora/shared'
import type { PluginToolContribution } from '../manager.js'
import { registerPluginTools, type PluginToolsDeps } from './tools.js'

function contribution(
  pluginId: string,
  name: string,
  overrides: Partial<PluginToolContribution> = {},
): PluginToolContribution {
  return {
    pluginId,
    pluginName: pluginId,
    name,
    fullName: `plugin.${pluginId}.${name}`,
    description: `${pluginId}.${name}`,
    parameters: { type: 'object', properties: {} },
    sensitivity: 'confirm',
    readonly: false,
    ...overrides,
  }
}

function bulk(count: number): PluginToolContribution[] {
  return Array.from({ length: count }, (_, index) =>
    contribution('com.example.bulk', `t${String(index).padStart(2, '0')}`),
  )
}

/** 装配真实 `ToolRegistry` + 内存 logger，只把 manager 换成可变贡献表。 */
function setup(initial: PluginToolContribution[], settings: Settings = createDefaultSettings()) {
  const tools = new ToolRegistry()
  const logger = createMemoryLogger()
  let contributions = initial
  const deps: PluginToolsDeps = {
    tools,
    manager: {
      toolContributions: () => contributions,
      invokeTool: async () => ({ content: 'ok' }),
    },
    getSettings: () => settings,
    logger,
  }
  const registry = registerPluginTools(deps)
  const setContributions = (next: PluginToolContribution[]): void => {
    contributions = next
  }
  const pluginTools = (): string[] =>
    tools
      .toLlmTools()
      .map((tool) => tool.name)
      .filter((name) => name.startsWith('plugin.'))
  return { registry, logger, pluginTools, setContributions, settings }
}

describe('插件工具注册（docs/14 §3.1.1）', () => {
  it('未超限时全量注册，快照按名字排序', () => {
    const { registry, pluginTools } = setup([contribution('b', 'z'), contribution('a', 'm')])
    const snapshot = registry.sync()
    expect(snapshot.registered).toEqual(['plugin.a.m', 'plugin.b.z'])
    expect(snapshot.skipped).toEqual([])
    expect(pluginTools()).toEqual(['plugin.a.m', 'plugin.b.z'])
  })

  it('超过全局上限按名字截断：注册 64 个，第 65 个不注册', () => {
    const { registry, pluginTools } = setup(bulk(65))
    const snapshot = registry.sync()
    expect(snapshot.registered).toHaveLength(64)
    expect(snapshot.skipped).toEqual(['plugin.com.example.bulk.t64'])
    expect(pluginTools()).toHaveLength(64)
    expect(pluginTools()).not.toContain('plugin.com.example.bulk.t64')
  })

  it('只读档先过滤再计数：写工具不注册也不占名额', () => {
    const settings = createDefaultSettings()
    settings.agent.permissionMode = 'readonly'
    const { registry, pluginTools } = setup(
      [contribution('a', 'write_one'), contribution('a', 'read_one', { readonly: true })],
      settings,
    )
    const snapshot = registry.sync()
    expect(snapshot.registered).toEqual(['plugin.a.read_one'])
    expect(snapshot.skipped).toEqual([])
    expect(pluginTools()).toEqual(['plugin.a.read_one'])
  })

  it('插件总开关关闭时清空注册，快照为空', () => {
    const settings = createDefaultSettings()
    settings.plugins.enabled = false
    const { registry, pluginTools } = setup(bulk(2), settings)
    const snapshot = registry.sync()
    expect(snapshot).toEqual({ registered: [], skipped: [] })
    expect(pluginTools()).toEqual([])
  })

  it('截断警告只在跳过集合变化时出现一次；名额腾出后自动补注册', () => {
    const { registry, logger, pluginTools, setContributions } = setup(bulk(65))
    registry.sync()
    registry.sync()
    const warnings = (): string[] => logger.entries.filter((entry) => entry.startsWith('[warn]'))
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toContain('plugin.com.example.bulk.t64')
    expect(
      logger.entries.some(
        (entry) => entry.startsWith('[info]') && entry.includes('"registered":64'),
      ),
    ).toBe(true)

    setContributions(bulk(64))
    const recovered = registry.sync()
    expect(recovered.skipped).toEqual([])
    expect(pluginTools()).toHaveLength(64)
    // 集合变化（从「有跳过」回到「无跳过」）不再追加警告
    expect(warnings()).toHaveLength(1)
  })
})
