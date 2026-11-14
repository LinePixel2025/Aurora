/** Minimal protocol between the main process and the Office utility worker. */
import type {
  OfficeBatchCommand,
  OfficeFormat,
  OfficeRawOperation,
  OfficeReadMode,
  OfficeRenderMode,
} from '@aurora/agent-core'

export type OfficeWorkerAction = 'read' | 'help' | 'create' | 'edit' | 'raw-edit' | 'render' | 'pdf'

interface OfficeWorkerBaseRequest {
  id: string
  timeoutMs: number
}

export interface OfficeWorkerReadRequest extends OfficeWorkerBaseRequest {
  action: 'read'
  path: string
  format: OfficeFormat
  mode: OfficeReadMode
  target?: string
  offset: number
  limit: number
  depth: number
}

export interface OfficeWorkerHelpRequest extends OfficeWorkerBaseRequest {
  action: 'help'
  format: OfficeFormat
  verb?: string
  element?: string
}

export interface OfficeWorkerCreateRequest extends OfficeWorkerBaseRequest {
  action: 'create'
  outputPath: string
  format: OfficeFormat
  commands: OfficeBatchCommand[]
  templatePath?: string
  templateData?: Record<string, unknown>
}

export interface OfficeWorkerEditRequest extends OfficeWorkerBaseRequest {
  action: 'edit'
  sourcePath: string
  outputPath: string
  format: OfficeFormat
  commands: OfficeBatchCommand[]
}

export interface OfficeWorkerRawEditRequest extends OfficeWorkerBaseRequest {
  action: 'raw-edit'
  sourcePath: string
  outputPath: string
  format: OfficeFormat
  operations: OfficeRawOperation[]
}

export interface OfficeWorkerRenderRequest extends OfficeWorkerBaseRequest {
  action: 'render'
  sourcePath: string
  format: OfficeFormat
  mode: OfficeRenderMode
  outputDir: string
  target?: string
  pageStart?: number
  pageEnd?: number
  grid?: number
  maxPages: number
  /**
   * 只渲染第 n 页（0 基，2026-11-12 文件面板版式预览）。在 `resolveRenderPages` 得出的
   * pages 数组上切片 —— xlsx 走工作表分支、完全忽略 pageStart/pageEnd，只有数组切片
   * 能同时覆盖 docx 页 / xlsx 工作表 / pptx 幻灯片。缺省时行为逐字不变。
   */
  pageIndex?: number
}

export interface OfficeWorkerPdfRequest extends OfficeWorkerBaseRequest {
  action: 'pdf'
  sourcePath: string
  outputPath: string
  format: OfficeFormat
  pageStart?: number
  pageEnd?: number
}

export type OfficeWorkerRequest =
  | OfficeWorkerReadRequest
  | OfficeWorkerHelpRequest
  | OfficeWorkerCreateRequest
  | OfficeWorkerEditRequest
  | OfficeWorkerRawEditRequest
  | OfficeWorkerRenderRequest
  | OfficeWorkerPdfRequest

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export type OfficeWorkerRunRequest = DistributiveOmit<OfficeWorkerRequest, 'id'>

export interface OfficeWorkerReadResult {
  content: string
  truncated: boolean
  warnings: string[]
}

export interface OfficeWorkerHelpResult {
  content: string
  truncated: boolean
}

export interface OfficeWorkerWriteResult {
  bytes: number
  warnings: string[]
}

export interface OfficeWorkerRenderResult {
  files: string[]
  pageCount?: number
  /** 每页标签（工作表名 / 页序号）；只在 `pageIndex` 请求时回，缺省响应形状不变 */
  pageLabels?: string[]
  warnings: string[]
}

export interface OfficeWorkerPdfResult {
  bytes: number
  pages: number
  warnings: string[]
}

export interface OfficeWorkerResponse {
  id: string
  ok: boolean
  read?: OfficeWorkerReadResult
  help?: OfficeWorkerHelpResult
  write?: OfficeWorkerWriteResult
  render?: OfficeWorkerRenderResult
  pdf?: OfficeWorkerPdfResult
  error?: string
  code?: string
  suggestion?: string
}
