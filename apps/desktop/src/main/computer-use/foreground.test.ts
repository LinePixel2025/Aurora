import { describe, expect, it } from 'vitest'
import { shouldBringAuroraToFront } from './foreground.js'

describe('Computer Use 结束后的前台化判据', () => {
  it('任务完成 / 用户停止 / 闲置 / 预算 / 失败：结束即把 Aurora 调回前台', () => {
    for (const reason of ['agent', 'user', 'idle', 'budget', 'error'] as const) {
      expect(shouldBringAuroraToFront(reason)).toBe(true)
    }
  })

  it('设置页 / 权限 / 模型 / 系统 / 退出等结束原因不打扰', () => {
    for (const reason of ['settings', 'permission', 'model', 'system', 'quit'] as const) {
      expect(shouldBringAuroraToFront(reason)).toBe(false)
    }
  })
})
