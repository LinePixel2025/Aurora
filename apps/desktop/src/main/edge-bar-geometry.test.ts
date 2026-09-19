import { describe, expect, it } from 'vitest'
import {
  EDGE_BAR_WIDTHS,
  placeEdgeBar,
  resizeEdgeBarKeepingRight,
  type Rect,
} from './edge-bar-geometry.js'

/** 常见 1080p 工作区（任务栏 40px 高） */
const WORK_AREA: Rect = { x: 0, y: 0, width: 1920, height: 1040 }

const size = (width: number, height: number): { width: number; height: number } => ({
  width,
  height,
})

describe('提示条几何（docs/07 §2.2）', () => {
  it('默认放置：右缘贴工作区右缘、垂直居中', () => {
    const bounds = placeEdgeBar(WORK_AREA, size(EDGE_BAR_WIDTHS.collapsed, 200))
    expect(bounds.x + bounds.width).toBe(WORK_AREA.x + WORK_AREA.width)
    expect(bounds.y + bounds.height / 2).toBe(WORK_AREA.y + WORK_AREA.height / 2)
    expect(bounds.width).toBe(8)
    expect(bounds.height).toBe(200)
  })

  it('默认放置在带偏移的工作区（多屏 / 任务栏在左）同样贴右缘', () => {
    const offset: Rect = { x: -1920, y: 40, width: 1920, height: 1000 }
    const bounds = placeEdgeBar(offset, size(EDGE_BAR_WIDTHS.collapsed, 200))
    expect(bounds.x + bounds.width).toBe(offset.x + offset.width)
    expect(bounds.y + bounds.height / 2).toBe(offset.y + offset.height / 2)
  })

  it('展开：8 → 228 后右缘不变、y 不变、height 不变', () => {
    const collapsed = placeEdgeBar(WORK_AREA, size(EDGE_BAR_WIDTHS.collapsed, 200))
    const expanded = resizeEdgeBarKeepingRight(collapsed, EDGE_BAR_WIDTHS.expanded, WORK_AREA)
    expect(expanded.width).toBe(228)
    expect(expanded.x + expanded.width).toBe(collapsed.x + collapsed.width)
    expect(expanded.y).toBe(collapsed.y)
    expect(expanded.height).toBe(collapsed.height)
  })

  it('收起：228 → 8 后右缘不变，且与初始收起态完全一致（往返幂等）', () => {
    const collapsed = placeEdgeBar(WORK_AREA, size(EDGE_BAR_WIDTHS.collapsed, 200))
    const expanded = resizeEdgeBarKeepingRight(collapsed, EDGE_BAR_WIDTHS.expanded, WORK_AREA)
    const back = resizeEdgeBarKeepingRight(expanded, EDGE_BAR_WIDTHS.collapsed, WORK_AREA)
    expect(back).toEqual(collapsed)
  })

  it('窄工作区：不出现负宽度 / 越界，x 被 clamp 到工作区左边界', () => {
    const narrow: Rect = { x: 100, y: 0, width: 200, height: 400 }
    const placed = placeEdgeBar(narrow, size(EDGE_BAR_WIDTHS.expanded, 200))
    expect(placed.x).toBe(narrow.x)
    expect(placed.width).toBe(EDGE_BAR_WIDTHS.expanded)
    expect(placed.x).toBeGreaterThanOrEqual(narrow.x)

    const fromEdge = resizeEdgeBarKeepingRight(
      { x: narrow.x + narrow.width - 8, y: 10, width: 8, height: 200 },
      EDGE_BAR_WIDTHS.expanded,
      narrow,
    )
    expect(fromEdge.x).toBe(narrow.x)
    expect(fromEdge.width).toBeGreaterThan(0)
    expect(fromEdge.y).toBe(10)
    expect(fromEdge.height).toBe(200)
  })

  it('展开态窗口已越出右缘时仍收敛回工作区内', () => {
    const offscreen: Rect = { x: WORK_AREA.width + 50, y: 12, width: 8, height: 200 }
    const expanded = resizeEdgeBarKeepingRight(offscreen, EDGE_BAR_WIDTHS.expanded, WORK_AREA)
    expect(expanded.x + expanded.width).toBe(WORK_AREA.x + WORK_AREA.width)
    expect(expanded.width).toBe(228)
  })
})
