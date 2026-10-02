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
    /**
     * 远程切模型 / 思考等级（专用命令，绝不触碰 apiKeyEnc / baseUrl）。
     *
     * `reasoningEffort` 的落值位置（v23 下沉后）在**当前模型**的
     * `llm.providers.<providerId>.modelParams.<当前 model>.reasoningEffort` ——
     * 由本端口的实现（装配层 `main/index.ts` 的 `switchLlm`）写入，
     * connector 只做命令分派与 `allowRemoteConfig` 闸门，自身不碰 settings。
     */
    switchLlm(request: {
      providerId?: string
      model?: string
      reasoningEffort?: ReasoningEffort
    }): Promise<{ ok: boolean; error?: string }>
  }
  /** 远程自动化管理（docs/13 §10）：与远程会话同组，受 allowRemoteSession 闸门 */
  automation?: AutomationRemotePort
  /**
   * 语音中转（v0.3.2，docs/12 §6.4）：本机 STT / TTS 服务（装配层注入**同一实例**，
   * 与 `stt:transcribe` / `tts:synthesize` IPC 共用，不在 connector 里直接构造）。
   * 门控判定经 `readiness` 注入（与 `ClientStatus.voice` 能力位同一份口径），
   * 未注入、或对应能力门控不满足时回 `E_VOICE_NOT_CONFIGURED`（老装配器兼容，
   * 与 sessionManager 同款语义）。
   */
  voice?: {
    /** 门控能力位（每次调用即时取值，设置热改立即生效） */
    readiness: () => { stt: boolean; tts: boolean }
    /** 录音 base64 → 文本；失败抛错（错误文案透传给网页端） */
    transcribe(input: { audioBase64: string; mime: string }): Promise<{ text: string }>
    /** 文本 → 音频；失败抛错（错误文案透传给网页端） */
    synthesize(text: string): Promise<{ audioBase64: string; mimeType: string }>
  }
  /**
   * 结算一张在途敏感工具确认卡（`confirm.resolve` 命令，docs/12 §5.1）。
   * 返回是否命中（false = 已超时 / 已被本地结算 / id 未知）；未注入时不拦截。
   */
  resolveConfirm?: (confirmId: string, approved: boolean) => boolean
  /**
   * 结算一张在途提问卡（`ask.resolve` 命令，docs/12 §5，v0.3.3）。
   * 幂等由 `AskUserService.resolve` 保证：未知 / 已结算的 requestId 返回 false，
   * 网页端据此提示「已失效」而不是当错误（本地卡与网页卡先到先得）。
   */
  resolveAsk?: (input: { requestId: string; answers: string[]; skipped?: boolean }) => boolean
  /** 连接事件回调：绑定时传入发往 Center 的发送函数，断开时传 undefined */
  bindSessionEmit?: (emit: ((message: unknown) => void) | undefined) => void
  onStatusChange?: (state: ConnectionState, lastError?: string) => void
}

export type ConnectionState = 'disabled' | 'connecting' | 'connected' | 'error'

/**
 * 重连退避上限（2026-09-29 提速，用户反馈「客户端上线时 Center 更新太慢」）：
 * 旧值 30s 意味着 Center 重启 / 网络闪断后，设备在网页端最长要等半分钟才重新变绿。
 * 5s 封顶对一台常驻客户端的重连负载可以忽略（退避仍是指数的，只是天花板低），
 * 再叠一层 ±20% 抖动，避免多台设备在 Center 重启后同一毫秒一起回来。
 */
const MAX_BACKOFF_MS = 5_000
/**
 * 服务器心跳看门狗（2026-09-29）：Center 每 `HEARTBEAT_INTERVAL_MS`（15s）发一次 `ping`，
 * 客户端这里连续 `SERVER_PING_TIMEOUT_MS` 收不到就判定链路半开（拔网线 / 休眠 / NAT 静默超时 ——
 * 这种连接 TCP 层不会报错，`close` 事件可能几十分钟都不来），主动断开走重连。
 * 判活快慢直接决定网页端「在线」是否可信，所以这里不等系统 TCP 超时。
 */
export const SERVER_PING_TIMEOUT_MS = 45_000
/** 看门狗检查间隔：只做一次减法，5s 一轮足够（判定精度 = 检查间隔） */
const SERVER_PING_CHECK_INTERVAL_MS = 5_000
/**
 * 离线上行队列上限（docs/12 §5 第 4 步，v0.2.3）：连接器离线期间的确认请求
 * FIFO 入队、重连后 flush；满 20 条丢最旧并写日志 —— 长时间离线的请求本来就
 * 会按本地超时结算（确认 60s 按拒绝、提问 180s 按未回答），补发只是兜「短暂断连」。
 * v0.3.3 起提问请求与确认请求**共用同一条队列与同一个上限**（两者都是「等人接手」的
 * 一次性卡片，合并计数才真正兜住内存与积压）。
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
  /** 上次收到服务器 `ping` 的时刻（心跳看门狗的判据，0 = 还没连上过） */
  private lastServerPingAt = 0
  /** 心跳看门狗定时器（连接期间存在，`teardownSocket` 清） */
  private pingWatchdog: NodeJS.Timeout | undefined
  /** 上次成功连接使用的配置签名；变化时强制重连 */
  private signature = ''
  private disposed = false
  /**
   * 离线上行队列（docs/12 §5 第 4 步）：确认请求与提问请求共用，离线入队、open 后 flush，
   * FIFO 上限见 CONFIRM_QUEUE_LIMIT。`kind` 只用于诊断计数，不影响发送顺序。
   */
  private readonly outboundQueue: { kind: 'confirm' | 'ask'; message: unknown }[] = []

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

  /**
   * 不可逆停机：置 `stopped` 后**没有任何复位路径**（只有 `start()` 会清）。
   *
   * ⚠️ 不要用它表达「用户在设置页关闭 Center」—— 那种情形是**可逆**的，走 `halt()`
   * （P1-04：曾经两处共用 `stopped = true`，于是关闭再启用永远停在 disabled，
   * 仅重启应用能恢复）。
   */
  stop(): void {
    this.stopped = true
    this.halt()
  }

  dispose(): void {
    this.disposed = true
    this.stop()
  }

  /**
   * 拆 socket + 清定时器 + 置 disabled（**可逆**暂停）：不置 `stopped`，
   * 因此再次启用时 `onConfigChanged` 会走到既有重建路径。
   *
   * 调用方：① `onConfigChanged` 的 `enabled=false` 分支（用户关闭 Center）；
   * ② `stop()`（不可逆停机，自身额外置 `stopped`）。
   */
  private halt(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.teardownSocket()
    this.setState('disabled')
    this.attempt = 0
  }

  /** settings:changed 时调用：enabled / serverUrl / token 变化会驱动连接状态 */
  onConfigChanged(): void {
    if (this.stopped || this.disposed) return
    const config = this.deps.config()
    if (!config.enabled) {
      // 用户关闭 Center = 可逆暂停（不置 stopped）：再启用时下面会重建连（P1-04）
      this.halt()
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
    this.enqueueOutbound('confirm', message)
  }

  /**
   * 提问请求入补发队列（v0.3.3，docs/12 §5）：与确认请求同一条队列、同一个上限。
   * 短暂断连（换网 / 服务器 5s 封顶的重连窗口）里提出的问题仍能送达网页端。
   */
  enqueueAsk(message: unknown): void {
    this.enqueueOutbound('ask', message)
  }

  private enqueueOutbound(kind: 'confirm' | 'ask', message: unknown): void {
    while (this.outboundQueue.length >= CONFIRM_QUEUE_LIMIT) {
      const dropped = this.outboundQueue.shift()
      this.logger.warn('离线上行队列已满，丢弃最旧一条', {
        kind: dropped?.kind,
        preview: JSON.stringify(dropped?.message).slice(0, 120),
      })
    }
    this.outboundQueue.push({ kind, message })
  }

  /** 补发队列里的确认请求条数（诊断用） */
  pendingConfirmCount(): number {
    return this.outboundQueue.filter((item) => item.kind === 'confirm').length
  }

  /** 补发队列里的提问请求条数（诊断用） */
  pendingAskCount(): number {
    return this.outboundQueue.filter((item) => item.kind === 'ask').length
  }

  /** socket open 后调用：按 FIFO 补发离线期间积压的卡片请求；发送失败保留余量待下次重连 */
  private flushConfirmQueue(): void {
    const socket = this.socket
    if (socket === undefined) return
    while (this.outboundQueue.length > 0) {
      const item = this.outboundQueue[0]
      if (item === undefined) break
      try {
        socket.send(JSON.stringify(item.message))
        this.outboundQueue.shift()
      } catch (error) {
        this.logger.warn('补发卡片请求失败，保留队列待下次 flush', { error: String(error) })
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
      // 心跳看门狗：连上就先记一次时间，之后每收到一个服务器 `ping` 都刷新
      // （判定与断开见下面 watchdog 的注释）
      this.lastServerPingAt = Date.now()
      const watchdog = setInterval(() => {
        if (this.socket !== socket) return // 已换连接：这份看门狗自然停（teardown 也会清）
        const silentMs = Date.now() - this.lastServerPingAt
        if (silentMs <= SERVER_PING_TIMEOUT_MS) return
        this.logger.warn('长时间未收到 Center 心跳，按链路已断处理并重连', { silentMs })
        // close() 走既有的 failure 路径（置 error → 指数退避重连）；
        // 半开连接上 close 帧发不出去也没关系，terminate 由 failure → teardownSocket 兜底
        failure(new Error(`心跳超时（${silentMs}ms 无 ping）`))
      }, SERVER_PING_CHECK_INTERVAL_MS)
      watchdog.unref?.()
      this.pingWatchdog = watchdog
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
      const delay = backoffDelayMs(this.attempt)
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
    if (this.pingWatchdog !== undefined) {
      clearInterval(this.pingWatchdog)
      this.pingWatchdog = undefined
    }
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
        // 刷新看门狗时间戳：它是"链路还活着"的唯一主动证据（服务器每 15s 发一次）
        this.lastServerPingAt = Date.now()
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
      // ── 语音中转（docs/12 §6.4）：服务远程对话的本机语音能力，与自动化同组受
      // allowRemoteSession 闸门（session.list 同款拒绝语义）；本机未配置 STT / TTS
      // 时回专用错误码 E_VOICE_NOT_CONFIGURED（网页端据此不渲染麦克风 / 朗读按钮，
      // 判定与 ClientStatus.voice 能力位同一份 readiness，别在这两处写两套口径）。
      case 'stt.transcribe':
      case 'tts.synthesize': {
        if (!config.allowRemoteSession) {
          reply(false, undefined, 'E_REMOTE_DISABLED')
          return
        }
        const voice = this.deps.voice
        if (voice === undefined) {
          reply(false, undefined, 'E_VOICE_NOT_CONFIGURED')
          return
        }
        const ready = voice.readiness()
        if (cmd.kind === 'stt.transcribe' ? !ready.stt : !ready.tts) {
          reply(false, undefined, 'E_VOICE_NOT_CONFIGURED')
          return
        }
        try {
          if (cmd.kind === 'stt.transcribe') {
            reply(true, await voice.transcribe({ audioBase64: cmd.audioBase64, mime: cmd.mime }))
          } else {
            reply(true, await voice.synthesize(cmd.text))
          }
        } catch (error) {
          this.logger.warn('远程语音命令执行失败', { kind: cmd.kind, error: String(error) })
          // service 的错误是给用户看的中文文案（超时 / 限流 / 密钥无效），原样透传
          reply(false, undefined, error instanceof Error ? error.message : 'E_UNKNOWN')
        }
        return
      }
      case 'llm.switch': {
        // 专用命令（docs/12 §6.3）：不走 config.update 白名单，但同属"远程改配置"类别，
        // 受 allowRemoteConfig 闸门；handler 只点改 model / reasoningEffort / active，
        // 绝不触碰 apiKeyEnc / baseUrl。
        // 注：`reasoningEffort` 的**落值位置**在实现端（装配层 main/index.ts 的 switchLlm）——
        // v23 起写的是 `providers.<providerId>.modelParams.<当前 model>.reasoningEffort`；
        // connector 侧只做分派，下面的入参逐个透传。
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
      case 'ask.resolve': {
        // 网页端对提问卡的作答（v0.3.3，docs/12 §5）：语义与 confirm.resolve 同款 ——
        // `settled: false` = 本地已作答 / 已超时 / id 未知，网页端提示「已失效」即可；
        // 先到先得由 AskUserService.resolve 的幂等保证（本地卡照常显示、先点的胜出）。
        //
        // 与 confirm.resolve 的唯一差别是这里的**闸门更严**：提问属 session 类别，
        // 关闭 `allowRemoteSession` 后连卡片都不会推给网页（index.ts 的上行钩子同款判定），
        // 因此作答也必须同闸门拒绝 —— 否则会出现「能答一张自己没有的卡」的错位。
        if (!config.allowRemoteSession) {
          reply(false, undefined, 'E_REMOTE_DISABLED')
          return
        }
        const resolved = this.deps.resolveAsk?.({
          requestId: cmd.requestId,
          answers: cmd.answers,
          ...(cmd.skipped === true ? { skipped: true } : {}),
        })
        reply(true, { settled: resolved ?? false })
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

/**
 * 重连退避（毫秒）：1s 起、指数翻倍、`MAX_BACKOFF_MS`（5s）封顶，再叠 ±20% 抖动。
 * 导出供单测钉住行为 —— 抖动让"同一 attempt 的两次调用"不再相等，
 * 因此单测断言的是**区间**（见 `connector.test.ts`）。
 */
export function backoffDelayMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** Math.max(0, attempt), MAX_BACKOFF_MS)
  const jitter = base * 0.2 * (Math.random() * 2 - 1)
  return Math.max(200, Math.round(base + jitter))
}
