/**
 * `classisland_remind` 工具（docs/05 §3.4 v3、docs/06 §14 的扩展工具口径）。
 *
 * 需求：「Aurora 可以调用 Classisland 的提醒功能」——本工具把提醒交给 ClassIsland 自己的
 * 通知服务弹出（通过 v3 桥接插件的命令通道），而不是弹 Aurora 自己的系统通知
 * （那是 `notify_user` 的职责）。
 *
 * 分层与 `tools/notify.ts` 完全一致：内核只认识**注入的端口**
 * （`ClassIslandNotifyPort`），真实的写文件 / POST 在 `main/classisland.ts` 的
 * `ClassIslandNotifier` 里实现，因此本文件保持纯 Node、可单测。
 *
 * **sensitivity 口径**：与 `notify_user` 同为 `'safe'` —— 两者都是「弹一条提醒给用户看」，
 * 不改动任何文件与系统状态；真正的打扰性由用户侧的 ClassIsland 提醒设置决定
 * （他可以在那边关掉「Aurora 提醒」渠道），因此不需要逐次确认。
 * 与之相对，`clipboard_*` / `generate_image` 会碰隐私或花钱，才用 `'confirm'`。
 */
import type { ClassIslandNotifyRequest, ClassIslandNotifyResult } from '@aurora/shared'
import type { ToolDefinition, ToolResult } from '@aurora/agent-core'

export const CLASSISLAND_REMIND_TOOL_NAME = 'classisland_remind'

/** 提醒标题缺省值：让 ClassIsland 上的提醒一眼看出是 Aurora 发的 */
export const DEFAULT_REMIND_TITLE = 'Aurora'

/** 提醒通道白名单（与桥接插件 v3 的映射一致） */
const CHANNELS = ['custom', 'class-started', 'pre-class'] as const

export interface ClassIslandNotifyPort {
  /** 发送提醒；实现内部已把一切失败转成 `{ ok: false, error }`，**不抛错** */
  notify(request: ClassIslandNotifyRequest): Promise<ClassIslandNotifyResult>
  /** 桥接是否已配置（未配置时工具直接给出可执行的指引，而不是等超时） */
  available(): boolean
}

export interface ClassIslandRemindToolOptions {
  port: ClassIslandNotifyPort
}

export function createClassIslandRemindTool(options: ClassIslandRemindToolOptions): ToolDefinition {
  return {
    name: CLASSISLAND_REMIND_TOOL_NAME,
    description:
      '通过 ClassIsland 弹出提醒（上课提醒 / 课前提醒 / Aurora 提醒渠道）。适合「提醒我下节课交作业」这类与课表、教室屏幕相关的提醒；需要已安装并配置 ClassIsland 桥接插件 v3，未配置时会返回失败原因。只弹提醒，不修改课表。',
    parameters: {
      type: 'object',
      properties: {
        body: { type: 'string', description: '提醒正文（具体内容，会显示在 ClassIsland 上）' },
        title: {
          type: 'string',
          description: `提醒标题（一句话）；省略时用「${DEFAULT_REMIND_TITLE}」`,
        },
        channel: {
          type: 'string',
          enum: [...CHANNELS],
          description:
            '提醒渠道：custom（Aurora 提醒，默认）/ class-started（上课提醒）/ pre-class（课前提醒）。实际是否弹出由 ClassIsland 的提醒设置决定。',
        },
      },
      required: ['body'],
      additionalProperties: false,
    },
    sensitivity: 'safe',
    execute: async (input): Promise<ToolResult> => {
      const record = asRecord(input)
      const body = readNonEmptyString(record, 'body')
      if (body === undefined) {
        return {
          content: '缺少参数：body（提醒正文）。',
          isError: true,
          summary: '提醒参数缺失',
        }
      }

      if (!options.port.available()) {
        return {
          content:
            'ClassIsland 提醒通道不可用：尚未在「设置 → 模式 → ClassRoom → 课程表」里把课程表来源设为 ClassIsland 联动并填写桥接端点（或桥接插件不是 v3）。请先完成配置，或改用 notify_user 发系统通知。',
          isError: true,
          summary: 'ClassIsland 未配置',
        }
      }

      const title = readNonEmptyString(record, 'title') ?? DEFAULT_REMIND_TITLE
      const channel = readChannel(record)
      const result = await options.port.notify({
        title,
        body,
        ...(channel === undefined ? {} : { channel }),
      })

      if (!result.ok) {
        return {
          content: `通过 ClassIsland 发送提醒失败：${result.error ?? '未知原因'}（耗时 ${result.elapsedMs}ms）`,
          isError: true,
          summary: 'ClassIsland 提醒失败',
        }
      }
      return {
        content: `已通过 ClassIsland 发送提醒：${title}（${body}），耗时 ${result.elapsedMs}ms。是否弹出与是否朗读由 ClassIsland 的提醒设置决定。`,
        summary: '已发送 ClassIsland 提醒',
      }
    },
  }
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  return input as Record<string, unknown>
}

/** 必填字符串：非字符串或纯空白一律视为缺参（**不触碰端口**） */
function readNonEmptyString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** 渠道：只接受白名单值，未知值按缺省（custom）处理（写错渠道名不该让提醒失败） */
function readChannel(
  record: Record<string, unknown> | undefined,
): 'custom' | 'class-started' | 'pre-class' | undefined {
  const value = record?.['channel']
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return (CHANNELS as readonly string[]).includes(trimmed)
    ? (trimmed as 'custom' | 'class-started' | 'pre-class')
    : undefined
}
