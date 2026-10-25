/**
 * 登录后工作台的导航清单（单源）：桌面侧栏（WorkbenchSidebar）与
 * 移动端底部导航（App.vue 的 .wb-bottom-nav）共用同一份，避免两处各写一份漂移。
 */
import type { Component } from 'vue'
import type { ClientPluginInfo } from '@aurora/shared'
import {
  Blocks,
  FolderOpen,
  Gauge,
  MonitorSmartphone,
  Puzzle,
  Sparkles,
} from '@aurora/shared/browser'
import type { RouteName } from '../router'

export interface WorkbenchNavItem {
  name: RouteName
  label: string
  icon: Component
  /** 仅管理员可见（admin 页） */
  admin: boolean
}

export const WORKBENCH_NAV: WorkbenchNavItem[] = [
  { name: 'console', label: '控制台', icon: Sparkles, admin: false },
  { name: 'usage', label: '用量', icon: Gauge, admin: false },
  { name: 'automations', label: '自动化', icon: Blocks, admin: false },
  { name: 'marketplace', label: '插件市场', icon: Puzzle, admin: false },
  { name: 'files', label: '文件', icon: FolderOpen, admin: false },
  { name: 'admin', label: '管理', icon: MonitorSmartphone, admin: true },
  { name: 'pluginsAdmin', label: '插件管理', icon: Puzzle, admin: true },
]

/** 侧栏「插件」分区条目上限（防止装了几十个插件的账号把导航撑爆） */
export const PLUGIN_NAV_LIMIT = 24

/** 构建插件导航所需的最少客户端信息（App 从 `ClientEntry` 投影） */
export interface PluginNavSource {
  clientId: string
  online: boolean
  ownerUserId: string
  /** 最近一次 `ClientStatus.plugins`；旧客户端 / 闸门关闭时为 undefined */
  plugins?: ClientPluginInfo[]
}

export interface PluginNavItem {
  /** 路由 query 与 `data-action` 的稳定键 */
  key: string
  pluginId: string
  panelId: string
  pluginName: string
  label: string
  icon?: string
  /** 该面板可用的在线设备（多设备时页内切换） */
  clientIds: string[]
}

/**
 * Center 侧栏的插件入口（docs/12 §6.5）：只取**本人名下且在线**的设备，
 * 按 `pluginId/panelId` 去重（多设备合并为一处），同名面板加插件名前缀，
 * 最多 `PLUGIN_NAV_LIMIT` 条。管理员不例外 —— 插件面板是个人数据。
 */
export function buildPluginNav(
  sources: readonly PluginNavSource[],
  userId: string,
): PluginNavItem[] {
  const byKey = new Map<string, PluginNavItem>()
  for (const source of sources) {
    if (!source.online || source.ownerUserId !== userId) continue
    for (const plugin of source.plugins ?? []) {
      for (const panel of plugin.panels) {
        const key = `${plugin.id}::${panel.id}`
        const existing = byKey.get(key)
        if (existing === undefined) {
          byKey.set(key, {
            key,
            pluginId: plugin.id,
            panelId: panel.id,
            pluginName: plugin.name,
            label: panel.title,
            ...(panel.icon === undefined ? {} : { icon: panel.icon }),
            clientIds: [source.clientId],
          })
        } else if (!existing.clientIds.includes(source.clientId)) {
          existing.clientIds.push(source.clientId)
        }
      }
    }
  }
  const items = [...byKey.values()]
  const labelCount = new Map<string, number>()
  for (const item of items) labelCount.set(item.label, (labelCount.get(item.label) ?? 0) + 1)
  for (const item of items) {
    if ((labelCount.get(item.label) ?? 0) > 1) {
      item.label = `${item.pluginName} · ${item.label}`
    }
  }
  items.sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key))
  return items.slice(0, PLUGIN_NAV_LIMIT)
}
