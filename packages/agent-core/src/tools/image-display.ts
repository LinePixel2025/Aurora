/**
 * `show_image` 工具（docs/06 §14）。
 *
 * 模型用它把本机的一张图片成果加入对话图片区。内核只认识端口：路径解析、格式 /
 * 大小 / 边界校验与图片元数据生成都由主进程实现。
 */
import type { ToolDefinition, ToolDisplayImage, ToolResult } from './registry.js'

export const SHOW_IMAGE_TOOL_NAME = 'show_image'

export interface ImageDisplayPort {
  /** 校验并生成可持久化的展示元数据；失败抛错，由工具如实回填。 */
  prepareImage(input: {
    path: string
    caption?: string
    sessionId: string
  }): Promise<ToolDisplayImage>
  /** 读取一张已登记图片的 data URL；调用方只能按会话里的 imageId 查到路径。 */
  readImage(input: {
    path: string
    sessionId: string
  }): Promise<{ dataUrl: string; name: string; mime: string }>
}

export interface ShowImageToolOptions {
  port: ImageDisplayPort
}

export function createShowImageTool(options: ShowImageToolOptions): ToolDefinition {
  return {
    name: SHOW_IMAGE_TOOL_NAME,
    description:
      '把本机的一张图片添加到当前对话里供用户查看，适合展示最终成果或阶段性视觉结果。' +
      '通常在任务收尾时调用，一次只展示一张；generate_image 的产物会自动展示，不要对同一张图重复调用。' +
      '本地文件必须位于当前会话的工作目录边界内，或 Aurora 自己生成的图片目录内。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '图片文件路径（绝对或相对当前工作目录）' },
        caption: { type: 'string', description: '图片说明（可选，一句话）' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    sensitivity: 'safe',
    execute: async (input, ctx): Promise<ToolResult> => {
      const record = asRecord(input)
      const path = readNonEmptyString(record, 'path')
      if (path === undefined) {
        return {
          content: '缺少参数：path（要展示的图片路径）。',
          isError: true,
          summary: '图片参数缺失',
        }
      }
      const caption = readNonEmptyString(record, 'caption')
      try {
        const image = await options.port.prepareImage({
          path,
          ...(caption === undefined ? {} : { caption }),
          sessionId: ctx.sessionId,
        })
        return {
          content: `已在对话中展示图片：${image.name}`,
          summary: '已展示图片',
          displayImages: [image],
        }
      } catch (error) {
        return {
          content: `展示图片失败：${describeError(error)}`,
          isError: true,
          summary: '展示图片失败',
        }
      }
    },
  }
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined
}

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
