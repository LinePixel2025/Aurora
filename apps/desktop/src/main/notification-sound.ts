/**
 * 自定义提示音的文件读取与校验（v42，docs/07 §2.2.3 R4、docs/08 §1）。
 *
 * 只负责「把设置里那条 `notifications.customSoundPath` 变成可播放的字节」：
 * 扩展名白名单 + 大小上限 + 存在性校验，全部在这里一次性做完；
 * IPC 层（`notifications:readSound`）只调用本模块，**不接受渲染层传入路径** ——
 * 渲染层没有文件系统能力，也不该有「读任意文件」的口子。
 *
 * 纯 Node、不 import electron：与 `main/banner.ts` 同款口径，可独立单测。
 * 失败一律抛带中文文案的 Error（IPC 层折成 Result 错误）；空路径返回 null = 未配置。
 */
import { promises as fs } from 'node:fs'
import { extname } from 'node:path'
import type { NotificationSoundData } from '@aurora/shared'

/**
 * 扩展名 → 播放 MIME。白名单即 Chromium `<audio>` 能解的格式集合；
 * 大小写不敏感（Windows 文件名常见 `.WAV` / `.Mp3`）。
 */
const SOUND_MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
}

/** 白名单扩展名（供文件选择框的 filters 复用，避免两处各写一份） */
export const SOUND_FILE_EXTENSIONS = Object.keys(SOUND_MIME_BY_EXT).map((ext) => ext.slice(1))

/**
 * 提示音文件大小上限（2MB）。提醒音应当短促；2MB 约等于 2 分钟 128kbps mp3，
 * 也守住 IPC base64 载荷的量级（与 TTS 音频过 IPC 同款口径，不能无限大）。
 */
export const MAX_SOUND_BYTES = 2 * 1024 * 1024

/**
 * 读取自定义提示音。
 *
 * - 空串 / 纯空白 → `null`（未配置，渲染层走默认合成音）；
 * - 扩展名不在白名单 / 文件不存在 / 不是文件 / 超过 2MB / 读取失败 → 抛中文 Error；
 * - 成功 → `{ dataBase64, mime }`（base64 不含 data: 前缀）。
 *
 * 校验顺序刻意是「扩展名 → stat → 大小 → 读取」：格式不对时连磁盘都不碰，
 * 错误文案也最具体（用户先看到"格式不支持"而不是"文件不存在"）。
 */
export async function readNotificationSound(path: string): Promise<NotificationSoundData | null> {
  const trimmed = path.trim()
  if (trimmed === '') return null

  const ext = extname(trimmed).toLowerCase()
  const mime = SOUND_MIME_BY_EXT[ext]
  if (mime === undefined) {
    throw new Error('不支持的音频格式：仅支持 wav / mp3 / ogg / m4a / aac / flac / webm')
  }

  let stat
  try {
    stat = await fs.stat(trimmed)
  } catch {
    throw new Error('提示音文件不存在或已被移动，请在设置里重新选择')
  }
  if (!stat.isFile()) {
    throw new Error('提示音路径不是一个文件，请重新选择音频文件')
  }
  if (stat.size > MAX_SOUND_BYTES) {
    throw new Error('提示音文件超过 2MB 上限，请裁剪后再选')
  }

  let bytes
  try {
    bytes = await fs.readFile(trimmed)
  } catch (error) {
    throw new Error(`提示音文件读取失败：${error instanceof Error ? error.message : String(error)}`)
  }
  return { dataBase64: bytes.toString('base64'), mime }
}
