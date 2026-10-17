import { describe, expect, it } from 'vitest'
import { clampComposerFlyoutLeft } from './composerFlyout.js'

describe('clampComposerFlyoutLeft', () => {
  const base = {
    boxLeft: 100,
    boxClientLeft: 1,
    boxClientWidth: 600,
    flyoutWidth: 320,
  }

  it('把触发按钮的左缘换算成相对卡片的 left（扣掉边框）', () => {
    expect(clampComposerFlyoutLeft({ ...base, triggerLeft: 250 })).toBe(149)
  })

  it('最左侧按钮仍落在 0', () => {
    expect(clampComposerFlyoutLeft({ ...base, triggerLeft: 100 })).toBe(0)
  })

  it('靠右按钮会被夹到「卡片宽 - 浮层宽」，不会越出卡右侧', () => {
    expect(clampComposerFlyoutLeft({ ...base, boxClientWidth: 380, triggerLeft: 460 })).toBe(60)
  })

  it('卡片比 320px 窄时浮层按卡宽算，left 仍不会为负', () => {
    expect(
      clampComposerFlyoutLeft({
        ...base,
        boxClientWidth: 280,
        triggerLeft: 260,
      }),
    ).toBe(0)
  })
})
