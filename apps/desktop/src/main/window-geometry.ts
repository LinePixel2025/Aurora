/**
 * 窗口几何适配纯函数（2026-11-14，docs/02 §2.2 / docs/07 §1）。
 *
 * 为什么单独一个模块：`window-manager.ts` 依赖 Electron，vitest 只收「不 import
 * electron」的主进程测试（同 `edge-bar-geometry.ts` 的先例）。DPI / 多屏适配的
 * 算术放这里保持纯函数、零依赖，交给 `window-geometry.test.ts` 覆盖。
 *
 * 口径：所有矩形都是 **DIP**（Electron bounds / workArea 同口径），与系统缩放比例
 * 无关；全局界面缩放（zoomFactor）是内容乘数，不参与这里的算术。
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

/** 默认尺寸 fit 工作区时四周保留的余量（不贴死屏幕边缘） */
export const WORK_AREA_FIT_MARGIN = 24

/** 恢复 / 重夹几何时窗口至少留在工作区内的可见量（沿用 readGeometry 既有语义） */
export const MIN_VISIBLE = 40

/**
 * 默认窗口尺寸不超工作区：高 DPI 小屏（如 1366×768 @125% → 工作区约 1093×575）
 * 装不下 chat 1280×800 时按工作区收，避免建窗即出屏、caption 按钮够不到。
 * 工作区本身比余量还小时退化为工作区尺寸（不产生负数）。
 */
export function fitSizeToWorkArea(size: Size, workArea: Rect, margin = WORK_AREA_FIT_MARGIN): Size {
  const maxWidth = Math.max(1, workArea.width - margin)
  const maxHeight = Math.max(1, workArea.height - margin)
  return {
    width: Math.min(size.width, maxWidth),
    height: Math.min(size.height, maxHeight),
  }
}

/**
 * 把窗口矩形夹回工作区：宽高 cap 到工作区（恢复的旧几何可能比当前工作区大），
 * 位置沿用既有 clamp 语义 —— 水平至少留 40px 可见、垂直标题带不出工作区顶 / 底。
 * 全部 round 到整数 DIP，避免小数 bounds 在分数缩放下发虚。
 */
export function clampBoundsToWorkArea(bounds: Rect, workArea: Rect): Rect {
  const width = Math.max(1, Math.min(Math.round(bounds.width), workArea.width))
  const height = Math.max(1, Math.min(Math.round(bounds.height), workArea.height))
  const minX = workArea.x - width + MIN_VISIBLE
  const maxX = workArea.x + workArea.width - MIN_VISIBLE
  const minY = workArea.y
  const maxY = Math.max(minY, workArea.y + workArea.height - MIN_VISIBLE)
  return {
    x: Math.round(Math.min(Math.max(bounds.x, minX), maxX)),
    y: Math.round(Math.min(Math.max(bounds.y, minY), maxY)),
    width,
    height,
  }
}

/** 最小尺寸在小屏上的放宽口径：spec 最小值与工作区 −16 取小（不小于 120×48 兜底） */
export function relaxedMinSize(specMin: Size, workArea: Rect): Size {
  return {
    width: Math.max(120, Math.min(specMin.width, workArea.width - 16)),
    height: Math.max(48, Math.min(specMin.height, workArea.height - 16)),
  }
}
