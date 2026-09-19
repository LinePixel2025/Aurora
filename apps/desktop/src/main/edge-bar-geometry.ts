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
 * 与渲染层 `edge-bar/App.vue` 的 `.panel { width: 200px }` 是同一份约定，改一处必须同时改另一处。
 */
export const EDGE_BAR_WIDTHS = { collapsed: 8, expanded: 228 } as const

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * 默认放置：右缘贴工作区右缘、垂直居中（与 `computeBounds` 的 `edge` 分支语义一致）。
 * 工作区比窗口还窄时 x 被 clamp 到左边界，不产生越界坐标。
 */
export function placeEdgeBar(workArea: Rect, size: Size): Rect {
  const maxX = Math.max(workArea.x, workArea.x + workArea.width - size.width)
  return {
    x: Math.round(clamp(workArea.x + workArea.width - size.width, workArea.x, maxX)),
    y: Math.round(workArea.y + (workArea.height - size.height) / 2),
    width: size.width,
    height: size.height,
  }
}

/**
 * 两态切换：**右缘固定**、`y` 与 `height` 不变，只改宽度（展开时向左生长）。
 *
 * 保持右缘而不是保持左缘：提示条贴的是屏幕物理右缘，收起态那 8px 必须始终贴着边缘，
 * 否则展开再收起后竖条会整体左移，屏幕最右侧反而漏出一条缝。
 */
export function resizeEdgeBarKeepingRight(current: Rect, width: number, workArea: Rect): Rect {
  const right = current.x + current.width
  const maxX = Math.max(workArea.x, workArea.x + workArea.width - width)
  return {
    x: Math.round(clamp(right - width, workArea.x, maxX)),
    y: current.y,
    width,
    height: current.height,
  }
}
