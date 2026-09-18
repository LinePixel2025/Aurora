/**
 * 最小 JSON-RPC 2.0 客户端（docs/06 §7）。
 *
 * 传输无关：`McpTransport` 负责一次"请求 → 响应"往返与单向通知，
 * 本类负责 id 配对、通知分发、超时与关闭时清理在途请求。
 */
import { McpError } from './errors.js'

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcErrorObject {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: JsonRpcErrorObject
}

export interface McpTransport {
  readonly kind: 'stdio' | 'http'
  /** 发送一次请求并等待其响应；失败必须抛 `McpError`。 */
  send(request: JsonRpcRequest, options: { timeoutMs: number }): Promise<JsonRpcResponse>
  /** 单向通知（无 id、不等待响应）。 */
  notify(notification: JsonRpcNotification): void
  close(): Promise<void>
}

export interface JsonRpcClientOptions {
  transport: McpTransport
  /** 单请求超时，默认 30s */
  timeoutMs?: number
  /** 服务端主动通知（如 `notifications/tools/list_changed`） */
  onNotification?(notification: JsonRpcNotification): void
}

export const DEFAULT_MCP_TIMEOUT_MS = 30_000

export class JsonRpcClient {
  private readonly transport: McpTransport
  private readonly timeoutMs: number
  private readonly onNotification: ((notification: JsonRpcNotification) => void) | undefined
  private nextId = 1
  private closed = false

  constructor(options: JsonRpcClientOptions) {
    this.transport = options.transport
    this.timeoutMs = options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS
    this.onNotification = options.onNotification
  }

  get kind(): 'stdio' | 'http' {
    return this.transport.kind
  }

  get isClosed(): boolean {
    return this.closed
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.closed) throw new McpError('E_CLOSED', 'MCP 连接已关闭')
    const id = this.nextId
    this.nextId += 1
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    }

    const response = await this.transport.send(request, {
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
    })

    if (response.error) {
      throw new McpError(
        'E_REMOTE',
        `MCP 服务返回错误：${response.error.message}`,
        response.error.data === undefined ? undefined : JSON.stringify(response.error.data),
      )
    }
    return response.result as T
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return
    this.transport.notify({
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    })
  }

  /** 服务端主动通知：由传输层读取后转交。 */
  handleNotification(notification: JsonRpcNotification): void {
    try {
      this.onNotification?.(notification)
    } catch {
      /* 通知处理异常不影响协议本身 */
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await this.transport.close().catch(() => undefined)
  }
}
