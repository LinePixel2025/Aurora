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
 * 提示条两态宽度：收起态是贴着屏幕右缘的 8px 竖条；展开态请求 328px = 320px 工作台 + 8px 竖条。
 *
 * 渲染层实际按**客户区**排版（面板 `right: 8px`，宽度由客户区宽减去竖条，实测客户区
 * 约 334~335px —— Electron 会给透明窗口补一圈不可见 inset，多出来的几 px 归面板）。
 * 这里的 328 只用于**建窗请求宽度**；`edgeBarShape` 用实际宿主尺寸算区域，不假定律宽。
 */
export const EDGE_BAR_WIDTHS = { collapsed: 8, expanded: 328 } as const

/**
 * 提示条贴附的屏幕侧（v21，`general.edgeBar.position`，docs/07 §2.2）。
 * 几何函数都以可选参数接收（缺省 `'right'` = 既有行为），主进程现读配置传入。
 */
export type EdgeBarSide = 'right' | 'left'

/** 收起态高度：竖条本身的高度（展开态高度见 `expandedEdgeBarHeight`） */
export const EDGE_BAR_COLLAPSED_HEIGHT = 200

/** 展开态面板上下各留的边距，避免贴死屏幕上下缘 */
export const EDGE_BAR_EXPANDED_MARGIN = 24

/**
 * 展开态高度：占满工作区高度减去上下边距（docs/07 §2.2「悬停展开为全高面板」）。
 *
 * 为什么要跟着长高：面板里有自感知 / 提醒 / 最近理解 / 上下文四块信息 + 3 个操作按钮，
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
 * 默认放置：贴工作区 `position` 侧边缘、垂直居中（与 `computeBounds` 的 `edge` 分支语义一致）。
 * 工作区比窗口还窄 / 还矮时被 clamp 到左上边界，不产生越界坐标。
 */
export function placeEdgeBar(workArea: Rect, size: Size, side: EdgeBarSide = 'right'): Rect {
  const maxX = Math.max(workArea.x, workArea.x + workArea.width - size.width)
  const maxY = Math.max(workArea.y, workArea.y + workArea.height - size.height)
  const x = side === 'left' ? workArea.x : workArea.x + workArea.width - size.width
  return {
    x: Math.round(clamp(x, workArea.x, maxX)),
    y: Math.round(clamp(workArea.y + (workArea.height - size.height) / 2, workArea.y, maxY)),
    width: size.width,
    height: size.height,
  }
}

/**
 * 面板朝屏幕内侧的圆角半径（与 `edge-bar/App.vue` 的 `--radius-xl` 同值）。
 * 窗口区域用 1px 阶梯近似这个圆，把 DWM 材质裁到圆角以内。
 */
export const EDGE_BAR_PANEL_RADIUS = 28

/** 竖条的圆角半径（与 `.strip` 的 `border-radius: 6px 0 0 6px` 同值） */
export const EDGE_BAR_STRIP_RADIUS = 6

/**
 * 把矩形**朝屏幕内侧**（左侧）的两个圆角切成 1px 阶梯，返回若干矩形。
 *
 * 为什么需要它：DWM 的系统材质按**窗口区域**裁剪（实测：收起态 shape 只有 8×200 时，
 * 材质也只画在那 8×200 里），而 CSS 的圆角只在页面里成立 —— 不把区域也切成圆角，
 * 面板矩形里被圆角让出的那两个三角就会露出矩形材质（用户 2026-10-11 实测就是这个）。
 * 逐行取圆方程的左内缩量、并把连续相同内缩量的行合并成一个矩形，28px 半径约 20 块/角。
 */
function roundLeftCorners(rect: Rect, radius: number): Rect[] {
  const r = Math.max(0, Math.min(radius, Math.floor(rect.width / 2), Math.floor(rect.height / 2)))
  if (r === 0 || rect.width <= 0 || rect.height <= 0) return [rect]
  /** 距上（或下）边缘 row 行处，圆在该行的左内缩量 */
  const insetAt = (row: number): number => {
    const dy = r - (row + 0.5)
    return Math.round(r - Math.sqrt(Math.max(0, r * r - dy * dy)))
  }
  const out: Rect[] = []
  const rowsFrom = (edge: 'top' | 'bottom'): void => {
    let row = 0
    while (row < r) {
      const inset = insetAt(row)
      let span = 1
      while (row + span < r && insetAt(row + span) === inset) span += 1
      const y = edge === 'top' ? rect.y + row : rect.y + rect.height - row - span
      out.push({
        x: rect.x + inset,
        y,
        width: Math.max(0, rect.width - inset),
        height: span,
      })
      row += span
    }
  }
  rowsFrom('top')
  const middleHeight = rect.height - 2 * r
  if (middleHeight > 0) {
    out.push({ x: rect.x, y: rect.y + r, width: rect.width, height: middleHeight })
  }
  rowsFrom('bottom')
  return out
}

/**
 * 提示条当前可见 / 可交互的原生 shape（窗口坐标，贴渲染层实际使用的右缘）。
 *
 * 宿主 BrowserWindow 始终保持在展开态尺寸，两态只换 shape：
 * - 收起态：右下侧居中的 8×200px 竖条（左圆角 6px 切成阶梯）；
 * - 展开态：**面板矩形（客户区宽 − 8px，左圆角 28px 切成阶梯）+ 竖条矩形**两块。
 *
 * 为什么展开态不是「整个宿主矩形」：材质按窗口区域裁剪（见 `roundLeftCorners`），
 * 而渲染层的面板是**左圆角**的 —— 区域直接把整窗圈进去，圆角外的两个三角就会露出材质。
 * 反过来，竖条上下那两段 8px 也必须留在区域外（那里页面是透明的），否则会变成两条材质带。
 */
export function edgeBarShape(host: Size, expanded: boolean): Rect[] {
  const hostWidth = Math.max(0, Math.round(host.width))
  const hostHeight = Math.max(0, Math.round(host.height))
  const stripWidth = Math.min(EDGE_BAR_WIDTHS.collapsed, hostWidth)
  const stripHeight = Math.min(EDGE_BAR_COLLAPSED_HEIGHT, hostHeight)
  const stripY = Math.max(0, Math.round((hostHeight - stripHeight) / 2))
  if (!expanded) {
    return roundLeftCorners(
      {
        x: Math.max(0, hostWidth - stripWidth),
        y: stripY,
        width: stripWidth,
        height: stripHeight,
      },
      EDGE_BAR_STRIP_RADIUS,
    )
  }
  const panelWidth = Math.max(0, hostWidth - stripWidth)
  const rects: Rect[] = []
  if (panelWidth > 0) {
    rects.push(
      ...roundLeftCorners(
        { x: 0, y: 0, width: panelWidth, height: hostHeight },
        EDGE_BAR_PANEL_RADIUS,
      ),
    )
  }
  if (stripWidth > 0) {
    rects.push(
      ...roundLeftCorners(
        {
          x: Math.max(0, hostWidth - stripWidth),
          y: stripY,
          width: stripWidth,
          height: stripHeight,
        },
        EDGE_BAR_STRIP_RADIUS,
      ),
    )
  }
  return rects
}
