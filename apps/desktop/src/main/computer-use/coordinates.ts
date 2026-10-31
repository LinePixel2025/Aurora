/**
 * Computer Use 坐标换算（纯函数，docs/06 §28）。
 *
 * 唯一口径：模型读的是**最近一张截图**的像素，动作层把图片坐标换算成物理虚拟屏幕坐标。
 * Electron 的 `screen` / `desktopCapturer` 都在主进程；本文件不 import electron，
 * 便于单测覆盖负坐标、多屏与原点在左上角之外的显示器。
 */

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** 一块显示器在 Electron 里的几何 + 物理原点 / 尺寸（由 main 用 screen 现取）。 */
export interface DisplayGeometry {
  id: number
  /** DIP 矩形（Electron `Display.bounds`） */
  bounds: Rect
  /** 物理虚拟屏幕原点（`screen.dipToScreenPoint(bounds 左上角)`） */
  physicalOrigin: Point
  /** 物理像素尺寸（bounds × scaleFactor，按实际截图像素校准后以 image 为准） */
  physicalSize: { width: number; height: number }
  scaleFactor: number
}

/** 会话级坐标空间：最近一张截图绑定的显示器 / 窗口。 */
export interface ScreenView {
  displayId: number
  /** 物理虚拟屏幕原点（图片左上角对应的物理点） */
  origin: Point
  /** 图片像素 / 物理像素（x / y 分别算，避免取整误差） */
  scaleX: number
  scaleY: number
  imageWidth: number
  imageHeight: number
  /** 截图时的目标窗口（前台或显式指定）；动作命中测试用 */
  targetWindowId?: string
  targetPid?: number
  capturedAt: number
}

export function buildScreenView(input: {
  display: DisplayGeometry
  imageWidth: number
  imageHeight: number
  /** 窗口裁剪时的物理矩形；缺省用整块显示器 */
  physicalRect?: Rect
  targetWindowId?: string
  targetPid?: number
  now?: number
}): ScreenView {
  const { display, imageWidth, imageHeight } = input
  const physicalRect = input.physicalRect
  const physicalWidth = Math.max(1, physicalRect?.width ?? display.physicalSize.width)
  const physicalHeight = Math.max(1, physicalRect?.height ?? display.physicalSize.height)
  return {
    displayId: display.id,
    origin:
      physicalRect === undefined
        ? { ...display.physicalOrigin }
        : { x: physicalRect.x, y: physicalRect.y },
    scaleX: imageWidth / physicalWidth,
    scaleY: imageHeight / physicalHeight,
    imageWidth,
    imageHeight,
    ...(input.targetWindowId === undefined ? {} : { targetWindowId: input.targetWindowId }),
    ...(input.targetPid === undefined ? {} : { targetPid: input.targetPid }),
    capturedAt: input.now ?? Date.now(),
  }
}

/** 图片像素 → 物理虚拟屏幕像素（模型给的坐标默认走这里）。 */
export function imageToPhysical(view: ScreenView, point: Point): Point {
  return {
    x: view.origin.x + point.x / safeScale(view.scaleX),
    y: view.origin.y + point.y / safeScale(view.scaleY),
  }
}

/** 物理虚拟屏幕像素 → 图片像素（结果回显 / UIA 中心点用）。 */
export function physicalToImage(view: ScreenView, point: Point): Point {
  return {
    x: (point.x - view.origin.x) * safeScale(view.scaleX),
    y: (point.y - view.origin.y) * safeScale(view.scaleY),
  }
}

/** 图片里的宽高 → 物理宽高（窗口 resize 用）。 */
export function imageSizeToPhysical(
  view: ScreenView,
  size: { width: number; height: number },
): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(size.width / safeScale(view.scaleX))),
    height: Math.max(1, Math.round(size.height / safeScale(view.scaleY))),
  }
}

/** view 是否仍对应当前显示器（分辨率 / 缩放变化后必须重新截图）。 */
export function viewMatchesDisplay(view: ScreenView, display: DisplayGeometry): boolean {
  return (
    view.displayId === display.id &&
    view.origin.x === display.physicalOrigin.x &&
    view.origin.y === display.physicalOrigin.y
  )
}

/** DIP 点是否落在某显示器矩形内（含边界）。 */
export function rectContains(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  )
}

/** 选择包含鼠标点的显示器；没有命中时回落到主显示器。 */
export function displayAtPoint(
  displays: readonly DisplayGeometry[],
  point: Point,
  primaryId: number,
): DisplayGeometry | undefined {
  return (
    displays.find((display) => rectContains(display.bounds, point)) ??
    displays.find((display) => display.id === primaryId) ??
    displays[0]
  )
}

function safeScale(scale: number): number {
  return Number.isFinite(scale) && scale > 0 ? scale : 1
}
