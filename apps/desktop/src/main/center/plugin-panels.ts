/**
 * Center 插件面板目录（docs/12 §6.5）。
 *
 * 只上报**侧栏面板**（`contributes.panels`）：桌面 / 提示条小组件（`contributes.widgets`）
 * 不属于 Center 的展示面。纯函数，不做 IO —— 调用方从 `PluginManager.list()` 拿快照。
 */
import type { ClientPluginInfo, ClientPluginPanelInfo } from '@aurora/shared'
import { CENTER_PLUGIN_CATALOG_LIMIT, type PluginSummary } from '@aurora/shared'

/** 面板订阅键（`pluginId` 与 `panelId` 各自不含分隔符冲突的约束由清单校验保证） */
export function pluginPanelKey(pluginId: string, panelId: string): string {
  return `${pluginId}/${panelId}`
}

/**
 * 从已安装插件快照生成 Center 目录：仅启用插件、仅侧栏面板、按 id 排序、最多
 * `CENTER_PLUGIN_CATALOG_LIMIT` 个插件。没有任何面板的插件不进目录（不占上限）。
 */
export function buildPluginCatalog(plugins: readonly PluginSummary[]): ClientPluginInfo[] {
  const result: ClientPluginInfo[] = []
  for (const plugin of plugins) {
    if (!plugin.enabled) continue
    if (plugin.panels.length === 0) continue
    const panels: ClientPluginPanelInfo[] = plugin.panels.map((panel) => ({
      id: panel.id,
      title: panel.title,
      ...(panel.icon === '' ? {} : { icon: panel.icon }),
      kind: panel.kind,
      ...(panel.kind === 'page' && panel.entry !== undefined ? { entry: panel.entry } : {}),
    }))
    result.push({
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      panels,
    })
  }
  result.sort((a, b) => a.id.localeCompare(b.id))
  return result.slice(0, CENTER_PLUGIN_CATALOG_LIMIT)
}
