/**
 * Aurora Center 连接器（docs/12 §2.1）：出站 WebSocket + 指数退避重连 +
 * 命令分发。真实 WS 由 `wsFactory` 注入（生产 = `ws` 包，单测 = 假 socket），
 * 因此连接状态机可在 Node 里完整单测。
 *
 * 三个 `allow*` 开关是**命令类别的最终闸门**（docs/12 §7）：被拒的命令回
 * `E_REMOTE_DISABLED`，Center 端如实展示。配置签名（serverUrl/token/enabled）
 * 变化时强制断开重连 —— 换服务器不能还挂在旧连接上。
 */
import type { CenterClientMessage, CenterCommand, ClientStatus, ModeId } from '@aurora/shared'
import type { Logger } from '@aurora/shared'
import type { CenterStatusInfo } from '@aurora/agent-core'
import { checkRemotePatch } from './remote-control.js'

export interface WsLike {
  send(data: string): void
  close(): void
  on(event: string, listener: (...args: unknown[]) => void): void
}

export type WsFactory = (url: string, options: { headers: Record<string, string> }) => WsLike

export interface CenterConfig {
  enabled: boolean
  serverUrl: string
  token: string
  clientId: string
  displayName: string
  allowRemoteSession: boolean
  allowRemoteConfig: boolean
  allowFileTransfer: boolean
}

export interface CenterConnectorDeps {
  logger: Logger
  /** 每次调用即时取值：设置热改立即生效 */
  config: () => CenterConfig
  /** 客户端状态快照（hello 与 status 上报共用） */
  statusSnapshot: () => ClientStatus
  version: string
  platform: string
  /** 缺省取主机名；单测注入固定值 */
  hostname: () => string
  wsFactory?: WsFactory
  /** 应用白名单补丁（已过 checkRemotePatch）；返回错误文案或 undefined */
  applyRemotePatch: (patch: Record<string, unknown>) => Promise<string | undefined>
  /** 脱敏后的完整配置快照（config.get 的回执数据） */
  getRedactedConfig: () => Record<string, unknown>
  /** 切换模式（走 ModeManager.setCurrent，与 `mode:set` IPC 同一条链）；返回错误文案或 undefined */
  switchMode: (mode: ModeId) => Promise<string | undefined>
  /** 远程会话命令处理（SessionBridge）；连接器负责开关门控 */
  sessionHandler: {
    handleInput(message: {
      requestId: string
      sessionId: string
      text: string
    }): Promise<{ ok: boolean; data?: unknown; error?: string }>
    handleAbort(message: { requestId: string; sessionId: string; agentRequestId: string }): {
      ok: boolean
      data?: unknown
      error?: string
    }
  }
  /** 连接事件回调：绑定时传入发往 Center 的发送函数，断开时传 undefined */
  bindSessionEmit?: (emit: ((message: unknown) => void) | undefined) => void
  onStatusChange?: (state: ConnectionState, lastError?: string) => void
}

export type ConnectionState = 'disabled' | 'connecting' | 'connected' | 'error'

const PING_REPLY_TIMEOUT = 30_000
const MAX_BACKOFF_MS = 30_000

export class CenterConnector {
  private readonly deps: CenterConnectorDeps
  private readonly logger: Logger
  private socket: WsLike | undefined
  private state: ConnectionState = 'disabled'
  private lastError: string | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  private attempt = 0
  private stopped = true
  /** 上次成功连接使用的配置签名；变化时强制重连 */
  private signature = ''
  private disposed = false

  constructor(deps: CenterConnectorDeps) {
    this.deps = deps
    this.logger = deps.logger
  }

  // ─────────────── 生命周期 ───────────────

  start(): void {
    this.stopped = false
    this.disposed = false
    this.scheduleConnect(0)
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.teardownSocket()
    this.setState('disabled')
    this.attempt = 0
  }

  dispose(): void {
    this.disposed = true
    this.stop()
  }

  /** settings:changed 时调用：enabled / serverUrl / token 变化会驱动连接状态 */
  onConfigChanged(): void {
    if (this.stopped || this.disposed) return
    const config = this.deps.config()
    if (!config.enabled) {
      this.stop()
      return
    }
    if (this.socket !== undefined || this.reconnectTimer !== undefined) {
      // 在线 / 重连中：签名变了才断开重连（改了无关开关不打扰连接）
      if (this.signatureOf(config) === this.signature) return
      this.teardownSocket()
      if (this.reconnectTimer !== undefined) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = undefined
      }
      this.scheduleConnect(0)
      return
    }
    this.scheduleConnect(0)
  }

  status(): CenterStatusInfo {
    const config = this.deps.config()
    return {
      enabled: config.enabled,
      connected: this.state === 'connected' && this.socket !== undefined,
      serverUrl: config.serverUrl,
      displayName: config.displayName === '' ? this.deps.hostname() : config.displayName,
    }
  }

  connectionState(): { state: ConnectionState; lastError?: string } {
    return {
      state: this.state,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    }
  }

  // ─────────────── 连接 ───────────────

  private scheduleConnect(delayMs: number): void {
    const config = this.deps.config()
    if (this.stopped || this.disposed || !config.enabled) {
      this.setState('disabled')
      return
    }
    if (config.serverUrl.trim() === '' || config.token === '' || config.clientId === '') {
      this.lastError = '尚未配置服务器地址或配对令牌'
      this.setState('error')
      return
    }
    if (this.reconnectTimer !== undefined) return
    this.setState('connecting')
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, delayMs)
    this.reconnectTimer.unref?.()
  }

  private connect(): void {
    const config = this.deps.config()
    if (this.stopped || this.disposed || !config.enabled || this.socket !== undefined) return
    this.signature = this.signatureOf(config)
    const url = wsUrlOf(config.serverUrl)
    if (url === undefined) {
      this.lastError = `无法解析服务器地址：${config.serverUrl}`
      this.setState('error')
      return
    }
    this.logger.info('正在连接 Aurora Center', { url })
    const factory =
      this.deps.wsFactory ??
      ((wsUrl, options): WsLike => {
        // 生产路径：`ws` 包（主进程依赖）。lazy import 避免 Node 环境单测拉起真实网络栈
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Ws = require('ws') as new (
          url: string,
          options: { headers: Record<string, string> },
        ) => WsLike
        return new Ws(wsUrl, options)
      })
    const socket = factory(url, { headers: { Authorization: `Bearer ${config.token}` } })
    this.socket = socket

    socket.on('open', () => {
      this.attempt = 0
      this.lastError = undefined
      this.setState('connected')
      socket.send(
        JSON.stringify({
          type: 'hello',
          hello: {
            clientId: config.clientId,
            name: config.displayName === '' ? this.deps.hostname() : config.displayName,
            version: this.deps.version,
            platform: this.deps.platform,
            mode: this.deps.statusSnapshot().mode,
            capabilities: {
              session: config.allowRemoteSession,
              remoteConfig: config.allowRemoteConfig,
              fileTransfer: config.allowFileTransfer,
            },
          },
        }),
      )
      socket.send(JSON.stringify({ type: 'status', status: this.deps.statusSnapshot() }))
      this.deps.bindSessionEmit?.((message: unknown) => {
        try {
          socket.send(JSON.stringify(message))
        } catch (error) {
          this.logger.warn('向 Center 发送事件失败', { error: String(error) })
        }
      })
    })

    socket.on('message', (data) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(String(data))
      } catch {
        return
      }
      this.handleServerMessage(parsed)
    })

    const failure = (error?: unknown): void => {
      if (this.socket !== socket) return // 旧连接的迟到事件
      this.teardownSocket()
      this.deps.bindSessionEmit?.(undefined)
      if (this.stopped || this.disposed) {
        this.setState('disabled')
        return
      }
      if (error !== undefined) {
        this.lastError = String(error)
      }
      this.setState('error')
      const delay = Math.min(1000 * 2 ** this.attempt, MAX_BACKOFF_MS)
      this.attempt += 1
      this.logger.warn('与 Aurora Center 的连接断开，将自动重连', {
        delayMs: delay,
        attempt: this.attempt,
      })
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined
        this.scheduleConnect(0)
      }, delay)
      this.reconnectTimer.unref?.()
    }
    socket.on('error', (error) => failure(error))
    socket.on('close', () => failure())
  }

  private teardownSocket(): void {
    const socket = this.socket
    this.socket = undefined
    if (socket !== undefined) {
      try {
        socket.close()
      } catch {
        /* 已经断开 */
      }
    }
  }

  private signatureOf(config: CenterConfig): string {
    return `${config.serverUrl}|${config.token}|${config.clientId}`
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return
    this.state = state
    this.deps.onStatusChange?.(state, this.lastError)
  }

  // ─────────────── 消息 ───────────────

  private handleServerMessage(parsed: unknown): void {
    if (typeof parsed !== 'object' || parsed === null) return
    const message = parsed as { type?: string }
    switch (message.type) {
      case 'ping':
        this.socket?.send(JSON.stringify({ type: 'pong' } satisfies CenterClientMessage))
        return
      case 'welcome':
        return
      case 'cmd':
        void this.runCommand((parsed as { cmd: CenterCommand }).cmd)
        return
      default:
        return // 协议只增不改
    }
  }

  private async runCommand(cmd: CenterCommand): Promise<void> {
    const config = this.deps.config()
    const reply = (ok: boolean, data?: unknown, error?: string): void => {
      this.socket?.send(
        JSON.stringify({
          type: 'result',
          requestId: cmd.requestId,
          ok,
          ...(data === undefined ? {} : { data }),
          ...(error === undefined ? {} : { error }),
        } satisfies CenterClientMessage),
      )
    }
    switch (cmd.kind) {
      case 'session.input':
      case 'session.abort': {
        if (!config.allowRemoteSession) {
          reply(false, undefined, 'E_REMOTE_DISABLED')
          return
        }
        const result =
          cmd.kind === 'session.input'
            ? await this.deps.sessionHandler.handleInput(cmd)
            : this.deps.sessionHandler.handleAbort(cmd)
        reply(result.ok, result.data, result.error)
        return
      }
      case 'config.get': {
        reply(true, this.deps.getRedactedConfig())
        return
      }
      case 'config.update': {
        if (!config.allowRemoteConfig) {
          reply(false, undefined, 'E_REMOTE_DISABLED')
          return
        }
        const check = checkRemotePatch(cmd.patch)
        if (!check.ok) {
          reply(false, undefined, `E_FORBIDDEN_PATH: ${check.forbiddenPath ?? ''}`)
          return
        }
        const error = await this.deps.applyRemotePatch(cmd.patch)
        if (error !== undefined) {
          reply(false, undefined, error)
          return
        }
        this.socket?.send(JSON.stringify({ type: 'status', status: this.deps.statusSnapshot() }))
        reply(true)
        return
      }
      case 'mode.switch': {
        if (!config.allowRemoteConfig) {
          reply(false, undefined, 'E_REMOTE_DISABLED')
          return
        }
        const error = await this.deps.switchMode(cmd.mode)
        if (error !== undefined) {
          reply(false, undefined, error)
          return
        }
        this.socket?.send(JSON.stringify({ type: 'status', status: this.deps.statusSnapshot() }))
        reply(true)
        return
      }
      default:
        return // 未知命令忽略
    }
  }
}

/** ws(s)/http(s) 统一换算成 WS 地址（`/api/client` 端点） */
export function wsUrlOf(serverUrl: string): string | undefined {
  try {
    const url = new URL(serverUrl)
    if (url.protocol === 'wss:') url.protocol = 'wss:'
    else if (url.protocol === 'ws:') url.protocol = 'ws:'
    else if (url.protocol === 'https:') url.protocol = 'wss:'
    else if (url.protocol === 'http:') url.protocol = 'ws:'
    else return undefined
    url.pathname = `${url.pathname.replace(/\/$/, '')}/api/client`
    return url.toString()
  } catch {
    return undefined
  }
}

/** 重连退避（毫秒）：1s 起、指数翻倍、30s 封顶 —— 导出供单测钉住行为 */
export function backoffDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt), MAX_BACKOFF_MS)
}

// PING_REPLY_TIMEOUT 目前仅作文档锚点：服务器主动 ping、客户端立即回 pong，
// 客户端不额外发心跳（半开连接由服务端的心跳超时兜底）
void PING_REPLY_TIMEOUT
