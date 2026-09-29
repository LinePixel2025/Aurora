/**
 * 自动化运行档（v0.2.8，docs/13 §7.1）的回归护栏。
 *
 * 两条硬口径各有一组断言：
 * ① 自动化会话（`origin: 'automation'` 或 `auto-` 会话 id）**不得**拿到写类自动化工具，
 *    并换上无人值守人设 + 「本次运行」小节；
 * ② 普通会话拿到的运行档必须是 `undefined`（否则所有交互式会话的提示词都会跟着变）。
 */
import { describe, expect, it } from 'vitest'
import { AUTOMATION_WRITE_TOOL_NAMES } from '../tools/automation-tools.js'
import { isAutomationSession } from './session-id.js'
import { AUTOMATION_PERSONA, AUTOMATION_RUN_CONTEXT, automationRunProfile } from './run-profile.js'

describe('isAutomationSession', () => {
  it('识别 auto- 前缀（含 runId 形态与 task 子代理的 -sub 后缀）', () => {
    expect(isAutomationSession('auto-m1a2b3-1')).toBe(true)
    expect(isAutomationSession('auto')).toBe(true)
    expect(isAutomationSession('auto-m1a2b3-1-sub')).toBe(true)
  })

  it('普通会话 id 一律不命中（chat- / quick / center- / 空串）', () => {
    for (const id of ['chat-m1a2b3-1', 'quick', 'center-9f2', 'sub-auto-1', '']) {
      expect(isAutomationSession(id)).toBe(false)
    }
  })
})

describe('automationRunProfile', () => {
  it('origin=automation → 专用人设 + 本次运行小节 + 摘掉写类自动化工具', () => {
    const profile = automationRunProfile({ sessionId: 'auto-m1-1', origin: 'automation' })
    expect(profile).toBeDefined()
    expect(profile?.persona).toBe(AUTOMATION_PERSONA)
    expect(profile?.runContext).toBe(AUTOMATION_RUN_CONTEXT)
    expect(profile?.hiddenTools).toEqual(AUTOMATION_WRITE_TOOL_NAMES)
    // 四个写类工具都在摘除名单里；只读的 list / history 保留（能看不能改）
    expect([...(profile?.hiddenTools ?? [])]).toEqual([
      'automation_create',
      'automation_update',
      'automation_delete',
      'automation_run',
    ])
  })

  it('会话 id 命中 auto- 但 origin 不是 automation（续跑 / 回放）也按自动化档跑', () => {
    const profile = automationRunProfile({ sessionId: 'auto-m1-1', origin: 'chat' })
    expect(profile?.persona).toBe(AUTOMATION_PERSONA)
  })

  it('普通会话返回 undefined（提示词与工具面保持原样）', () => {
    expect(automationRunProfile({ sessionId: 'chat-1', origin: 'chat' })).toBeUndefined()
    expect(automationRunProfile({ sessionId: 'quick', origin: 'edge-bar' })).toBeUndefined()
  })
})
