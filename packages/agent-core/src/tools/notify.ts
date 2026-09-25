/**
 * `notify_user` 工具（Design/betav2-spec.md §6）。
 *
 * 分层与 `tools/files.ts` 同一套：内核只认识**注入的端口**，
 * 真实弹系统托盘通知由主进程（NotificationService）实现并注入，
 * 本文件保持纯 Node 可单测。通知是只读的打扰性动作，`sensitivity: 'safe'`。
 */
import type { ToolDefinition, ToolResult } from './registry.js'

export const NOTIFY_TOOL_NAME = 'notify_user'

export interface NotifyPort {
  /** 弹一条系统托盘通知；失败（系统不支持等）由实现抛错 */
  show(title: string, body: string): Promise<void>
}

export interface NotifyToolOptions {
  port: NotifyPort
}

export function createNotifyTool(options: NotifyToolOptions): ToolDefinition {
  return {
    name: NOTIFY_TOOL_NAME,
    description: '通过系统托盘通知告知用户。适合长任务完成、需要用户回到窗口等场景。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '通知标题（一句话）' },
        body: { type: 'string', description: '通知正文（具体内容）' },
      },
      required: ['title', 'body'],
      additionalProperties: false,
    },
    sensitivity: 'safe',
    execute: async (input): Promise<ToolResult> => {
      const record = asRecord(input)
      const title = readNonEmptyString(record, 'title')
      const body = readNonEmptyString(record, 'body')
      if (title === undefined || body === undefined) {
        return {
          content: `缺少参数：${title === undefined ? 'title（通知标题）' : 'body（通知正文）'}。`,
          isError: true,
          summary: '通知参数缺失',
        }
      }
      try {
        await options.port.show(title, body)
        return {
          content: `已发送系统通知：${title}`,
          summary: '已发送通知',
        }
      } catch (error) {
        return {
          content: `发送通知失败：${describeError(error)}`,
          isError: true,
          summary: '发送通知失败',
        }
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
