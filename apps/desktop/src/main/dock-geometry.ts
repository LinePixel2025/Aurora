/**
 * 服务窗（圆形浮球 ↔ 输入条）几何计算（docs/07 §2.1）。
 *
 * 为什么单独一个模块：`window-manager.ts` 依赖 Electron（`BrowserWindow` / `screen`），
 * 而 vitest 只收「不 import electron」的主进程测试，几何算术放在那里就没法单测。
 * 这里保持纯函数、零依赖，交给 `dock-geometry.test.ts` 覆盖。
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * 以 `(x, y)` 作为左上角放置指定尺寸，并整体 clamp 进工作区。
 *
 * `x` 为期望的水平中心、`y` 为期望的底边（服务窗贴屏幕下方，形态切换时底边不动更稳），
 * 这里把「期望中心 / 期望底边」换算成可用的左上角坐标。
 */
export function placeDockWithCenterBottom(
  centerX: number,
  bottom: number,
  size: Size,
  workArea: Rect,
): Rect {
  const maxX = workArea.x + workArea.width - size.width
  const maxY = workArea.y + workArea.height - size.height
  return {
    x: Math.round(clamp(centerX - size.width / 2, workArea.x, maxX)),
    y: Math.round(clamp(bottom - size.height, workArea.y, maxY)),
    width: size.width,
    height: size.height,
  }
}

/**
 * 折叠态切换：保持当前窗口的水平中心与底边不变，换成目标尺寸并 clamp 进工作区。
 * 这样圆球展开成输入条时是「向左右生长」，收起时是「向中心回缩」，不会整体跳位。
 */
export function resizeDockKeepingAnchor(current: Rect, size: Size, workArea: Rect): Rect {
  return placeDockWithCenterBottom(
    current.x + current.width / 2,
    current.y + current.height,
    size,
    workArea,
  )
}

/**
 * 恢复已保存的位置：尺寸由当前折叠态决定（**不复用持久化尺寸**，
 * 否则收起态会继承上次输入条的宽高，圆球形态被破坏）。
 *
 * 传入的 `saved.x` / `saved.y` 必须是 `dockAnchorRect()` 写出的**收起态锚点**，
 * 而不是某次展开态窗口的左上角。
 */
export function restoreDockBounds(
  saved: { x: number; y: number },
  size: Size,
  workArea: Rect,
): Rect {
  return placeDockWithCenterBottom(saved.x + size.width / 2, saved.y + size.height, size, workArea)
}

/**
 * 把当前窗口矩形归一化成**与折叠态无关**的锚点矩形，供持久化使用。
 *
 * 为什么不直接存窗口左上角：服务窗有两种尺寸，若退出时停在展开态（320×56），
 * 存下的 `x` 是输入条的左边缘；下次启动按圆球（56×56）恢复时会以该左边缘为中心，
 * 浮球整体左移约 132px。归一化成「同一个中心 / 底边下的收起态矩形」后，
 * 无论何时退出，恢复出的圆球位置都一致。
 */
export function dockAnchorRect(current: Rect, collapsedSize: Size): Rect {
  return {
    x: Math.round(current.x + current.width / 2 - collapsedSize.width / 2),
    y: Math.round(current.y + current.height - collapsedSize.height),
    width: collapsedSize.width,
    height: collapsedSize.height,
  }
}
