/**
 * MCP 传输实现（docs/06 §7）：stdio 与 streamable-http。
 *
 * 安全：
 * - stdio 命令来自**用户显式配置**，参数以 argv 数组传递，绝不经过 shell；
 *   本模块不接受任何来自 LLM 的命令字符串。
 * - stderr 只作为日志，不参与协议。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { McpError } from './errors.js'
import { createFrameState, decodeFrames } from './frames.js'
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  McpTransport,
} from './jsonrpc.js'

// ───────────────────────── stdio ─────────────────────────

export interface StdioTransportOptions {
  command: string
  args?: string[]
  /** 解密后的环境变量（与 process.env 合并，前者优先） */
  env?: Record<string, string>
  cwd?: string
  onStderr?(line: string): void
  /** 服务端主动通知（转交给 JsonRpcClient.handleNotification） */
  onNotification?(notification: JsonRpcNotification): void
  /** 子进程退出时回调（用于把服务器置为 error 并清理工具） */
  onExit?(info: { code: number | null; signal: string | null }): void
}

interface PendingEntry {
  resolve: (response: JsonRpcResponse) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | undefined
}

export class StdioTransport implements McpTransport {
  readonly kind = 'stdio' as const
  private child: ChildProcessWithoutNullStreams | undefined
  private buffer = Buffer.alloc(0)
  private frameState = createFrameState()
  private stderrBuffer = ''
  private readonly pending = new Map<number, PendingEntry>()
  private readonly options: StdioTransportOptions
  private closed = false

  constructor(options: StdioTransportOptions) {
    this.options = options
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child
    const child = spawn(this.options.command, this.options.args ?? [], {
      ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
      env: { ...process.env, ...(this.options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.consumeStderr(chunk))
    child.on('error', (error) => {
      this.failAll(new McpError('E_SPAWN', `MCP 进程启动失败：${error.message}`))
    })
    child.on('exit', (code, signal) => {
      const info = { code: code ?? null, signal: signal ?? null }
      this.failAll(new McpError('E_CLOSED', `MCP 进程已退出（code=${info.code ?? 'null'}）`))
      this.closed = true
      this.options.onExit?.(info)
    })
    this.child = child
    return child
  }

  async send(request: JsonRpcRequest, options: { timeoutMs: number }): Promise<JsonRpcResponse> {
    if (this.closed) throw new McpError('E_CLOSED', 'MCP 连接已关闭')
    const child = this.ensureStarted()
    const payload = frame(JSON.stringify(request))

    return await new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer =
        options.timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(request.id)
              reject(new McpError('E_TIMEOUT', `MCP 请求超时：${request.method}`))
            }, options.timeoutMs)
          : undefined
      timer?.unref?.()

      this.pending.set(request.id, { resolve, reject, timer })

      child.stdin.write(payload, (error) => {
        if (error) {
          this.pending.delete(request.id)
          if (timer !== undefined) clearTimeout(timer)
          reject(new McpError('E_CLOSED', `写入 MCP 进程失败：${error.message}`))
        }
      })
    })
  }

  notify(notification: JsonRpcNotification): void {
    if (this.closed) return
    try {
      const child = this.ensureStarted()
      child.stdin.write(frame(JSON.stringify(notification)))
    } catch {
      /* 通知失败不影响主流程 */
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.buffer = Buffer.alloc(0)
    this.frameState = createFrameState()
    this.failAll(new McpError('E_CLOSED', 'MCP 连接已关闭'))
    const child = this.child
    this.child = undefined
    if (!child) return
    await new Promise<void>((resolve) => {
      const done = (): void => resolve()
      child.once('exit', done)
      try {
        child.stdin.end()
        child.kill()
      } catch {
        resolve()
      }
      // 兜底：2s 内未退出也视为已关闭
      const timer = setTimeout(done, 2_000)
      timer.unref?.()
    })
  }

  // ───────────────────────── 内部 ─────────────────────────

  /**
   * stdout 按 `Content-Length` 分帧（见 `frames.ts`）：
   * 跨 chunk 边界安全，兼容帧间换行与"一行一个 JSON"。
   */
  private consumeStdout(chunk: string): void {
    this.buffer =
      this.buffer.length === 0
        ? Buffer.from(chunk, 'utf8')
        : Buffer.concat([this.buffer, Buffer.from(chunk, 'utf8')])
    const result = decodeFrames(this.buffer, this.frameState)
    if (result.cursor > 0) {
      this.buffer = this.buffer.subarray(result.cursor)
      this.frameState = createFrameState()
    }
    for (const message of result.messages) {
      if (message.error !== undefined) {
        this.options.onStderr?.(`无法解析的 MCP 报文：${message.error.slice(0, 200)}`)
        continue
      }
      this.handleMessage(message.text)
    }
  }

  private consumeStderr(chunk: string): void {
    this.stderrBuffer += chunk
    for (;;) {
      const newline = this.stderrBuffer.indexOf('\n')
      if (newline < 0) {
        if (this.stderrBuffer.length > 8_192) {
          this.options.onStderr?.(this.stderrBuffer.slice(0, 8_192))
          this.stderrBuffer = ''
        }
        return
      }
      const line = this.stderrBuffer.slice(0, newline).trim()
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1)
      if (line !== '') this.options.onStderr?.(line)
    }
  }

  private handleMessage(text: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      this.options.onStderr?.(`无法解析的 MCP 报文：${text.slice(0, 200)}`)
      return
    }

    const message = parsed as Partial<JsonRpcResponse> & Partial<JsonRpcNotification>
    if (typeof message.method === 'string') {
      this.options.onNotification?.(message as JsonRpcNotification)
      return
    }
    if (typeof message.id !== 'number') return

    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.resolve(message as JsonRpcResponse)
  }

  private failAll(error: McpError): void {
    for (const [, entry] of this.pending) {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }
}

// ───────────────────────── http (streamable-http) ─────────────────────────

export interface HttpTransportOptions {
  url: string
  headers?: Record<string, string>
  fetchImpl?: typeof fetch
}

export class HttpTransport implements McpTransport {
  readonly kind = 'http' as const
  private readonly url: string
  private readonly headers: Record<string, string>
  private readonly fetchImpl: typeof fetch
  private closed = false

  constructor(options: HttpTransportOptions) {
    this.url = options.url
    this.headers = options.headers ?? {}
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    if (typeof this.fetchImpl !== 'function') {
      throw new McpError('E_UNSUPPORTED', '当前运行环境不提供 fetch，无法使用 HTTP 传输的 MCP')
    }
  }

  async send(request: JsonRpcRequest, options: { timeoutMs: number }): Promise<JsonRpcResponse> {
    if (this.closed) throw new McpError('E_CLOSED', 'MCP 连接已关闭')
    const controller = new AbortController()
    const timer =
      options.timeoutMs > 0 ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined
    timer?.unref?.()

    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...this.headers,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      })
      if (!response.ok) {
        const body = await safeText(response)
        throw new McpError('E_HTTP', `MCP HTTP ${response.status}`, body.slice(0, 300))
      }
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('text/event-stream')) {
        return await this.readSse(response, request.id)
      }
      const payload = (await response.json()) as JsonRpcResponse
      return payload
    } catch (error) {
      if (error instanceof McpError) throw error
      const message = error instanceof Error ? error.message : String(error)
      if (controller.signal.aborted) {
        throw new McpError('E_TIMEOUT', `MCP 请求超时：${request.method}`)
      }
      throw new McpError('E_HTTP', `MCP 请求失败：${message}`)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  notify(notification: JsonRpcNotification): void {
    if (this.closed) return
    void this.fetchImpl(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...this.headers,
      },
      body: JSON.stringify(notification),
    }).catch(() => undefined)
  }

  async close(): Promise<void> {
    this.closed = true
  }

  /** 从 SSE 流里取第一条携带请求 id 的 JSON-RPC 响应。 */
  private async readSse(response: Response, id: number): Promise<JsonRpcResponse> {
    const body = await response.text()
    const blocks = body.split(/\r?\n\r?\n/)
    for (const block of blocks) {
      const dataLines = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
      const data = dataLines.join('')
      if (data === '' || data === '[DONE]') continue
      try {
        const parsed = JSON.parse(data) as JsonRpcResponse
        if (parsed.id === id || parsed.id === null) return parsed
      } catch {
        continue
      }
    }
    throw new McpError('E_PROTOCOL', 'MCP SSE 响应中未找到匹配的 JSON-RPC 回应')
  }
}

// ───────────────────────── 工具 ─────────────────────────

export function frame(payload: string): string {
  return `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}
