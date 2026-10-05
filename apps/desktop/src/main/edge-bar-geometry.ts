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
 * 展开态 328px = 320px 感知工作台 + 8px 竖条。320px 用于同时容纳自感知状态、
 * 最近理解与上下文摘要，避免旧版 220px 下每张卡片都被压成两三行。
 *
 * 与渲染层 `edge-bar/App.vue` 的 `.panel { width: 320px }` 是同一份约定，改一处必须同时改另一处。
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
 * 提示条当前可见 / 可交互的原生 shape（窗口坐标，贴渲染层实际使用的右缘）。
 *
 * 宿主 BrowserWindow 始终保持在展开态尺寸，两态只换 shape：展开覆盖完整面板宽度，
 * 收起只留右下侧居中的 8×200px。由于当前窗口几何与左侧配置仍沿用既有右缘布局，
 * 这里不额外翻转 shape，避免在动画修复中顺带改变 `position: left` 的既有观感。
 */
export function edgeBarShape(host: Size, expanded: boolean): Rect[] {
  const hostWidth = Math.max(0, Math.round(host.width))
  const hostHeight = Math.max(0, Math.round(host.height))
  const targetWidth = expanded ? EDGE_BAR_WIDTHS.expanded : EDGE_BAR_WIDTHS.collapsed
  const width = Math.min(targetWidth, hostWidth)
  const height = expanded ? hostHeight : Math.min(EDGE_BAR_COLLAPSED_HEIGHT, hostHeight)
  return [
    {
      x: Math.max(0, hostWidth - width),
      y: expanded ? 0 : Math.max(0, Math.round((hostHeight - height) / 2)),
      width,
      height,
    },
  ]
}
