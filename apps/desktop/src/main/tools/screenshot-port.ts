/**
 * `ScreenshotPort` 的主进程实现（图像工具，docs/06 §25）。
 *
 * 用 Electron 的 `desktopCapturer` 取屏幕缩略图 —— 在**主进程**里调用它不需要
 * `setDisplayMediaRequestHandler`（那是渲染层 `getDisplayMedia` 那条路）。
 *
 * 本文件 import electron（`desktopCapturer` / `screen`），因此**没有也不该有**单测
 * （vitest 的 Node 环境加载不了它）；纯逻辑已抽到 `image-store.ts`，
 * 参数校验与 `sensitivity: 'confirm'` 语义由 agent-core 的 `createScreenshotTool` 覆盖。
 *
 * 三条口径：
 * - **每块屏一张图**：`desktopCapturer` 一次只给一张缩略图，多屏拼合要靠额外的图像合成；
 *   而各屏的原始分辨率本身对模型更友好（`all` 时返回多张，工具层逐张下发）；
 * - **按屏取像素尺寸**：`thumbnailSize` 必须是该屏的 `size × scaleFactor`，否则高分屏
 *   会被缩成逻辑分辨率（截出来的字发虚，正是这类工具最需要看清的东西）；
 * - **超限自动降采样**：单张超过 `IMAGE_MAX_BYTES`（8 MiB）时按 0.7 逐次缩小重编码，
 *   与附件管线同一个上限 —— 静默发一张 20 MB 的图会把请求体顶爆。
 */
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { desktopCapturer, screen, type Display, type DesktopCapturerSource } from 'electron'
import type { Logger } from '@aurora/shared'
import type { ScreenshotPort, ToolImage } from '@aurora/agent-core'
import { IMAGE_MAX_BYTES } from '../attachments.js'
import { imageFileName, selectExpiredFiles } from './image-store.js'

const PNG_MIME = 'image/png'

/** 目录里保留最近多少张（与日志按天轮转同理：产物目录不该无限长）。 */
export const SCREENSHOT_KEEP = 50

export interface ScreenshotPortOptions {
  /** 落盘目录（装配层传 `<userData>/screenshots`，同时也是 view_image 的白名单根之一） */
  dir: string
  logger: Logger
  /** 保留最近多少张；缺省 `SCREENSHOT_KEEP`（传 0 表示不清理） */
  keep?: number
}

export function createScreenshotPort(options: ScreenshotPortOptions): ScreenshotPort {
  const keep = options.keep ?? SCREENSHOT_KEEP
  return {
    async capture({ display }): Promise<ToolImage[]> {
      const targets = display === 'all' ? screen.getAllDisplays() : [screen.getPrimaryDisplay()]
      const out: ToolImage[] = []

      for (const target of targets) {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: pixelSizeOf(target),
        })
        const source = pickSource(sources, target.id)
        if (source === undefined) {
          options.logger.warn('截屏：找不到对应的显示器源', { displayId: target.id })
          continue
        }
        const encoded = encodeWithinLimit(source, options)
        if (encoded === undefined) continue

        const filePath = await writePng(options.dir, encoded)
        out.push({
          path: filePath,
          image: {
            mimeType: PNG_MIME,
            dataBase64: encoded.toString('base64'),
            name: basename(filePath),
          },
        })
      }

      await prune(options.dir, keep, options.logger)
      options.logger.info('截屏完成', { display, count: out.length })
      return out
    },
  }
}

/** 该显示器的**像素**尺寸（`thumbnailSize` 收的是设备像素，不乘 scaleFactor 会截出发虚的图） */
function pixelSizeOf(display: Display): { width: number; height: number } {
  const factor = display.scaleFactor > 0 ? display.scaleFactor : 1
  return {
    width: Math.max(1, Math.round(display.size.width * factor)),
    height: Math.max(1, Math.round(display.size.height * factor)),
  }
}

/**
 * 从源列表里挑出目标显示器的那一个。
 *
 * Windows 上 `display_id` 能对上（`Display.id` 是数字，源上是字符串）；
 * 对不上时**仅在只有一个源**的情况下兜底取它 —— 多屏却挑错屏，比什么都不截更糟。
 */
function pickSource(
  sources: readonly DesktopCapturerSource[],
  displayId: number,
): DesktopCapturerSource | undefined {
  const matched = sources.find((source) => source.display_id === String(displayId))
  if (matched !== undefined) return matched
  return sources.length === 1 ? sources[0] : undefined
}

/** PNG 编码；超过单图上限时按 0.7 逐次缩小重编码（最多 3 次），仍超限则放弃这一张。 */
function encodeWithinLimit(
  source: DesktopCapturerSource,
  options: ScreenshotPortOptions,
): Buffer | undefined {
  let image = source.thumbnail
  let png = image.toPNG()
  for (let round = 0; round < 3 && png.byteLength > IMAGE_MAX_BYTES; round += 1) {
    const size = image.getSize()
    image = image.resize({
      width: Math.max(1, Math.round(size.width * 0.7)),
      quality: 'good',
    })
    png = image.toPNG()
  }
  if (png.byteLength === 0) {
    options.logger.warn('截屏：得到空图片')
    return undefined
  }
  if (png.byteLength > IMAGE_MAX_BYTES) {
    options.logger.warn('截屏：缩放后仍超过单图上限，已放弃这一张', {
      bytes: png.byteLength,
      limit: IMAGE_MAX_BYTES,
    })
    return undefined
  }
  return png
}

async function writePng(dir: string, bytes: Buffer): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  const filePath = join(dir, imageFileName(Date.now(), randomBytes(3).toString('hex')))
  await fs.writeFile(filePath, bytes)
  return filePath
}

/** 目录里只留最近 `keep` 张（失败只记 warn：清理是维护动作，不该让一次截屏失败）。 */
async function prune(dir: string, keep: number, logger: Logger): Promise<void> {
  if (keep <= 0) return
  try {
    const names = (await fs.readdir(dir)).filter((name) => name.endsWith('.png'))
    const expired = selectExpiredFiles(names, keep)
    for (const name of expired) await fs.rm(join(dir, name), { force: true })
    if (expired.length > 0) logger.debug('已清理旧的截屏', { removed: expired.length })
  } catch (error) {
    logger.warn('清理旧截屏失败', { error: error instanceof Error ? error.message : String(error) })
  }
}
