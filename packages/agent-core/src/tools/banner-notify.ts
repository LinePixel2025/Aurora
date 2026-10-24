/**
 * `notify_banner` 工具（2026-10-24，docs/06 §14、docs/07 §2.2.3）。
 *
 * 定位：与 `notify_user`（系统通知）**并列**的第二条主动提醒通道 —— 屏幕顶端流光 + 置顶卡片。
 * 为什么不是给 `notify_user` 加一个 `channel` 参数：两者在系统里的落点完全不同
 * （系统通知中心 vs Aurora 自己的浮层窗口），谁也没法降级成对方；
 * 一个工具承担两种展示语义时，模型只会挑它熟悉的那条用。
 *
 * 分层与 `tools/notify.ts` 同一套：内核只定义工具与**端口**，真实窗口 / 语音 / 音效
 * 全部由主进程注入。`BannerService.show()` 永不抛错（失败折成 `{ ok:false, reason }`），
 * 因此这里的失败是**业务结果**，回填给模型的是原因而不是异常。
 *
 * 敏感级 `safe`：只弹一条提醒，不碰文件与系统状态（与 `notify_user` 同一判定）。
 */
import type { ToolDefinition, ToolResult } from './registry.js'

export const BANNER_NOTIFY_TOOL_NAME = 'notify_banner'

/** 一次提醒的入参（已通过长度 / 类型校验） */
export interface BannerNotifyInput {
  title: string
  body: string
  speak?: boolean
  sound?: boolean
}

/** 端口回报：`ok: false` 带原因（去重 / 队列满 / 窗口不可用），实现**不得抛错** */
export interface BannerNotifyOutcome {
  ok: boolean
  reason?: string
}

/**
 * 流光提醒端口（主进程实现：`apps/desktop/src/main/tools/banner-notify.ts` →
 * `BannerService.show`）。实现方必须自己消化异常并折成 `ok: false`。
 */
export interface BannerNotifyPort {
  show(input: BannerNotifyInput): Promise<BannerNotifyOutcome>
}

export interface BannerNotifyToolDeps {
  port: BannerNotifyPort
}

/** 标题 / 正文的硬上限（与 `BannerService` 的截断口径一致，超长直接判参数错误） */
export const BANNER_NOTIFY_TITLE_MAX = 120
export const BANNER_NOTIFY_BODY_MAX = 800

export function createBannerNotifyTool(deps: BannerNotifyToolDeps): ToolDefinition {
  return {
    name: BANNER_NOTIFY_TOOL_NAME,
    description:
      '在屏幕顶端弹一条流光提醒（置顶卡片 + 可选语音朗读 / 提示音），适合长任务完成、' +
      '需要用户回到窗口、或要在不打断当前操作的前提下告知结果时使用。' +
      '与 `notify_user`（系统通知中心）不同：它一定显示在最上层。' +
      '标题与正文都要给：标题一句话，正文写清楚发生了什么。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '提醒标题（一句话，≤ 40 字最好读）' },
        body: { type: 'string', description: '提醒正文（具体内容，会显示在标题下方）' },
        speak: {
          type: 'boolean',
          description: '是否语音朗读这条提醒（缺省跟随用户的 TTS 配置；未配置时不朗读）',
        },
        sound: { type: 'boolean', description: '是否播放提示音（缺省 true）' },
      },
      required: ['title', 'body'],
      additionalProperties: false,
    },
    sensitivity: 'safe',
    execute: async (input): Promise<ToolResult> => {
      const record = asRecord(input)
      const title = readNonEmptyString(record, 'title')
      const body = readText(record, 'body')
      if (title === undefined || body === undefined) {
        return {
          content: `缺少参数：${title === undefined ? 'title（提醒标题）' : 'body（提醒正文）'}。`,
          isError: true,
          summary: '流光提醒参数缺失',
        }
      }
      if (title.length > BANNER_NOTIFY_TITLE_MAX) {
        return {
          content: `title 不能超过 ${BANNER_NOTIFY_TITLE_MAX} 个字符（当前 ${title.length}）。`,
          isError: true,
          summary: '流光提醒标题过长',
        }
      }
      if (body.length > BANNER_NOTIFY_BODY_MAX) {
        return {
          content: `body 不能超过 ${BANNER_NOTIFY_BODY_MAX} 个字符（当前 ${body.length}）。`,
          isError: true,
          summary: '流光提醒正文过长',
        }
      }

      const request: BannerNotifyInput = { title, body }
      const speak = record?.['speak']
      const sound = record?.['sound']
      if (typeof speak === 'boolean') request.speak = speak
      if (typeof sound === 'boolean') request.sound = sound

      let outcome: BannerNotifyOutcome
      try {
        outcome = await deps.port.show(request)
      } catch (error) {
        // 端口实现本不该抛错（约定如此）；万一抛了也按失败回报，不把异常塞进工具循环
        outcome = { ok: false, reason: describeError(error) }
      }
      if (!outcome.ok) {
        return {
          content: `流光提醒未显示：${outcome.reason ?? '原因未知'}。${outcome.reason?.includes('重复') ? '这是正常的合并行为，不用重试。' : ''}`,
          isError: true,
          summary: '流光提醒未显示',
        }
      }
      return {
        content: `已显示流光提醒：${title}`,
        summary: '已显示流光提醒',
      }
    },
  }
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  return input as Record<string, unknown>
}

/** 必填标题：非字符串或纯空白一律视为缺参（**不触碰端口**） */
function readNonEmptyString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 必填正文：允许空串（卡片只显示标题），但不接受非字符串 ——
 * 「缺参数」与「故意不带正文」是两件事，前者要模型自己修正。
 */
function readText(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  if (typeof value !== 'string') return undefined
  return value.trim()
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
