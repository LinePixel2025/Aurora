/**
 * `generate_image` 工具（Design/betav2-spec.md §6）。
 *
 * 分层与 `tools/files.ts` 同一套：内核只认识**注入的端口**，真实生图
 * （出网调用生图模型、落盘到 `userData/generated`）由主进程实现并注入，
 * 本文件保持纯 Node 可单测。
 *
 * 安全边界：生图要花 API 费用，`sensitivity: 'confirm'`，逐次过
 * `confirmTool` 钩子；耗时可能较长，工具描述里向模型交代清楚。
 */
import type { ToolDefinition, ToolResult } from './registry.js'

export const IMAGE_GEN_TOOL_NAME = 'generate_image'

export interface ImageGenPort {
  /** 调用生图模型并把图片写入本地；成功返回文件绝对路径 */
  generate(input: { prompt: string; size?: string }): Promise<{ filePath: string }>
}

export interface ImageGenToolOptions {
  port: ImageGenPort
}

export function createImageGenTool(options: ImageGenToolOptions): ToolDefinition {
  return {
    name: IMAGE_GEN_TOOL_NAME,
    description:
      '调用生图模型生成图片并保存到本地，成功返回文件路径；耗时可能较长，不要在同一轮里重复发起。' +
      '生成前先向用户确认描述与尺寸（本工具会请求用户确认）。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '图片描述（要画什么，越具体越好）' },
        size: {
          type: 'string',
          description: '图片尺寸（如 1024x1024）；缺省用生图 provider 的默认尺寸',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    sensitivity: 'confirm',
    execute: async (input): Promise<ToolResult> => {
      const record = asRecord(input)
      const prompt = readNonEmptyString(record, 'prompt')
      if (prompt === undefined) {
        return {
          content: '缺少参数 prompt（图片描述）。',
          isError: true,
          summary: '缺少 prompt 参数',
        }
      }
      const size = readNonEmptyString(record, 'size')
      try {
        const result = await options.port.generate({
          prompt,
          ...(size === undefined ? {} : { size }),
        })
        return {
          content: `已保存到 ${result.filePath}`,
          summary: '已生成图片',
        }
      } catch (error) {
        return {
          content: `生成图片失败：${describeError(error)}`,
          isError: true,
          summary: '生成图片失败',
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
