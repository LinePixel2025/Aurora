/**
 * Aurora Center Web —— WebSocket 客户端与命令回执表（docs/12 §4.2）。
 *
 * 断线自动重连：指数退避 1s 起步、**5s 封顶**（2026-09-29 从 15s 收紧）：网页端的
 * 「在线 / 离线」完全靠这条 WS 推送（`clients` 全量快照，无轮询兜底），断线期间页面上的
 * 在线状态就是停住不动的旧快照 —— 越早重连，越早对齐真实状态。
 *
 * 命令回执（`result`）与待回执表也在这里：`requestId` **必须不可预测**（见 nextRequestId），
 * 否则任意已配对客户端可以在待回执窗口内逐个猜 `web-N`，把伪造 result 投进别人的网页会话。
 */
import type { CenterWebMessage, CenterWebServerMessage } from '@aurora/shared'

export type SocketStatus = 'idle' | 'connecting' | 'open' | 'closed'

export class CenterSocket {
  onMessage: ((message: CenterWebServerMessage) => void) | null = null
  onStatus: ((status: SocketStatus) => void) | null = null

  private ws: WebSocket | null = null
  private attempt = 0
  private reconnectTimer: number | undefined
  private stopped = true

  connect(token: string): void {
    this.stopped = false
    this.attempt = 0
    this.open(token)
  }

  close(): void {
    this.stopped = true
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.ws?.close()
    this.ws = null
    this.emitStatus('idle')
  }

  /** 连接未就绪时返回 false（调用方按错误处理，不排队） */
  send(message: CenterWebMessage): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
      return true
    }
    return false
  }

  private open(token: string): void {
    this.emitStatus('connecting')
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(
      `${protocol}://${window.location.host}/api/ws?token=${encodeURIComponent(token)}`,
    )
    this.ws = ws
    ws.onopen = () => {
      this.attempt = 0
      this.emitStatus('open')
    }
    ws.onmessage = (event: MessageEvent) => {
      try {
        this.onMessage?.(JSON.parse(String(event.data)) as CenterWebServerMessage)
      } catch {
        // 非 JSON 帧一律忽略
      }
    }
    ws.onclose = () => {
      this.ws = null
      if (this.stopped) {
        this.emitStatus('idle')
        return
      }
      this.emitStatus('closed')
      const delay = Math.min(5_000, 1000 * 2 ** this.attempt)
      this.attempt += 1
      this.reconnectTimer = window.setTimeout(() => this.open(token), delay)
    }
    // onerror 后必然跟随 onclose，重连统一在 onclose 处理
  }

  private emitStatus(status: SocketStatus): void {
    this.onStatus?.(status)
  }
}

/** 全局唯一的连接实例（`state/index.ts` 装配 onMessage / onStatus） */
export const socket = new CenterSocket()

interface PendingCommand {
  resolve: (data: unknown) => void
  reject: (error: Error) => void
  timer: number
}

const pendingCommands = new Map<string, PendingCommand>()

/**
 * 命令 `requestId`（P1-03）：**必须不可预测**。
 *
 * 优先 `crypto.randomUUID()`；明文 HTTP 直连 IP 部署时不是安全上下文（`randomUUID`
 * 在该上下文不存在，调用会抛错），退化为 `getRandomValues` 拼 128 位随机十六进制 ——
 * 两条路径都满足"猜不到"。服务器侧另有 pending 键按连接隔离兜底（hub.ts）。
 */
export function nextRequestId(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()
  const bytes = new Uint8Array(16)
  cryptoApi?.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** 上行一条命令并等 result 回执；ok=false / 超时 / 连接未就绪都按错误处理 */
export function command<T>(message: CenterWebMessage, timeoutMs = 30_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!socket.send(message)) {
      reject(new Error('与 Center 的连接尚未建立，请稍候重试'))
      return
    }
    const timer = window.setTimeout(() => {
      pendingCommands.delete(message.requestId)
      reject(new Error('Center 未在时限内回执（客户端可能离线或正忙）'))
    }, timeoutMs)
    pendingCommands.set(message.requestId, {
      resolve: resolve as (data: unknown) => void,
      reject,
      timer,
    })
  })
}

/** `result` 帧到达：按 requestId 结算（未知 id 一律忽略 —— 协议只增不改） */
export function settleCommand(requestId: string, ok: boolean, data?: unknown, error?: string): void {
  const pending = pendingCommands.get(requestId)
  if (pending === undefined) return
  pendingCommands.delete(requestId)
  window.clearTimeout(pending.timer)
  if (ok) pending.resolve(data)
  else pending.reject(new Error(error || '命令执行失败'))
}

/** 登出 / 断连清理：把所有在途命令按失败结算，别让调用方永远挂着 */
export function rejectAllCommands(reason: Error): void {
  const entries = [...pendingCommands.values()]
  pendingCommands.clear()
  for (const pending of entries) {
    window.clearTimeout(pending.timer)
    pending.reject(reason)
  }
}
