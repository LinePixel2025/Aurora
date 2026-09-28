/**
 * Aurora Center 连接器（docs/12 §2.1）：出站 WebSocket + 指数退避重连 +
 * 命令分发。真实 WS 由 `wsFactory` 注入（生产 = `ws` 包，单测 = 假 socket），
 * 因此连接状态机可在 Node 里完整单测。
 *
 * 三个 `allow*` 开关是**命令类别的最终闸门**（docs/12 §7）：被拒的命令回
 * `E_REMOTE_DISABLED`，Center 端如实展示。配置签名（serverUrl/token/enabled）
 * 变化时强制断开重连 —— 换服务器不能还挂在旧连接上。
 */
import type {
  AutomationCatalog,
  AutomationDefinition,
  AutomationHistoryQuery,
  AutomationListResult,
  AutomationRun,
  CenterClientMessage,
  CenterCommand,
  CenterProjectOption,
  CenterSessionSummary,
  ClientStatus,
  ModeId,
  PermissionMode,
  ReasoningEffort,
} from '@aurora/shared'
import type { Logger } from '@aurora/shared'
import type { CenterStatusInfo } from '@aurora/agent-core'
import { CENTER_SESSION_PREFIX } from '@aurora/shared'
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

/**
 * 远程自动化管理端口（docs/13 §10）：客户端存数据、连接器只透传。未注入时相关
 * 命令一律回 `E_SESSION_NOT_FOUND`（老装配器兼容，与 sessionManager 同款语义）。
 */
export interface AutomationRemotePort {
  /** 枚举自动化（user + builtin） */
  list(): Promise<AutomationListResult>
  /** 触发器 / 操作组件的表单元数据（编辑器动态渲染用） */
  catalog(): AutomationCatalog
  /** 校验并保存（id 为空 = 新建）；非法定义回 error 文案，绝不写半份数据 */
  save(
    input: unknown,
  ): Promise<{ ok: true; definition: AutomationDefinition } | { ok: false; error: string }>
  delete(id: string): Promise<{ ok: boolean; error?: string }>
  /** 手动触发一次；返回 runId（Agent Mode 下同时是会话 id） */
  run(id: string): Promise<{ ok: true; runId: string } | { ok: false; error: string }>
  /** 运行历史（triggeredAt 倒序） */
  history(query?: AutomationHistoryQuery): Promise<AutomationRun[]>
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
  /**
   * 远程会话管理命令（docs/12 §6.3，v0.2.3）。**仅接受 `center-` 前缀会话**——
   * 前缀与门控由连接器统一判定，这里的 handler 只管执行。未注入时相关命令一律回
   * `E_SESSION_NOT_FOUND`（老装配器兼容）。
   */
  sessionManager?: {
    /** 枚举 `center-` 前缀会话（`session.list` 的 `result.data`） */
    listSessions(): Promise<CenterSessionSummary[]>
    /** 让主界面切到指定会话（兜底装载未落盘的会话 + 推 `chat:remoteActivate`） */
    activateSession(sessionId: string): Promise<{ ok: boolean; error?: string }>
    /** 开关该会话在客户端左栏的可见性 */
    setVisibility(sessionId: string, visible: boolean): Promise<{ ok: boolean; error?: string }>
    /** 会话级权限档覆盖（SessionMeta 数据，不动全局档） */
    setPermissionMode(
      sessionId: string,
      permissionMode: PermissionMode,
    ): Promise<{ ok: boolean; error?: string }>
    /** 会话绑定项目（`''` 清除）；projectId 合法性由装配层 / store 解析链兜底 */
    setProject(sessionId: string, projectId: string): Promise<{ ok: boolean; error?: string }>
    /** 客户端项目选项（`project.list` 的 `result.data`） */
    listProjects(): CenterProjectOption[]
    /**
     * 历史回放（docs/12 §5 第 7 步，v0.2.4）：读 SessionStore 的渲染层历史，
     * `result.data` 携带 `CenterSessionHistoryMessage[]`（仅 `center-` 前缀会话）。
     */
    history(sessionId: string): Promise<{ ok: boolean; data?: unknown; error?: string }>
    /** 远程切模型 / 思考等级（专用命令，绝不触碰 apiKeyEnc / baseUrl） */
    switchLlm(request: {
      providerId?: string
      model?: string
      reasoningEffort?: ReasoningEffort
    }): Promise<{ ok: boolean; error?: string }>
  }
  /** 远程自动化管理（docs/13 §10）：与远程会话同组，受 allowRemoteSession 闸门 */
  automation?: AutomationRemotePort
  /**
   * 结算一张在途敏感工具确认卡（`confirm.resolve` 命令，docs/12 §5.1）。
   * 返回是否命中（false = 已超时 / 已被本地结算 / id 未知）；未注入时不拦截。
   */
  resolveConfirm?: (confirmId: string, approved: boolean) => boolean
  /** 连接事件回调：绑定时传入发往 Center 的发送函数，断开时传 undefined */
  bindSessionEmit?: (emit: ((message: unknown) => void) | undefined) => void
  onStatusChange?: (state: ConnectionState, lastError?: string) => void
}

export type ConnectionState = 'disabled' | 'connecting' | 'connected' | 'error'

const PING_REPLY_TIMEOUT = 30_000
const MAX_BACKOFF_MS = 30_000
/**
 * 确认请求补发队列上限（docs/12 §5 第 4 步，v0.2.3）：连接器离线期间的确认请求
 * FIFO 入队、重连后 flush；满 20 条丢最旧并写日志 —— 长时间离线的请求本来就
 * 会按本地 60s 超时拒绝，补发只是兜「短暂断连」。
 */
export const CONFIRM_QUEUE_LIMIT = 20

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
  /** 确认请求补发队列（docs/12 §5 第 4 步）：离线入队、open 后 flush，FIFO 上限见 CONFIRM_QUEUE_LIMIT */
  private readonly confirmQueue: unknown[] = []

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
      if (this.signatureOf(config) === this.signature) {
        // 已连接且连接参数没变：相关设置（llm / mode 等，docs/12 §6.1「每次相关变更时上报」）
        // 变了也要重报状态快照 —— 本机设置页改模型后网页端才能看到新值
        this.socket?.send(JSON.stringify({ type: 'status', status: this.deps.statusSnapshot() }))
        return
      }
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

  /**
   * 确认请求入补发队列（docs/12 §5 第 4 步，v0.2.3）。
   *
   * 调用方（index.ts 的 `proactiveScheduler.onRequest`）在连接器离线（emit 为 undefined）
   * 或当次发送失败时调用；socket 下次 open 时按 FIFO flush。满上限丢**最旧** ——
   * 新请求的倒计时更长，旧请求大概率已按本地超时结算（先到先得的另一侧）。
   */
  enqueueConfirm(message: unknown): void {
    while (this.confirmQueue.length >= CONFIRM_QUEUE_LIMIT) {
      const dropped = this.confirmQueue.shift()
      this.logger.warn('确认请求补发队列已满，丢弃最旧一条', {
        preview: JSON.stringify(dropped).slice(0, 120),
      })
    }
    this.confirmQueue.push(message)
  }

  /** 补发队列当前长度（诊断用） */
  pendingConfirmCount(): number {
    return this.confirmQueue.length
  }

  /** socket open 后调用：按 FIFO 补发离线期间积压的确认请求；发送失败保留余量待下次重连 */
  private flushConfirmQueue(): void {
    const socket = this.socket
    if (socket === undefined) return
    while (this.confirmQueue.length > 0) {
      const message = this.confirmQueue[0]
      try {
        socket.send(JSON.stringify(message))
        this.confirmQueue.shift()
      } catch (error) {
        this.logger.warn('补发确认请求失败，保留队列待下次 flush', { error: String(error) })
        return
      }
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
      this.lastError = '尚未配置服务器地址或登录凭据'
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
          // 重抛：session.event 由 SessionBridge.forward 捕获记日志；确认请求由
          // index.ts 的 onRequest 捕获后进补发队列 —— 在这里吞掉会让后者失去入队时机
          //（socket 失效但 close 尚未触发的窗口期）。
          throw error
        }
      })
      // hello / status 已发、emit 已绑定：补发离线期间积压的确认请求（docs/12 §5 第 4 步）
      this.flushConfirmQueue()
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
      // ── 远程会话管理（docs/12 §6.3，v0.2.3）：仅 center- 前缀会话 ──
      case 'session.list':
      case 'session.activate':
      case 'session.visibility':
      case 'session.setPermission':
      case 'session.setProject':
      case 'session.history':
      case 'project.list': {
        // 会话管理属 session 类别：受 allowRemoteSession 闸门
        if (!config.allowRemoteSession) {
          reply(false, undefined, 'E_REMOTE_DISABLED')
          return
        }
        const manager = this.deps.sessionManager
        if (manager === undefined) {
          reply(false, undefined, 'E_SESSION_NOT_FOUND')
          return
        }
        // 带 sessionId 的命令一律先过 center- 前缀：本地会话对 Center 不可见、
        // 不可枚举、不可切换（docs/12 §6.3）
        if (
          cmd.kind !== 'session.list' &&
          cmd.kind !== 'project.list' &&
          !cmd.sessionId.startsWith(CENTER_SESSION_PREFIX)
        ) {
          reply(false, undefined, 'E_SESSION_NOT_FOUND')
          return
        }
        try {
          switch (cmd.kind) {
            case 'session.list': {
              reply(true, await manager.listSessions())
              return
            }
            case 'session.activate': {
              const result = await manager.activateSession(cmd.sessionId)
              reply(result.ok, undefined, result.error)
              return
            }
            case 'session.visibility': {
              const result = await manager.setVisibility(cmd.sessionId, cmd.visible)
              reply(result.ok, undefined, result.error)
              return
            }
            case 'session.setPermission': {
              const result = await manager.setPermissionMode(cmd.sessionId, cmd.permissionMode)
              reply(result.ok, undefined, result.error)
              return
            }
            case 'session.setProject': {
              const result = await manager.setProject(cmd.sessionId, cmd.projectId)
              reply(result.ok, undefined, result.error)
              return
            }
            case 'project.list': {
              reply(true, manager.listProjects())
              return
            }
            case 'session.history': {
              // 历史回放（docs/12 §5 第 7 步）：SessionStore 读盘，回执 data 携带历史消息
              const result = await manager.history(cmd.sessionId)
              reply(result.ok, result.data, result.error)
              return
            }
          }
        } catch (error) {
          this.logger.warn('远程会话管理命令执行失败', {
            kind: cmd.kind,
            error: String(error),
          })
          reply(false, undefined, 'E_UNKNOWN')
        }
        return
      }
      // ── 远程自动化管理（docs/13 §10）：客户端存数据、连接器只透传。自动化是
      // 会话级能力，与远程会话同组受 allowRemoteSession 闸门（session.list 同款拒绝语义）
      case 'automation.list':
      case 'automation.catalog':
      case 'automation.save':
      case 'automation.delete':
      case 'automation.run':
      case 'automation.history': {
        if (!config.allowRemoteSession) {
          reply(false, undefined, 'E_REMOTE_DISABLED')
          return
        }
        const port = this.deps.automation
        if (port === undefined) {
          reply(false, undefined, 'E_SESSION_NOT_FOUND')
          return
        }
        try {
          switch (cmd.kind) {
            case 'automation.list': {
              reply(true, await port.list())
              return
            }
            case 'automation.catalog': {
              reply(true, port.catalog())
              return
            }
            case 'automation.save': {
              // definition 原样透传（合法化校验在引擎的 validateDefinition）
              const result = await port.save(cmd.definition)
              if (result.ok) reply(true, result.definition)
              else reply(false, undefined, result.error)
              return
            }
            case 'automation.delete': {
              const result = await port.delete(cmd.id)
              reply(result.ok, undefined, result.error)
              return
            }
            case 'automation.run': {
              const result = await port.run(cmd.id)
              if (result.ok) reply(true, { runId: result.runId })
              else reply(false, undefined, result.error)
              return
            }
            case 'automation.history': {
              reply(
                true,
                await port.history({
                  ...(cmd.automationId === undefined ? {} : { automationId: cmd.automationId }),
                  ...(cmd.mode === undefined ? {} : { mode: cmd.mode }),
                  ...(cmd.limit === undefined ? {} : { limit: cmd.limit }),
                }),
              )
              return
            }
          }
        } catch (error) {
          this.logger.warn('远程自动化命令执行失败', {
            kind: cmd.kind,
            error: String(error),
          })
          reply(false, undefined, 'E_UNKNOWN')
        }
        return
      }
      case 'llm.switch': {
        // 专用命令（docs/12 §6.3）：不走 config.update 白名单，但同属"远程改配置"类别，
        // 受 allowRemoteConfig 闸门；handler 只点改 model / reasoningEffort / active，
        // 绝不触碰 apiKeyEnc / baseUrl。
        if (!config.allowRemoteConfig) {
          reply(false, undefined, 'E_REMOTE_DISABLED')
          return
        }
        const manager = this.deps.sessionManager
        if (manager === undefined) {
          reply(false, undefined, 'E_SESSION_NOT_FOUND')
          return
        }
        try {
          const result = await manager.switchLlm({
            ...(cmd.providerId === undefined ? {} : { providerId: cmd.providerId }),
            ...(cmd.model === undefined ? {} : { model: cmd.model }),
            ...(cmd.reasoningEffort === undefined ? {} : { reasoningEffort: cmd.reasoningEffort }),
          })
          if (!result.ok) {
            reply(false, undefined, result.error)
            return
          }
          this.socket?.send(JSON.stringify({ type: 'status', status: this.deps.statusSnapshot() }))
          reply(true)
        } catch (error) {
          this.logger.warn('远程 LLM 切换执行失败', { error: String(error) })
          reply(false, undefined, 'E_UNKNOWN')
        }
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
      case 'confirm.resolve': {
        // 网页端对确认卡的批复（docs/12 §5.1）。`settled: false` 说明本地已超时 /
        // 已被本地窗口结算 —— 也算 ok，网页端据此提示「已失效」而不是当错误；
        // 幂等性由 proactive.resolve 保证（未知 confirmId 返回 false，不抛）。
        const settled = this.deps.resolveConfirm?.(cmd.confirmId, cmd.approved) ?? false
        reply(true, { settled })
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
