/**
 * `view_image` 工具（图像工具，docs/06 §25）。
 *
 * 分层与 `tools/files.ts` / `tools/imagegen.ts` 同一套：内核只认识**注入的端口**，
 * 真实读盘（以及项目根边界校验、单图大小上限）由主进程实现并注入，
 * 本文件保持纯 Node 可单测。
 *
 * 它补上的正是此前的缺口：`read_file` 明确拒绝二进制（含 NUL 即报错），
 * 于是「让模型看一眼这张图」只有用户拖拽附件这一条路 —— 工具侧只能被动等图。
 *
 * 门控不在本文件：模型不支持图片输入时，**注册处**（主进程 `registerImageTools`）
 * 根本不把它放进工具表（docs/06 §25），所以这里没有「不支持就拒绝」的分支 ——
 * 能跑到这里就说明当前模型看得懂图。
 */
import type { ToolDefinition, ToolImage, ToolResult } from './registry.js'
import type { LlmImageInput } from '../llm/types.js'

export const VIEW_IMAGE_TOOL_NAME = 'view_image'

/** 一次读图的结果：`image` 缺省 = 读不出来（`note` 说明原因），调用方按失败如实回填。 */
export interface ViewImageResult {
  /** 实际读取的路径（主进程回带，便于工具结果里显示模型自己给的那个路径） */
  path: string
  image?: LlmImageInput
  /** 读不出来的原因（越界 / 超限 / 不存在），**原样回填给模型** */
  note?: string
}

export interface ViewImagePort {
  /**
   * 读一张本地图片。
   *
   * `sessionId` 一并传入：读盘边界是**按会话解析**的项目根（docs/06 §5.1），
   * 两个会话绑定了不同项目时各按各的根判定（与 `file-port` 同一条链）。
   */
  view(input: { path: string; sessionId: string }): Promise<ViewImageResult>
}

export interface ViewImageToolOptions {
  port: ViewImagePort
}

export function createViewImageTool(options: ViewImageToolOptions): ToolDefinition {
  return {
    name: VIEW_IMAGE_TOOL_NAME,
    description:
      '读取本地的一张图片并把图片内容交给你看（截图、生成的图片、用户给的路径都可以）。' +
      '只能读图片格式（png / jpg / jpeg / webp / gif / bmp），读文本文件请用 read_file。' +
      '路径在项目根之外时会被拒绝，此时可以请用户把图片拖进对话窗口。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '图片的绝对路径（或相对当前工作目录的路径）' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    sensitivity: 'safe',
    parallel: true,
    execute: async (input, ctx): Promise<ToolResult> => {
      const path = readNonEmptyString(asRecord(input), 'path')
      if (path === undefined) {
        return {
          content: '缺少参数 path（要查看的图片路径）。',
          isError: true,
          summary: '缺少 path 参数',
        }
      }

      let result: ViewImageResult
      try {
        result = await options.port.view({ path, sessionId: ctx.sessionId })
      } catch (error) {
        return {
          content: `读取图片失败：${describeError(error)}`,
          isError: true,
          summary: '读取图片失败',
        }
      }

      const target = result.path === '' ? path : result.path
      const image = result.image
      if (image === undefined) {
        return {
          content: `未能读取图片 ${target}：${result.note ?? '原因未知'}`,
          isError: true,
          summary: '读取图片失败',
        }
      }

      const images: ToolImage[] = [{ path: target, image }]
      return {
        content: `已读取图片 ${target}（图片内容随本条结果一起提供，请直接看图作答）。`,
        summary: '已读取图片',
        images,
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
