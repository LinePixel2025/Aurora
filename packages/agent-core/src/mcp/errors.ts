/**
 * MCP 错误类型（docs/06 §7）。
 *
 * 约定：MCP 的任何失败都**不得**中断 Agent 主流程 ——
 * 调用方把 `McpError` 转成状态灯 / 工具错误文本即可。
 */

export type McpErrorCode =
  'E_SPAWN' | 'E_TIMEOUT' | 'E_PROTOCOL' | 'E_HTTP' | 'E_REMOTE' | 'E_CLOSED' | 'E_UNSUPPORTED'

export class McpError extends Error {
  readonly code: McpErrorCode
  readonly detail: string | undefined

  constructor(code: McpErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'McpError'
    this.code = code
    this.detail = detail
  }
}

export function isMcpError(value: unknown): value is McpError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { name?: unknown }).name === 'McpError' &&
    typeof (value as { code?: unknown }).code === 'string'
  )
}

export function toMcpError(value: unknown, fallback: McpErrorCode = 'E_PROTOCOL'): McpError {
  if (isMcpError(value)) return value
  if (value instanceof Error) return new McpError(fallback, value.message)
  return new McpError(fallback, String(value))
}
