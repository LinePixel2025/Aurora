/**
 * 鉴权与账户（docs/12 §3）：网页用户（scrypt 口令哈希）、配对令牌（SHA-256 哈希，
 * 明文只出现一次）、网页会话令牌（内存持有，重启即失效 = 重登录）。
 *
 * 设计取舍：不用 JWT / 数据库 —— Center 的规模是"个人 / 小团队"，JSON 文件 +
 * 随机令牌足够，且少一层可被误配的基础设施。所有哈希都带独立盐。
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
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

/** 配对令牌（客户端连 Center 用）；tokenHash = SHA-256(明文)，明文只在创建时返回一次 */
export interface PairingTokenRecord {
  id: string
  userId: string
  tokenHash: string
  label: string
  /** 首次连接的客户端 id（一个令牌只绑一台客户端） */
  clientId: string
  createdAt: string
  revokedAt?: string
}

/** 网页端可见的令牌形状（绝不含哈希） */
export interface PairingTokenView {
  id: string
  userId: string
  label: string
  clientId: string
  createdAt: string
  revokedAt?: string
}

const SCRYPT_KEYLEN = 64

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export interface AuthStoreOptions {
  dataDir: string
  logger?: Logger
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
  readonly tokens: JsonStore<PairingTokenRecord[]>
  private userCache: UserRecord[] = []
  private tokenCache: PairingTokenRecord[] = []
  /** 网页会话令牌：token → { userId, expiresAt }（内存持有，重启即全失效） */
  private readonly sessions = new Map<string, { userId: string; expiresAt: number }>()
  private readonly logger?: Logger

  /** 网页会话有效期：7 天 */
  static readonly SESSION_TTL_MS = 7 * 24 * 3600 * 1000

  constructor(options: AuthStoreOptions) {
    this.logger = options.logger
    this.users = new JsonStore<UserRecord[]>(`${options.dataDir}/users.json`, () => [], this.logger)
    this.tokens = new JsonStore<PairingTokenRecord[]>(
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
      throw new AuthError('E_INVALID_ARGUMENT', '用户名不能为空，口令至少 6 位')
    }
    if (this.userCache.some((user) => user.username === username)) {
      throw new AuthError('E_USER_EXISTS', `用户已存在：${username}`)
    }
    const salt = randomBytes(16).toString('hex')
    const record: UserRecord = {
      id: `u-${randomBytes(6).toString('hex')}`,
      username,
      role: input.role,
      passHash: hashPassword(input.password, salt),
      passSalt: salt,
      createdAt: new Date().toISOString(),
    }
    this.userCache.push(record)
    await this.users.save(this.userCache)
    return record
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
    if (user === undefined) throw new AuthError('E_BAD_CREDENTIALS', '用户名或口令不正确')
    const expected = Buffer.from(user.passHash, 'hex')
    const actual = hashPassword(password, user.passSalt)
    const actualBuf = Buffer.from(actual, 'hex')
    if (actualBuf.length !== expected.length || !timingSafeEqual(actualBuf, expected)) {
      throw new AuthError('E_BAD_CREDENTIALS', '用户名或口令不正确')
    }
    return user
  }

  async resetPassword(userId: string, password: string): Promise<void> {
    const user = this.userCache.find((record) => record.id === userId)
    if (user === undefined) throw new AuthError('E_USER_NOT_FOUND', '用户不存在')
    if (password.length < 6) {
      throw new AuthError('E_INVALID_ARGUMENT', '口令至少 6 位')
    }
    user.passSalt = randomBytes(16).toString('hex')
    user.passHash = hashPassword(password, user.passSalt)
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

  /** 首个管理员不存在时创建（CLI init / start 的自动引导）。返回 created 与一次性口令。 */
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

  createWebSession(userId: string): string {
    const token = randomBytes(32).toString('hex')
    this.sessions.set(token, { userId, expiresAt: Date.now() + AuthStore.SESSION_TTL_MS })
    return token
  }

  /** 返回会话对应的用户；过期 / 不存在 → undefined（并顺手清理过期项）。 */
  verifyWebSession(token: string): UserRecord | undefined {
    const entry = this.sessions.get(token)
    if (entry === undefined) return undefined
    if (Date.now() > entry.expiresAt) {
      this.sessions.delete(token)
      return undefined
    }
    return this.userCache.find((user) => user.id === entry.userId)
  }

  dropWebSession(token: string): void {
    this.sessions.delete(token)
  }

  // ─────────────── 配对令牌 ───────────────

  /** 创建配对令牌；明文只在本返回值出现一次（调用方负责展示 / 打印）。 */
  async createPairingToken(
    userId: string,
    label: string,
  ): Promise<{ record: PairingTokenView; token: string }> {
    const token = `ac-${randomBytes(24).toString('base64url')}`
    const record: PairingTokenRecord = {
      id: `t-${randomBytes(6).toString('hex')}`,
      userId,
      tokenHash: hashToken(token),
      label: label.trim(),
      clientId: '',
      createdAt: new Date().toISOString(),
    }
    this.tokenCache.push(record)
    await this.tokens.save(this.tokenCache)
    return { record: toTokenView(record), token }
  }

  listPairingTokens(userId?: string): PairingTokenView[] {
    const source =
      userId === undefined ? this.tokenCache : this.tokenCache.filter((t) => t.userId === userId)
    return source.map(toTokenView)
  }

  findByTokenId(id: string): PairingTokenRecord | undefined {
    return this.tokenCache.find((record) => record.id === id)
  }

  /**
   * 该 clientId 当前**有效**（未吊销）令牌的属主；无 → undefined。
   * 账号登录用它拒绝「用别人 clientId 抢注」（会把对方有效令牌吊销 = 远端 DoS）。
   */
  activeOwnerOfClient(clientId: string): string | undefined {
    const trimmed = clientId.trim()
    const record = this.tokenCache.find(
      (entry) => entry.clientId === trimmed && entry.revokedAt === undefined,
    )
    return record?.userId
  }

  async revokePairingToken(id: string, actor: Pick<UserRecord, 'id' | 'role'>): Promise<void> {
    const record = this.tokenCache.find((entry) => entry.id === id)
    if (record === undefined) throw new AuthError('E_TOKEN_NOT_FOUND', '令牌不存在')
    if (actor.role !== 'admin' && record.userId !== actor.id) {
      throw new AuthError('E_TOKEN_NOT_FOUND', '令牌不存在')
    }
    if (record.revokedAt === undefined) {
      record.revokedAt = new Date().toISOString()
      await this.tokens.save(this.tokenCache)
    }
  }

  /**
   * 用明文凭据校验配对令牌；`clientId` 是首次连接时绑定（之后同一令牌只认它）。
   * 返回令牌记录；非法 / 已吊销 / 已绑定到别的客户端 → undefined。
   */
  async verifyPairingToken(
    token: string,
    clientId: string,
  ): Promise<PairingTokenRecord | undefined> {
    if (clientId.trim() === '') return undefined
    const tokenHash = hashToken(token)
    const record = this.tokenCache.find((entry) => entry.tokenHash === tokenHash)
    if (record === undefined) return undefined
    if (record.revokedAt !== undefined) return undefined
    if (record.clientId === '') {
      // 首次绑定的属主护栏（与 /api/client/login 的 E_CLIENT_BOUND 同款）：该 clientId
      // 已有**其他用户**的有效令牌时拒绝绑定，否则任何人可用自己新建的配对令牌把
      // 他人设备抢绑定到自己名下（upsert 属主跟随令牌后 = 直接翻走属主）。
      const conflicting = this.tokenCache.find(
        (entry) =>
          entry.clientId === clientId &&
          entry.revokedAt === undefined &&
          entry.userId !== record.userId,
      )
      if (conflicting !== undefined) return undefined
      record.clientId = clientId
      await this.tokens.save(this.tokenCache)
      this.logger?.info('配对令牌已绑定客户端', { tokenId: record.id, clientId })
      return record
    }
    return record.clientId === clientId ? record : undefined
  }

  /**
   * 账号登录颁发客户端令牌（docs/12 §3，v0.2.1）：创建**归属 `userId`、创建即绑定
   * `clientId`** 的令牌，并吊销同 `clientId` 的全部旧令牌（换账号 / 重新登录后旧凭据
   * 立即失效）。明文只在本次返回值出现一次。
   */
  async mintClientToken(
    userId: string,
    clientId: string,
    label: string,
  ): Promise<{ record: PairingTokenView; token: string }> {
    const trimmed = clientId.trim()
    let changed = false
    for (const record of this.tokenCache) {
      if (record.clientId === trimmed && record.revokedAt === undefined) {
        record.revokedAt = new Date().toISOString()
        changed = true
      }
    }
    const token = `ac-${randomBytes(24).toString('base64url')}`
    const record: PairingTokenRecord = {
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

function toTokenView(record: PairingTokenRecord): PairingTokenView {
  return {
    id: record.id,
    userId: record.userId,
    label: record.label,
    clientId: record.clientId,
    createdAt: record.createdAt,
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
  }
}
