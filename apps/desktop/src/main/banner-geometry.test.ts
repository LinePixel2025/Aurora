/**
 * 流光提醒卡片窗几何的单测（`banner-geometry.ts`，docs/07 §2.2.3）。
 *
 * 这一层是「大屏上到底多大」的唯一实现：宽度按显示器比例、窗口 = 卡片 + 24px、
 * 高度先占位后收缩。纯逻辑、不 import electron，所以直接跑在 node 环境里。
 */
import { describe, expect, it } from 'vitest'
import {
  BANNER_CARD,
  BANNER_CARD_PROFILES,
  bannerCardBounds,
  clampBannerCardHeight,
  resolveBannerCardWidth,
} from './banner-geometry.js'

describe('resolveBannerCardWidth', () => {
  it('1920 屏按比例落成紧凑 461 / 标准 691 / 宽大 883', () => {
    expect(resolveBannerCardWidth('compact', 1920)).toBe(461)
    expect(resolveBannerCardWidth('standard', 1920)).toBe(691)
    expect(resolveBannerCardWidth('large', 1920)).toBe(883)
  })

  it('同一屏上宽大 > 标准 > 紧凑（档位真的拉开）', () => {
    for (const displayWidth of [1280, 1366, 1920, 2560, 3840]) {
      const compact = resolveBannerCardWidth('compact', displayWidth)
      const standard = resolveBannerCardWidth('standard', displayWidth)
      const large = resolveBannerCardWidth('large', displayWidth)
      expect(standard, `display=${displayWidth}`).toBeGreaterThan(compact)
      expect(large, `display=${displayWidth}`).toBeGreaterThan(standard)
    }
  })

  it('小屏夹到各档下限，大屏夹到上限', () => {
    // 1000 宽时三档比例值都低于下限，夹取后正好是 minWidth（再窄会被 displayWidth - 40 压住）
    expect(resolveBannerCardWidth('large', 1000)).toBe(BANNER_CARD_PROFILES.large.minWidth)
    expect(resolveBannerCardWidth('standard', 3840)).toBe(BANNER_CARD_PROFILES.standard.maxWidth)
    expect(resolveBannerCardWidth('large', 3840)).toBe(BANNER_CARD_PROFILES.large.maxWidth)
  })

  it('宽度永远留出两侧各 20px（不会撑满显示器）', () => {
    for (const displayWidth of [600, 1024, 1920, 3840]) {
      for (const size of ['compact', 'standard', 'large'] as const) {
        expect(resolveBannerCardWidth(size, displayWidth)).toBeLessThanOrEqual(displayWidth - 40)
      }
    }
  })

  it('脏数据（0 / NaN / 负值）回落到 1920 参考宽度，不会算出非正数', () => {
    for (const bad of [0, Number.NaN, -1920]) {
      const width = resolveBannerCardWidth('standard', bad)
      expect(width).toBeGreaterThan(0)
      expect(width).toBe(resolveBannerCardWidth('standard', 1920))
    }
  })
})

describe('bannerCardBounds', () => {
  it('水平居中、贴顶下浮 16px、窗口 = 卡片 + 上下左右各 12px', () => {
    const display = { x: 100, y: -1080, width: 1920, height: 1080 }
    const bounds = bannerCardBounds('standard', display)
    const cardWidth = resolveBannerCardWidth('standard', display.width)
    expect(bounds.width).toBe(cardWidth + BANNER_CARD.margin * 2)
    expect(bounds.height).toBe(BANNER_CARD.initialHeight + BANNER_CARD.margin * 2)
    // 窗口中心与显示器中心对齐（多显示器带负坐标也要对；奇数宽度会有 ±0.5 的取整误差）
    expect(
      Math.abs(bounds.x + bounds.width / 2 - (display.x + display.width / 2)),
    ).toBeLessThanOrEqual(0.5)
    expect(bounds.y).toBe(display.y + BANNER_CARD.topOffset)
  })

  it('首帧高度不超过高度上限，留出量完后收缩的空间', () => {
    expect(BANNER_CARD.initialHeight).toBeGreaterThan(BANNER_CARD.minHeight)
    expect(BANNER_CARD.initialHeight).toBeLessThanOrEqual(BANNER_CARD.maxHeight)
  })
})

describe('clampBannerCardHeight', () => {
  it('越界值夹到上下限、四舍五入', () => {
    expect(clampBannerCardHeight(10)).toBe(BANNER_CARD.minHeight)
    expect(clampBannerCardHeight(9999)).toBe(BANNER_CARD.maxHeight)
    expect(clampBannerCardHeight(120.4)).toBe(120)
  })

  it('非法值按最小高度处理（绝不把窗口调成 0）', () => {
    expect(clampBannerCardHeight(Number.NaN)).toBe(BANNER_CARD.minHeight)
    expect(clampBannerCardHeight(Number.POSITIVE_INFINITY)).toBe(BANNER_CARD.minHeight)
  })
})
