/**
 * 附件准备（docs/07 §2.3、docs/06 §3.1）：把附件路径整理成「本轮要额外给模型看的内容」。
 *
 * 从 `ipc.ts` 抽出来的原因：`chat:send`（本地消息）与 Center 远程会话要**同一条**
 * 附件链路 —— 图片分流、vision 降级、文档提取、字符截断的规则只写一份，
 * 两条发送通路才不会出现「本机能看、远程不能看」的漂移。
 *
 * 本文件**纯 Node**（不 import electron），可直接单测。
 */
import type { Settings } from '@aurora/shared'
import type { Logger } from '@aurora/shared'
import { imageFallbackBlock, splitAttachments } from './attachments.js'
import { visionEnabled as resolveVisionEnabled } from './vision.js'

/** 附件正文入上下文的字符上限（超出截断，避免一个 PDF 吃掉整个上下文预算） */
export const MAX_ATTACHMENT_CHARS = 8_000

/** 单条消息最多处理的附件数（图文合计；图片分片同样占这个额度） */
export const MAX_ATTACHMENTS = 5

/** 单个附件提取结果（用文件名 + 截断正文入上下文） */
export interface AttachmentDigest {
  path: string
  fileName: string
  /** 提取到的文本（已截断）；无法提取时为 undefined */
  text?: string
  /** 提取失败 / 不支持时的原因（会一并告给模型，避免它假装读过） */
  note?: string
}

/** `prepareAttachments` 需要的最小依赖面（IPC 装配层与主进程装配层都能满足）。 */
export interface AttachmentPrepareDeps {
  /** 配置快照：`visionEnabled` 未注入时按它判定当前模型是否支持图片输入 */
  settings: { get(): Settings }
  logger: Pick<Logger, 'warn'>
  /**
   * 附件提取（docs/07 §2.3）：把本地文件转成可入上下文的文本。
   * 返回 `undefined` 表示该文件无法提取文本（按「仅文件名」降级处理）。
   */
  attachmentExtract?: (path: string) => Promise<AttachmentDigest | undefined>
  /** 当前生效模型是否支持图片输入；缺省按 `settings` 判定（测试兼容）。 */
  visionEnabled?: () => boolean
}

export interface PreparedAttachments {
  /** 拼进本轮消息的额外上下文（图片降级说明 / 文档正文）；无内容时缺省 */
  extraContext?: string
  /** 本轮要下发的图片路径；vision 关闭时为空（甚至不应出现图片分片） */
  images: string[]
}

/** 当前生效模型是否开启图片输入（唯一判据在 `vision.ts`，这里只做 getter 回落）。 */
export function attachmentVisionEnabled(deps: AttachmentPrepareDeps): boolean {
  return deps.visionEnabled?.() ?? resolveVisionEnabled(deps.settings.get())
}

/**
 * 把附件整理成「本轮要额外给模型看的内容」。
 *
 * 分流规则：图片（`png / jpg / jpeg / webp / gif / bmp`）**不提取文本**，而是作为图片分片下发；
 * 其余文件走分类管线的 `extract.ts` 提取文本。两类可以同时存在于一轮消息里。
 *
 * 降级策略（一律**不阻断发送**）：
 * - 关闭了图片输入（当前模型的 `modelParams.<modelId>.vision` 为假）→ 图片写成一行「未读取」说明，
 *   请求体里不出现图片分片（对不支持视觉的模型发图片会被服务端 400）；
 * - 无法提取的文档 → 同样如实写明「内容未读取」，避免模型以为读过而编造。
 *
 * 返回的 `images` 是**路径**（读盘在内核的 `loadImages` 端口里发生，一处读、一处缓存），
 * 只有真正要下发时才是非空。
 */
export async function prepareAttachments(
  deps: AttachmentPrepareDeps,
  attachments: string[] | undefined,
): Promise<PreparedAttachments> {
  if (attachments === undefined || attachments.length === 0) return { images: [] }

  const targets = attachments.slice(0, MAX_ATTACHMENTS)
  if (attachments.length > MAX_ATTACHMENTS) {
    deps.logger.warn('附件数量超过上限，多余的已忽略', {
      provided: attachments.length,
      limit: MAX_ATTACHMENTS,
    })
  }

  const { images, documents } = splitAttachments(targets)
  const blocks: string[] = []

  // 图片：能力开关决定「下发」还是「降级成一行说明」
  const vision = attachmentVisionEnabled(deps)
  for (const path of images) {
    if (!vision) {
      blocks.push(imageFallbackBlock(fileNameOf(path), '当前模型未开启图片输入'))
    }
  }

  // 文档：沿用既有提取链（officeparser / 纯文本读取器）
  const extract = deps.attachmentExtract
  if (documents.length > 0 && extract === undefined) {
    // 未装配提取能力（例如精简场景）：如实说明，不静默假装附件存在
    blocks.push(`【附件】${documents.length} 个文件未读取内容（当前环境未启用附件解析）`)
  } else if (extract !== undefined) {
    for (const path of documents) {
      try {
        const digest = await extract(path)
        if (digest === undefined) {
          blocks.push(`【附件】${fileNameOf(path)}：内容未读取（不支持的格式）`)
          continue
        }
        if (digest.text === undefined || digest.text.trim() === '') {
          blocks.push(
            `【附件】${digest.fileName}：内容未读取${digest.note === undefined ? '' : `（${digest.note}）`}`,
          )
          continue
        }
        blocks.push(
          [
            `【附件】${digest.fileName}`,
            digest.text.length > MAX_ATTACHMENT_CHARS
              ? `${digest.text.slice(0, MAX_ATTACHMENT_CHARS)}\n（内容过长，已截断）`
              : digest.text,
          ].join('\n'),
        )
      } catch (error) {
        deps.logger.warn('附件提取失败，按未读取处理', { path, error: String(error) })
        blocks.push(`【附件】${fileNameOf(path)}：内容未读取（提取失败）`)
      }
    }
  }

  return {
    ...(blocks.length === 0
      ? {}
      : {
          extraContext: [
            '以下是用户随消息一起发送的本地文件内容，仅供本次回复参考。',
            ...blocks,
          ].join('\n\n'),
        }),
    images: vision ? images : [],
  }
}

/** 从绝对路径取文件名（渲染层传来的路径可能含 Windows 反斜杠） */
function fileNameOf(path: string): string {
  const segments = path.split(/[\\/]/)
  return segments[segments.length - 1] ?? path
}
