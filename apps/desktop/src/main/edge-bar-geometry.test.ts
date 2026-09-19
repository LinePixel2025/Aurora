import { describe, expect, it } from 'vitest'
import {
  EDGE_BAR_COLLAPSED_HEIGHT,
  EDGE_BAR_EXPANDED_MARGIN,
  EDGE_BAR_WIDTHS,
  expandedEdgeBarHeight,
  placeEdgeBar,
  resizeEdgeBarKeepingAnchor,
  type Rect,
} from './edge-bar-geometry.js'

/** 常见 1080p 工作区（任务栏 40px 高） */
const WORK_AREA: Rect = { x: 0, y: 0, width: 1920, height: 1040 }

const collapsedSize = (): { width: number; height: number } => ({
  width: EDGE_BAR_WIDTHS.collapsed,
  height: EDGE_BAR_COLLAPSED_HEIGHT,
})

const expandedSize = (workArea: Rect): { width: number; height: number } => ({
  width: EDGE_BAR_WIDTHS.expanded,
  height: expandedEdgeBarHeight(workArea),
})

const centerOf = (rect: Rect): number => rect.y + rect.height / 2

describe('提示条几何（docs/07 §2.2）', () => {
  it('默认放置：右缘贴工作区右缘、垂直居中', () => {
    const bounds = placeEdgeBar(WORK_AREA, collapsedSize())
    expect(bounds.x + bounds.width).toBe(WORK_AREA.x + WORK_AREA.width)
    expect(centerOf(bounds)).toBe(WORK_AREA.y + WORK_AREA.height / 2)
    expect(bounds.width).toBe(8)
    expect(bounds.height).toBe(EDGE_BAR_COLLAPSED_HEIGHT)
  })

  it('默认放置在带偏移的工作区（多屏 / 任务栏在左）同样贴右缘并居中', () => {
    const offset: Rect = { x: -1920, y: 40, width: 1920, height: 1000 }
    const bounds = placeEdgeBar(offset, collapsedSize())
    expect(bounds.x + bounds.width).toBe(offset.x + offset.width)
    expect(centerOf(bounds)).toBe(offset.y + offset.height / 2)
  })

  it('展开态高度 = 工作区高 - 上下边距，且不低于收起态高度', () => {
    expect(expandedEdgeBarHeight(WORK_AREA)).toBe(WORK_AREA.height - EDGE_BAR_EXPANDED_MARGIN * 2)
    const tiny: Rect = { x: 0, y: 0, width: 1920, height: 100 }
    expect(expandedEdgeBarHeight(tiny)).toBe(EDGE_BAR_COLLAPSED_HEIGHT)
  })

  it('展开：右缘与垂直中心不变，宽度 8→228、高度变高', () => {
    const collapsed = placeEdgeBar(WORK_AREA, collapsedSize())
    const expanded = resizeEdgeBarKeepingAnchor(collapsed, expandedSize(WORK_AREA), WORK_AREA)
    expect(expanded.width).toBe(EDGE_BAR_WIDTHS.expanded)
    expect(expanded.height).toBeGreaterThan(collapsed.height)
    expect(expanded.x + expanded.width).toBe(collapsed.x + collapsed.width)
    expect(centerOf(expanded)).toBe(centerOf(collapsed))
  })

  it('收起：228→8 后与初始收起态完全一致（往返幂等）', () => {
    const collapsed = placeEdgeBar(WORK_AREA, collapsedSize())
    const expanded = resizeEdgeBarKeepingAnchor(collapsed, expandedSize(WORK_AREA), WORK_AREA)
    const back = resizeEdgeBarKeepingAnchor(expanded, collapsedSize(), WORK_AREA)
    expect(back).toEqual(collapsed)
  })

  it('展开态面板完整落在工作区内（不会伸到下缘之外）', () => {
    const collapsed = placeEdgeBar(WORK_AREA, collapsedSize())
    const expanded = resizeEdgeBarKeepingAnchor(collapsed, expandedSize(WORK_AREA), WORK_AREA)
    expect(expanded.y).toBeGreaterThanOrEqual(WORK_AREA.y)
    expect(expanded.y + expanded.height).toBeLessThanOrEqual(WORK_AREA.y + WORK_AREA.height)
  })

  it('窄工作区：不出现负宽度 / 越界，x 被 clamp 到工作区左边界', () => {
    const narrow: Rect = { x: 100, y: 0, width: 200, height: 400 }
    const placed = placeEdgeBar(narrow, expandedSize(narrow))
    expect(placed.x).toBe(narrow.x)
    expect(placed.width).toBe(EDGE_BAR_WIDTHS.expanded)

    const fromEdge = resizeEdgeBarKeepingAnchor(
      { x: narrow.x + narrow.width - 8, y: 100, width: 8, height: EDGE_BAR_COLLAPSED_HEIGHT },
      expandedSize(narrow),
      narrow,
    )
    expect(fromEdge.x).toBe(narrow.x)
    expect(fromEdge.width).toBeGreaterThan(0)
    // 期望中心 = 100 + 200/2 = 200，被 clamp 后仍要落在这个中心上
    expect(centerOf(fromEdge)).toBe(200)
  })

  it('展开态窗口已越出右缘时仍收敛回工作区内', () => {
    const offscreen: Rect = { x: WORK_AREA.width + 50, y: 400, width: 8, height: 200 }
    const expanded = resizeEdgeBarKeepingAnchor(offscreen, expandedSize(WORK_AREA), WORK_AREA)
    expect(expanded.x + expanded.width).toBe(WORK_AREA.x + WORK_AREA.width)
    expect(expanded.width).toBe(EDGE_BAR_WIDTHS.expanded)
  })
})
