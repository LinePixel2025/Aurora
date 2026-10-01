/**
 * 设备授权登录（docs/12 §4.3）：客户端点「登录账户」→ 打开 verifyUrl → 用户在网页
 * 确认 → 客户端轮询 `POST /api/client/device/poll` 自动拿到客户端令牌。
 *
 * 挑战只存内存（重启即失效，客户端重新发起即可）：
 * - `deviceCode` 给客户端（轮询凭据），`userCode` 给人（网页确认页输入 / 展示）；
 * - 一次性：approved / denied / expired 之后就删除；
 * - 到期由 `now()` 判定（可注入，便于单测），不靠定时器。
 */
import { randomBytes, randomInt } from 'node:crypto'
import type { DeviceLoginChallenge, DeviceLoginPollResult, Logger } from '@aurora/shared'

/** 挑战有效期：10 分钟 */
export const DEVICE_CHALLENGE_TTL_MS = 10 * 60 * 1000
/** 客户端建议轮询间隔 */
export const DEVICE_POLL_INTERVAL_MS = 2000
/**
 * 挑战表上限（P2-13）：`start` 无需登录，任何人都能刷。超限时**淘汰最旧**而不是拒绝
 * 新挑战 —— 拒绝会让攻击者用"刷满"把正常用户挡在门外（做成拒绝服务），淘汰最旧只影响
 * 早已被遗忘的挑战。正常规模（同时待确认的设备）远小于这个数。
 */
export const DEVICE_MAX_CHALLENGES = 1000

const USER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

interface DeviceChallenge {
  deviceCode: string
  userCode: string
  clientId: string
  verifyUrl: string
  createdAt: number
  expiresAt: number
  /** approved 后记录颁发结果，poll 据此返回 */
  state: 'pending' | 'approved' | 'denied'
  approved?: { token: string; username: string }
}

export interface DeviceAuthStoreOptions {
  /** 挑战有效期（毫秒），默认 10 分钟 */
  ttlMs?: number
  /** 挑战表上限（条），默认 `DEVICE_MAX_CHALLENGES`；超限淘汰最旧 */
  maxChallenges?: number
  /** 可注入时钟（单测） */
  now?: () => number
  logger?: Logger
}

/** userCode 展示形如 `ABCD-1234`（8 位字母数字 + 中间连字符） */
export function formatUserCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4)}`
}

export class DeviceAuthStore {
  private readonly challenges = new Map<string, DeviceChallenge>()
  private readonly ttlMs: number
  private readonly maxChallenges: number
  private readonly now: () => number
  private readonly logger?: Logger

  constructor(options: DeviceAuthStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEVICE_CHALLENGE_TTL_MS
    this.maxChallenges = options.maxChallenges ?? DEVICE_MAX_CHALLENGES
    this.now = options.now ?? Date.now
    this.logger = options.logger
  }

  /** 当前挑战条数（供单测断言清扫 / 上限；不属于对外协议面） */
  get size(): number {
    return this.challenges.size
  }

  /** 发起一次挑战；`verifyUrlOf` 由调用方按请求 Host 拼（服务器侧才知道对外地址）。 */
  start(clientId: string, verifyUrlOf: (userCode: string) => string): DeviceLoginChallenge {
    // 先清扫 + 限容（P2-13）：sweep 原先只在四个查询方法里跑，光刷本端点就能让 Map
    // 永续增长；而下面的撞码检查对全表线性扫描 → 总成本随表长二次方放大。
    this.sweep()
    this.evictOldest()
    const deviceCode = randomBytes(32).toString('base64url').slice(0, 43)
    let userCode = ''
    do {
      let raw = ''
      for (let i = 0; i < 8; i += 1) raw += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]
      userCode = formatUserCode(raw)
      // userCode 是人输入的确认凭据，撞上未过期挑战就重来一次（概率极低）
    } while ([...this.challenges.values()].some((c) => c.userCode === userCode))
    const challenge: DeviceChallenge = {
      deviceCode,
      userCode,
      clientId,
      verifyUrl: verifyUrlOf(userCode),
      createdAt: this.now(),
      expiresAt: this.now() + this.ttlMs,
      state: 'pending',
    }
    this.challenges.set(deviceCode, challenge)
    return {
      deviceCode,
      userCode,
      verifyUrl: challenge.verifyUrl,
      expiresAt: new Date(challenge.expiresAt).toISOString(),
      intervalMs: DEVICE_POLL_INTERVAL_MS,
    }
  }

  /** 按展示码（userCode）找未过期挑战；网页确认页用。 */
  findByUserCode(
    userCode: string,
  ): { deviceCode: string; clientId: string; expiresAt: string } | undefined {
    this.sweep()
    const normalized = userCode.trim().toUpperCase()
    const challenge = [...this.challenges.values()].find(
      (c) => c.userCode === normalized && c.state === 'pending',
    )
    if (challenge === undefined) return undefined
    return {
      deviceCode: challenge.deviceCode,
      clientId: challenge.clientId,
      expiresAt: new Date(challenge.expiresAt).toISOString(),
    }
  }

  /** 按设备码看一眼未过期、未决挑战（authorize 前的属主护栏预检用）。 */
  peek(deviceCode: string): { clientId: string; expiresAt: string } | undefined {
    this.sweep()
    const challenge = this.challenges.get(deviceCode)
    if (challenge === undefined || challenge.state !== 'pending') return undefined
    return {
      clientId: challenge.clientId,
      expiresAt: new Date(challenge.expiresAt).toISOString(),
    }
  }

  /**
   * 网页端批复。approve=true 时 `mint` 负责颁发令牌（属主护栏由 mint / 调用方保证）；
   * 返回 false 表示挑战不存在或已过期（调用方回 404）。
   */
  resolve(
    deviceCode: string,
    approve: boolean,
    mint: () => { token: string; username: string },
  ): boolean {
    const challenge = this.challenges.get(deviceCode)
    if (challenge === undefined || challenge.state !== 'pending') return false
    if (this.now() > challenge.expiresAt) {
      this.challenges.delete(deviceCode)
      return false
    }
    if (approve) {
      challenge.state = 'approved'
      challenge.approved = mint()
      this.logger?.info('设备授权已批准', { clientId: challenge.clientId })
    } else {
      challenge.state = 'denied'
      this.logger?.info('设备授权已拒绝', { clientId: challenge.clientId })
    }
    return true
  }

  /** 客户端轮询：一次性消费 approved / denied / expired 的结果。 */
  poll(deviceCode: string, clientId: string): DeviceLoginPollResult {
    this.sweep()
    const challenge = this.challenges.get(deviceCode)
    if (challenge === undefined) return { status: 'expired' }
    if (challenge.clientId !== clientId) return { status: 'expired' }
    switch (challenge.state) {
      case 'approved': {
        const approved = challenge.approved as { token: string; username: string }
        this.challenges.delete(deviceCode)
        return { status: 'approved', token: approved.token, username: approved.username }
      }
      case 'denied':
        this.challenges.delete(deviceCode)
        return { status: 'denied' }
      case 'pending':
        return { status: 'pending' }
    }
  }

  /** 丢弃过期挑战（惰性清扫，无定时器）。 */
  private sweep(): void {
    const now = this.now()
    for (const [code, challenge] of this.challenges) {
      if (now > challenge.expiresAt) this.challenges.delete(code)
    }
  }

  /** 已达上限时按创建序（Map 插入序）淘汰最旧，给新挑战腾位。 */
  private evictOldest(): void {
    while (this.challenges.size >= this.maxChallenges) {
      const oldest = this.challenges.keys().next()
      if (oldest.done === true) return
      this.challenges.delete(oldest.value)
    }
  }
}
