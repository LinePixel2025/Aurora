/**
 * 插件面板图标白名单（docs/14 §3.4）。
 *
 * 图标名只是字符串：清单来自第三方，不能让它引用任意组件。
 * 渲染层有一张同名映射表（`renderer/plugins/pluginIcons.ts`），未登记的图标回落 `Puzzle`。
 */
export const PLUGIN_PANEL_ICONS = [
  'Blocks',
  'Puzzle',
  'ListChecks',
  'Gauge',
  'CalendarClock',
  'Bot',
  'Workflow',
  'FolderOpen',
  'Globe',
  'Terminal',
  'FileText',
  'Sparkles',
  'Bell',
  'BellRing',
  'Search',
  'Clock',
  'CirclePlay',
  'Play',
  'History',
  'MessageSquare',
] as const

export type PluginPanelIcon = (typeof PLUGIN_PANEL_ICONS)[number]

export const PLUGIN_PANEL_DEFAULT_ICON: PluginPanelIcon = 'Puzzle'

export function normalizePluginPanelIcon(value: string | undefined): PluginPanelIcon {
  if (!value) return PLUGIN_PANEL_DEFAULT_ICON
  return (PLUGIN_PANEL_ICONS as readonly string[]).includes(value)
    ? (value as PluginPanelIcon)
    : PLUGIN_PANEL_DEFAULT_ICON
}
