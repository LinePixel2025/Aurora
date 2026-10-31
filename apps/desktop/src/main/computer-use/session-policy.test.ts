import { describe, expect, it } from 'vitest'
import { canHoldComputerUseSession } from './session-policy.js'

describe('Computer Use 会话资格', () => {
  it('普通 / quick / center 会话可以持有授权', () => {
    for (const sessionId of ['main', 'chat-abc', 'quick', 'center-abc']) {
      expect(canHoldComputerUseSession(sessionId)).toBe(true)
    }
  })

  it('自动化 / 自感知 / 子代理 / 空会话不能持有授权', () => {
    for (const sessionId of ['auto-1', 'awareness-1', 'chat-1-sub', '', '   ']) {
      expect(canHoldComputerUseSession(sessionId)).toBe(false)
    }
  })
})
