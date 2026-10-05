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
