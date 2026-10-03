/**
 * 右栏「文件」预览的读盘实现（2026-10-03，docs/07 §2.3）。
 *
 * 安全口径（与 file-port 同源但更严）：
 * - 路径必须在**发起会话**的边界根之内 —— 复用 `resolveWithin` 的 realpath 前缀校验；
 *   但与文件工具不同，边界根解析不出时**直接拒绝**而不是退回无边界 ——
 *   这是渲染层主动发起的任意路径读通道，缺根时放行等于把整个用户目录敞给渲染层；
 * - 文本 2 MB / 图片 10 MB 上限；文本超限**截断**（`truncated` 标记），图片超限拒绝；
 * - 二进制探测：前 8 KB 出现 NUL 字节按二进制处理，返回 `unsupported` ——
 *   绝不把半截乱码当文本塞给渲染层。
 */
import { promises as nodeFs } from 'node:fs'
import { extname } from 'node:path'
import { resolveWithin, isPathOutsideError, type WorkspaceGuardOptions } from './tools/file-port.js'
import type { FilePreviewResult } from '@aurora/shared'

/** 文本预览上限（与附件缩略图同量级；超限截断而不是拒绝 —— 部分内容也有价值） */
export const PREVIEW_TEXT_MAX_BYTES = 2 * 1024 * 1024
/** 图片预览上限：data URL 会放大 4/3 倍，10 MB 是渲染层可承受的上界 */
export const PREVIEW_IMAGE_MAX_BYTES = 10 * 1024 * 1024

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg'])
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown'])

export interface FilePreviewPort {
  /** 会话边界根（`sessionProjects.boundaryRoot` 回落链）；返回 undefined = 无法确定边界 */
  rootOf(sessionId: string): string | undefined
}

function imageMimeOf(ext: string): string {
  switch (ext) {
    case '.svg':
      return 'image/svg+xml'
    case '.ico':
      return 'image/x-icon'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    default:
      return `image/${ext.slice(1)}`
  }
}

export async function buildFilePreview(
  port: FilePreviewPort,
  request: { sessionId: string; path: string },
): Promise<FilePreviewResult> {
  const root = port.rootOf(request.sessionId)
  if (root === undefined || root.trim() === '') {
    throw new Error('当前会话没有可用的工作目录，无法确定预览边界；请先绑定项目或检查工作目录设置')
  }
  const path = typeof request.path === 'string' ? request.path.trim() : ''
  if (path === '') throw new Error('请输入要预览的文件路径')
  const guard: WorkspaceGuardOptions = { workspaceRoot: () => root }
  try {
    await resolveWithin(path, false, guard, request.sessionId)
  } catch (error) {
    if (isPathOutsideError(error)) {
      throw new Error('该路径在当前会话的工作目录边界之外，不能预览')
    }
    throw error
  }

  const stat = await nodeFs.stat(path).catch(() => undefined)
  if (stat === undefined) throw new Error('文件不存在或无法访问')
  if (!stat.isFile()) throw new Error('不是普通文件（目录 / 设备等无法预览）')

  const ext = extname(path).toLowerCase()
  if (IMAGE_EXTENSIONS.has(ext)) {
    if (stat.size > PREVIEW_IMAGE_MAX_BYTES) {
      throw new Error(`图片超过预览上限（${Math.round(stat.size / 1024 / 1024)} MB > 10 MB）`)
    }
    const buffer = await nodeFs.readFile(path)
    return {
      path,
      kind: 'image',
      dataUrl: `data:${imageMimeOf(ext)};base64,${buffer.toString('base64')}`,
      bytes: stat.size,
    }
  }

  if (stat.size > PREVIEW_TEXT_MAX_BYTES) {
    // 超限文本只读前 2 MB：handlebars 一类的超大日志前缀往往就够了
    const buffer = await nodeFs.readFile(path)
    return {
      path,
      kind: MARKDOWN_EXTENSIONS.has(ext) ? 'markdown' : 'text',
      content: decodeText(buffer.subarray(0, PREVIEW_TEXT_MAX_BYTES)),
      bytes: stat.size,
      truncated: true,
    }
  }

  const buffer = await nodeFs.readFile(path)
  if (buffer.subarray(0, 8192).includes(0)) {
    return {
      path,
      kind: 'unsupported',
      bytes: stat.size,
      note: '二进制文件不支持预览',
    }
  }
  return {
    path,
    kind: MARKDOWN_EXTENSIONS.has(ext) ? 'markdown' : 'text',
    content: decodeText(buffer),
    bytes: stat.size,
  }
}

/** UTF-8 解码 + 去掉 BOM；畸形字节序列由 TextDecoder 的替换策略兜成 U+FFFD */
function decodeText(buffer: Buffer): string {
  const text = new TextDecoder('utf-8').decode(buffer)
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}
