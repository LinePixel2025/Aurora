/** 主进程与 Office worker 之间的最小请求 / 响应协议（两入口共用，避免字符串漂移）。 */
import type { OfficeFormat } from '@aurora/agent-core'

export type OfficeWorkerAction = 'read' | 'create' | 'edit'

export interface OfficeWorkerReadRequest {
  id: string
  action: 'read'
  path: string
  format: OfficeFormat
  target?: string
  offset: number
  limit: number
}

export interface OfficeWorkerCreateRequest {
  id: string
  action: 'create'
  outputPath: string
  format: OfficeFormat
  content?: unknown
  templatePath?: string
  templateData?: Record<string, unknown>
}

export interface OfficeWorkerEditRequest {
  id: string
  action: 'edit'
  sourcePath: string
  outputPath: string
  format: OfficeFormat
  operations: unknown[]
}

export type OfficeWorkerRequest =
  OfficeWorkerReadRequest | OfficeWorkerCreateRequest | OfficeWorkerEditRequest

export type OfficeWorkerRunRequest =
  | Omit<OfficeWorkerReadRequest, 'id'>
  | Omit<OfficeWorkerCreateRequest, 'id'>
  | Omit<OfficeWorkerEditRequest, 'id'>

export interface OfficeWorkerReadResult {
  content: string
  truncated: boolean
  warnings: string[]
}

export interface OfficeWorkerWriteResult {
  bytes: number
  warnings: string[]
}

export interface OfficeWorkerResponse {
  id: string
  ok: boolean
  read?: OfficeWorkerReadResult
  write?: OfficeWorkerWriteResult
  error?: string
}
