/**
 * 插件权限（docs/14 §4）—— **API 级门控**，不是 OS 沙箱。
 *
 * 权限只决定「宿主的白名单 RPC 能否调用、某类贡献能否加载」；
 * 插件进程本身持有当前用户权限，可绕过 RPC 直接读文件 / 发网络。
 * 文档与安装弹窗必须如实写明这一点（`docs/14 §6.4`）。
 */

export const PLUGIN_PERMISSIONS = [
  'tools',
  'skills',
  'commands',
  'automation',
  'automation.events',
  'storage',
  'config',
  'usage',
  'net',
  'net.private',
  'notifications',
  'logging',
  'ui.panels',
  'ui.widgets',
  'themes',
  'events',
] as const

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number]

/** 权限 → 设置页 / 安装弹窗里的中文说明（一句话，不写文档引用）。 */
export const PLUGIN_PERMISSION_LABELS: Record<PluginPermission, string> = {
  tools: '向 Agent 提供工具（每次调用默认需要你确认）',
  skills: '提供 Skill（注入上下文的知识包）',
  commands: '注册斜杠命令',
  automation: '提供自动化动作组件',
  'automation.events': '定义并触发自动化事件',
  storage: '读写自己的键值存储（最多 5 MB）',
  config: '读写自己的配置项',
  usage: '读取本机用量统计（Token / 生图 / 语音次数）',
  net: '通过宿主代理发起 HTTP 请求',
  'net.private': '访问本机与内网地址',
  notifications: '发送系统通知与流光提醒',
  logging: '写入插件日志',
  'ui.panels': '在右栏添加面板',
  'ui.widgets': '在桌面或提示条放置小组件',
  themes: '提供界面主题令牌',
  events: '订阅宿主事件（设置变更 / 消息 / 工具调用）',
}

/** 权限分组（安装弹窗按组展示，避免一长串无层次的列表）。 */
export const PLUGIN_PERMISSION_GROUPS: ReadonlyArray<{
  title: string
  permissions: PluginPermission[]
}> = [
  { title: 'Agent 能力', permissions: ['tools', 'skills', 'commands'] },
  { title: '自动化', permissions: ['automation', 'automation.events'] },
  { title: '数据', permissions: ['storage', 'config', 'usage'] },
  { title: '网络与系统', permissions: ['net', 'net.private', 'notifications', 'logging'] },
  { title: '界面', permissions: ['ui.panels', 'ui.widgets', 'themes', 'events'] },
]

/** 贡献 → 必需权限（加载时逐项检查，缺权限的贡献整条拒绝并告警）。 */
export const PLUGIN_CONTRIBUTION_PERMISSIONS = {
  tools: 'tools',
  skills: 'skills',
  commands: 'commands',
  automationActions: 'automation',
  automationEvents: 'automation.events',
  panels: 'ui.panels',
  widgets: 'ui.widgets',
  themes: 'themes',
} as const satisfies Record<string, PluginPermission>

/** 判断某权限是否已声明（`net.private` 依赖 `net`，由清单校验层保证成对出现）。 */
export function hasPermission(granted: readonly string[], permission: PluginPermission): boolean {
  return granted.includes(permission)
}
