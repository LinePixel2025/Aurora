import { describe, expect, it } from 'vitest'
import {
  EDGE_BAR_COLLAPSED_HEIGHT,
  EDGE_BAR_EXPANDED_MARGIN,
  EDGE_BAR_WIDTHS,
  edgeBarShape,
  expandedEdgeBarHeight,
  placeEdgeBar,
  type Rect,
} from './edge-bar-geometry.js'

/** 常见 1080p 工作区（任务栏 40px 高） */
const WORK_AREA: Rect = { x: 0, y: 0, width: 1920, height: 1040 }

const collapsedSize = (): { width: number; height: number } => ({
  width: EDGE_BAR_WIDTHS.collapsed,
  height: EDGE_BAR_COLLAPSED_HEIGHT,
})

const hostSize = (workArea: Rect): { width: number; height: number } => ({
  width: EDGE_BAR_WIDTHS.expanded,
  height: expandedEdgeBarHeight(workArea),
})

describe('提示条几何（docs/07 §2.2）', () => {
  it('默认放置：右缘贴工作区右缘、垂直居中', () => {
    const bounds = placeEdgeBar(WORK_AREA, collapsedSize())
    expect(bounds.x + bounds.width).toBe(WORK_AREA.x + WORK_AREA.width)
    expect(bounds.y + bounds.height / 2).toBe(WORK_AREA.y + WORK_AREA.height / 2)
    expect(bounds.width).toBe(8)
    expect(bounds.height).toBe(EDGE_BAR_COLLAPSED_HEIGHT)
  })

  it('默认放置在带偏移的工作区（多屏 / 任务栏在左）同样贴右缘并居中', () => {
    const offset: Rect = { x: -1920, y: 40, width: 1920, height: 1000 }
    const bounds = placeEdgeBar(offset, hostSize(offset))
    expect(bounds.x + bounds.width).toBe(offset.x + offset.width)
    expect(bounds.y + bounds.height / 2).toBe(offset.y + offset.height / 2)
  })

  it('展开态高度 = 工作区高 - 上下边距，且不低于收起态高度', () => {
    expect(expandedEdgeBarHeight(WORK_AREA)).toBe(WORK_AREA.height - EDGE_BAR_EXPANDED_MARGIN * 2)
    const tiny: Rect = { x: 0, y: 0, width: 1920, height: 100 }
    expect(expandedEdgeBarHeight(tiny)).toBe(EDGE_BAR_COLLAPSED_HEIGHT)
  })

  it('宿主窗口两态保持展开尺寸：只换 shape，不做原生尺寸往返', () => {
    const host = placeEdgeBar(WORK_AREA, hostSize(WORK_AREA))
    expect(host.width).toBe(EDGE_BAR_WIDTHS.expanded)
    expect(host.height).toBe(expandedEdgeBarHeight(WORK_AREA))

    const collapsed = edgeBarShape(host, false)
    const expanded = edgeBarShape(host, true)
    expect(collapsed).toHaveLength(1)
    expect(expanded).toHaveLength(1)
  })

  it('收起 shape：贴渲染右缘、垂直居中，保持 8×200px', () => {
    const host = { width: 330, height: 992 }
    expect(edgeBarShape(host, false)).toEqual([
      {
        x: 322,
        y: (992 - EDGE_BAR_COLLAPSED_HEIGHT) / 2,
        width: EDGE_BAR_WIDTHS.collapsed,
        height: EDGE_BAR_COLLAPSED_HEIGHT,
      },
    ])
  })

  it('展开 shape：贴渲染右缘并覆盖完整宿主宽度与高度', () => {
    const host = { width: 330, height: 992 }
    expect(edgeBarShape(host, true)).toEqual([
      { x: 2, y: 0, width: EDGE_BAR_WIDTHS.expanded, height: 992 },
    ])
  })

  it('窄宿主：shape 不出现负宽度 / 越界，收紧到实际可用区域', () => {
    const narrow: Rect = { x: 100, y: 0, width: 200, height: 400 }
    const placed = placeEdgeBar(narrow, hostSize(narrow))
    expect(placed.x).toBe(narrow.x)
    expect(placed.width).toBe(EDGE_BAR_WIDTHS.expanded)

    expect(edgeBarShape({ width: 100, height: 100 }, false)).toEqual([
      { x: 92, y: 0, width: 8, height: 100 },
    ])
    expect(edgeBarShape({ width: 100, height: 100 }, true)).toEqual([
      { x: 0, y: 0, width: 100, height: 100 },
    ])
  })

  // ───── v21：贴附屏幕侧可配置（general.edgeBar.position，docs/07 §2.2）─────

  it('左侧放置：左缘贴工作区左缘、垂直居中；默认参数仍贴右缘', () => {
    const left = placeEdgeBar(WORK_AREA, hostSize(WORK_AREA), 'left')
    expect(left.x).toBe(WORK_AREA.x)
    expect(left.y + left.height / 2).toBe(WORK_AREA.y + WORK_AREA.height / 2)
    // 缺省参数 = 既有右缘行为（老调用点不动）
    expect(placeEdgeBar(WORK_AREA, collapsedSize()).x + 8).toBe(WORK_AREA.width)
  })
})
