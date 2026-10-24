/**
 * 声明式面板的渲染辅助（docs/14 §3.4）。
 *
 * 校验只有一份实现（`@aurora/shared` 的 `validatePanelSchema`）；这里只做渲染层需要的
 * 小工具：节点 key、图片 URL、文本兜底。**没有 HTML 拼装**，全部走 Vue 文本绑定。
 */
import {
  validatePanelSchema,
  type PluginPanelSchema,
  type PluginUiNode,
} from '@aurora/shared/browser'

export { validatePanelSchema }
export type { PluginPanelSchema, PluginUiNode }

/** `aurora-plugin://<pluginId>/<相对路径>`（逐段编码，`..` 由主进程 realpath 再挡一次） */
export function pluginAssetUrl(pluginId: string, relativePath: string): string {
  const clean = relativePath.replace(/^\/+/, '')
  return `aurora-plugin://${pluginId}/${clean
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
