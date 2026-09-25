/**
 * 工具名 → 图标（docs/07 §5）。
 *
 * 工具卡此前只有状态点，看不出「这是什么工具」；给每个内置工具配一枚语义图标，
 * 一眼能分清读文件 / 跑命令 / 派子代理。映射是**纯查表 + 兜底**：
 * 表里没有的工具（第三方 MCP、未来新增）走前缀 / 通用兜底，绝不因为缺映射而渲染失败。
 */
import type { Component } from 'vue'
import {
  Bell,
  Bot,
  ClipboardCopy,
  FileText,
  FolderOpen,
  FolderSearch,
  Globe,
  ImageIcon,
  ListChecks,
  Puzzle,
  School,
  Search,
  Settings,
  Terminal,
  Wrench,
} from './icons.js'

const TOOL_ICONS: Record<string, Component> = {
  // 终端与文件三件套 + 打开（docs/06 §14）
  run_command: Terminal,
  read_file: FileText,
  write_file: FileText,
  list_dir: FolderOpen,
  open_path: FolderOpen,
  // 搜索层（v12，docs/06 §11.5）：grep 按**内容**找（放大镜）、glob 按**文件名**找（文件夹 + 放大镜）
  grep: Search,
  glob: FolderSearch,
  // BetaV2 新工具五件套
  web_fetch: Globe,
  notify_user: Bell,
  clipboard_read: ClipboardCopy,
  clipboard_write: ClipboardCopy,
  generate_image: ImageIcon,
  // 内核工具
  todo_write: ListChecks,
  todo_read: ListChecks,
  task: Bot,
  set_setting: Settings,
  // ClassIsland 联动（v3）
  classisland_remind: School,
}

/** 查表；未登记的工具按前缀退到 MCP 的拼图与通用扳手 */
export function toolIconOf(name: string): Component {
  const known = TOOL_ICONS[name]
  if (known !== undefined) return known
  return name.startsWith('mcp.') ? Puzzle : Wrench
}
