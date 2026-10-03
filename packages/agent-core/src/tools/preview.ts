/**
 * `show_preview` 工具（2026-10-03，docs/06 §14）：把成果**展示在用户桌面的右栏预览面板**里
 * —— 与 Codex 一类 Agent「把产物打开给用户看」同一个形状：生成的 HTML 报告 / 图表 /
 * 本地页面或一个网址，直接在对话旁边渲染出来，而不是把大段内容贴进消息正文。
 *
 * 分层与 `tools/notify.ts` 同一套：内核只认识**注入的端口**，「目标是否合法」
 * （http/https，或落在会话边界根之内的本地文件）与「推给哪个窗口」全在主进程实现，
 * 本文件保持纯 Node 可单测。
 *
 * `sensitivity: 'safe'`：展示本身不写盘、不起进程、不改配置；唯一的可见副作用是
 * 右栏加载一个页面，而加载目标会**显示在地址栏**里（用户看得见去了哪里）。
 * 本地文件的读取边界由端口复用 `resolveWithin` 的 realpath 前缀校验兜住。
 */
import type { ToolContext, ToolDefinition, ToolResult } from './registry.js'

export const SHOW_PREVIEW_TOOL_NAME = 'show_preview'

export interface PreviewShowOptions {
  /** 发起展示的会话（主进程据此判断该不该推给当前窗口） */
  sessionId: string
  /** 展示标题（可空串；渲染层当前只用于提示，不注入页面） */
  title: string
}

export interface PreviewShowOutcome {
  /** 真正加载进预览面板的地址（http/https 或 `file://`） */
  url: string
  /** 给用户看的目标串（本地文件是原始路径） */
  display: string
}

export interface PreviewPort {
  /**
   * 展示一个目标并把请求交给渲染层。
   * 目标非法（协议不支持 / 越界 / 不存在）由实现**抛错**，工具如实回填失败原因。
   */
  show(target: string, options: PreviewShowOptions): Promise<PreviewShowOutcome>
}

export interface ShowPreviewToolOptions {
  port: PreviewPort
}

export function createShowPreviewTool(options: ShowPreviewToolOptions): ToolDefinition {
  return {
    name: SHOW_PREVIEW_TOOL_NAME,
    description:
      '在用户桌面的右侧预览面板里展示一个成果：网页地址（http/https）或本地文件（生成的 HTML 报告、页面、图片、PDF、文本等）。' +
      '适合"做完一个可视化产物给用户看"的场景 —— 用户在对话旁边直接看到结果，不需要把整份内容贴进回复。' +
      '本地文件必须位于当前会话的工作目录（项目文件夹）之内；相对路径按该目录解析。',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: '要展示的目标：http/https 网址，或本地文件的绝对 / 相对路径（HTML 页面等）',
        },
        title: { type: 'string', description: '展示标题（可选，一句话说明这是什么）' },
      },
      required: ['target'],
      additionalProperties: false,
    },
    sensitivity: 'safe',
    execute: async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const record = asRecord(input)
      const target = readNonEmptyString(record, 'target')
      if (target === undefined) {
        return {
          content: '缺少参数：target（要展示的网址或文件路径）。',
          isError: true,
          summary: '展示预览参数缺失',
        }
      }
      const title = readNonEmptyString(record, 'title') ?? ''
      try {
        const outcome = await options.port.show(target, { sessionId: ctx.sessionId, title })
        return {
          content: `已在右栏预览面板中展示：${outcome.display}`,
          summary: '已展示预览',
        }
      } catch (error) {
        return {
          content: `展示失败：${describeError(error)}`,
          isError: true,
          summary: '展示预览失败',
        }
      }
    },
  }
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  return input as Record<string, unknown>
}

/** 可选字符串：非字符串按缺省处理（`title` 是可选参数，不做「缺参」判定） */
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
