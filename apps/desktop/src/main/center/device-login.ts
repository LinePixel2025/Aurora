/**
 * Aurora Center 设备授权登录（docs/12 §4.3，v0.2.2）：设置页点「登录账户」→
 * `POST /api/client/device/start` 拿到设备码与确认页地址 → 打开浏览器 →
 * 按 `intervalMs` 轮询 `POST /api/client/device/poll`，直到 approved（拿到令牌）/
 * expired / denied / 超过挑战有效期。
 *
 * 本文件保持纯 Node（不 import electron）：`fetchImpl` 与 `openExternal`
 * 由主进程注入（生产 = `main/net.ts` 的 `netFetch` + Electron `shell.openExternal`；
 * 单测 = 假 fetch / 假打开），与 `client-login.ts`「只接受注入」的套路一致。
 *
 * 出网约定对齐 `ingest.ts`：Center 地址是用户显式配置的可信目标，
 * `advanced.proxy` 对本通道无效（docs/12 §11）。
 */
import type { Logger } from '@aurora/shared'
import { httpBaseUrlOf } from './client-login.js'

export interface DeviceLoginInput {
  serverUrl: string
  clientId: string
}

/**
 * 一次设备授权的最终结果。`approved` 带令牌明文（调用方负责立即写入凭据链路，
 * 令牌不进日志）；`error` 是本地故障（网络 / 响应解析），与服务器明确的
 * expired / denied 区分开。
 */
export type DeviceLoginOutcome =
  | { status: 'approved'; token: string; username: string }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'error'; message: string }

export type DeviceLoginStartOutcome =
  { started: true; verifyUrl: string } | { started: false; message: string }

export interface DeviceLoginDeps {
  fetchImpl: typeof fetch
  /** 打开确认页（生产 = `shell.openExternal`；单测注入假实现） */
  openExternal: (url: string) => Promise<void>
  logger?: Logger
  /** 单次 HTTP 请求超时（毫秒）；缺省 15s。测试注入小值，不必真等 */
  timeoutMs?: number
  /** 轮询间隔下限（毫秒）；缺省 1000 —— 防止把服务器打爆 */
  minIntervalMs?: number
  /** 最终结果回调（approved / expired / denied / error 各一次；取消后不回调） */
  onResult?: (outcome: DeviceLoginOutcome) => void
}

/** 单次请求超时：Center 不可达时快速失败，别让设置页转圈 30 秒 */
const REQUEST_TIMEOUT_MS = 15_000
/** 轮询间隔下限：服务器给的 intervalMs 再小也不踩穿，防打爆 */
const MIN_POLL_INTERVAL_MS = 1_000
/** 连续轮询失败容忍次数：偶发抖动不中断登录，连续失败才报错 */
const MAX_POLL_FAILURES = 3

export class DeviceLoginController {
  private readonly deps: DeviceLoginDeps
  /** 运行代号：每次 start 递增；轮询循环只在自己的代号仍是当前值时继续 */
  private currentRun = 0
  /** 最近一次成功发起的代号（isRunning 的判据：结算 / 取消后 currentRun 会越过它） */
  private lastStartedRun = 0

  constructor(deps: DeviceLoginDeps) {
    this.deps = deps
  }

  /** 是否有轮询在跑（供测试与状态展示） */
  isRunning(): boolean {
    return this.currentRun > 0 && this.lastStartedRun === this.currentRun
  }

  /** 取消在途轮询（设置页关闭 / 重新发起时调用）：被取消的运行不再回调 onResult */
  cancel(): void {
    this.currentRun += 1
  }

  /**
   * 发起设备授权：POST start → 打开确认页 → 后台轮询。**立即返回**触发回执
   * （打开成功即 `{ started: true, verifyUrl }`），最终结果走 `onResult`。
   * 重复调用会先取消上一次的轮询（同 clientId 旧挑战留在服务器侧自然过期）。
   */
  async start(input: DeviceLoginInput): Promise<DeviceLoginStartOutcome> {
    this.cancel() // 重复点击：先掐掉旧轮询
    const run = ++this.currentRun
    this.lastStartedRun = run
    const base = httpBaseUrlOf(input.serverUrl)
    if (base === undefined) {
      this.currentRun += 1 // 地址非法：没有循环可跑，直接作废本次代号
      return { started: false, message: `无法解析服务器地址：${input.serverUrl}` }
    }
    const timeoutMs = this.deps.timeoutMs ?? REQUEST_TIMEOUT_MS
    let challenge: {
      deviceCode?: unknown
      verifyUrl?: unknown
      expiresAt?: unknown
      intervalMs?: unknown
    }
    try {
      challenge = (await this.postJson(
        `${base.replace(/\/+$/, '')}/api/client/device/start`,
        { clientId: input.clientId },
        timeoutMs,
      )) as typeof challenge
    } catch (error) {
      this.currentRun += 1
      return { started: false, message: `无法连接服务器：${String(error)}` }
    }
    const verifyUrl = challenge['verifyUrl']
    const deviceCode = challenge['deviceCode']
    const expiresAtMs = Date.parse(
      typeof challenge['expiresAt'] === 'string' ? challenge['expiresAt'] : '',
    )
    if (
      typeof verifyUrl !== 'string' ||
      verifyUrl === '' ||
      typeof deviceCode !== 'string' ||
      deviceCode === '' ||
      Number.isNaN(expiresAtMs)
    ) {
      this.currentRun += 1
      return { started: false, message: '服务器响应缺少设备码或确认页地址' }
    }
    try {
      await this.deps.openExternal(verifyUrl)
    } catch (error) {
      this.currentRun += 1
      const message = `无法打开浏览器：${String(error)}`
      this.deps.logger?.warn('设备授权登录打开确认页失败', { error: message })
      return { started: false, message }
    }
    this.deps.logger?.info('设备授权登录已发起，等待网页确认', { clientId: input.clientId })
    const minInterval = this.deps.minIntervalMs ?? MIN_POLL_INTERVAL_MS
    const suggested =
      typeof challenge['intervalMs'] === 'number' && challenge['intervalMs'] > 0
        ? challenge['intervalMs']
        : minInterval
    void this.pollLoop(run, {
      base: base.replace(/\/+$/, ''),
      deviceCode,
      clientId: input.clientId,
      interval: Math.max(minInterval, suggested),
      expiresAtMs,
      timeoutMs,
    })
    return { started: true, verifyUrl }
  }

  // ───────────────────────── 内部 ─────────────────────────

  /** 轮询循环（后台运行，不阻塞 start 的返回） */
  private async pollLoop(
    run: number,
    ctx: {
      base: string
      deviceCode: string
      clientId: string
      interval: number
      expiresAtMs: number
      timeoutMs: number
    },
  ): Promise<void> {
    let interval = ctx.interval
    let failures = 0
    for (;;) {
      if (this.currentRun !== run) return // 已被取消 / 新的登录已发起
      await this.sleep(interval)
      if (this.currentRun !== run) return
      if (Date.now() >= ctx.expiresAtMs) {
        this.finish(run, { status: 'expired' })
        return
      }
      let body: { status?: unknown; token?: unknown; username?: unknown }
      try {
        body = (await this.postJson(
          `${ctx.base}/api/client/device/poll`,
          { deviceCode: ctx.deviceCode, clientId: ctx.clientId },
          ctx.timeoutMs,
        )) as typeof body
        failures = 0
      } catch (error) {
        // 偶发网络抖动不中断登录（用户正在浏览器里确认）；连续失败才放弃
        failures += 1
        this.deps.logger?.warn('设备授权轮询失败', {
          error: String(error),
          failures,
        })
        if (failures >= MAX_POLL_FAILURES) {
          this.finish(run, {
            status: 'error',
            message: `轮询确认结果失败：${String(error)}`,
          })
          return
        }
        continue
      }
      switch (body['status']) {
        case 'approved': {
          const token = body['token']
          const username = body['username']
          if (typeof token !== 'string' || token === '') {
            this.finish(run, { status: 'error', message: '服务器响应缺少令牌' })
            return
          }
          this.finish(run, {
            status: 'approved',
            token,
            username: typeof username === 'string' ? username : '',
          })
          return
        }
        case 'expired':
          this.finish(run, { status: 'expired' })
          return
        case 'denied':
          this.finish(run, { status: 'denied' })
          return
        case 'slow_down':
          // 服务器要求放慢：间隔放大 1.5 倍后继续（协议 docs/12 §4.3）
          interval = Math.round(interval * 1.5)
          continue
        case 'pending':
          continue
        default:
          // 未知 status 按协议「只增不改」忽略，下一轮再试
          continue
      }
    }
  }

  /** 结算本次运行：只有代号仍是当前值才回调（被取消 / 被新登录取代的静默丢弃） */
  private finish(run: number, outcome: DeviceLoginOutcome): void {
    if (this.currentRun !== run) return
    this.currentRun += 1 // 结算后立即作废本次代号，finish 不会跑两次
    if (outcome.status === 'approved') {
      this.deps.logger?.info('设备授权登录已确认', { username: outcome.username })
    } else {
      this.deps.logger?.info('设备授权登录未完成', { status: outcome.status })
    }
    this.deps.onResult?.(outcome)
  }

  /** 带超时的 JSON POST（响应体解析失败按请求失败处理，交由调用方容错） */
  private async postJson(url: string, payload: unknown, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    try {
      const response = await this.deps.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
      if (!response.ok) {
        const reason = typeof body['error'] === 'string' ? body['error'] : `HTTP ${response.status}`
        throw new Error(reason)
      }
      return body
    } finally {
      clearTimeout(timer)
    }
  }

  /** 可被打断的等待：返回后代号已变就立刻返回，不给旧循环续命 */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
  }
}
