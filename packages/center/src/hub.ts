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
}

/** 待回执命令的超时：session.input 的回执是"客户端收下了"（毫秒级），15s 足够宽裕 */
const PENDING_TIMEOUT_MS = 15_000

/** 会话类命令（带 sessionId）：forwardCommand 时未记账则顺带补记属主（与 create 同款） */
const SESSION_OWNER_KINDS: ReadonlySet<string> = new Set([
  'session.input',
  'session.activate',
  'session.visibility',
  'session.setPermission',
  'session.setProject',
])

export class Hub {
  private readonly clientConns = new Map<string, ClientConn>()
  private readonly webConns = new Map<string, WebConn>()
  /** requestId → 发起方（回执路由） */
  private readonly pending = new Map<string, { webConnId: string; timer: NodeJS.Timeout }>()
  /** sessionId → { userId, clientId }（会话属主记账） */
  private readonly sessionOwners = new Map<string, { userId: string; clientId: string }>()
  /** clientId → 最近一次状态快照（网页端展示开关 / 模式） */
  private readonly statusByClient = new Map<string, ClientStatus>()

  constructor(private readonly deps: HubDeps) {}

  // ─────────────── 连接生命周期 ───────────────

  registerClient(conn: ClientConn, status: ClientStatus): void {
    this.clientConns.set(conn.clientId, conn)
    this.statusByClient.set(conn.clientId, status)
    conn.send({
      type: 'welcome',
      serverVersion: this.deps.serverVersion(),
      clientId: conn.clientId,
    })
    this.broadcastClients()
  }

  removeClient(clientId: string): void {
    if (this.clientConns.delete(clientId)) this.broadcastClients()
  }

  registerWeb(conn: WebConn): void {
    this.webConns.set(conn.id, conn)
    conn.send({ type: 'clients', clients: this.buildClientInfos(conn.user) })
    this.sendStatusTo(conn)
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
    const timer = setTimeout(() => {
      if (this.pending.delete(requestId)) {
        conn.send({ type: 'result', requestId, ok: false, error: 'E_CLIENT_TIMEOUT' })
      }
    }, PENDING_TIMEOUT_MS)
    this.pending.set(requestId, { webConnId: conn.id, timer })
    target.send({ type: 'cmd', cmd })
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

  /** 远程配置白名单预检（docs/12 §6.2）：只允许已登记前缀的路径，整条拒绝。 */
  private checkPatch(patch: Record<string, unknown>): string | undefined {
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
        const entry = this.pending.get(message.requestId)
        if (entry !== undefined) {
          clearTimeout(entry.timer)
          this.pending.delete(message.requestId)
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

  /** 客户端断开时丢弃其属主会话的记账（防 Map 无限增长；网页端刷新列表后自然收尾） */
  dropClientSessions(clientId: string): void {
    for (const [sessionId, owner] of this.sessionOwners) {
      if (owner.clientId === clientId) this.sessionOwners.delete(sessionId)
    }
  }
}
