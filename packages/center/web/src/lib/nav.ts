/**
 * 登录后工作台的导航清单（单源）：桌面侧栏（WorkbenchSidebar）与
 * 移动端底部导航（App.vue 的 .wb-bottom-nav）共用同一份，避免两处各写一份漂移。
 */
import type { Component } from 'vue'
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
