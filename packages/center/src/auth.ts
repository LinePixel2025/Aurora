/**
 * 鉴权与账户（docs/12 §3）：网页用户（scrypt 密码哈希）、客户端令牌（SHA-256 哈希，
 * 明文只出现一次）、网页会话令牌（内存持有，重启即失效 = 重登录）。
 *
 * 设计取舍：不用 JWT / 数据库 —— Center 的规模是"个人 / 小团队"，JSON 文件 +
 * 随机令牌足够，且少一层可被误配的基础设施。所有哈希都带独立盐。
 */
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { Logger } from '@aurora/shared'
import { JsonStore } from './store.js'

export type UserRole = 'admin' | 'user'

export interface UserRecord {
  id: string
  username: string
  role: UserRole
  passHash: string
  passSalt: string
  createdAt: string
}

/** 客户端令牌（客户端连 Center 用）；tokenHash = SHA-256(明文)，明文只在创建时返回一次 */
export interface ClientTokenRecord {
  id: string
  userId: string
  tokenHash: string
  label: string
  /** 绑定的客户端 id（一个令牌只绑一台客户端；空串表示旧数据尚未绑定） */
  clientId: string
  createdAt: string
  revokedAt?: string
}

/** 网页端可见的令牌形状（绝不含哈希） */
export interface ClientTokenView {
  id: string
  userId: string
  label: string
  clientId: string
  createdAt: string
  revokedAt?: string
}

const SCRYPT_KEYLEN = 64

const scryptAsync = promisify(scrypt)

/**
 * 密码哈希（异步，P2-15）：早先用 `scryptSync` —— 每次登录 / 改密阻塞事件循环约 32ms
 * （本机实测），公网约 30 req/s 的穷举就能让 WS 心跳被误判超时、全服卡顿。异步版把
 * scrypt 交给 libuv 线程池，事件循环只等回调。
 *
 * ⚠️ 调用方**必须 await**：漏掉 await 拿到的是 Promise（恒真），认证会被静默绕过。
 * 本文件的三处（createUser / verifyPassword / resetPassword）已全部 await；
 * server.ts 的两处调用点（login / client login）本来就是 `await auth.verifyPassword(...)`。
 */
async function hashPassword(password: string, salt: string): Promise<string> {
  const derived = (await scryptAsync(password, salt, SCRYPT_KEYLEN)) as Buffer
  return derived.toString('hex')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export interface AuthStoreOptions {
  dataDir: string
  logger?: Logger
  /** 可注入时钟（单测验证会话清扫 / 过期）；缺省 `Date.now` */
  now?: () => number
  /** 网页会话表上限（条），默认 `AuthStore.MAX_WEB_SESSIONS`；超限淘汰最旧 */
  maxSessions?: number
}

export interface NewUserInput {
  username: string
  password: string
  role: UserRole
}

export class AuthError extends Error {
  constructor(
    public readonly code:
      | 'E_USER_EXISTS'
      | 'E_USER_NOT_FOUND'
      | 'E_BAD_CREDENTIALS'
      | 'E_LAST_ADMIN'
      | 'E_TOKEN_NOT_FOUND'
      | 'E_INVALID_ARGUMENT',
    message: string,
  ) {
    super(message)
  }
}

export class AuthStore {
  readonly users: JsonStore<UserRecord[]>
  readonly tokens: JsonStore<ClientTokenRecord[]>
  private userCache: UserRecord[] = []
  private tokenCache: ClientTokenRecord[] = []
  /** 网页会话令牌：token → { userId, expiresAt }（内存持有，重启即全失效） */
  private readonly sessions = new Map<string, { userId: string; expiresAt: number }>()
  private readonly logger?: Logger
  private readonly now: () => number
  private readonly maxSessions: number

  /** 网页会话有效期：7 天 */
  static readonly SESSION_TTL_MS = 7 * 24 * 3600 * 1000

  /**
   * 网页会话表上限（P2-12）：登录成功就新增一条（7 天 TTL），没有任何上界时长期
   * 无人查询的过期项会一直占内存 —— 超限按插入顺序淘汰最旧（正常规模远达不到）。
   * 可用 `AuthStoreOptions.maxSessions` 覆盖（单测用）。
   */
  static readonly MAX_WEB_SESSIONS = 10_000

  constructor(options: AuthStoreOptions) {
    this.logger = options.logger
    this.now = options.now ?? Date.now
    this.maxSessions = options.maxSessions ?? AuthStore.MAX_WEB_SESSIONS
    this.users = new JsonStore<UserRecord[]>(`${options.dataDir}/users.json`, () => [], this.logger)
    this.tokens = new JsonStore<ClientTokenRecord[]>(
      `${options.dataDir}/tokens.json`,
      () => [],
      this.logger,
    )
  }

  async init(): Promise<void> {
    this.userCache = await this.users.load()
    this.tokenCache = await this.tokens.load()
  }

  // ─────────────── 用户 ───────────────

  async createUser(input: NewUserInput): Promise<UserRecord> {
    const username = input.username.trim()
    if (username === '' || input.password.length < 6) {
      throw new AuthError('E_INVALID_ARGUMENT', '用户名不能为空，密码至少 6 位')
    }
    if (this.userCache.some((user) => user.username === username)) {
      throw new AuthError('E_USER_EXISTS', `用户已存在：${username}`)
    }
    const salt = randomBytes(16).toString('hex')
    const record: UserRecord = {
      id: `u-${randomBytes(6).toString('hex')}`,
      username,
      role: input.role,
      passHash: await hashPassword(input.password, salt),
      passSalt: salt,
      createdAt: new Date().toISOString(),
    }
    this.userCache.push(record)
    await this.users.save(this.userCache)
    return record
  }

  /** 自助注册（docs/12 §4.2）：比 createUser 更严的校验，固定 role:'user'。 */
  async registerUser(username: string, password: string): Promise<UserRecord> {
    const name = username.trim()
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(name)) {
      throw new AuthError('E_INVALID_ARGUMENT', '用户名须为 3–32 位字母、数字、下划线或连字符')
    }
    if (password.length < 8) {
      throw new AuthError('E_INVALID_ARGUMENT', '密码至少 8 位')
    }
    return this.createUser({ username: name, password, role: 'user' })
  }

  listUsers(): Array<Pick<UserRecord, 'id' | 'username' | 'role' | 'createdAt'>> {
    return this.userCache.map(({ id, username, role, createdAt }) => ({
      id,
      username,
      role,
      createdAt,
    }))
  }

  getUser(id: string): UserRecord | undefined
  getUser(id: string, byName: 'username'): UserRecord | undefined
  getUser(id: string, byName?: 'username'): UserRecord | undefined {
    if (byName === 'username') return this.userCache.find((user) => user.username === id)
    return this.userCache.find((user) => user.id === id)
  }

  async verifyPassword(username: string, password: string): Promise<UserRecord> {
    const user = this.userCache.find((record) => record.username === username)
    if (user === undefined) throw new AuthError('E_BAD_CREDENTIALS', '用户名或密码不正确')
    const expected = Buffer.from(user.passHash, 'hex')
    const actual = await hashPassword(password, user.passSalt)
    const actualBuf = Buffer.from(actual, 'hex')
    if (actualBuf.length !== expected.length || !timingSafeEqual(actualBuf, expected)) {
      throw new AuthError('E_BAD_CREDENTIALS', '用户名或密码不正确')
    }
    return user
  }

  async resetPassword(userId: string, password: string): Promise<void> {
    const user = this.userCache.find((record) => record.id === userId)
    if (user === undefined) throw new AuthError('E_USER_NOT_FOUND', '用户不存在')
    if (password.length < 6) {
      throw new AuthError('E_INVALID_ARGUMENT', '密码至少 6 位')
    }
    user.passSalt = randomBytes(16).toString('hex')
    user.passHash = await hashPassword(password, user.passSalt)
    await this.users.save(this.userCache)
  }

  async deleteUser(userId: string, actor: Pick<UserRecord, 'id' | 'role'>): Promise<void> {
    const user = this.userCache.find((record) => record.id === userId)
    if (user === undefined) throw new AuthError('E_USER_NOT_FOUND', '用户不存在')
    if (user.id === actor.id) throw new AuthError('E_LAST_ADMIN', '不能删除自己')
    const admins = this.userCache.filter((record) => record.role === 'admin')
    if (user.role === 'admin' && admins.length <= 1) {
      throw new AuthError('E_LAST_ADMIN', '不能删除最后一个管理员')
    }
    this.userCache = this.userCache.filter((record) => record.id !== userId)
    await this.users.save(this.userCache)
  }

  /** 首个管理员不存在时创建（CLI init / start 的自动引导）。返回 created 与一次性密码。 */
  async ensureAdmin(
    username: string,
    password?: string,
  ): Promise<{ created: boolean; password?: string }> {
    const existing = this.userCache.find((record) => record.role === 'admin')
    if (existing !== undefined) return { created: false }
    const generated = password ?? randomBytes(9).toString('base64url')
    await this.createUser({ username, password: generated, role: 'admin' })
    this.logger?.info('已创建首个管理员', { username })
    return { created: true, password: generated }
  }

  // ─────────────── 网页会话 ───────────────

  /**
   * 颁发网页会话令牌。**创建时清扫过期项**（P2-12）：过期会话原先只在被查询时顺带删，
   * 而真实会话一旦过期就再也没人查询它 —— 那批条目会一直留在 Map 里。
   * 清扫后再按 `MAX_WEB_SESSIONS` 淘汰最旧（Map 插入序）。
   */
  createWebSession(userId: string): string {
    this.sweepSessions()
    const token = randomBytes(32).toString('hex')
    this.sessions.set(token, { userId, expiresAt: this.now() + AuthStore.SESSION_TTL_MS })
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next()
      if (oldest.done === true) break
      this.sessions.delete(oldest.value)
    }
    return token
  }

  /** 当前持有的会话条数（供单测断言清扫 / 上限；不属于对外协议面） */
  get sessionCount(): number {
    return this.sessions.size
  }

  /** 返回会话对应的用户；过期 / 不存在 → undefined（并顺手清理过期项）。 */
  verifyWebSession(token: string): UserRecord | undefined {
    const entry = this.sessions.get(token)
    if (entry === undefined) return undefined
    if (this.now() > entry.expiresAt) {
      this.sessions.delete(token)
      return undefined
    }
    return this.userCache.find((user) => user.id === entry.userId)
  }

  dropWebSession(token: string): void {
    this.sessions.delete(token)
  }

  private sweepSessions(): void {
    const now = this.now()
    for (const [token, entry] of this.sessions) {
      if (now > entry.expiresAt) this.sessions.delete(token)
    }
  }

  // ─────────────── 客户端令牌 ───────────────

  /** 该 clientId 当前**有效**（未吊销）令牌的属主；无 → undefined。 */
  activeOwnerOfClient(clientId: string): string | undefined {
    const trimmed = clientId.trim()
    const record = this.tokenCache.find(
      (entry) => entry.clientId === trimmed && entry.revokedAt === undefined,
    )
    return record?.userId
  }

  listClientTokens(userId?: string): ClientTokenView[] {
    const source =
      userId === undefined ? this.tokenCache : this.tokenCache.filter((t) => t.userId === userId)
    return source.map(toTokenView)
  }

  /**
   * 用明文凭据校验客户端令牌；`clientId` 是首次连接时绑定（之后同一令牌只认它）。
   * 返回令牌记录；非法 / 已吊销 / 已绑定到别的客户端 → undefined。
   */
  async verifyClientToken(token: string, clientId: string): Promise<ClientTokenRecord | undefined> {
    if (clientId.trim() === '') return undefined
    const tokenHash = hashToken(token)
    const record = this.tokenCache.find((entry) => entry.tokenHash === tokenHash)
    if (record === undefined) return undefined
    if (record.revokedAt !== undefined) return undefined
    if (record.clientId === '') {
      // 首次绑定的属主护栏（与 /api/client/login 的 E_CLIENT_BOUND 同款）：该 clientId
      // 已有**其他用户**的有效令牌时拒绝绑定，否则任何人可用一枚未绑定令牌把他人设备
      // 抢绑定到自己名下（upsert 属主跟随令牌后 = 直接翻走属主）。
      const conflicting = this.tokenCache.find(
        (entry) =>
          entry.clientId === clientId &&
          entry.revokedAt === undefined &&
          entry.userId !== record.userId,
      )
      if (conflicting !== undefined) return undefined
      record.clientId = clientId
      await this.tokens.save(this.tokenCache)
      this.logger?.info('客户端令牌已绑定客户端', { tokenId: record.id, clientId })
      return record
    }
    return record.clientId === clientId ? record : undefined
  }

  /**
   * 账号登录颁发客户端令牌（docs/12 §3，v0.2.1）：创建**归属 `userId`、创建即绑定
   * `clientId`** 的令牌，并吊销同 `clientId` 的全部旧令牌（换账号 / 重新登录后旧凭据
   * 立即失效）。明文只在本次返回值出现一次。设备授权登录（docs/12 §4.3）也走这里。
   */
  async mintClientToken(
    userId: string,
    clientId: string,
    label: string,
  ): Promise<{ record: ClientTokenView; token: string }> {
    const trimmed = clientId.trim()
    let changed = false
    for (const record of this.tokenCache) {
      if (record.clientId === trimmed && record.revokedAt === undefined) {
        record.revokedAt = new Date().toISOString()
        changed = true
      }
    }
    const token = `ac-${randomBytes(24).toString('base64url')}`
    const record: ClientTokenRecord = {
      id: `t-${randomBytes(6).toString('hex')}`,
      userId,
      tokenHash: hashToken(token),
      label: label.trim(),
      clientId: trimmed,
      createdAt: new Date().toISOString(),
    }
    this.tokenCache.push(record)
    await this.tokens.save(this.tokenCache)
    if (changed) {
      this.logger?.info('账号登录重发令牌，旧令牌已吊销', { clientId })
    }
    return { record: toTokenView(record), token }
  }
}

function toTokenView(record: ClientTokenRecord): ClientTokenView {
  return {
    id: record.id,
    userId: record.userId,
    label: record.label,
    clientId: record.clientId,
    createdAt: record.createdAt,
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
  }
}
