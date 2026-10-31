import { describe, expect, it } from 'vitest'
import { shouldBringAuroraToFront } from './foreground.js'

describe('Computer Use 结束后的前台化判据', () => {
  it('只有 Agent 主动退出（任务完成）才抢焦点', () => {
    expect(shouldBringAuroraToFront('agent')).toBe(true)
  })

  it('用户 / 设置 / 系统 / 退出等结束原因都不打扰', () => {
    for (const reason of [
      'user',
      'settings',
      'model',
      'permission',
      'idle',
      'budget',
      'error',
      'system',
      'quit',
    ] as const) {
      expect(shouldBringAuroraToFront(reason)).toBe(false)
    }
  })
})
