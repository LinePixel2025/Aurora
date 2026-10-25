/**
 * 声明式面板的渲染辅助（docs/14 §3.4；Center 侧副本）。
 *
 * ⚠️ 与 `apps/desktop/src/renderer/plugins/pluginSchema.ts` **双端同构**：节点 key / 表格
 * 文本的语义必须逐字一致，改动需同步两端。差异只有图片 URL —— 桌面走
 * `aurora-plugin://`，Center 从市场包的 `/p/<pluginId>/<version>/<path>` 取。
 */
import {
  validatePanelSchema,
  type PluginPanelSchema,
  type PluginUiNode,
} from '@aurora/shared/browser'

export { validatePanelSchema }
export type { PluginPanelSchema, PluginUiNode }

/** Center 的插件静态资源地址（服务器从市场 zip 读取，公开可访问） */
export function pluginAssetUrl(pluginId: string, version: string, relativePath: string): string {
  const clean = relativePath.replace(/^\/+/, '')
  return `/p/${encodeURIComponent(pluginId)}/${encodeURIComponent(version)}/${clean
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`
}

export function nodeKey(node: PluginUiNode, index: number): string {
  return node.id ?? `${node.type}-${index}`
}

/** 表格单元格文本：只接受字符串，其余按空串处理（schema 校验已限制形状） */
export function cellText(row: Record<string, string>, key: string): string {
  return typeof row[key] === 'string' ? row[key] : ''
}
