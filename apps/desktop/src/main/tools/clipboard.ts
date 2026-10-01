/**
 * `ClipboardPort` / `ClipboardImagePort` 的主进程实现（Design/betav2-spec.md §8.4、docs/06 §14、§25）。
 *
 * 直接使用 Electron 的 `clipboard`（只有主进程拿得到）：文本映射成内核的
 * `read() / write()`，图片把 `NativeImage` 编码成 PNG **先落盘**再回传 —— 回放口径依赖路径
 * （docs/06 §25），剪贴板图片本身没有路径，落盘这一步就是在补它。
 *
 * 本文件**允许 import electron**，因此**没有也不该有**单测（vitest 的 Node 环境加载不了它）；
 * 工具层的参数解析与 `sensitivity: 'confirm'` 语义由 agent-core 的
 * `createClipboardTools` / `createClipboardImageTool` 覆盖，清理选人在 `image-store.ts`。
 */
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { clipboard } from 'electron'
import type { Logger } from '@aurora/shared'
import type { ClipboardImagePort, ClipboardPort, ToolImage } from '@aurora/agent-core'
import { imageFileName, selectExpiredFiles } from './image-store.js'

const PNG_MIME = 'image/png'

/** 目录里保留最近多少张（与截屏同口径）。 */
export const CLIPBOARD_IMAGE_KEEP = 50

export function createElectronClipboardPort(): ClipboardPort {
  return {
    async read(): Promise<string> {
      // 非文本内容（图片 / 文件）readText 返回空串，由工具层折叠成「剪贴板为空」提示
      return clipboard.readText()
    },
    async write(text: string): Promise<void> {
      clipboard.writeText(text)
    },
  }
}

export interface ClipboardImagePortOptions {
  /** 落盘目录（装配层传 `<userData>/clipboard`，同时也是 view_image 的白名单根之一） */
  dir: string
  logger: Logger
  /** 保留最近多少张；缺省 `CLIPBOARD_IMAGE_KEEP`（传 0 表示不清理） */
  keep?: number
}

export function createElectronClipboardImagePort(
  options: ClipboardImagePortOptions,
): ClipboardImagePort {
  const keep = options.keep ?? CLIPBOARD_IMAGE_KEEP
  return {
    async capture(): Promise<ToolImage | undefined> {
      const image = clipboard.readImage()
      // 剪贴板里没有图片是**正常情形**（不是错误）：返回 undefined，由工具层如实回填
      if (image.isEmpty()) return undefined
      const png = image.toPNG()
      if (png.byteLength === 0) return undefined

      await fs.mkdir(options.dir, { recursive: true })
      const filePath = join(options.dir, imageFileName(Date.now(), randomBytes(3).toString('hex')))
      await fs.writeFile(filePath, png)
      await prune(options.dir, keep, options.logger)
      options.logger.info('已读取剪贴板图片', { bytes: png.byteLength, filePath })
      return {
        path: filePath,
        image: {
          mimeType: PNG_MIME,
          dataBase64: png.toString('base64'),
          name: basename(filePath),
        },
      }
    },
  }
}

/** 目录里只留最近 `keep` 张（失败只记 warn：清理是维护动作，不该让一次读取失败）。 */
async function prune(dir: string, keep: number, logger: Logger): Promise<void> {
  if (keep <= 0) return
  try {
    const names = (await fs.readdir(dir)).filter((name) => name.endsWith('.png'))
    const expired = selectExpiredFiles(names, keep)
    for (const name of expired) await fs.rm(join(dir, name), { force: true })
    if (expired.length > 0) logger.debug('已清理旧的剪贴板图片', { removed: expired.length })
  } catch (error) {
    logger.warn('清理旧剪贴板图片失败', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
