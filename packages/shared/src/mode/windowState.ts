/**
 * 窗口可见性与互斥状态机（纯逻辑，可单测）。
 *
 * 规则（docs/07 §3）：
 * - 交互窗（chat）是唯一主对话窗口（独立小窗已于 v1.0 轮次删除）；
 * - 关闭 = 隐藏，托盘是唯一真实出口（docs/02 §2.2）。
 */
import type { WindowName, WindowState } from '../ipc/types.js'
import { WINDOW_NAMES } from '../config/schema.js'

export function createInitialWindowState(): WindowState {
  return { visible: {}, primary: null }
}

function withVisible(state: WindowState, name: WindowName, visible: boolean): WindowState {
  const next: WindowState = {
    visible: { ...state.visible, [name]: visible },
    primary: state.primary,
  }
  if (!visible && next.primary === name) next.primary = null
  return next
}

export function showWindow(state: WindowState, name: WindowName): WindowState {
  const next = withVisible(state, name, true)
  // 交互窗是唯一主对话窗口：只有它会把 primary 置为 'chat'。
  return name === 'chat' ? { ...next, primary: 'chat' } : next
}

export function hideWindow(state: WindowState, name: WindowName): WindowState {
  return withVisible(state, name, false)
}

export function toggleWindow(state: WindowState, name: WindowName): WindowState {
  return isVisible(state, name) ? hideWindow(state, name) : showWindow(state, name)
}

export function isVisible(state: WindowState, name: WindowName): boolean {
  return state.visible[name] === true
}

/** 引导窗与设置窗为独立窗口，不参与主对话判定。 */
export function isPrimaryWindow(name: WindowName): name is 'chat' {
  return name === 'chat'
}

export function listVisible(state: WindowState): WindowName[] {
  return WINDOW_NAMES.filter((name) => isVisible(state, name))
}
