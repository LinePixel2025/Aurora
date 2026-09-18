/**
 * 窗口可见性与互斥状态机（纯逻辑，可单测）。
 *
 * 规则（docs/07 §3）：
 * - 迷你窗与交互窗同屏互斥（同一会话同一时间只在一个窗口）；
 * - 隐藏服务窗时迷你窗一并隐藏；
 * - 关闭 = 隐藏，托盘是唯一真实出口（docs/02 §2.2）。
 */
import type { PrimaryWindow, WindowName, WindowState } from '../ipc/types.js'
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

/** 隐藏另一个主对话窗口，保证互斥。 */
function enforceExclusivity(state: WindowState, shown: PrimaryWindow): WindowState {
  const other: PrimaryWindow = shown === 'chat' ? 'mini-chat' : 'chat'
  return { visible: { ...state.visible, [other]: false }, primary: shown }
}

export function showWindow(state: WindowState, name: WindowName): WindowState {
  if (name === 'mini-chat' || name === 'chat') {
    return enforceExclusivity(withVisible(state, name, true), name)
  }
  return withVisible(state, name, true)
}

export function hideWindow(state: WindowState, name: WindowName): WindowState {
  const next = withVisible(state, name, false)
  if (name === 'service-dock') {
    // 服务窗隐藏 → 迷你窗一并隐藏（docs/07 §3）
    return { visible: { ...next.visible, 'mini-chat': false }, primary: null }
  }
  return next
}

export function toggleWindow(state: WindowState, name: WindowName): WindowState {
  return isVisible(state, name) ? hideWindow(state, name) : showWindow(state, name)
}

export function isVisible(state: WindowState, name: WindowName): boolean {
  return state.visible[name] === true
}

/** 引导窗与设置窗为独立窗口，不参与主对话互斥。 */
export function isPrimaryWindow(name: WindowName): name is PrimaryWindow {
  return name === 'chat' || name === 'mini-chat'
}

export function listVisible(state: WindowState): WindowName[] {
  return WINDOW_NAMES.filter((name) => isVisible(state, name))
}
