/**
 * 粘贴图片落盘（通道 `chat:stageImage` 的对端，docs/07 §2.3，2026-10-18）。
 *
 * 渲染进程的 paste 事件只能拿到 `File`（没有本地路径），而附件链路按路径工作；
 * 主进程把字节写进 `<userData>/pasted/` 再交回路径 —— 之后的流程与拖拽附件完全一致
 * （`chat:readAttachment` 预览、`chat:send` 的 `prepareAttachments`）。
 *
 * 本文件**纯 Node**（不 import electron），因此可被 vitest 直接覆盖：
 * - mime 白名单 / 大小上限 / 空文件都在这里判定（渲染层传来的 mime 与大小不可信）；
 * - 命名与清理选人复用图像产物那一套（`selectExpiredFiles`），目录不会无限长。
 */
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { PASTED_IMAGE_MAX_BYTES, type Logger } from '@aurora/shared'
import { selectExpiredFiles } from './tools/image-store.js'

/** `<userData>/pasted/` 里保留最近多少张（与剪贴板 / 截屏同口径：50）。 */
export const PASTED_IMAGE_KEEP = 50

/**
 * 允许粘贴的 mime → 落盘扩展名。
 *
 * 只收浏览器剪贴板里真正会出现的五种图；其它 mime 一律拒绝（不猜、不转码）：
 * 渲染层按 `File.type` 传值，主进程是**第二道**校验，不能因为「看起来像图」就写盘。
 */
export const PASTED_IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
}

export type PastedImageErrorCode = 'E_INVALID_ARGUMENT' | 'E_IO'

/** 粘贴图片落盘的失败原因（IPC 层据此映射成 `Result` 的 code）。 */
export class PastedImageError extends Error {
  constructor(
    message: string,
    public readonly code: PastedImageErrorCode,
  ) {
    super(message)
    this.name = 'PastedImageError'
  }
}

export interface WritePastedImageOptions {
  /** 落盘目录（装配层传 `<userData>/pasted`，不接受任意目标路径） */
  dir: string
  /** 渲染层声明的 mime（大小写不敏感） */
  mimeType: string
  data: Uint8Array
  /** 保留最近多少张；缺省 `PASTED_IMAGE_KEEP`（传 0 表示不清理） */
  keep?: number
  logger?: Pick<Logger, 'debug' | 'warn'>
  /** 测试注入：13 位毫秒时间戳与随机段 */
  now?: number
  random?: string
}

export interface PastedImageFile {
  /** 绝对路径（与 `SendMessageRequest.attachments` 里的同一个值） */
  path: string
  /** 落盘文件名（chip / title 用） */
  name: string
  /** 归一后的 mime（大写输入也回小写） */
  mimeType: string
}

/** mime → 扩展名（未知 mime 返回 undefined，调用方按「不支持」拒绝）。 */
export function pastedImageExtensionOf(mimeType: string): string | undefined {
  return PASTED_IMAGE_EXTENSIONS[mimeType.trim().toLowerCase()]
}

/**
 * 校验并写入一张粘贴图片。
 *
 * 校验顺序有意：先 mime → 再空 → 最后大小。mime 不支持时无论内容多大都直接拒绝，
 * 免得把一个 8 MB 的坏格式读进内存判断完再丢。
 */
export async function writePastedImage(options: WritePastedImageOptions): Promise<PastedImageFile> {
  const mimeType = options.mimeType.trim().toLowerCase()
  const ext = pastedImageExtensionOf(mimeType)
  if (ext === undefined) {
    throw new PastedImageError(
      `不支持的图片格式：${mimeType === '' ? '未知' : mimeType}`,
      'E_INVALID_ARGUMENT',
    )
  }
  if (options.data.byteLength === 0) {
    throw new PastedImageError('粘贴的图片内容为空', 'E_INVALID_ARGUMENT')
  }
  if (options.data.byteLength > PASTED_IMAGE_MAX_BYTES) {
    throw new PastedImageError(
      `图片超过 ${Math.round(PASTED_IMAGE_MAX_BYTES / 1024 / 1024)} MB 上限`,
      'E_INVALID_ARGUMENT',
    )
  }

  const now = options.now ?? Date.now()
  const random = options.random ?? randomBytes(3).toString('hex')
  const name = `pasted-${now}-${random}.${ext}`
  const path = join(options.dir, name)
  try {
    await fs.mkdir(options.dir, { recursive: true })
    await fs.writeFile(path, options.data)
  } catch (error) {
    throw new PastedImageError(
      `保存粘贴图片失败：${error instanceof Error ? error.message : String(error)}`,
      'E_IO',
    )
  }
  await prune(options.dir, options.keep ?? PASTED_IMAGE_KEEP, options.logger)
  options.logger?.debug('已暂存粘贴图片', { name, bytes: options.data.byteLength })
  return { path, name, mimeType }
}

/** 只清理**本模块自己写的**粘贴图（`pasted-<13 位时间戳>-<随机段>.<ext>`）。 */
const MANAGED_NAME_PATTERN = /^pasted-\d{13}-[0-9a-f]+\.(png|jpg|webp|gif|bmp)$/

/** 目录里只留最近 `keep` 张（失败只记 warn：清理是维护动作，不该让一次粘贴失败）。 */
async function prune(
  dir: string,
  keep: number,
  logger: Pick<Logger, 'debug' | 'warn'> | undefined,
): Promise<void> {
  if (keep <= 0) return
  try {
    const names = (await fs.readdir(dir)).filter((name) => MANAGED_NAME_PATTERN.test(name))
    const expired = selectExpiredFiles(names, keep)
    for (const name of expired) await fs.rm(join(dir, name), { force: true })
    if (expired.length > 0) logger?.debug('已清理旧的粘贴图片', { removed: expired.length })
  } catch (error) {
    logger?.warn('清理旧粘贴图片失败', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
