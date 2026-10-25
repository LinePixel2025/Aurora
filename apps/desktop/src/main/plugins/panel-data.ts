/**
 * 插件面板数据加载（桌面 IPC `plugins:panelData` 与 Center 中继共用，docs/12 §6.5）。
 *
 * 声明式面板：静态 schema + `invokePanel` 动态覆盖，调用失败时回落静态 schema
 * （面板不至于整块打不开）；页面型面板：直接返回 `invokePanel` 的完整结果，
 * 由页面自己的 `window.auroraPlugin.request` 约定取用。
 */
import type { PluginPanelSchema, PluginPanelDataResult } from '@aurora/shared'
import type { PluginManager } from './manager.js'

export interface PluginPanelDataInput {
  pluginId: string
  panelId: string
  method?: string
  params?: unknown
  values?: Record<string, unknown>
}

/** 页面型面板的 `data` 是插件返回值本体（含 `data` / `toast` / `message` / `error`） */
export interface PluginPanelPayload extends PluginPanelDataResult {
  data?: unknown
}

export async function readPluginPanelData(
  plugins: PluginManager,
  input: PluginPanelDataInput,
  options?: { allowPage?: boolean },
): Promise<PluginPanelPayload> {
  const pluginId = typeof input.pluginId === 'string' ? input.pluginId : ''
  const panelId = typeof input.panelId === 'string' ? input.panelId : ''
  if (pluginId === '' || panelId === '') throw new Error('缺少插件或面板 id')
  const panel = plugins.get(pluginId)?.panels.find((item) => item.id === panelId)
  if (panel === undefined) throw new Error('插件面板不存在')

  if (panel.kind === 'page') {
    // 桌面 IPC 的既有口径不变：页面型面板只走 `plugins:pageRpc`；Center 中继才放行
    if (options?.allowPage !== true) throw new Error('页面型面板请通过插件页面打开')
    const result = await plugins.invokePanel(pluginId, panelId, input.method ?? 'refresh', {
      params: input.params,
      values: input.values ?? {},
    })
    return { data: result }
  }

  let schema: PluginPanelSchema | undefined
  const file = await plugins.panelSchemaFile(pluginId, panelId)
  if (file !== undefined) schema = JSON.parse(file) as PluginPanelSchema
  try {
    const result = await plugins.invokePanel(pluginId, panelId, input.method ?? 'refresh', {
      params: input.params,
      values: input.values ?? {},
    })
    if (result.schema !== undefined) schema = result.schema as PluginPanelSchema
    return {
      ...(schema === undefined ? {} : { schema }),
      ...(result.toast === undefined ? {} : { toast: result.toast }),
    }
  } catch (error) {
    if (schema === undefined) throw error
    return { schema }
  }
}
