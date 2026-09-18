import { describe, expect, it } from 'vitest'
import {
  dockAnchorRect,
  placeDockWithCenterBottom,
  resizeDockKeepingAnchor,
  restoreDockBounds,
  type Rect,
} from './dock-geometry.js'

/** 1080p 主屏工作区 */
const AREA: Rect = { x: 0, y: 0, width: 1920, height: 1040 }
const COLLAPSED = { width: 56, height: 56 }
const EXPANDED = { width: 320, height: 56 }

describe('resizeDockKeepingAnchor', () => {
  it('展开时水平中心与底边不变，只向左右生长', () => {
    const current: Rect = { x: 932, y: 960, width: 56, height: 56 }
    const next = resizeDockKeepingAnchor(current, EXPANDED, AREA)
    expect(next.width).toBe(320)
    expect(next.height).toBe(56)
    // 中心不变：932 + 28 = 960 → 960 - 160 = 800
    expect(next.x + next.width / 2).toBe(current.x + current.width / 2)
    // 底边不变：960 + 56 = 1016
    expect(next.y + next.height).toBe(current.y + current.height)
    expect(next).toEqual({ x: 800, y: 960, width: 320, height: 56 })
  })

  it('收起后回到原来的圆球位置（往返一致）', () => {
    const collapsed: Rect = { x: 932, y: 960, width: 56, height: 56 }
    const roundTrip = resizeDockKeepingAnchor(
      resizeDockKeepingAnchor(collapsed, EXPANDED, AREA),
      COLLAPSED,
      AREA,
    )
    expect(roundTrip).toEqual(collapsed)
  })

  it('贴右缘时展开不越界（clamp 进工作区）', () => {
    const current: Rect = { x: 1864, y: 960, width: 56, height: 56 }
    const next = resizeDockKeepingAnchor(current, EXPANDED, AREA)
    expect(next.x).toBe(1920 - 320)
    expect(next.x + next.width).toBeLessThanOrEqual(AREA.x + AREA.width)
  })

  it('贴左缘时展开不越界', () => {
    const current: Rect = { x: 0, y: 960, width: 56, height: 56 }
    const next = resizeDockKeepingAnchor(current, EXPANDED, AREA)
    expect(next.x).toBe(0)
  })

  it('贴屏幕底部时收起不回退到工作区外', () => {
    const current: Rect = { x: 900, y: 984, width: 320, height: 56 }
    const next = resizeDockKeepingAnchor(current, COLLAPSED, AREA)
    expect(next.y + next.height).toBeLessThanOrEqual(AREA.y + AREA.height)
  })

  it('尊重工作区偏移（任务栏在左侧 / 非主屏坐标）', () => {
    const area: Rect = { x: 100, y: 50, width: 800, height: 600 }
    const current: Rect = { x: 200, y: 300, width: 56, height: 56 }
    const next = resizeDockKeepingAnchor(current, EXPANDED, area)
    expect(next.x).toBeGreaterThanOrEqual(area.x)
    expect(next.y + next.height).toBeLessThanOrEqual(area.y + area.height)
  })
})

describe('restoreDockBounds', () => {
  it('只恢复位置，尺寸取传入的折叠态尺寸', () => {
    const next = restoreDockBounds({ x: 932, y: 960 }, COLLAPSED, AREA)
    expect(next).toEqual({ x: 932, y: 960, width: 56, height: 56 })
  })

  it('持久化尺寸是输入条宽度时，收起态仍是 56×56（不被继承）', () => {
    // 上次退出时窗口可能是 320×56，位置 x=800；恢复时必须回到圆球形态
    const next = restoreDockBounds({ x: 800, y: 960 }, COLLAPSED, AREA)
    expect(next.width).toBe(56)
    expect(next.height).toBe(56)
  })

  it('越界坐标被 clamp 回工作区', () => {
    const next = restoreDockBounds({ x: 5000, y: -200 }, COLLAPSED, AREA)
    expect(next.x).toBe(AREA.x + AREA.width - 56)
    expect(next.y).toBe(AREA.y)
  })
})

describe('placeDockWithCenterBottom', () => {
  it('按期望中心与底边换算左上角', () => {
    const next = placeDockWithCenterBottom(400, 1016, EXPANDED, AREA)
    expect(next).toEqual({ x: 240, y: 960, width: 320, height: 56 })
  })
})

describe('dockAnchorRect（持久化锚点）', () => {
  it('把展开态矩形归一化为收起态锚点', () => {
    const expanded: Rect = { x: 800, y: 960, width: 320, height: 56 }
    expect(dockAnchorRect(expanded, COLLAPSED)).toEqual({
      x: 932,
      y: 960,
      width: 56,
      height: 56,
    })
  })

  it('展开态退出后重启仍回到同一个圆球位置（回归：浮球左移）', () => {
    const collapsed: Rect = { x: 932, y: 960, width: 56, height: 56 }
    const expanded = resizeDockKeepingAnchor(collapsed, EXPANDED, AREA)
    // 退出时停在展开态：存锚点后按收起态恢复，必须回到原位
    const saved = dockAnchorRect(expanded, COLLAPSED)
    const restored = restoreDockBounds(saved, COLLAPSED, AREA)
    expect(restored).toEqual(collapsed)
  })

  it('展开态与收起态存下的锚点一致', () => {
    const collapsed: Rect = { x: 932, y: 960, width: 56, height: 56 }
    const expanded = resizeDockKeepingAnchor(collapsed, EXPANDED, AREA)
    expect(dockAnchorRect(expanded, COLLAPSED)).toEqual(dockAnchorRect(collapsed, COLLAPSED))
  })
})
