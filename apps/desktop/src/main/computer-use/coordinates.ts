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
  /**
   * 截图时显示器的物理几何快照。
   *
   * 与 `origin` 分开：`origin` 是**本次图像**覆盖区域的左上角（窗口裁剪时是窗口），
   * 这三个字段是**显示器**的绝对几何 —— 动作前用它校验「分辨率 / 缩放 / 显示器增删」
   * 是否变化（`viewMatchesDisplay`），窗口裁剪视图同样适用。
   */
  displayPhysicalOrigin: Point
  displayPhysicalSize: { width: number; height: number }
  displayScaleFactor: number
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
  /** 目标窗口 exe basename（小写）：同一应用多进程窗口仍视为同一目标 */
  targetExe?: string
  /** 截图时目标窗口的物理矩形：动作前校验窗口是否被移动 / 缩放 */
  targetBounds?: Rect
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
  targetExe?: string
  targetBounds?: Rect
  now?: number
}): ScreenView {
  const { display, imageWidth, imageHeight } = input
  const physicalRect = input.physicalRect
  const physicalWidth = Math.max(1, physicalRect?.width ?? display.physicalSize.width)
  const physicalHeight = Math.max(1, physicalRect?.height ?? display.physicalSize.height)
  return {
    displayId: display.id,
    displayPhysicalOrigin: { ...display.physicalOrigin },
    displayPhysicalSize: { ...display.physicalSize },
    displayScaleFactor: display.scaleFactor,
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
    ...(input.targetExe === undefined ? {} : { targetExe: input.targetExe }),
    ...(input.targetBounds === undefined ? {} : { targetBounds: input.targetBounds }),
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

/** view 是否仍对应当前显示器（分辨率 / 缩放 / 显示器增删后必须重新截图）。 */
export function viewMatchesDisplay(view: ScreenView, display: DisplayGeometry): boolean {
  return (
    view.displayId === display.id &&
    view.displayPhysicalOrigin.x === display.physicalOrigin.x &&
    view.displayPhysicalOrigin.y === display.physicalOrigin.y &&
    view.displayPhysicalSize.width === display.physicalSize.width &&
    view.displayPhysicalSize.height === display.physicalSize.height &&
    view.displayScaleFactor === display.scaleFactor
  )
}

/** 目标窗口在截图后是否被移动 / 缩放（容差吸收 DWM 边框取整）；最小化另由调用方判断。 */
export function targetBoundsMoved(before: Rect, after: Rect, tolerancePx = 6): boolean {
  const tolerance = Math.max(0, tolerancePx)
  return (
    Math.abs(before.x - after.x) > tolerance ||
    Math.abs(before.y - after.y) > tolerance ||
    Math.abs(before.width - after.width) > tolerance ||
    Math.abs(before.height - after.height) > tolerance
  )
}

export interface ScreenCapturePlan {
  /** 源图像素里的裁剪矩形；undefined = 不裁剪 */
  crop?: Rect
  /** 最终图片覆盖的物理区域（窗口裁剪时是实际裁剪出来的物理区域） */
  physicalRect: Rect
  /** 源图宽度 / 物理宽度（1 = 源图本身就是物理像素） */
  sourceScaleX: number
  sourceScaleY: number
  cropped: boolean
  /** 请求了窗口裁剪但没裁成（宽高比异常 / 窗口不在屏内），调用方应提示「已改截整屏」 */
  cropFailed: boolean
  warning?: string
}

/** 源图像素与物理像素的「1:1」容差：吸收 Electron 1px 级的 DIP 取整误差。 */
const SOURCE_SCALE_EPSILON = 0.005
/** 源图宽高比与显示器宽高比的相对差容差。 */
const SOURCE_ASPECT_EPSILON = 0.005

/**
 * 计算一次截图该怎么裁剪、以及图片覆盖的物理区域（纯函数，docs/06 §28）。
 *
 * **不能假设 Electron 返回的缩略图像素等于物理像素**（官方文档明确写 depends on the
 * scale of the screen）。本函数用**实际源图尺寸**反算 `sourceScale`：
 * - 源图接近 1:1 → `physicalRect` 用源图宽高（同时修正 Electron 物理尺寸 1px 的取整差）；
 * - 源图被缩放（DIP / 低分辨率）→ `physicalRect` 用显示器物理尺寸；
 * - 窗口裁剪：先把窗口物理矩形换算成**源图像素**再取整裁剪，`physicalRect` 由实际裁剪反算；
 * - 宽高比异常 / 窗口不在屏内 → 不裁剪、回整屏，并让调用方在结果里说明。
 */
export function planScreenCapture(input: {
  display: DisplayGeometry
  sourceWidth: number
  sourceHeight: number
  windowRect?: Rect
}): ScreenCapturePlan {
  const { display, windowRect } = input
  const sourceWidth = Math.max(1, Math.round(input.sourceWidth))
  const sourceHeight = Math.max(1, Math.round(input.sourceHeight))
  const displayRect: Rect = {
    x: display.physicalOrigin.x,
    y: display.physicalOrigin.y,
    width: Math.max(1, Math.round(display.physicalSize.width)),
    height: Math.max(1, Math.round(display.physicalSize.height)),
  }
  const physicalAspect = displayRect.width / displayRect.height
  const sourceAspect = sourceWidth / sourceHeight
  const aspectDelta = Math.abs(sourceAspect - physicalAspect) / Math.max(0.0001, physicalAspect)
  const sourceIsPhysical =
    Math.abs(sourceWidth / displayRect.width - 1) <= SOURCE_SCALE_EPSILON &&
    Math.abs(sourceHeight / displayRect.height - 1) <= SOURCE_SCALE_EPSILON
  // 整屏覆盖的物理矩形：1:1 源图用源图宽高（更准），否则用显示器物理尺寸。
  const basePhysical: Rect = sourceIsPhysical
    ? { x: displayRect.x, y: displayRect.y, width: sourceWidth, height: sourceHeight }
    : { ...displayRect }
  const sourceScaleX = sourceWidth / basePhysical.width
  const sourceScaleY = sourceHeight / basePhysical.height
  const fallback = (warning: string): ScreenCapturePlan => ({
    physicalRect: { ...basePhysical },
    sourceScaleX,
    sourceScaleY,
    cropped: false,
    cropFailed: windowRect !== undefined,
    warning,
  })

  if (windowRect === undefined) {
    return {
      physicalRect: { ...basePhysical },
      sourceScaleX,
      sourceScaleY,
      cropped: false,
      cropFailed: false,
    }
  }
  if (aspectDelta > SOURCE_ASPECT_EPSILON) {
    return fallback('截屏源宽高比与显示器不一致，已跳过窗口裁剪')
  }
  const overlapWidth =
    Math.min(windowRect.x + windowRect.width, displayRect.x + displayRect.width) -
    Math.max(windowRect.x, displayRect.x)
  const overlapHeight =
    Math.min(windowRect.y + windowRect.height, displayRect.y + displayRect.height) -
    Math.max(windowRect.y, displayRect.y)
  if (overlapWidth <= 1 || overlapHeight <= 1) {
    return fallback('目标窗口不在显示器内，已截整屏')
  }
  const target = clampRect(windowRect, displayRect)
  const cropX = clampInt(
    Math.round((target.x - displayRect.x) * sourceScaleX),
    0,
    Math.max(0, sourceWidth - 1),
  )
  const cropY = clampInt(
    Math.round((target.y - displayRect.y) * sourceScaleY),
    0,
    Math.max(0, sourceHeight - 1),
  )
  const cropWidth = clampInt(Math.round(target.width * sourceScaleX), 1, sourceWidth - cropX)
  const cropHeight = clampInt(Math.round(target.height * sourceScaleY), 1, sourceHeight - cropY)
  return {
    crop: { x: cropX, y: cropY, width: cropWidth, height: cropHeight },
    physicalRect: {
      x: displayRect.x + cropX / sourceScaleX,
      y: displayRect.y + cropY / sourceScaleY,
      width: cropWidth / sourceScaleX,
      height: cropHeight / sourceScaleY,
    },
    sourceScaleX,
    sourceScaleY,
    cropped: true,
    cropFailed: false,
  }
}

function clampRect(rect: Rect, bounds: Rect): Rect {
  const left = clampInt(Math.round(rect.x), bounds.x, bounds.x + bounds.width)
  const top = clampInt(Math.round(rect.y), bounds.y, bounds.y + bounds.height)
  const right = clampInt(Math.round(rect.x + rect.width), left + 1, bounds.x + bounds.width)
  const bottom = clampInt(Math.round(rect.y + rect.height), top + 1, bounds.y + bounds.height)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
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

/**
 * 按**物理点**选显示器（窗口列表 / UIA 的矩形都是物理像素）。
 *
 * 不要拿物理点去和 `display.bounds`（DIP）比 —— 150% 缩放下这是两套坐标；
 * 混合 DPI 多屏时会把窗口判到错误的显示器。
 */
export function displayAtPhysicalPoint(
  displays: readonly DisplayGeometry[],
  point: Point,
  primaryId: number,
): DisplayGeometry | undefined {
  const rectOf = (display: DisplayGeometry): Rect => ({
    x: display.physicalOrigin.x,
    y: display.physicalOrigin.y,
    width: display.physicalSize.width,
    height: display.physicalSize.height,
  })
  return (
    displays.find((display) => rectContains(rectOf(display), point)) ??
    displays.find((display) => display.id === primaryId) ??
    displays[0]
  )
}

function safeScale(scale: number): number {
  return Number.isFinite(scale) && scale > 0 ? scale : 1
}
