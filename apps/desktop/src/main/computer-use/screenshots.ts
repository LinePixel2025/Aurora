/**
 * Computer Use 截屏（主进程实现，docs/06 §28）。
 *
 * 与 `tools/screenshot-port.ts` 的区别：
 * - 这里是**坐标空间**的一部分 —— 返回图片尺寸与物理矩形，供端口构建 `ScreenView`；
 * - 按窗口裁剪、按最长边缩放、优先 JPEG（模型只看需要看清的文字，JPEG 更省 token）；
 * - 浮层由 `setContentProtection(true)` 排除在系统抓屏之外（见 window-manager）。
 *
 * Electron 的 `desktopCapturer` / `screen` 只在主进程可用；本文件没有单测，
 * 纯换算逻辑在 coordinates.ts，落盘 / 清理复用 image-store。
 */
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { desktopCapturer, screen, type Display, type NativeImage } from 'electron'
import type { Logger } from '@aurora/shared'
import type { ToolImage } from '@aurora/agent-core'
import { IMAGE_MAX_BYTES } from '../attachments.js'
import { selectExpiredFiles } from '../tools/image-store.js'
import type { DisplayGeometry, Rect } from './coordinates.js'

const JPEG_QUALITY = 80
const KEEP = 50

export interface CaptureDisplayOptions {
  dir: string
  logger: Logger
  display: DisplayGeometry
  /** 只截这个物理矩形（窗口），坐标是虚拟屏幕物理像素 */
  windowRect?: Rect
  maxWidth: number
}

export interface CapturedImage {
  image: ToolImage
  imageWidth: number
  imageHeight: number
  path: string
  bytes: number
  /** 实际截取的物理矩形（窗口裁剪后） */
  physicalRect: Rect
  mimeType: string
}

/** 当前所有显示器的几何（DIP + 物理原点 / 尺寸）。 */
export function listDisplayGeometries(): DisplayGeometry[] {
  return screen.getAllDisplays().map((display) => displayGeometryOf(display))
}

/** 主显示器 id（Electron `Display.id`）。 */
export function primaryDisplayId(): number {
  return screen.getPrimaryDisplay().id
}

/** 光标所在的显示器 id（DIP 点）。 */
export function displayIdAtCursor(): number {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id
}

/** DIP 点 → 物理虚拟屏幕点；Electron 在 Windows 上提供精确的每屏换算。 */
export function dipToPhysical(point: { x: number; y: number }): { x: number; y: number } {
  try {
    return screen.dipToScreenPoint(point)
  } catch {
    const display = screen.getDisplayNearestPoint(point)
    const factor = display.scaleFactor > 0 ? display.scaleFactor : 1
    return {
      x: Math.round(display.bounds.x + (point.x - display.bounds.x) * factor),
      y: Math.round(display.bounds.y + (point.y - display.bounds.y) * factor),
    }
  }
}

function displayGeometryOf(display: Display): DisplayGeometry {
  const topLeft = display.bounds
  const bottomRight = {
    x: display.bounds.x + display.bounds.width,
    y: display.bounds.y + display.bounds.height,
  }
  const physicalTopLeft = dipToPhysical({ x: topLeft.x, y: topLeft.y })
  const physicalBottomRight = dipToPhysical(bottomRight)
  return {
    id: display.id,
    bounds: {
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
    },
    physicalOrigin: physicalTopLeft,
    physicalSize: {
      width: Math.max(1, physicalBottomRight.x - physicalTopLeft.x),
      height: Math.max(1, physicalBottomRight.y - physicalTopLeft.y),
    },
    scaleFactor: display.scaleFactor > 0 ? display.scaleFactor : 1,
  }
}

/**
 * 截一块显示器（可选按窗口裁剪），返回落盘后的图片与物理矩形。
 *
 * `desktopCapturer` 一次只给一张缩略图；`thumbnailSize` 必须是物理像素，
 * 否则高分屏会被按逻辑分辨率缩掉，文字发虚、坐标也会偏。
 */
export async function captureDisplay(options: CaptureDisplayOptions): Promise<CapturedImage> {
  const { display } = options
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.max(1, display.physicalSize.width),
      height: Math.max(1, display.physicalSize.height),
    },
  })
  const source =
    sources.find((item) => item.display_id === String(display.id)) ??
    (sources.length === 1 ? sources[0] : undefined)
  if (source === undefined) throw new Error('找不到对应显示器的截屏源')

  let image = source.thumbnail
  if (image.isEmpty()) throw new Error('截屏得到空图片')

  const fullSize = image.getSize()
  const physicalRect = clampRect(
    options.windowRect ?? {
      x: display.physicalOrigin.x,
      y: display.physicalOrigin.y,
      width: display.physicalSize.width,
      height: display.physicalSize.height,
    },
    {
      x: display.physicalOrigin.x,
      y: display.physicalOrigin.y,
      width: fullSize.width,
      height: fullSize.height,
    },
  )
  if (options.windowRect !== undefined) {
    image = image.crop({
      x: Math.round(physicalRect.x - display.physicalOrigin.x),
      y: Math.round(physicalRect.y - display.physicalOrigin.y),
      width: Math.max(1, Math.round(physicalRect.width)),
      height: Math.max(1, Math.round(physicalRect.height)),
    })
  }

  const maxWidth = Math.max(640, Math.min(2560, Math.round(options.maxWidth)))
  image = resizeToWidth(image, maxWidth)

  let encoded = image.toJPEG(JPEG_QUALITY)
  let mimeType = 'image/jpeg'
  if (encoded.byteLength === 0) {
    encoded = image.toPNG()
    mimeType = 'image/png'
  }
  for (let round = 0; round < 3 && encoded.byteLength > IMAGE_MAX_BYTES; round += 1) {
    const size = image.getSize()
    image = image.resize({ width: Math.max(320, Math.round(size.width * 0.72)), quality: 'good' })
    encoded = image.toJPEG(JPEG_QUALITY)
    mimeType = 'image/jpeg'
  }
  if (encoded.byteLength > IMAGE_MAX_BYTES) {
    throw new Error('截屏缩放后仍超过单图上限')
  }

  await fs.mkdir(options.dir, { recursive: true })
  const extension = mimeType === 'image/png' ? '.png' : '.jpg'
  const filePath = join(options.dir, `${Date.now()}-${randomBytes(3).toString('hex')}${extension}`)
  await fs.writeFile(filePath, encoded)
  await prune(options.dir, options.logger)

  const finalSize = image.getSize()
  options.logger.info('Computer Use 已截屏', {
    displayId: display.id,
    width: finalSize.width,
    height: finalSize.height,
    bytes: encoded.byteLength,
  })
  return {
    image: {
      path: filePath,
      image: {
        mimeType,
        dataBase64: encoded.toString('base64'),
        name: basename(filePath),
      },
    },
    imageWidth: finalSize.width,
    imageHeight: finalSize.height,
    path: filePath,
    bytes: encoded.byteLength,
    physicalRect,
    mimeType,
  }
}

function resizeToWidth(image: NativeImage, maxWidth: number): NativeImage {
  const size = image.getSize()
  if (size.width <= maxWidth) return image
  return image.resize({ width: maxWidth, quality: 'good' })
}

function clampRect(rect: Rect, bounds: Rect): Rect {
  const left = Math.max(bounds.x, Math.min(bounds.x + bounds.width, Math.round(rect.x)))
  const top = Math.max(bounds.y, Math.min(bounds.y + bounds.height, Math.round(rect.y)))
  const right = Math.max(
    left + 1,
    Math.min(bounds.x + bounds.width, Math.round(rect.x + rect.width)),
  )
  const bottom = Math.max(
    top + 1,
    Math.min(bounds.y + bounds.height, Math.round(rect.y + rect.height)),
  )
  return { x: left, y: top, width: right - left, height: bottom - top }
}

async function prune(dir: string, logger: Logger): Promise<void> {
  try {
    const names = (await fs.readdir(dir)).filter((name) => /\.(png|jpe?g)$/i.test(name))
    const expired = selectExpiredFiles(names, KEEP)
    for (const name of expired) await fs.rm(join(dir, name), { force: true })
  } catch (error) {
    logger.warn('清理旧 Computer Use 截图失败', { error: String(error) })
  }
}
