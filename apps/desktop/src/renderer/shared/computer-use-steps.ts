/**
 * Computer Use 过程面板 / 状态条的「一步」视图模型与语义图标（2026-10-31）。
 *
 * 主进程事件里带机器可读的 `action`（`mouse.click` / `window.activate` / `ui.invoke` …），
 * 这里只做「action → 图标」的纯映射；图标全部来自 `@aurora/shared/browser`（lucide 单源），
 * 未登记的图标不会进产物。
 *
 * 分组规则（历史显示）：**连续**的同一 `action + summary` 合并为一条并在右侧显示 `×N`；
 * 中间隔了别的步骤就算新的一条 —— 这样既不刷屏，也不丢时间顺序。
 */
import type { Component } from 'vue'
import {
  AppWindow,
  Check,
  ChevronDown,
  ChevronUp,
  Eye,
  Focus,
  Info,
  Keyboard,
  ListChecks,
  Minus,
  MousePointer2,
  MousePointerClick,
  Play,
  RotateCw,
  Scan,
  Search,
  Square,
  TextCursorInput,
  Timer,
  TriangleAlert,
  Wrench,
  X,
} from '@aurora/shared/browser'

/** 过程面板里的一步（`count` 只在连续重复时 > 1）。 */
export interface ComputerUseStepView {
  action: string
  summary: string
  count: number
}

/** 没有 action（刚授权、还没动作）时的兜底图标。 */
export const DEFAULT_COMPUTER_USE_ICON = MousePointer2

export function computerUseIcon(action: string | undefined): Component {
  const key = (action ?? '').trim()
  if (key === 'screen.capture') return Scan
  if (key === 'mouse.click') return MousePointerClick
  if (key.startsWith('mouse.')) return MousePointer2
  if (key.startsWith('keyboard.')) return Keyboard
  if (key === 'window.list') return ListChecks
  if (key === 'window.active') return Eye
  if (key === 'window.launch') return Play
  if (key === 'window.close') return X
  if (key === 'window.minimize') return Minus
  if (key === 'window.maximize') return Square
  if (key === 'window.restore') return RotateCw
  if (key.startsWith('window.')) return AppWindow
  if (key === 'ui.tree') return ListChecks
  if (key === 'ui.find') return Search
  if (key === 'ui.invoke') return MousePointerClick
  if (key === 'ui.set_value') return TextCursorInput
  if (key === 'ui.focus') return Focus
  if (key === 'ui.expand') return ChevronDown
  if (key === 'ui.collapse') return ChevronUp
  if (key === 'ui.select') return Check
  if (key.startsWith('ui.')) return AppWindow
  if (key === 'wait') return Timer
  if (key === 'notice') return Info
  if (key === 'error') return TriangleAlert
  return Wrench
}
