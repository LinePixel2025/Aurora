/**
 * Center Web 输入卡的图片附件：**纯逻辑**（校验 / 文件 id / objectURL 回收）。
 *
 * 单独成模块是为了能被 node 环境的单测覆盖（`packages/center/web/src/lib/*.test.ts`
 * 的既有口径）：组件里那段粘贴 / 上传流程要发 REST、要摸 DOM，纯判定留在不摸任何 DOM。
 *
 * 上限口径是**双端同一份**：`CENTER_INPUT_ATTACHMENT_LIMIT` / `CENTER_INPUT_IMAGE_MAX_BYTES`
 * 来自 `@aurora/shared/browser`（协议文件只有类型与字面量常量，没有 Node 依赖），
 * 服务器转发前与客户端下载前都会再校验一次 —— 网页端这道只是"尽早告诉用户"。
 */
import { CENTER_INPUT_ATTACHMENT_LIMIT, CENTER_INPUT_IMAGE_MAX_BYTES } from '@aurora/shared/browser'

/**
 * 网页端随消息发送的图片 MIME 白名单。
 *
 * 与桌面端粘贴图片的（png / jpeg / webp / gif / bmp）同口径；`image/svg+xml` 刻意不在此列
 * —— SVG 是活动内容，客户端落盘后当图片看也会带来 XSS 面。
 */
export const COMPOSER_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
] as const

export type ComposerAttachmentStatus = 'uploading' | 'ready'

/** 输入卡里的一张待发送图片（上传完成前 `fileId` 为空串） */
export interface ComposerAttachment {
  /** 本地身份（列表 key / 移除 / 忽略过期上传回执；服务器 id 上传成功后才拿到） */
  id: string
  /** 服务器暂存文件 id；空串 = 上传中 */
  fileId: string
  name: string
  size: number
  /** 本地 objectURL（56×56 缩略图）；移除 / 切会话 / 卸载时必须 revoke */
  previewUrl: string
  status: ComposerAttachmentStatus
}

/** 单张上限的展示文案（从协议常量算，不另写死一个数字） */
export function maxAttachmentSizeLabel(): string {
  return `${Math.round(CENTER_INPUT_IMAGE_MAX_BYTES / (1024 * 1024))} MB`
}

/**
 * 是否当作图片处理：优先看 MIME；部分浏览器从剪贴板拿到的 `File.type` 是空串，
 * 这时退回扩展名判断（真正的服务端校验仍按 MIME / 字节内容，不会被扩展名绕过）。
 */
export function isImageFile(file: { type: string; name?: string }): boolean {
  if ((COMPOSER_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) return true
  if (file.type !== '') return false
  return /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name ?? '')
}

/**
 * 粘贴 / 选择一张图时的拒绝理由；空串 = 接受。
 *
 * 顺序是有意的：先看数量（已经满了就该说"最多带 N 张"），再看格式 / 大小 ——
 * 反过来的话用户在第 6 张时会被"格式不对"误导去换格式。
 */
export function imageRejectReason(
  file: { type: string; name?: string; size: number },
  existingCount: number,
): string {
  if (existingCount >= CENTER_INPUT_ATTACHMENT_LIMIT) {
    return `一条消息最多带 ${CENTER_INPUT_ATTACHMENT_LIMIT} 张图片`
  }
  if (!isImageFile(file)) {
    return '只支持图片（PNG / JPEG / WebP / GIF / BMP）'
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return '这张图片是空的，换一张再试'
  }
  if (file.size > CENTER_INPUT_IMAGE_MAX_BYTES) {
    return `单张图片不能超过 ${maxAttachmentSizeLabel()}`
  }
  return ''
}

/** 已上传完成的附件 → 随 `session.input` 上行的 fileId 列表（保持加入顺序） */
export function readyFileIds(items: readonly ComposerAttachment[]): string[] {
  return items
    .filter((item) => item.status === 'ready' && item.fileId !== '')
    .map((item) => item.fileId)
}

/** 回收本地预览 URL：只处理 blob:（用户拖入的 data: / 空串一律跳过） */
export function revokePreviewUrl(url: string): void {
  if (!url.startsWith('blob:')) return
  try {
    URL.revokeObjectURL(url)
  } catch {
    // 已经回收过（或浏览器早就不认这个 URL）：不影响主流程
  }
}
