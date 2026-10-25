import { describe, expect, it, vi } from 'vitest'
import type { PluginManager } from './manager.js'
import { readPluginPanelData } from './panel-data.js'

const STATIC_SCHEMA = { version: 1, nodes: [{ type: 'text', text: '静态' }] }

function managerOf(options: {
  kind: 'schema' | 'page'
  staticSchema?: string
  invoke?: () => Promise<Record<string, unknown>>
}): PluginManager {
  return {
    get: () => ({
      panels: [{ id: 'board', kind: options.kind }],
    }),
    panelSchemaFile: async () => options.staticSchema,
    invokePanel: options.invoke ?? (async () => ({})),
  } as unknown as PluginManager
}

describe('readPluginPanelData · 桌面 IPC 与 Center 中继共用（docs/12 §6.5）', () => {
  it('声明式面板：静态 schema + 动态覆盖，并把 params / values 透传给插件', async () => {
    const invoke = vi.fn(async () => ({ schema: { version: 1, nodes: [] }, toast: '好' }))
    const result = await readPluginPanelData(
      managerOf({ kind: 'schema', staticSchema: JSON.stringify(STATIC_SCHEMA), invoke }),
      {
        pluginId: 'com.example.hello',
        panelId: 'board',
        method: 'submit',
        params: { a: 1 },
        values: { name: 'x' },
      },
    )
    expect(invoke).toHaveBeenCalledWith('com.example.hello', 'board', 'submit', {
      params: { a: 1 },
      values: { name: 'x' },
    })
    expect(result).toEqual({ schema: { version: 1, nodes: [] }, toast: '好' })
  })

  it('插件调用失败时回落静态 schema（面板不至于整块打不开）', async () => {
    const result = await readPluginPanelData(
      managerOf({
        kind: 'schema',
        staticSchema: JSON.stringify(STATIC_SCHEMA),
        invoke: async () => {
          throw new Error('boom')
        },
      }),
      { pluginId: 'com.example.hello', panelId: 'board' },
    )
    expect(result).toEqual({ schema: STATIC_SCHEMA })
  })

  it('既没有静态 schema 又调用失败：整条抛错（不返回空面板）', async () => {
    await expect(
      readPluginPanelData(
        managerOf({
          kind: 'schema',
          invoke: async () => {
            throw new Error('boom')
          },
        }),
        { pluginId: 'com.example.hello', panelId: 'board' },
      ),
    ).rejects.toThrow('boom')
  })

  it('页面型面板：默认拒绝（桌面 IPC 走 plugins:pageRpc），中继放行并返回原始结果', async () => {
    const manager = managerOf({
      kind: 'page',
      invoke: async () => ({ data: { count: 2 }, toast: 'ok' }),
    })
    await expect(
      readPluginPanelData(manager, { pluginId: 'com.example.hello', panelId: 'board' }),
    ).rejects.toThrow('页面型面板请通过插件页面打开')

    await expect(
      readPluginPanelData(
        manager,
        { pluginId: 'com.example.hello', panelId: 'board', method: 'status' },
        { allowPage: true },
      ),
    ).resolves.toEqual({ data: { data: { count: 2 }, toast: 'ok' } })
  })

  it('缺少 id / 面板不存在时抛错', async () => {
    const manager = managerOf({ kind: 'schema' })
    await expect(readPluginPanelData(manager, { pluginId: '', panelId: 'board' })).rejects.toThrow(
      '缺少插件或面板 id',
    )
    await expect(
      readPluginPanelData(manager, { pluginId: 'com.example.hello', panelId: 'ghost' }),
    ).rejects.toThrow('插件面板不存在')
  })
})
