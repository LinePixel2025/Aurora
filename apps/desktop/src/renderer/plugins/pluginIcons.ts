/**
 * 插件面板图标映射（docs/14 §3.4）。
 *
 * 清单里的图标只是白名单里的字符串；这里维护同名 lucide 组件表。
 * 未登记 / 非法名字一律回落 `Puzzle`，不抛错、不引入任意组件。
 */
import type { Component } from 'vue'
import {
  Bell,
  BellRing,
  Blocks,
  Bot,
  CalendarClock,
  CirclePlay,
  Clock,
  FileText,
  FolderOpen,
  Gauge,
  Globe,
  History,
  ListChecks,
  MessageSquare,
  normalizePluginPanelIcon,
  Play,
  Puzzle,
  Search,
  Sparkles,
  Terminal,
  Workflow,
  type PluginPanelIcon,
} from '@aurora/shared/browser'

const ICONS: Record<PluginPanelIcon, Component> = {
  Blocks,
  Puzzle,
  ListChecks,
  Gauge,
  CalendarClock,
  Bot,
  Workflow,
  FolderOpen,
  Globe,
  Terminal,
  FileText,
  Sparkles,
  Bell,
  BellRing,
  Search,
  Clock,
  CirclePlay,
  Play,
  History,
  MessageSquare,
}

export function pluginPanelIcon(name: string | undefined): Component {
  return ICONS[normalizePluginPanelIcon(name)]
}
