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
  /**
   * Streamable HTTP 会话 id（P2-05）：initialize 响应头 `Mcp-Session-Id` 由服务端分配，
   * 规范要求客户端**此后每个请求都回传**。不捕获就会让 `tools/list` / `tools/call`
   * 被 400/404 拒绝（服务器整体不可用），且用户侧无从判断原因。
   */
  private sessionId: string | undefined

  constructor(options: HttpTransportOptions) {
    this.url = options.url
    this.headers = options.headers ?? {}
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    if (typeof this.fetchImpl !== 'function') {
      throw new McpError('E_UNSUPPORTED', '当前运行环境不提供 fetch，无法使用 HTTP 传输的 MCP')
    }
  }

  /**
   * 组装请求头：默认头 → 用户显式配置头（覆盖默认）→ 服务端分配的会话 id。
   *
   * 会话 id 放在最后：它是协议要求的回传值，优先于用户手工配的同名头
   * （静态配置无法知道服务端这次分配了什么）。
   */
  private buildHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...this.headers,
      ...(this.sessionId === undefined ? {} : { 'mcp-session-id': this.sessionId }),
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
        headers: this.buildHeaders(),
        body: JSON.stringify(request),
        signal: controller.signal,
      })
      if (!response.ok) {
        const body = await safeText(response)
        throw new McpError('E_HTTP', `MCP HTTP ${response.status}`, body.slice(0, 300))
      }
      // 会话 id 只在 initialize 响应里出现（规范），但"看到就记住"更稳：
      // 部分服务端会在每个响应里重复下发，重复赋值是同值幂等的。
      const assigned = response.headers.get('mcp-session-id')
      if (assigned !== null && assigned !== '') this.sessionId = assigned
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
      headers: this.buildHeaders(),
      body: JSON.stringify(notification),
    }).catch(() => undefined)
  }

  async close(): Promise<void> {
    this.closed = true
    this.sessionId = undefined
  }

  /**
   * 从 SSE 流里取第一条携带请求 id 的 JSON-RPC 响应。
   *
   * **增量解析（P2-04）**：Streamable HTTP 规范允许服务端写出响应后继续持有流
   * （长工具期间推通知 / 心跳就是这么做的）。等 `response.text()` 会一直挂到流关闭，
   * 先撞上请求超时——响应其实早已到达，于是"执行超过 30s 的 MCP 工具必然报超时"。
   * 这里逐 chunk 解码、按空行切出**完整事件**，命中即返回并取消读取（释放连接）；
   * 只有流自然结束仍无匹配才报协议错。`TextDecoder` 全程复用，跨 chunk 的多字节
   * 字符不会被截断成乱码。
   */
  private async readSse(response: Response, id: number): Promise<JsonRpcResponse> {
    const body = response.body
    if (body === null) {
      // 无流可读（204 / 极简测试替身）→ 回落全量文本解析
      const matched = parseSseResponse(`${await response.text()}\n\n`, id)
      if (matched === undefined) throw sseMiss()
      return matched
    }
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const matched = parseSseResponse(buffer, id)
        if (matched !== undefined) return matched
      }
      buffer += decoder.decode()
      const tail = parseSseResponse(`${buffer}\n\n`, id)
      if (tail === undefined) throw sseMiss()
      return tail
    } finally {
      // 命中即返回：取消剩余流，别把连接留到超时；流已结束时的 cancel 是幂等空操作
      void reader.cancel().catch(() => undefined)
    }
  }
}

/** SSE 流结束 / 无匹配事件时的统一失败形态 */
function sseMiss(): McpError {
  return new McpError('E_PROTOCOL', 'MCP SSE 响应中未找到匹配的 JSON-RPC 回应')
}

/**
 * 从 SSE 文本里找出第一条匹配 `id` 的 JSON-RPC 响应。
 *
 * 先按空行切出**完整事件**（未收全的事件留在调用方缓冲里等下一个 chunk ——
 * 这正是"增量解析"与"等流关闭再切"的区别所在）；完整事件里没有命中的，
 * 再对**尾部残缺块**试一次：只要 `data:` 行已能解析出完整 JSON 且 id 匹配就直接返回，
 * 不必等服务端补上收尾空行（有实现省略末尾空行、同时继续持有连接）。
 * `[DONE]` 与解析失败的事件一律跳过。
 * `id === null` 的回应也接受 —— 服务端在无法判定请求 id 时用 null（JSON-RPC 2.0 约定）。
 */
function parseSseResponse(text: string, id: number): JsonRpcResponse | undefined {
  let cursor = 0
  for (;;) {
    const end = findEventEnd(text, cursor)
    if (end === undefined) break
    const matched = parseSseEvent(text.slice(cursor, end), id)
    cursor = end
    if (matched !== undefined) return matched
  }
  return parseSseEvent(text.slice(cursor), id)
}

/** 单个 SSE 事件块 → 匹配 id 的 JSON-RPC 响应（解析失败 / 不匹配返回 `undefined`） */
function parseSseEvent(block: string, id: number): JsonRpcResponse | undefined {
  const data = block
    .split(/\r\n|\n|\r/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('')
  if (data === '' || data === '[DONE]') return undefined
  try {
    const parsed = JSON.parse(data) as JsonRpcResponse
    if (parsed.id === id || parsed.id === null) return parsed
  } catch {
    return undefined
  }
  return undefined
}

/**
 * 返回 `from` 之后第一个**空行**结束处（事件边界）的下标；没有完整事件时返回 `undefined`。
 * 兼容 `\n` / `\r\n` / `\r` 三种行尾（SSE 规范允许）。
 */
function findEventEnd(text: string, from: number): number | undefined {
  let index = from
  while (index < text.length) {
    const char = text[index]
    let lineEnd: number
    if (char === '\n') lineEnd = index + 1
    else if (char === '\r') lineEnd = text[index + 1] === '\n' ? index + 2 : index + 1
    else {
      index += 1
      continue
    }
    const next = text[lineEnd]
    if (next === '\n') return lineEnd + 1
    if (next === '\r') return lineEnd + (text[lineEnd + 1] === '\n' ? 2 : 1)
    index = lineEnd
  }
  return undefined
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
