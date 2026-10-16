/**
 * 消息路由中心（docs/12 §4）：网页命令 → 客户端，客户端事件 → 属主 + 管理员。
 *
 * 信任边界：
 * - **属主关系只信服务器记账**：客户端属主来自客户端令牌（登记表持久化），
 *   会话属主记录在 `sessionOwners`（谁发起 `session.create` 谁拥有）——不信任任何一方自报；
 * - 命令转发前做**白名单预检**（`CENTER_REMOTE_CONFIG_PREFIXES`，仅 config.update；
 *   llm.switch 等专用命令不做预检，客户端侧还会再验一道）；
 * - 待回执的命令带超时，超时向网页端合成错误回执，不让请求悬死。
 */
import { randomBytes } from 'node:crypto'
import {
  CENTER_REMOTE_CONFIG_PREFIXES,
  CENTER_SESSION_PREFIX,
  type AskSettleOutcome,
  type AskUserRequestPayload,
  type CenterClientMessage,
  type CenterCommand,
  type CenterServerMessage,
  type CenterWebMessage,
  type CenterWebServerMessage,
  type ClientInfo,
  type ClientStatus,
} from '@aurora/shared'
import type { UserRecord } from './auth.js'
import type { ClientRegistry } from './clients.js'
import type { Logger } from '@aurora/shared'

export interface ClientConn {
  clientId: string
  send(message: CenterServerMessage): void
  close(): void
}

export interface WebConn {
  id: string
  user: Pick<UserRecord, 'id' | 'username' | 'role'>
  send(message: CenterWebServerMessage): void
}

export interface HubDeps {
  clients: ClientRegistry
  usernameOf(userId: string): string
  serverVersion(): string
  logger?: Logger
  /**
   * 查暂存文件（`file.send` 用，本轮 docs/12 §5）：服务器据此在转发前补齐 `name` / `size`。
   * 返回 `undefined` = 文件不存在 / 已过期 → 命令回 `E_NOT_FOUND` 且不进 pending。
   * 未注入时该命令一律 `E_NOT_FOUND`（老装配器兼容）。
   */
  fileLookup?: (fileId: string) => { clientId: string; name: string; size: number } | undefined
}

/** 待回执命令的超时：session.input 的回执是"客户端收下了"（毫秒级），15s 足够宽裕 */
const PENDING_TIMEOUT_MS = 15_000
/**
 * 语音中转命令（stt.transcribe / tts.synthesize，docs/12 §6.4）的待回执超时：
 * 客户端调本机 STT / TTS provider 本身就有 30s 级超时（stt.ts / tts.ts 的
 * `DEFAULT_TIMEOUT_MS`），沿用 15s 会让服务器**先于客户端**超时、把还在转写的
 * 请求报成 E_CLIENT_TIMEOUT。与协议注释「网页端回执等待放宽到 60s」对齐。
 */
const VOICE_PENDING_TIMEOUT_MS = 60_000
/** 语音中转命令（按 cmd.kind 判定，用放宽后的超时） */
const VOICE_KINDS: ReadonlySet<string> = new Set(['stt.transcribe', 'tts.synthesize'])

/**
 * 文件下发命令（`file.send`，本轮 docs/12 §5）的待回执超时：客户端要把文件**流式下载**
 * 到本机（可能几十 MB），15s 必然不够 —— 沿用默认值会让服务器**先于客户端**超时，
 * 把一次成功的下载报成 `E_CLIENT_TIMEOUT`（与 `VOICE_KINDS` 同一类坑）。
 */
const FILE_PENDING_TIMEOUT_MS = 10 * 60_000
/** 文件下发命令（按 cmd.kind 判定，用放宽后的超时） */
const FILE_KINDS: ReadonlySet<string> = new Set(['file.send'])

/**
 * 待回执条目（P1-03），键为 `${webConnId}:${requestId}`。
 *
 * 键里带网页连接 id：两条页签用相同 requestId 发命令时各记各的，不再互相覆盖
 * （旧实现是全局 `requestId` 单键）。
 * `clientId` 记的是**这条命令被转发给的那台客户端**：回执必须由它发回，别台客户端
 * 拿猜到的 requestId 伪造 result 会被 `settlePending` 直接丢掉。
 */
interface PendingEntry {
  webConnId: string
  clientId: string
  requestId: string
  timer: NodeJS.Timeout
}

/** 纯对象判定（数组 / null / 标量一律不算）：入站消息的形状守卫共用（P0-01 / P1-02） */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 结算原因归化：未知取值按 `'answered'`（客户端已结算，网页端只需要知道"可以收起了"） */
function normalizeSettleOutcome(value: unknown): AskSettleOutcome {
  return value === 'skipped' || value === 'timedOut' || value === 'aborted' ? value : 'answered'
}

/**
 * 入站的字符串数组（`ask.settled` 的作答）：**整体要么是合法数组要么 undefined**。
 *
 * 畸形的入站帧（`answers: 'x'`、`answers: {}`、元素含非字符串）不让它半截通过：
 * 只读卡宁可只显示结算原因，也不要显示一个来路不明的"答案"。
 */
function stringArrayOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.every((item) => typeof item === 'string') ? [...(value as string[])] : undefined
}

/** 二维字符串数组（多问时的分组作答）：逐层校验，任一层不合法即整体丢弃 */
function stringMatrixOf(value: unknown): string[][] | undefined {
  if (!Array.isArray(value)) return undefined
  const groups: string[][] = []
  for (const group of value) {
    const parsed = stringArrayOf(group)
    if (parsed === undefined) return undefined
    groups.push(parsed)
  }
  return groups
}

const pendingKey = (webConnId: string, requestId: string): string => `${webConnId}:${requestId}`

/** 会话类命令（带 sessionId）：forwardCommand 时未记账则顺带补记属主（与 create 同款） */
const SESSION_OWNER_KINDS: ReadonlySet<string> = new Set([
  'session.input',
  'session.activate',
  'session.visibility',
  'session.setPermission',
  'session.setProject',
  'session.setModel',
])

export class Hub {
  private readonly clientConns = new Map<string, ClientConn>()
  private readonly webConns = new Map<string, WebConn>()
  /** `${webConnId}:${requestId}` → 待回执条目（回执路由 + 超时；键含连接 id，见 PendingEntry） */
  private readonly pending = new Map<string, PendingEntry>()
  /** sessionId → { userId, clientId }（会话属主记账） */
  private readonly sessionOwners = new Map<string, { userId: string; clientId: string }>()
  /** clientId → 最近一次状态快照（网页端展示开关 / 模式） */
  private readonly statusByClient = new Map<string, ClientStatus>()
  /**
   * requestId → 未过期的提问（`ask.request` 登记，v0.3.3 docs/12 §5）。
   *
   * 只存内存、不持久化（与「服务器不缓存会话内容」同口径，这里缓存的是一条尚未结算的
   * 待答问题）；`ask.resolve` 或过期后被清除。网页端新连上时回放，否则刷新一次页签就
   * 再也答不上（提问窗口 180s，比确认卡的 60s 长得多）。
   */
  private readonly pendingAsks = new Map<
    string,
    { clientId: string; sessionId: string; request: AskUserRequestPayload }
  >()

  constructor(private readonly deps: HubDeps) {}

  // ─────────────── 连接生命周期 ───────────────

  registerClient(conn: ClientConn, status: ClientStatus): void {
    this.clientConns.set(conn.clientId, conn)
    // hello 派生的占位快照不含 `voice`（只带 capabilities，见 server.ts 的 helloToStatus），
    // 而无条件覆盖会把上一轮带 voice 的完整快照换成「没有语音」——恰好此刻新连上的网页
    // 页签就会读到一个没有麦克风 / 朗读按钮的界面。新连接的第一条真 `status` 毫秒级到达即
    // 刷新，这里只需保住旧值。首次连接（或服务器重启后）没有旧值，行为不变。
    const previous = this.statusByClient.get(conn.clientId)
    this.statusByClient.set(
      conn.clientId,
      previous?.voice === undefined || status.voice !== undefined
        ? status
        : { ...status, voice: previous.voice },
    )
    conn.send({
      type: 'welcome',
      serverVersion: this.deps.serverVersion(),
      clientId: conn.clientId,
    })
    this.broadcastClients()
  }

  /**
   * 断开某个客户端。`conn` 传了就做**身份校验**：只有 `clientConns` 里当前那条
   * 就是这条连接时才删。
   *
   * 为什么需要校验：重连场景下同一 clientId 的新连接可能已经注册完成，旧 socket 的
   * `close` 才迟到（心跳 terminate 与新建连交错、或客户端改配置后立即重连）。
   * 无条件 `delete` 会把**刚上线的新连接**删掉 → 网页端显示离线、且要等下一次重连才恢复
   * （用户感知就是「上线状态不对 / 慢半拍」）。管理员「解除登记」等按 clientId 主动踢人的
   * 路径不传 `conn`，语义是"不管当前是哪条都踢掉"。
   */
  removeClient(clientId: string, conn?: ClientConn): boolean {
    const current = this.clientConns.get(clientId)
    if (current === undefined) return false
    if (conn !== undefined && current !== conn) return false
    this.clientConns.delete(clientId)
    this.broadcastClients()
    return true
  }

  registerWeb(conn: WebConn): void {
    this.webConns.set(conn.id, conn)
    conn.send({ type: 'clients', clients: this.buildClientInfos(conn.user) })
    this.sendStatusTo(conn)
    this.sendPendingAsksTo(conn)
  }

  removeWeb(connId: string): void {
    this.webConns.delete(connId)
  }

  isOnline(clientId: string): boolean {
    return this.clientConns.has(clientId)
  }

  getStatus(clientId: string): ClientStatus | undefined {
    return this.statusByClient.get(clientId)
  }

  // ─────────────── 网页 → 客户端 ───────────────

  handleWebMessage(conn: WebConn, message: CenterWebMessage): void {
    switch (message.type) {
      case 'session.create':
        this.handleSessionCreate(conn, message.clientId, message.requestId)
        break
      case 'session.input':
        this.forwardCommand(conn, message.clientId, {
          kind: 'session.input',
          requestId: message.requestId,
          sessionId: message.sessionId,
          text: message.text,
        })
        break
      case 'session.abort':
        this.forwardCommand(conn, message.clientId, {
          kind: 'session.abort',
          requestId: message.requestId,
          sessionId: message.sessionId,
          agentRequestId: message.agentRequestId,
        })
        break
      case 'config.get':
        this.forwardCommand(conn, message.clientId, {
          kind: 'config.get',
          requestId: message.requestId,
        })
        break
      case 'config.update':
        this.forwardCommand(
          conn,
          message.clientId,
          {
            kind: 'config.update',
            requestId: message.requestId,
            patch: message.patch,
          },
          this.checkPatch(message.patch),
        )
        break
      case 'mode.switch':
        this.forwardCommand(conn, message.clientId, {
          kind: 'mode.switch',
          requestId: message.requestId,
          mode: message.mode,
        })
        break
      case 'confirm.resolve':
        // 确认卡批复：授权与离线判定同其他命令；客户端的 result 回执走通用 pending
        // 通道转回网页端（网页端 requestId 保持不变）。
        this.forwardCommand(conn, message.clientId, {
          kind: 'confirm.resolve',
          requestId: message.requestId,
          confirmId: message.confirmId,
          approved: message.approved,
        })
        break
      case 'ask.resolve': {
        // 提问卡作答（v0.3.3）：先把它从待答表里摘掉（同一 requestId 的第二条页签再作答时
        // 客户端会因已结算回 `settled: false`），再走与 confirm.resolve 同一条转发管道。
        // 逐问作答过 stringMatrixOf：畸形入站帧整体清洗为 undefined，不让来路不明的答案下发。
        this.pendingAsks.delete(message.requestId)
        const answersByQuestion = stringMatrixOf(message.answersByQuestion)
        this.forwardCommand(conn, message.clientId, {
          kind: 'ask.resolve',
          requestId: message.requestId,
          sessionId: message.sessionId,
          answers: message.answers,
          ...(answersByQuestion === undefined ? {} : { answersByQuestion }),
          ...(message.skipped === true ? { skipped: true } : {}),
        })
        break
      }
      // ── 远程会话管理（docs/12 §6.3）：授权与回执同其他命令 ──
      case 'session.list':
        this.forwardCommand(conn, message.clientId, {
          kind: 'session.list',
          requestId: message.requestId,
        })
        break
      case 'session.activate':
        this.forwardCommand(conn, message.clientId, {
          kind: 'session.activate',
          requestId: message.requestId,
          sessionId: message.sessionId,
        })
        break
      case 'session.visibility':
        this.forwardCommand(conn, message.clientId, {
          kind: 'session.visibility',
          requestId: message.requestId,
          sessionId: message.sessionId,
          visible: message.visible,
        })
        break
      case 'session.setPermission':
        this.forwardCommand(conn, message.clientId, {
          kind: 'session.setPermission',
          requestId: message.requestId,
          sessionId: message.sessionId,
          permissionMode: message.permissionMode,
        })
        break
      case 'session.setProject':
        this.forwardCommand(conn, message.clientId, {
          kind: 'session.setProject',
          requestId: message.requestId,
          sessionId: message.sessionId,
          projectId: message.projectId,
        })
        break
      case 'session.setModel':
        // 会话级模型覆盖（本轮，docs/06 §3）：会话数据操作（毫秒级），沿用默认待回执超时。
        // `model` 为空串 = 清除覆盖 —— 原样透传，是否合法由客户端裁决。
        this.forwardCommand(conn, message.clientId, {
          kind: 'session.setModel',
          requestId: message.requestId,
          sessionId: message.sessionId,
          ...(message.providerId === undefined ? {} : { providerId: message.providerId }),
          model: message.model,
        })
        break
      case 'file.send':
        // 把暂存文件推给该客户端落盘（本轮，docs/12 §5）：**服务器查索引补齐 name/size**
        // 后再下发（客户端不必自己 HEAD），查不到直接回 E_NOT_FOUND 不进 pending。
        this.forwardFileSend(conn, message.clientId, message.requestId, message.fileId)
        break
      case 'project.list':
        this.forwardCommand(conn, message.clientId, {
          kind: 'project.list',
          requestId: message.requestId,
        })
        break
      case 'session.history':
        // 历史回放（docs/12 §5 第 7 步 / §6.3）：普通命令转发，授权 / 离线 / 超时判定
        // 同其他命令；客户端从 SessionStore 读盘回传，`result.data` 携带历史消息数组。
        // 服务器不缓存、不记账 —— 历史只在回执里路过。
        this.forwardCommand(conn, message.clientId, {
          kind: 'session.history',
          requestId: message.requestId,
          sessionId: message.sessionId,
        })
        break
      case 'session.readImage':
        // 对话图片读取：与历史回放同一条“客户端现场读、服务器只转发”的零存储路径。
        this.forwardCommand(conn, message.clientId, {
          kind: 'session.readImage',
          requestId: message.requestId,
          sessionId: message.sessionId,
          imageId: message.imageId,
        })
        break
      case 'llm.switch':
        // 专用命令，不做 config.update 的白名单预检（checkPatch 只服务 config.update）
        this.forwardCommand(conn, message.clientId, {
          kind: 'llm.switch',
          requestId: message.requestId,
          ...(message.providerId === undefined ? {} : { providerId: message.providerId }),
          ...(message.model === undefined ? {} : { model: message.model }),
          ...(message.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: message.reasoningEffort }),
        })
        break
      // ── 远程自动化管理（docs/13 §10）：客户端存数据、服务器只转发不缓存。
      // 授权 / 离线 / 超时判定同其他命令；无 sessionId，不进会话属主记账
      //（session.list / project.list 同款处理）。
      case 'automation.list':
        this.forwardCommand(conn, message.clientId, {
          kind: 'automation.list',
          requestId: message.requestId,
        })
        break
      case 'automation.catalog':
        this.forwardCommand(conn, message.clientId, {
          kind: 'automation.catalog',
          requestId: message.requestId,
        })
        break
      case 'automation.save':
        this.forwardCommand(conn, message.clientId, {
          kind: 'automation.save',
          requestId: message.requestId,
          definition: message.definition,
        })
        break
      case 'automation.delete':
        this.forwardCommand(conn, message.clientId, {
          kind: 'automation.delete',
          requestId: message.requestId,
          id: message.id,
        })
        break
      case 'automation.run':
        this.forwardCommand(conn, message.clientId, {
          kind: 'automation.run',
          requestId: message.requestId,
          id: message.id,
        })
        break
      case 'automation.history':
        this.forwardCommand(conn, message.clientId, {
          kind: 'automation.history',
          requestId: message.requestId,
          ...(message.automationId === undefined ? {} : { automationId: message.automationId }),
          ...(message.mode === undefined ? {} : { mode: message.mode }),
          ...(message.limit === undefined ? {} : { limit: message.limit }),
          ...(message.offset === undefined ? {} : { offset: message.offset }),
        })
        break
      // ── 语音中转（v0.3.2，docs/12 §6.4）：客户端用本机已配 STT / TTS provider，
      // 服务器只转发不缓存（音频不落盘、不进任何存储）。授权 / 离线判定同其他命令；
      // 无 sessionId，不进会话属主记账（automation.* 同款）。回执等待放宽到 60s，
      // 见 VOICE_PENDING_TIMEOUT_MS。
      case 'stt.transcribe':
        this.forwardCommand(conn, message.clientId, {
          kind: 'stt.transcribe',
          requestId: message.requestId,
          audioBase64: message.audioBase64,
          mime: message.mime,
        })
        break
      case 'tts.synthesize':
        this.forwardCommand(conn, message.clientId, {
          kind: 'tts.synthesize',
          requestId: message.requestId,
          text: message.text,
        })
        break
      default:
        break // 协议只增不改：未知类型忽略
    }
  }

  private handleSessionCreate(conn: WebConn, clientId: string, requestId: string): void {
    const denial = this.authorize(conn, clientId)
    if (denial !== undefined) {
      conn.send({ type: 'result', requestId, ok: false, error: denial })
      return
    }
    const sessionId = `${CENTER_SESSION_PREFIX}${randomBytes(5).toString('hex')}`
    this.sessionOwners.set(sessionId, { userId: conn.user.id, clientId })
    this.deps.logger?.info('远程会话已创建', { sessionId, clientId, userId: conn.user.id })
    conn.send({ type: 'result', requestId, ok: true, data: { sessionId } })
  }

  /**
   * 文件下发（`file.send`，本轮 docs/12 §5）：授权 → 查索引补齐 name/size → 交给 `forwardCommand`。
   *
   * 校验比普通命令多一条：**文件的来源客户端也必须是这个用户的**（或他是管理员），
   * 否则任何登录用户都能把自己名下的文件推给别人的设备（跨租户写入对方磁盘）。
   * 网页自己上传的文件来源就是目标客户端，天然通过。
   */
  private forwardFileSend(
    conn: WebConn,
    clientId: string,
    requestId: string,
    fileId: string,
  ): void {
    const denial = this.authorize(conn, clientId)
    if (denial !== undefined) {
      conn.send({ type: 'result', requestId, ok: false, error: denial })
      return
    }
    const record = this.deps.fileLookup?.(fileId)
    if (record === undefined) {
      conn.send({ type: 'result', requestId, ok: false, error: 'E_NOT_FOUND' })
      return
    }
    if (conn.user.role !== 'admin') {
      const source = this.deps.clients.get(record.clientId)
      if (source === undefined || source.ownerUserId !== conn.user.id) {
        conn.send({ type: 'result', requestId, ok: false, error: 'E_FORBIDDEN' })
        return
      }
    }
    this.forwardCommand(conn, clientId, {
      kind: 'file.send',
      requestId,
      fileId,
      name: record.name,
      size: record.size,
    })
  }

  /**
   * 通用命令转发：授权 → 在线 → 白名单预检 → 记 pending → 发给客户端。
   * `precheckError` 由调用方传入（config.update 的白名单预检），非空直接回执。
   */
  private forwardCommand(
    conn: WebConn,
    clientId: string,
    cmd: CenterCommand,
    precheckError?: string,
  ): void {
    const requestId = cmd.requestId
    const denial = precheckError ?? this.authorize(conn, clientId)
    if (denial !== undefined) {
      conn.send({ type: 'result', requestId, ok: false, error: denial })
      return
    }
    const target = this.clientConns.get(clientId)
    if (target === undefined) {
      conn.send({ type: 'result', requestId, ok: false, error: 'E_CLIENT_OFFLINE' })
      return
    }
    // 会话类命令顺带补记会话属主（create 之外的入口防御：直接打到未 create 的会话时，
    // input / activate / visibility / setPermission / setProject 同款处理）
    if (
      SESSION_OWNER_KINDS.has(cmd.kind) &&
      'sessionId' in cmd &&
      !this.sessionOwners.has(cmd.sessionId)
    ) {
      this.sessionOwners.set(cmd.sessionId, { userId: conn.user.id, clientId })
    }
    const key = pendingKey(conn.id, requestId)
    // 超时按命令分级：语音要等本机 provider（30s 级 → 60s）；文件下发要等整份文件落盘
    // （可能几十 MB → 10 分钟）；其余（会话数据 / 配置）毫秒级，15s 足够。
    const timeoutMs = VOICE_KINDS.has(cmd.kind)
      ? VOICE_PENDING_TIMEOUT_MS
      : FILE_KINDS.has(cmd.kind)
        ? FILE_PENDING_TIMEOUT_MS
        : PENDING_TIMEOUT_MS
    const timer = setTimeout(() => {
      const current = this.pending.get(key)
      // 只回收自己那一条：同一条网页连接复用同一个 requestId 时（协议上允许），
      // 迟到的旧定时器不能把新条目的 pending 删掉（否则新命令的回执会被静默丢弃）
      if (current === undefined || current.timer !== timer) return
      this.pending.delete(key)
      conn.send({ type: 'result', requestId, ok: false, error: 'E_CLIENT_TIMEOUT' })
    }, timeoutMs)
    this.pending.set(key, { webConnId: conn.id, clientId, requestId, timer })
    target.send({ type: 'cmd', cmd })
  }

  /**
   * 取回并清除一条待回执（P1-03）。
   *
   * 回执只带 `requestId`（协议形状不变，客户端无需知道网页连接 id），因此这里按
   * **（发起客户端, requestId）** 首个匹配取回：条目里记着命令转发给的是哪台客户端，
   * 别的客户端拿着猜到的 requestId 发 result 匹配不到任何条目，直接丢弃（跨租户伪造注入被封堵）。
   * 两条页签用同一个 requestId 打同一台客户端时各有一条条目，按插入顺序（= 命令顺序）
   * 逐条配对，互不串扰。
   */
  private settlePending(clientId: string, requestId: string): PendingEntry | undefined {
    for (const [key, entry] of this.pending) {
      if (entry.clientId !== clientId || entry.requestId !== requestId) continue
      this.pending.delete(key)
      return entry
    }
    return undefined
  }

  /** 授权判定：客户端必须存在（登记表），且是本人名下或管理员。 */
  private authorize(conn: WebConn, clientId: string): string | undefined {
    const record = this.deps.clients.get(clientId)
    if (record === undefined) return 'E_CLIENT_NOT_FOUND'
    if (conn.user.role !== 'admin' && record.ownerUserId !== conn.user.id) {
      return 'E_FORBIDDEN'
    }
    return undefined
  }

  /**
   * 远程配置白名单预检（docs/12 §6.2）：只允许已登记前缀的路径，整条拒绝。
   *
   * ⚠️ 入站消息的**运行时形状无人校验**（server.ts 是盲转型），因此这里必须自己守形状：
   * 缺 `patch`（undefined）或 `patch: null` 会让 `Object.keys()` 抛 TypeError，异常一旦
   * 逃出事件监听器就是 uncaughtException（全仓没有进程级兜底）= 整个服务器退出（P0-01）；
   * 数组虽然不抛，但也不是合法的 patch（下标会被当成配置路径），同款拒绝。
   */
  private checkPatch(patch: unknown): string | undefined {
    if (!isRecord(patch)) return 'E_INVALID_PATCH'
    const allowed = CENTER_REMOTE_CONFIG_PREFIXES as readonly string[]
    for (const path of Object.keys(patch)) {
      if (!allowed.some((prefix) => path === prefix || path.startsWith(`${prefix}.`))) {
        return `E_FORBIDDEN_PATH: ${path}`
      }
    }
    return undefined
  }

  // ─────────────── 客户端 → 网页 ───────────────

  handleClientMessage(clientId: string, message: CenterClientMessage): void {
    switch (message.type) {
      case 'result': {
        // requestId 非字符串（畸形帧）在运行时是可能的：盲查 pending 会拿到 undefined → 无害，
        // 但形状守卫在这里一并做掉，语义更清楚
        if (typeof message.requestId !== 'string') return
        const entry = this.settlePending(clientId, message.requestId)
        if (entry !== undefined) {
          clearTimeout(entry.timer)
          const target = this.webConns.get(entry.webConnId)
          if (target !== undefined) {
            const payload: CenterWebServerMessage = {
              type: 'result',
              requestId: message.requestId,
              ok: message.ok,
              ...(message.data === undefined ? {} : { data: message.data }),
              ...(message.error === undefined ? {} : { error: message.error }),
            }
            target.send(payload)
          }
        }
        break
      }
      case 'session.event': {
        const owner = this.sessionOwners.get(message.sessionId)
        // 属主回落：客户端本地已存在的历史 center- 会话没有 sessionOwners 记录
        // （网页端 session.list 枚举后仍要看它们的事件流），回落用客户端登记表的属主；
        // 客户端不在登记表才丢弃（仍按「属主 + 管理员」规则路由）。
        const ownerId = owner?.userId ?? this.deps.clients.get(clientId)?.ownerUserId
        if (ownerId === undefined) return
        for (const web of this.webConns.values()) {
          if (web.user.role !== 'admin' && web.user.id !== ownerId) continue
          web.send({
            type: 'client.event',
            clientId,
            sessionId: message.sessionId,
            event: message.event,
          })
        }
        break
      }
      case 'confirm.request': {
        // 确认卡转发：按客户端登记表的属主 + 全部管理员路由（与 file.received 同款；
        // 不在线就没有收方，客户端自带 60s 超时按拒绝收尾）
        //
        // ⚠️ 形状守卫（P1-02）：`{"type":"confirm.request"}` 这种缺 request 的畸形帧
        // 会让 `message.request.sessionId` 抛 TypeError，异常逃出监听器即进程退出
        // （与 P0-01 同族）。非纯对象直接丢弃 —— 客户端→网页这条链没有 requestId，
        // 回不了错误帧，忽略就是协议允许的收尾方式。
        if (!isRecord(message.request)) return
        const record = this.deps.clients.get(clientId)
        if (record === undefined) return
        for (const web of this.webConns.values()) {
          if (web.user.role !== 'admin' && web.user.id !== record.ownerUserId) continue
          web.send({
            type: 'confirm.request',
            clientId,
            sessionId: message.request.sessionId,
            request: message.request,
          })
        }
        break
      }
      case 'ask.request': {
        // 提问卡转发（v0.3.3）：路由与形状守卫都与 confirm.request 同款（属主 + 全部管理员；
        // 缺 request 的畸形帧直接丢弃，不抛 TypeError 逃出监听器）。多一步登记 `pendingAsks`：
        // 网页刷新后还能看到未过期的提问（见 sendPendingAsksTo）。
        if (!isRecord(message.request)) return
        const record = this.deps.clients.get(clientId)
        if (record === undefined) return
        const request = message.request as unknown as AskUserRequestPayload
        if (this.isExpired(request.expiresAt)) return
        // sessionId 取请求体里的（客户端消息本身不带它——request 就是 `AskUserRequest` 原文）
        const sessionId = typeof request.sessionId === 'string' ? request.sessionId : ''
        this.pendingAsks.set(request.requestId, { clientId, sessionId, request })
        for (const web of this.webConns.values()) {
          if (web.user.role !== 'admin' && web.user.id !== record.ownerUserId) continue
          web.send({
            type: 'ask.request',
            clientId,
            sessionId,
            request,
          })
        }
        break
      }
      case 'ask.settled': {
        // 提问已在客户端结算（本轮，docs/12 §5）：摘除 pendingAsks 并广播，网页卡立刻收起。
        //
        // 形状守卫（与 P0-01 同族）：字段缺失 / 类型不对一律静默丢弃 ——
        // 客户端→网页这条链没有 requestId 可回错误帧，忽略就是协议允许的收尾方式。
        if (typeof message.requestId !== 'string' || message.requestId === '') return
        const pendingAsk = this.pendingAsks.get(message.requestId)
        // 只受理**这台客户端**登记过的那条：别的客户端拿猜到的 requestId 伪造结算
        // 会把别人还没答的卡片提前收掉（跨租户干扰）。登记表里没有 = 已结算过或从没登记，
        // 幂等丢弃。
        if (pendingAsk === undefined || pendingAsk.clientId !== clientId) return
        this.pendingAsks.delete(message.requestId)
        const record = this.deps.clients.get(clientId)
        if (record === undefined) return
        const outcome = normalizeSettleOutcome(message.outcome)
        // 作答是**不可信入站数据**：非数组 / 元素非字符串一律丢弃（畸形帧不得让下游
        // 渲染层拿到意外形状；只读卡拿不到答案就只显示结算原因）
        const answers = stringArrayOf(message.answers)
        const answersByQuestion = stringMatrixOf(message.answersByQuestion)
        for (const web of this.webConns.values()) {
          if (web.user.role !== 'admin' && web.user.id !== record.ownerUserId) continue
          web.send({
            type: 'ask.settled',
            clientId,
            sessionId: pendingAsk.sessionId,
            requestId: message.requestId,
            outcome,
            ...(answers === undefined ? {} : { answers }),
            ...(answersByQuestion === undefined ? {} : { answersByQuestion }),
          })
        }
        break
      }
      case 'status': {
        this.statusByClient.set(clientId, message.status)
        for (const web of this.webConns.values()) {
          const record = this.deps.clients.get(clientId)
          if (web.user.role !== 'admin' && record?.ownerUserId !== web.user.id) continue
          web.send({ type: 'client.status', clientId, status: message.status })
        }
        break
      }
      case 'hello':
      default:
        break // hello 在握手期已处理；未知类型忽略
    }
  }

  // ─────────────── 快照 ───────────────

  /**
   * 文件到达通知（`/api/ingest/files` 上传完成后调用，docs/12 §5）：
   * 发给属主与全部管理员（server.ts 已知属主，这里只管路由）。
   */
  broadcastFileReceived(
    record: {
      fileId: string
      clientId: string
      name: string
      size: number
      note?: string
      at: string
    },
    ownerUserId: string,
  ): void {
    for (const web of this.webConns.values()) {
      if (web.user.role !== 'admin' && web.user.id !== ownerUserId) continue
      web.send({
        type: 'file.received',
        fileId: record.fileId,
        clientId: record.clientId,
        name: record.name,
        size: record.size,
        ...(record.note === undefined ? {} : { note: record.note }),
        at: record.at,
      })
    }
  }

  /** 网页端可见的客户端全量快照（在线状态 = 此刻有连接；属主或管理员可见）。 */
  buildClientInfos(user: Pick<UserRecord, 'id' | 'role'>): ClientInfo[] {
    const records =
      user.role === 'admin' ? this.deps.clients.list() : this.deps.clients.listFor(user.id)
    return records.map((record) => ({
      clientId: record.clientId,
      name: record.name,
      online: this.clientConns.has(record.clientId),
      version: record.version,
      platform: record.platform,
      mode: (this.statusByClient.get(record.clientId)?.mode ??
        record.lastMode) as ClientInfo['mode'],
      ownerUserId: record.ownerUserId,
      ownerUsername: this.deps.usernameOf(record.ownerUserId),
      lastSeenAt: record.lastSeenAt,
      firstSeenAt: record.firstSeenAt,
    }))
  }

  private broadcastClients(): void {
    for (const web of this.webConns.values()) {
      web.send({ type: 'clients', clients: this.buildClientInfos(web.user) })
    }
  }

  private sendStatusTo(web: WebConn): void {
    for (const [clientId, status] of this.statusByClient) {
      const record = this.deps.clients.get(clientId)
      if (web.user.role !== 'admin' && record?.ownerUserId !== web.user.id) continue
      web.send({ type: 'client.status', clientId, status })
    }
  }

  /**
   * 回放未过期的提问给刚连上的网页（v0.3.3，docs/12 §5）：路由规则与实时转发一致
   * （属主 + 全部管理员）。顺手清掉过期项——过期项没有任何收方，留着只会让 Map 长草。
   */
  private sendPendingAsksTo(web: WebConn): void {
    for (const [requestId, entry] of [...this.pendingAsks]) {
      if (this.isExpired(entry.request.expiresAt)) {
        this.pendingAsks.delete(requestId)
        continue
      }
      const record = this.deps.clients.get(entry.clientId)
      if (web.user.role !== 'admin' && record?.ownerUserId !== web.user.id) continue
      web.send({
        type: 'ask.request',
        clientId: entry.clientId,
        sessionId: entry.sessionId,
        request: entry.request,
      })
    }
  }

  /** `expiresAt` 是毫秒时间戳（`AskUserRequestPayload` 的形状）；非数字按已过期处理 */
  private isExpired(expiresAt: unknown): boolean {
    return typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= Date.now()
  }

  /** 客户端断开时丢弃其属主会话的记账（防 Map 无限增长；网页端刷新列表后自然收尾） */
  dropClientSessions(clientId: string): void {
    for (const [sessionId, owner] of this.sessionOwners) {
      if (owner.clientId === clientId) this.sessionOwners.delete(sessionId)
    }
    // 未结算的提问也一并清（本轮）：客户端已经断开，那张卡永远不会有本地结算通知了；
    // 留着它会被新连上的网页端回放出来，点了必然得到 `E_CLIENT_OFFLINE`
    //（且客户端重连后是**新的** requestId，那条永远不会被对上）。
    for (const [requestId, entry] of this.pendingAsks) {
      if (entry.clientId === clientId) this.pendingAsks.delete(requestId)
    }
  }
}
