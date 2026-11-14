/**
 * 右栏「文件」预览的读盘实现（2026-10-03，docs/07 §2.3；2026-11-12 补文档正文）。
 *
 * 安全口径：路径边界统一走 `preview-path.ts` 的 `assertPreviewPath`（五条通道共用，
 * **缺根即拒**，不沿用 `resolveWithin` 给 Agent 工具的那套宽容回落）。
 *
 * 分流顺序（**Office 分支必须在 NUL 探测之前**）：docx/xlsx/pptx 本质是 ZIP，
 * 前 8 KB 必然含 NUL —— 排在二进制探测后面就永远落 unsupported，这正是改造前的症状。
 *
 * 上限：文本 2 MB（超限截断）、图片 10 MB（超限拒绝）、文档 32 MiB（超限拒绝）。
 */
import { promises as nodeFs } from 'node:fs'
import { extname } from 'node:path'
import { assertPreviewPath, type PreviewPathPort } from './preview-path.js'
import { OFFICE_EXTENSIONS, LEGACY_OFFICE_EXTENSIONS } from './extract.js'
import type { FilePreviewResult } from '@aurora/shared'

/** 文本预览上限（与附件缩略图同量级；超限截断而不是拒绝 —— 部分内容也有价值） */
export const PREVIEW_TEXT_MAX_BYTES = 2 * 1024 * 1024
/** 图片预览上限：data URL 会放大 4/3 倍，10 MB 是渲染层可承受的上界 */
export const PREVIEW_IMAGE_MAX_BYTES = 10 * 1024 * 1024
/** 文档正文上限：解析成本随体积超线性增长，32 MiB 以上直接交给系统程序 */
export const PREVIEW_DOCUMENT_MAX_BYTES = 32 * 1024 * 1024

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg'])
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown'])
/** 只有这三种结构化格式能走 OfficeCLI 版式渲染（与 office-port 的 `formatOf` 同口径） */
const LAYOUT_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx'])

/** 文档正文提取结果（由主进程注入的提取池产出，已是干净 Markdown，无证据头部） */
export interface DocumentBody {
  body: string
  warnings: string[]
}

export interface FilePreviewPort extends PreviewPathPort {
  /**
   * Office / PDF 正文提取。**注入**：生产走 `preview-extract.ts` 的子进程池，
   * 单测传假实现即可，不必起 utilityProcess。未注入时文档落 unsupported（渲染层给信息卡）。
   */
  documentBodyOf?(
    path: string,
    ext: string,
    sizeBytes: number,
    mtimeMs: number,
  ): Promise<DocumentBody>
  /** 本机 OfficeCLI 是否可用：决定「版式」档位能不能点，不可用时渲染层直接显示原因 */
  layoutAvailable?(): boolean
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

/** 版式可用性：只对 docx/xlsx/pptx 有意义，其余格式连档位都不出现 */
function layoutFields(
  port: FilePreviewPort,
  ext: string,
): Pick<FilePreviewResult, 'layoutAvailable' | 'layoutUnavailableReason'> {
  if (!LAYOUT_EXTENSIONS.has(ext)) return {}
  if (port.layoutAvailable?.() !== true) {
    return { layoutAvailable: false, layoutUnavailableReason: '本机未安装 Office 渲染组件' }
  }
  return { layoutAvailable: true }
}

export async function buildFilePreview(
  port: FilePreviewPort,
  request: { sessionId: string; path: string },
): Promise<FilePreviewResult> {
  const { path } = await assertPreviewPath(port, request)

  const stat = await nodeFs.stat(path).catch(() => undefined)
  if (stat === undefined) throw new Error('文件不存在或无法访问')
  if (!stat.isFile()) throw new Error('不是普通文件（目录 / 设备等无法预览）')

  const ext = extname(path).toLowerCase()
  const mtimeMs = stat.mtimeMs

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
      mtimeMs,
    }
  }

  // ── 结构化文档：必须在下面的 NUL 探测之前 ──
  const bare = ext.slice(1)
  if (OFFICE_EXTENSIONS.has(bare)) {
    const layout = layoutFields(port, ext)
    if (stat.size > PREVIEW_DOCUMENT_MAX_BYTES) {
      return {
        path,
        kind: 'unsupported',
        bytes: stat.size,
        mtimeMs,
        note: '文档超过预览上限（32 MB），请用系统默认程序打开',
        ...layout,
      }
    }
    if (port.documentBodyOf === undefined) {
      return {
        path,
        kind: 'unsupported',
        bytes: stat.size,
        mtimeMs,
        note: '文档提取器不可用',
        ...layout,
      }
    }
    try {
      const { body, warnings } = await port.documentBodyOf(path, bare, stat.size, mtimeMs)
      return {
        path,
        kind: 'document',
        content: body,
        bytes: stat.size,
        mtimeMs,
        document: { format: bare, warnings },
        ...layout,
      }
    } catch (error) {
      // 提取失败不抛到 IPC 顶层：渲染层要能显示信息卡 + 系统打开，而不是只有一行红字
      return {
        path,
        kind: 'unsupported',
        bytes: stat.size,
        mtimeMs,
        note: `无法抽取正文：${error instanceof Error ? error.message : String(error)}`,
        ...layout,
      }
    }
  }

  if (LEGACY_OFFICE_EXTENSIONS.has(bare)) {
    return {
      path,
      kind: 'unsupported',
      bytes: stat.size,
      mtimeMs,
      note: '老式二进制 Office 格式无法抽取正文，请用系统默认程序打开',
    }
  }

  // 先只嗅头部：音视频 / 压缩包这类文件**绝不能整份读进内存**。
  // 2026-11-14 用户实测：点 `.mov` / `.mp3` 主界面卡死 —— 旧实现在这里 `readFile` 整份读，
  // 而且 > 2 MB 的文件先走「截断当文本」分支，于是 2 MB 二进制垃圾进了渲染层的 `<pre>`
  // （常常一整行没有换行），主进程和渲染层一起卡住；同时因为被判成 text，也不会交给系统程序。
  const head = await readHead(path, BINARY_SNIFF_BYTES)
  if (head.includes(0)) {
    return {
      path,
      kind: 'unsupported',
      bytes: stat.size,
      mtimeMs,
      note: '二进制文件不支持预览',
    }
  }
  const truncated = stat.size > PREVIEW_TEXT_MAX_BYTES
  const buffer = truncated
    ? await readHead(path, PREVIEW_TEXT_MAX_BYTES)
    : await nodeFs.readFile(path)
  return {
    path,
    kind: MARKDOWN_EXTENSIONS.has(ext) ? 'markdown' : 'text',
    content: decodeText(buffer),
    bytes: stat.size,
    mtimeMs,
    ...(truncated ? { truncated: true } : {}),
  }
}

/** 二进制嗅探窗口：与改造前的 NUL 探测同宽，只是不再先整份读 */
export const BINARY_SNIFF_BYTES = 8192

/** 只读文件前 `maxBytes` 字节（不足则读到 EOF）：任何大小的文件都不会整份进内存 */
async function readHead(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await nodeFs.open(path, 'r')
  try {
    const stat = await handle.stat()
    const size = Math.min(stat.size, maxBytes)
    const buffer = Buffer.alloc(size)
    let filled = 0
    while (filled < size) {
      const { bytesRead } = await handle.read(buffer, filled, size - filled, filled)
      if (bytesRead <= 0) break
      filled += bytesRead
    }
    return filled === size ? buffer : buffer.subarray(0, filled)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** UTF-8 解码 + 去掉 BOM；畸形字节序列由 TextDecoder 的替换策略兜成 U+FFFD */
function decodeText(buffer: Buffer): string {
  const text = new TextDecoder('utf-8').decode(buffer)
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}
