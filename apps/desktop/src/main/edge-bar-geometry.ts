/**
 * 提示条（右侧 Edge Bar）两态几何计算（docs/07 §2.2）。
 *
 * 为什么单独一个模块：`window-manager.ts` 依赖 Electron（`BrowserWindow` / `screen`），
 * 而 vitest 只收「不 import electron」的主进程测试，几何算术放在那里就没法单测。
 * 这里保持纯函数、零依赖，交给 `edge-bar-geometry.test.ts` 覆盖。
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

/**
 * 提示条两态宽度：收起态是贴着屏幕右缘的 8px 竖条；
 * 展开态 228px = 200px 面板 + 8px 竖条 + 20px 余量（面板自身的 padding / 阴影 / 圆角需要这点空间，
 * 否则内容会被窗口边缘裁掉）。
 *
 * 与渲染层 `edge-bar/App.vue` 的 `.panel { width: 220px }` 是同一份约定，改一处必须同时改另一处。
 */
export const EDGE_BAR_WIDTHS = { collapsed: 8, expanded: 228 } as const

/** 收起态高度：竖条本身的高度（展开态高度见 `expandedEdgeBarHeight`） */
export const EDGE_BAR_COLLAPSED_HEIGHT = 200

/** 展开态面板上下各留的边距，避免贴死屏幕上下缘 */
export const EDGE_BAR_EXPANDED_MARGIN = 24

/**
 * 展开态高度：占满工作区高度减去上下边距（docs/07 §2.2「悬停展开为全高面板」）。
 *
 * 为什么要跟着长高：面板里有状态 / 模式 / 最近消息 / 系统状态四块信息 + 4 个操作按钮，
 * 200px 高度装不下 —— 按钮会被挤到可视区域之外，用户"看得到面板却点不到按钮"。
 */
export function expandedEdgeBarHeight(workArea: Rect): number {
  return Math.max(
    EDGE_BAR_COLLAPSED_HEIGHT,
    Math.round(workArea.height - EDGE_BAR_EXPANDED_MARGIN * 2),
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * 默认放置：右缘贴工作区右缘、垂直居中（与 `computeBounds` 的 `edge` 分支语义一致）。
 * 工作区比窗口还窄 / 还矮时被 clamp 到左上边界，不产生越界坐标。
 */
export function placeEdgeBar(workArea: Rect, size: Size): Rect {
  const maxX = Math.max(workArea.x, workArea.x + workArea.width - size.width)
  const maxY = Math.max(workArea.y, workArea.y + workArea.height - size.height)
  return {
    x: Math.round(clamp(workArea.x + workArea.width - size.width, workArea.x, maxX)),
    y: Math.round(clamp(workArea.y + (workArea.height - size.height) / 2, workArea.y, maxY)),
    width: size.width,
    height: size.height,
  }
}

/**
 * 两态切换：**右缘固定 + 垂直中心固定**，宽度与高度换成目标尺寸。
 *
 * 保持右缘而不是保持左缘：提示条贴的是屏幕物理右缘，收起态那 8px 必须始终贴着边缘，
 * 否则展开再收起后竖条会整体左移，屏幕最右侧反而漏出一条缝。
 * 保持垂直中心：展开成半屏高度时竖条的中心不能跳位，否则鼠标会"跑出"面板。
 */
export function resizeEdgeBarKeepingAnchor(current: Rect, size: Size, workArea: Rect): Rect {
  const right = current.x + current.width
  const centerY = current.y + current.height / 2
  const maxX = Math.max(workArea.x, workArea.x + workArea.width - size.width)
  const maxY = Math.max(workArea.y, workArea.y + workArea.height - size.height)
  return {
    x: Math.round(clamp(right - size.width, workArea.x, maxX)),
    y: Math.round(clamp(centerY - size.height / 2, workArea.y, maxY)),
    width: size.width,
    height: size.height,
  }
}
