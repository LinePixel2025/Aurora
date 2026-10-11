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

/** 一组 shape 矩形的并集包围盒（阶梯圆角下不能再拿单块矩形当整体看） */
const unionOf = (rects: Rect[]): { x: number; y: number; right: number; bottom: number } => ({
  x: Math.min(...rects.map((r) => r.x)),
  y: Math.min(...rects.map((r) => r.y)),
  right: Math.max(...rects.map((r) => r.x + r.width)),
  bottom: Math.max(...rects.map((r) => r.y + r.height)),
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
    // 两态都是**多块**：圆角用 1px 阶梯近似（DWM 材质按窗口区域裁剪，见 edgeBarShape 的注释）
    expect(collapsed.length).toBeGreaterThan(1)
    expect(expanded.length).toBeGreaterThan(10)
  })

  it('收起 shape：贴渲染右缘、垂直居中，8×200px，左圆角切成阶梯', () => {
    const host = { width: 330, height: 992 }
    const rects = edgeBarShape(host, false)
    const union = unionOf(rects)
    expect(union.x).toBe(322)
    expect(union.right).toBe(330)
    expect(union.y).toBe((992 - EDGE_BAR_COLLAPSED_HEIGHT) / 2)
    expect(union.bottom - union.y).toBe(EDGE_BAR_COLLAPSED_HEIGHT)
    // 每一块都在竖条列内；最上面那块被圆角内缩（阶梯意味着首块 x > 列左缘）
    expect(rects.every((r) => r.x >= 322 && r.x + r.width <= 330)).toBe(true)
    expect(rects[0]?.x).toBeGreaterThan(322)
    // 中间那块是完整的 8px 宽
    expect(rects.some((r) => r.x === 322 && r.width === 8)).toBe(true)
  })

  it('展开 shape：面板（左圆角阶梯）+ 竖条两块，覆盖客户区而不覆盖竖条上下那两段', () => {
    const host = { width: 330, height: 992 }
    const rects = edgeBarShape(host, true)
    const union = unionOf(rects)
    expect(union.x).toBe(0)
    expect(union.right).toBe(330)
    expect(union.y).toBe(0)
    expect(union.bottom).toBe(992)
    // 面板主体（除圆角行）铺满 0..322；首行被 28px 圆角内缩
    expect(rects.some((r) => r.x === 0 && r.width === 322)).toBe(true)
    const panelTop = rects.find((r) => r.y === 0)
    expect(panelTop?.x).toBeGreaterThan(0)
    // 竖条只占 8×200 的居中一段：超过该范围的块不许出现在竖条列里
    const stripTop = union.y + Math.round((992 - EDGE_BAR_COLLAPSED_HEIGHT) / 2)
    const stripBottom = stripTop + EDGE_BAR_COLLAPSED_HEIGHT
    const stray = rects.filter(
      (r) => r.x >= 322 && (r.y < stripTop || r.y + r.height > stripBottom),
    )
    expect(stray).toEqual([])
  })

  it('窄宿主：shape 不出现负宽度 / 越界，收紧到实际可用区域', () => {
    const narrow: Rect = { x: 100, y: 0, width: 200, height: 400 }
    const placed = placeEdgeBar(narrow, hostSize(narrow))
    expect(placed.x).toBe(narrow.x)
    expect(placed.width).toBe(EDGE_BAR_WIDTHS.expanded)

    const collapsed = edgeBarShape({ width: 100, height: 100 }, false)
    expect(unionOf(collapsed)).toEqual({ x: 92, y: 0, right: 100, bottom: 100 })
    const expanded = edgeBarShape({ width: 100, height: 100 }, true)
    expect(unionOf(expanded)).toEqual({ x: 0, y: 0, right: 100, bottom: 100 })
    expect(expanded.every((r) => r.x >= 0 && r.y >= 0 && r.width >= 0 && r.height >= 0)).toBe(true)
  })

  it('宿主比竖条还窄：并集仍是实际可用区域、不产生负宽度', () => {
    for (const expanded of [false, true]) {
      const rects = edgeBarShape({ width: 5, height: 40 }, expanded)
      expect(unionOf(rects)).toEqual({ x: 0, y: 0, right: 5, bottom: 40 })
      expect(rects.every((r) => r.width >= 0 && r.height >= 0)).toBe(true)
    }
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
