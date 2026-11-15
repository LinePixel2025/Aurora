/**
 * 鸿蒙遥控台推送（docs/12 §15.2 / §15.3）。
 *
 * 职责三块：
 * - **登记**：App 上报 Push Token（加密落盘）+ 每用户通知偏好；
 * - **配置**：AGC 服务账号凭据（私钥经 SecretBox 加密，主密钥缺失 = 能力未配置，
 *   与官方模型能力同一降级口径）；
 * - **投递**：hub 钩子算好收方后调 `notify`，这里按偏好 / 限速 / 设备解析 token，
 *   经 Push Kit **v3** 发送（HarmonyOS NEXT 只认 v3；鉴权是服务账号 JWT 直接作 Bearer，
 *   不再支持 OAuth2 client_credentials）。
 *
 * 安全口径：**载荷最小化** —— 通知只带路由字段（kind/clientId/sessionId/…），
 * 绝不带会话正文、工具入参、提问选项、文件内容；日志不记 token 全文。
 * `notify` 是同步入口、内部异步 fire-and-forget：推送失败绝不影响 WS 主链路，
 * 也绝不能把异常抛回 hub 的消息监听器（P0-01 同族）。
 */
import { constants, createSign, randomBytes, sign as cryptoSign } from 'node:crypto'
import {
  CENTER_PUSH_DEVICES_PER_USER,
  type CenterNotificationPrefs,
  type CenterPushConfigUpdate,
  type CenterPushConfigView,
  type CenterPushRegisterRequest,
  type Logger,
} from '@aurora/shared'
import { hashToken } from './auth.js'
import type { SecretBox } from './secrets.js'
import { JsonStore } from './store.js'

/** 推送设备登记（push token 加密落盘；tokenHash 仅用于 upsert / 剔除查表） */
export interface PushDeviceRecord {
  id: string
  userId: string
  /** 登记时的持久会话 id（logout / 吊销级联清理用；refresh 轮换令牌不丢登记） */
  sessionId: string
  platform: 'harmony'
  tokenHash: string
  tokenEnc: string
  deviceName?: string
  appVersion?: string
  createdAt: string
  lastSeenAt: string
}

export type PushKind = 'confirm' | 'ask' | 'file' | 'done' | 'error'

/** 一条推送通知（hub 钩子构造；data 只允许路由字段） */
export interface PushNotification {
  kind: PushKind
  title: string
  body: string
  /** 去重标识（进 pushOptions.biTag，回执可关联；≤ 64 字节） */
  collapseKey: string
  /** 离线缓存时长（毫秒）；确认 / 提问对齐卡片窗口，缺省 1 天 */
  ttlMs?: number
  /** 经 clickAction.data → Want.parameters 透传给 App（≤ 1024 字节） */
  data: Record<string, string>
}

/** 发送器接口（单测注入假实现；生产 = AgcPushSender） */
export interface PushSender {
  /** 返回回执判定为无效的 token（登记侧据此剔除） */
  send(tokens: string[], notification: PushNotification): Promise<{ invalidTokens: string[] }>
}

export class PushError extends Error {
  constructor(
    public readonly code: 'E_PUSH_UNAVAILABLE' | 'E_INVALID_ARGUMENT' | 'E_SECRET_UNAVAILABLE',
    message: string,
  ) {
    super(message)
  }
}

/** 每用户推送限速（防失控常量：确认卡风暴 / 自动化批量完成时不轰通知栏） */
export const PUSH_PER_USER_PER_MINUTE = 30

/** clickAction.data 的字节上限（华为官方口径：最大 1024） */
const PUSH_DATA_MAX_BYTES = 1024

/** pushOptions.collapseKey 分组（0~100；离线缓存每组只留最新一条，上线后下发） */
const COLLAPSE_GROUP: Record<PushKind, number> = {
  confirm: 1,
  ask: 2,
  file: 3,
  done: 4,
  error: 5,
}

/** 偏好键映射：done / error 共用 sessionDone 开关 */
function prefKeyOf(kind: PushKind): keyof CenterNotificationPrefs {
  return kind === 'done' || kind === 'error' ? 'sessionDone' : kind
}

export const DEFAULT_NOTIFICATION_PREFS: CenterNotificationPrefs = {
  confirm: true,
  ask: true,
  file: true,
  sessionDone: false,
}

// ─────────────── AGC 发送器（Push Kit v3）───────────────

/** 服务账号 JWT 的固定 aud（华为官方口径） */
const AGC_TOKEN_AUD = 'https://oauth-login.cloud.huawei.com/oauth2/v3/token'
const AGC_PUSH_BASE = 'https://push-api.cloud.huawei.com/v3'
/** JWT 有效期 1h，提前 60s 换新（官方建议 ≤ 3600s 且可复用） */
const JWT_TTL_MS = 3600_000
const JWT_REFRESH_MARGIN_MS = 60_000
/** REST 业务成功码 */
const AGC_SUCCESS_CODE = '80000000'
/** 所有 Token 无效（msg.illegalTokens 按原因列出 token，据此剔除登记） */
const AGC_INVALID_TOKENS_CODE = '80300007'

export interface AgcPushSenderOptions {
  projectId: string
  keyId: string
  subAccount: string
  privateKeyPem: string
  category: string
  algorithm: 'RS256' | 'PS256'
  testMessage?: boolean
  logger?: Logger
  /** 单测注入假 fetch */
  fetchImpl?: typeof fetch
  now?: () => number
}

function base64url(input: Buffer | string): string {
  return (typeof input === 'string' ? Buffer.from(input, 'utf8') : input).toString('base64url')
}

/**
 * Push Kit v3 发送器：服务账号 JWT 鉴权 + 通知消息（push-type: 0）。
 *
 * 签名算法做成可配置：官方《基于服务账号生成鉴权令牌》写 PS256，社区实测有
 * 「服务端只认 RS256」的口径差异（docs/12 §15.3）——联调以真机回执定案。
 */
export class AgcPushSender implements PushSender {
  private jwtCache: { token: string; expiresAt: number } | undefined
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number

  constructor(private readonly options: AgcPushSenderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
  }

  async send(
    tokens: string[],
    notification: PushNotification,
  ): Promise<{ invalidTokens: string[] }> {
    if (tokens.length === 0) return { invalidTokens: [] }
    try {
      const jwt = this.jwt()
      const ttlSeconds =
        notification.ttlMs === undefined
          ? 86400
          : Math.min(1296000, Math.max(1, Math.ceil(notification.ttlMs / 1000)))
      const body = {
        payload: {
          notification: {
            category: this.options.category,
            title: notification.title,
            body: notification.body,
            // actionType 0 = 打开应用首页，路由由 App 按 data 自行分发（免 skills 匹配）
            clickAction: { actionType: 0, data: this.boundedData(notification) },
          },
        },
        target: { token: tokens },
        pushOptions: {
          ttl: ttlSeconds,
          collapseKey: COLLAPSE_GROUP[notification.kind],
          biTag: notification.collapseKey.slice(0, 64),
          ...(this.options.testMessage === true ? { testMessage: true } : {}),
        },
      }
      const res = await this.fetchImpl(`${AGC_PUSH_BASE}/${this.options.projectId}/messages:send`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          'push-type': '0',
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      })
      const parsed = (await res.json().catch(() => undefined)) as
        { code?: string; msg?: string; requestId?: string } | undefined
      if (!res.ok || parsed === undefined) {
        this.options.logger?.warn('推送回执异常', {
          kind: notification.kind,
          status: res.status,
          code: parsed?.code,
        })
        return { invalidTokens: [] }
      }
      if (parsed.code === AGC_SUCCESS_CODE) return { invalidTokens: [] }
      if (parsed.code === AGC_INVALID_TOKENS_CODE) {
        return { invalidTokens: this.illegalTokensOf(parsed.msg, tokens) }
      }
      // 80300002（应用无权限）等：配置 / 权益问题，剔 token 无意义，只记日志
      this.options.logger?.warn('推送被拒', {
        kind: notification.kind,
        code: parsed.code,
        msg: parsed.msg,
      })
      return { invalidTokens: [] }
    } catch (error) {
      // 网络失败 / JWT 签名失败（私钥非法）：只记日志，不重试、不影响主链路
      this.options.logger?.warn('推送发送失败', {
        kind: notification.kind,
        error: String(error),
      })
      return { invalidTokens: [] }
    }
  }

  /** data 超 1024 字节时降级为最小路由集（宁可少带字段，不可整条被华为拒收） */
  private boundedData(notification: PushNotification): Record<string, string> {
    const data = notification.data
    if (Buffer.byteLength(JSON.stringify(data), 'utf8') <= PUSH_DATA_MAX_BYTES) return data
    this.options.logger?.warn('推送 data 超限，已降级为最小路由集', { kind: notification.kind })
    const minimal: Record<string, string> = {}
    if (typeof data['kind'] === 'string') minimal['kind'] = data['kind']
    if (typeof data['clientId'] === 'string') minimal['clientId'] = data['clientId']
    return minimal
  }

  /** 80300007 的 msg 是 JSON 字符串：{ failure, illegalTokens: { 原因: [token…] } } */
  private illegalTokensOf(msg: string | undefined, sent: string[]): string[] {
    if (typeof msg !== 'string') return [...sent]
    try {
      const parsed = JSON.parse(msg) as { illegalTokens?: Record<string, unknown> }
      const groups = parsed.illegalTokens
      if (groups === undefined || typeof groups !== 'object') return [...sent]
      const listed: string[] = []
      for (const value of Object.values(groups)) {
        if (Array.isArray(value)) {
          for (const token of value) if (typeof token === 'string') listed.push(token)
        }
      }
      return listed.length > 0 ? listed : [...sent]
    } catch {
      return [...sent]
    }
  }

  /** 服务账号 JWT（缓存复用，提前 60s 换新） */
  private jwt(): string {
    const now = this.now()
    if (this.jwtCache !== undefined && now < this.jwtCache.expiresAt - JWT_REFRESH_MARGIN_MS) {
      return this.jwtCache.token
    }
    const iat = Math.floor(now / 1000)
    const header = { alg: this.options.algorithm, kid: this.options.keyId, typ: 'JWT' }
    const claims = {
      iss: this.options.subAccount,
      aud: AGC_TOKEN_AUD,
      iat,
      exp: iat + Math.floor(JWT_TTL_MS / 1000),
    }
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`
    const signature =
      this.options.algorithm === 'PS256'
        ? cryptoSign('sha256', Buffer.from(signingInput, 'utf8'), {
            key: this.options.privateKeyPem,
            padding: constants.RSA_PKCS1_PSS_PADDING,
            saltLength: 32,
          })
        : createSign('RSA-SHA256').update(signingInput).sign(this.options.privateKeyPem)
    const token = `${signingInput}.${base64url(signature)}`
    this.jwtCache = { token, expiresAt: now + JWT_TTL_MS }
    return token
  }
}

// ─────────────── 登记 / 偏好 / 配置 / 投递 ───────────────

interface PushConfigRecord {
  enabled: boolean
  projectId: string
  keyId: string
  subAccount: string
  privateKeyEnc: string
  category: string
  algorithm: 'RS256' | 'PS256'
  testMessage: boolean
}

const DEFAULT_PUSH_CONFIG: PushConfigRecord = {
  enabled: false,
  projectId: '',
  keyId: '',
  subAccount: '',
  privateKeyEnc: '',
  category: 'WORK',
  algorithm: 'RS256',
  testMessage: false,
}

export interface PushServiceOptions {
  dataDir: string
  secrets: SecretBox
  logger?: Logger
  /** 单测注入假发送器（注入后不要求 AGC 私钥，enabled 即可用） */
  sender?: PushSender
  now?: () => number
}

export class PushService {
  private readonly devices: JsonStore<PushDeviceRecord[]>
  private readonly prefs: JsonStore<Record<string, CenterNotificationPrefs>>
  private readonly configStore: JsonStore<PushConfigRecord>
  private deviceCache: PushDeviceRecord[] = []
  private prefsCache: Record<string, CenterNotificationPrefs> = {}
  private config: PushConfigRecord = { ...DEFAULT_PUSH_CONFIG }
  private readonly secrets: SecretBox
  private readonly logger?: Logger
  private readonly senderOverride?: PushSender
  private readonly now: () => number
  /** 每用户推送限速：userId → 最近 1 分钟内的发送时间戳 */
  private readonly pushLog = new Map<string, number[]>()

  constructor(options: PushServiceOptions) {
    this.secrets = options.secrets
    this.logger = options.logger
    this.senderOverride = options.sender
    this.now = options.now ?? Date.now
    this.devices = new JsonStore<PushDeviceRecord[]>(
      `${options.dataDir}/push-devices.json`,
      () => [],
      options.logger,
    )
    this.prefs = new JsonStore<Record<string, CenterNotificationPrefs>>(
      `${options.dataDir}/notification-prefs.json`,
      () => ({}),
      options.logger,
    )
    this.configStore = new JsonStore<PushConfigRecord>(
      `${options.dataDir}/push-config.json`,
      () => ({ ...DEFAULT_PUSH_CONFIG }),
      options.logger,
    )
  }

  async init(): Promise<void> {
    this.deviceCache = await this.devices.load()
    this.prefsCache = await this.prefs.load()
    const stored = await this.configStore.load()
    this.config = { ...DEFAULT_PUSH_CONFIG, ...stored }
  }

  /** 通道是否可用（enabled + 发送器可解析）；不可用时 register 回 503、notify no-op */
  get available(): boolean {
    return this.config.enabled && this.resolveSender() !== undefined
  }

  // ── 登记 ──

  async register(
    userId: string,
    sessionId: string,
    request: CenterPushRegisterRequest,
  ): Promise<{ id: string }> {
    if (!this.available) throw new PushError('E_PUSH_UNAVAILABLE', '推送通道未配置')
    if (request.platform !== 'harmony') {
      throw new PushError('E_INVALID_ARGUMENT', 'platform 必须为 harmony')
    }
    const token = typeof request.token === 'string' ? request.token.trim() : ''
    if (token === '' || token.length > 2048) {
      throw new PushError('E_INVALID_ARGUMENT', 'token 非法')
    }
    const deviceName =
      typeof request.deviceName === 'string' ? request.deviceName.trim().slice(0, 64) : undefined
    const appVersion =
      typeof request.appVersion === 'string' ? request.appVersion.trim().slice(0, 32) : undefined
    const tokenHash = hashToken(token)
    const tokenEnc = this.secrets.encrypt(token)
    const nowIso = new Date(this.now()).toISOString()
    const existing = this.deviceCache.find(
      (record) => record.userId === userId && record.tokenHash === tokenHash,
    )
    if (existing !== undefined) {
      existing.sessionId = sessionId
      existing.tokenEnc = tokenEnc
      existing.lastSeenAt = nowIso
      if (deviceName !== undefined) existing.deviceName = deviceName
      if (appVersion !== undefined) existing.appVersion = appVersion
      await this.devices.save(this.deviceCache)
      return { id: existing.id }
    }
    const mine = this.deviceCache.filter((record) => record.userId === userId)
    while (mine.length >= CENTER_PUSH_DEVICES_PER_USER) {
      const oldest = mine.shift()
      if (oldest === undefined) break
      this.deviceCache = this.deviceCache.filter((record) => record.id !== oldest.id)
    }
    const record: PushDeviceRecord = {
      id: `pd-${randomBytes(6).toString('hex')}`,
      userId,
      sessionId,
      platform: 'harmony',
      tokenHash,
      tokenEnc,
      ...(deviceName === undefined ? {} : { deviceName }),
      ...(appVersion === undefined ? {} : { appVersion }),
      createdAt: nowIso,
      lastSeenAt: nowIso,
    }
    this.deviceCache.push(record)
    await this.devices.save(this.deviceCache)
    return { id: record.id }
  }

  async unregister(userId: string, token: string): Promise<void> {
    const tokenHash = hashToken(token)
    const next = this.deviceCache.filter(
      (record) => !(record.userId === userId && record.tokenHash === tokenHash),
    )
    if (next.length === this.deviceCache.length) return
    this.deviceCache = next
    await this.devices.save(this.deviceCache)
  }

  /** 会话登出 / 吊销级联：删该会话登记的全部设备 */
  async unregisterSession(sessionId: string): Promise<void> {
    const next = this.deviceCache.filter((record) => record.sessionId !== sessionId)
    if (next.length === this.deviceCache.length) return
    this.deviceCache = next
    await this.devices.save(this.deviceCache)
  }

  /** 删除用户级联 */
  async unregisterUser(userId: string): Promise<void> {
    const next = this.deviceCache.filter((record) => record.userId !== userId)
    if (next.length === this.deviceCache.length) return
    this.deviceCache = next
    await this.devices.save(this.deviceCache)
  }

  // ── 偏好 ──

  prefsOf(userId: string): CenterNotificationPrefs {
    return { ...DEFAULT_NOTIFICATION_PREFS, ...this.prefsCache[userId] }
  }

  async setPrefs(
    userId: string,
    patch: Partial<CenterNotificationPrefs>,
  ): Promise<CenterNotificationPrefs> {
    const merged = { ...this.prefsOf(userId) }
    for (const key of ['confirm', 'ask', 'file', 'sessionDone'] as const) {
      const value = patch[key]
      if (value === undefined) continue
      if (typeof value !== 'boolean') {
        throw new PushError('E_INVALID_ARGUMENT', `偏好字段 ${key} 必须为布尔`)
      }
      merged[key] = value
    }
    this.prefsCache[userId] = merged
    await this.prefs.save(this.prefsCache)
    return merged
  }

  // ── 配置（管理端）──

  adminConfig(): CenterPushConfigView {
    const view: CenterPushConfigView = {
      enabled: this.config.enabled,
      projectId: this.config.projectId,
      keyId: this.config.keyId,
      subAccount: this.config.subAccount,
      category: this.config.category,
      algorithm: this.config.algorithm,
      testMessage: this.config.testMessage,
      keySet: this.config.privateKeyEnc !== '',
    }
    if (!this.secrets.available) {
      return { ...view, error: '主密钥 AURORA_CENTER_SECRET 未配置，无法加密 / 解密推送私钥' }
    }
    if (this.config.privateKeyEnc !== '') {
      try {
        this.secrets.decrypt(this.config.privateKeyEnc)
      } catch {
        return { ...view, error: '推送私钥无法解密（主密钥可能已轮换），请重新填写' }
      }
    }
    return view
  }

  async updateConfig(update: CenterPushConfigUpdate): Promise<CenterPushConfigView> {
    const next: PushConfigRecord = { ...this.config }
    if (update.enabled !== undefined) {
      if (typeof update.enabled !== 'boolean')
        throw new PushError('E_INVALID_ARGUMENT', 'enabled 必须为布尔')
      next.enabled = update.enabled
    }
    for (const key of ['projectId', 'keyId', 'subAccount', 'category'] as const) {
      const value = update[key]
      if (value === undefined) continue
      if (typeof value !== 'string' || value.length > 256) {
        throw new PushError('E_INVALID_ARGUMENT', `${key} 非法`)
      }
      next[key] = value.trim()
    }
    if (update.algorithm !== undefined) {
      if (update.algorithm !== 'RS256' && update.algorithm !== 'PS256') {
        throw new PushError('E_INVALID_ARGUMENT', 'algorithm 必须为 RS256 或 PS256')
      }
      next.algorithm = update.algorithm
    }
    if (update.testMessage !== undefined) {
      if (typeof update.testMessage !== 'boolean') {
        throw new PushError('E_INVALID_ARGUMENT', 'testMessage 必须为布尔')
      }
      next.testMessage = update.testMessage
    }
    if (update.privateKey === null) {
      next.privateKeyEnc = ''
    } else if (typeof update.privateKey === 'string' && update.privateKey.trim() !== '') {
      if (!this.secrets.available) {
        throw new PushError(
          'E_SECRET_UNAVAILABLE',
          '主密钥 AURORA_CENTER_SECRET 未配置，无法加密推送私钥',
        )
      }
      next.privateKeyEnc = this.secrets.encrypt(update.privateKey.trim())
    }
    this.config = next
    await this.configStore.save(this.config)
    return this.adminConfig()
  }

  // ── 投递 ──

  /**
   * hub 钩子入口（同步、fire-and-forget）：userIds 已由 hub 按路由规则算好
   * （属主 + 管理员 / 会话创建者）并做过 harmony 在线抑制；这里再按偏好 / 限速 /
   * 设备过滤后发送。**任何失败只记日志**，绝不抛回消息监听器。
   */
  notify(userIds: string[], notification: PushNotification): void {
    void this.dispatch(userIds, notification).catch((error) => {
      this.logger?.warn('推送投递失败', { kind: notification.kind, error: String(error) })
    })
  }

  private async dispatch(userIds: string[], notification: PushNotification): Promise<void> {
    const sender = this.resolveSender()
    if (sender === undefined) return
    const prefKey = prefKeyOf(notification.kind)
    for (const userId of new Set(userIds)) {
      if (!this.prefsOf(userId)[prefKey]) continue
      if (!this.allowPush(userId)) {
        this.logger?.warn('推送限速，已丢弃', { userId, kind: notification.kind })
        continue
      }
      const devices = this.deviceCache.filter((record) => record.userId === userId)
      if (devices.length === 0) continue
      const tokens: string[] = []
      for (const device of devices) {
        try {
          tokens.push(this.secrets.decrypt(device.tokenEnc))
        } catch {
          this.logger?.warn('推送 token 解密失败，已跳过', { deviceId: device.id })
        }
      }
      if (tokens.length === 0) continue
      const { invalidTokens } = await sender.send(tokens, notification)
      if (invalidTokens.length > 0) await this.removeInvalidTokens(invalidTokens)
    }
  }

  /** 回执判无效的 token 剔除登记（卸载重装 / 恢复出厂会换 token，App 启动重新上报兜底） */
  private async removeInvalidTokens(tokens: string[]): Promise<void> {
    const hashes = new Set(tokens.map((token) => hashToken(token)))
    const next = this.deviceCache.filter((record) => !hashes.has(record.tokenHash))
    if (next.length === this.deviceCache.length) return
    this.deviceCache = next
    await this.devices.save(this.deviceCache)
  }

  private allowPush(userId: string): boolean {
    const threshold = this.now() - 60_000
    const recent = (this.pushLog.get(userId) ?? []).filter((at) => at > threshold)
    if (recent.length >= PUSH_PER_USER_PER_MINUTE) {
      this.pushLog.set(userId, recent)
      return false
    }
    recent.push(this.now())
    this.pushLog.set(userId, recent)
    return true
  }

  /** 解析发送器：注入优先；否则按配置 + 私钥构造 AGC 发送器（不可用 → undefined） */
  private resolveSender(): PushSender | undefined {
    if (!this.config.enabled) return undefined
    if (this.senderOverride !== undefined) return this.senderOverride
    if (!this.secrets.available || this.config.privateKeyEnc === '') return undefined
    if (this.config.projectId === '' || this.config.keyId === '' || this.config.subAccount === '') {
      return undefined
    }
    try {
      const privateKeyPem = this.secrets.decrypt(this.config.privateKeyEnc)
      return new AgcPushSender({
        projectId: this.config.projectId,
        keyId: this.config.keyId,
        subAccount: this.config.subAccount,
        privateKeyPem,
        category: this.config.category,
        algorithm: this.config.algorithm,
        testMessage: this.config.testMessage,
        logger: this.logger,
      })
    } catch {
      return undefined
    }
  }
}
