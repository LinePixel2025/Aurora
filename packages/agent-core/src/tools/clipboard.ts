/**
 * 剪贴板工具（Design/betav2-spec.md §6）。
 *
 * 分层与 `tools/files.ts` 同一套：内核只认识**注入的端口**，
 * 真实读写由主进程（Electron `clipboard`）实现并注入，本文件保持纯 Node 可单测。
 *
 * 安全边界：读剪贴板可能带出用户复制的密码等隐私内容，因此
 * `clipboard_read` / `clipboard_write` 都标记 `sensitivity: 'confirm'`，
 * 每次调用都要过 `confirmTool` 钩子（docs/06 §5）。
 */
import type { ToolDefinition, ToolResult } from './registry.js'

export const CLIPBOARD_READ_TOOL_NAME = 'clipboard_read'
export const CLIPBOARD_WRITE_TOOL_NAME = 'clipboard_write'

export interface ClipboardPort {
  /** 读取系统剪贴板文本（非文本内容由实现折叠为空串或其文本表示） */
  read(): Promise<string>
  /** 写入文本到系统剪贴板 */
  write(text: string): Promise<void>
}

export interface ClipboardToolOptions {
  port: ClipboardPort
}

export function createClipboardTools(options: ClipboardToolOptions): ToolDefinition[] {
  return [createClipboardReadTool(options.port), createClipboardWriteTool(options.port)]
}

function createClipboardReadTool(port: ClipboardPort): ToolDefinition {
  return {
    name: CLIPBOARD_READ_TOOL_NAME,
    description: '读取系统剪贴板文本，涉及隐私：只应在用户明确要求时使用。',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    sensitivity: 'confirm',
    execute: async (): Promise<ToolResult> => {
      try {
        const text = await port.read()
        return {
          content: text === '' ? '（剪贴板为空或不含文本）' : text,
          summary: text === '' ? '剪贴板为空' : '读取剪贴板',
        }
      } catch (error) {
        return {
          content: `读取剪贴板失败：${describeError(error)}`,
          isError: true,
          summary: '读取剪贴板失败',
        }
      }
    },
  }
}

function createClipboardWriteTool(port: ClipboardPort): ToolDefinition {
  return {
    name: CLIPBOARD_WRITE_TOOL_NAME,
    description: '把文本写入系统剪贴板，会覆盖用户当前复制的内容。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要写入剪贴板的文本' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    sensitivity: 'confirm',
    execute: async (input): Promise<ToolResult> => {
      const record = asRecord(input)
      const text = readString(record, 'text')
      if (text === undefined) {
        return {
          content: '缺少参数 text（要写入剪贴板的文本）。',
          isError: true,
          summary: '缺少 text 参数',
        }
      }
      try {
        await port.write(text)
        return {
          content: `已写入剪贴板（${text.length} 字符）`,
          summary: `写入剪贴板 ${text.length} 字符`,
        }
      } catch (error) {
        return {
          content: `写入剪贴板失败：${describeError(error)}`,
          isError: true,
          summary: '写入剪贴板失败',
        }
      }
    },
  }
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  return input as Record<string, unknown>
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' ? value : undefined
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
