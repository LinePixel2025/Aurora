import { describe, expect, it } from 'vitest'
import {
  createInitialWindowState,
  hideWindow,
  isPrimaryWindow,
  isVisible,
  listVisible,
  showWindow,
  toggleWindow,
} from './windowState.js'

describe('窗口可见性状态机（docs/07 §3）', () => {
  it('初始所有窗口隐藏', () => {
    const state = createInitialWindowState()
    expect(listVisible(state)).toEqual([])
    expect(state.primary).toBeNull()
  })

  it('显示提示条与设置窗互不影响', () => {
    let state = createInitialWindowState()
    state = showWindow(state, 'edge-bar')
    state = showWindow(state, 'settings')
    expect(isVisible(state, 'edge-bar')).toBe(true)
    expect(isVisible(state, 'settings')).toBe(true)
  })

  it('迷你窗与交互窗互斥：后显示者胜出', () => {
    let state = createInitialWindowState()
    state = showWindow(state, 'mini-chat')
    expect(state.primary).toBe('mini-chat')
    state = showWindow(state, 'chat')
    expect(isVisible(state, 'chat')).toBe(true)
    expect(isVisible(state, 'mini-chat')).toBe(false)
    expect(state.primary).toBe('chat')
  })

  it('隐藏主对话窗口后 primary 归零，其它窗口不受影响', () => {
    let state = createInitialWindowState()
    state = showWindow(state, 'edge-bar')
    state = showWindow(state, 'chat')
    state = hideWindow(state, 'chat')
    expect(isVisible(state, 'edge-bar')).toBe(true)
    expect(isVisible(state, 'chat')).toBe(false)
    expect(state.primary).toBeNull()
  })

  it('toggle 在显示与隐藏之间切换（含互斥）', () => {
    let state = createInitialWindowState()
    state = toggleWindow(state, 'mini-chat')
    expect(isVisible(state, 'mini-chat')).toBe(true)
    state = toggleWindow(state, 'chat')
    expect(isVisible(state, 'chat')).toBe(true)
    expect(isVisible(state, 'mini-chat')).toBe(false)
    state = toggleWindow(state, 'chat')
    expect(isVisible(state, 'chat')).toBe(false)
    expect(state.primary).toBeNull()
  })

  it('设置窗与引导窗不参与主对话互斥', () => {
    let state = createInitialWindowState()
    state = showWindow(state, 'chat')
    state = showWindow(state, 'settings')
    state = showWindow(state, 'onboarding')
    expect(isVisible(state, 'chat')).toBe(true)
    expect(state.primary).toBe('chat')
    expect(isPrimaryWindow('settings')).toBe(false)
    expect(listVisible(state)).toEqual(['chat', 'settings', 'onboarding'])
  })

  it('状态更新不可变（不修改入参）', () => {
    const state = createInitialWindowState()
    const next = showWindow(state, 'chat')
    expect(state.visible['chat']).toBeUndefined()
    expect(next).not.toBe(state)
  })
})
