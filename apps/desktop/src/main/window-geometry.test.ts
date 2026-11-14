import { describe, expect, it } from 'vitest'
import {
  clampBoundsToWorkArea,
  fitSizeToWorkArea,
  relaxedMinSize,
  type Rect,
} from './window-geometry.js'

/** 1080p @100% 工作区 */
const AREA_100: Rect = { x: 0, y: 0, width: 1920, height: 1040 }
/** 1366×768 @125% → DIP 工作区约 1093×575（任务栏再扣一点） */
const AREA_125_SMALL: Rect = { x: 0, y: 0, width: 1093, height: 575 }
/** 副屏（主屏左侧，150% 缩放后的 DIP 偏移） */
const AREA_SECONDARY: Rect = { x: -1280, y: 0, width: 1280, height: 680 }

describe('fitSizeToWorkArea（高 DPI 小屏默认尺寸不出屏）', () => {
  it('工作区装得下时保持 spec 尺寸', () => {
    expect(fitSizeToWorkArea({ width: 1280, height: 800 }, AREA_100)).toEqual({
      width: 1280,
      height: 800,
    })
  })

  it('125% 小屏：chat 1280×800 收到工作区 − 余量', () => {
    expect(fitSizeToWorkArea({ width: 1280, height: 800 }, AREA_125_SMALL)).toEqual({
      width: 1069,
      height: 551,
    })
  })

  it('极小工作区不产生负数 / 零尺寸', () => {
    const tiny: Rect = { x: 0, y: 0, width: 10, height: 10 }
    expect(fitSizeToWorkArea({ width: 900, height: 640 }, tiny)).toEqual({ width: 1, height: 1 })
  })
})

describe('clampBoundsToWorkArea（恢复几何按所在显示器夹回）', () => {
  it('完全在内时只取整、不动位置', () => {
    const bounds = { x: 100.4, y: 80.6, width: 900, height: 640 }
    expect(clampBoundsToWorkArea(bounds, AREA_100)).toEqual({
      x: 100,
      y: 81,
      width: 900,
      height: 640,
    })
  })

  it('副屏保存的几何不被主屏工作区拽走', () => {
    const bounds = { x: -1000, y: 100, width: 900, height: 640 }
    const clamped = clampBoundsToWorkArea(bounds, AREA_SECONDARY)
    expect(clamped.x).toBe(-1000)
    expect(clamped.y).toBe(100)
  })

  it('出屏几何夹回：水平至少留 40px、垂直标题带不出顶', () => {
    const far = { x: 5000, y: -300, width: 900, height: 640 }
    const clamped = clampBoundsToWorkArea(far, AREA_100)
    expect(clamped.x).toBe(AREA_100.width - 40)
    expect(clamped.y).toBe(0)
  })

  it('比工作区还大的旧几何被 cap 到工作区', () => {
    const big = { x: -100, y: -100, width: 2560, height: 1400 }
    const clamped = clampBoundsToWorkArea(big, AREA_125_SMALL)
    expect(clamped.width).toBe(AREA_125_SMALL.width)
    expect(clamped.height).toBe(AREA_125_SMALL.height)
  })
})

describe('relaxedMinSize（小屏放宽最小尺寸）', () => {
  it('大工作区保持 spec 最小值', () => {
    expect(relaxedMinSize({ width: 1060, height: 660 }, AREA_100)).toEqual({
      width: 1060,
      height: 660,
    })
  })

  it('125% 小屏：高度最小值放宽到工作区 −16，宽度仍取 spec（取小口径）', () => {
    expect(relaxedMinSize({ width: 1060, height: 660 }, AREA_125_SMALL)).toEqual({
      width: 1060,
      height: 559,
    })
    const narrower: Rect = { x: 0, y: 0, width: 1000, height: 575 }
    expect(relaxedMinSize({ width: 1060, height: 660 }, narrower)).toEqual({
      width: 984,
      height: 559,
    })
  })

  it('兜底不小于 120×48', () => {
    const tiny: Rect = { x: 0, y: 0, width: 100, height: 50 }
    expect(relaxedMinSize({ width: 1060, height: 660 }, tiny)).toEqual({ width: 120, height: 48 })
  })
})
