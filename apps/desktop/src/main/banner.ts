/**
 * 流光提醒（Banner Notification）的主进程侧逻辑（docs/07 §2.2.3、§4）。
 *
 * 定位：**独立于**系统通知（`NotificationService` / Electron `Notification`）与
 * ClassIsland 提醒的第三条提醒通道 —— 屏幕顶端出现流光，提醒内容以置顶卡片浮现。
 * 三个来源（Agent 工具 `notify_banner` / 插件 `ctx.banner` / `ask_user`）都汇聚到
 * 本服务的 `show()`，因此**排队、去重、降级只有一份实现**。
 *
 * 与 `NotificationService` 的两处刻意差异：
 * 1. **一次只显示一条**（有队列）：流光提醒占据屏幕顶端且带语音播报，同时弹两条会互相打断；
 * 2. **展示载体是注入的两个窗口**（流光浮层 + 卡片窗），本文件因此**不得 import electron**，
 *    可以在 vitest 里直接构造、直接断言队列与去重（与 `tts.ts` / `awareness-glow.ts` 同款）。
 *
 * 失败口径：`show()` 永不抛错，一律折成 `{ ok, reason }` 回报 —— 提醒只是锦上添花，
 * 不能因为窗口没建起来把 Agent 的工具循环或插件调用带崩。
 */
import type { BannerLevel, BannerRequest, BannerShowPayload, Logger } from '@aurora/shared'

/**
 * 提醒来源：只用于日志与排障，不参与任何权限判定。
 *
 * `system` = Aurora 自己发起的提醒（分类完成 / 课前提醒 / 引导 / `notify_user` 等，
 * 即按「默认提醒方式」投递的那一类）；其余三条是显式请求流光提醒的来源。
 */
export type BannerSource = 'agent' | 'plugin' | 'ask' | 'system' | 'smoke'

/** `show()` 的回报：`ok: false` 是业务结果（去重 / 队列满 / 载体失败），不是异常。 */
export interface BannerShowOutcome {
  ok: boolean
  reason?: string
  /** 本次生成的展示 id（`ok: true` 时才有） */
  id?: string
  /** true = 前一条还在显示，本次进了队列 */
  queued?: boolean
}

export interface BannerServiceOptions {
  logger: Logger
  /** 注入的展示载体（`WindowManager.showBanner`）：返回 false 表示窗口没能显示出来 */
  present: (payload: BannerShowPayload) => boolean
  /** 注入的隐藏载体（`WindowManager.hideBanner`）：必须幂等 */
  hide: () => void
  /**
   * `speak` 的缺省值（live getter）：是否已配置可用的 TTS。
   *
   * 为什么是 getter 而不是构造时的布尔：用户在设置页配好 / 清掉 TTS 之后，
   * 下一批提醒就该按新配置走，不必重启（与 `agent.loop.*` 的上限注入同一条规矩）。
   */
  speakDefault?: () => boolean
  now?: () => number
  /** 去重窗口（缺省 3s，与 `NotificationService` 同口径） */
  dedupeWindowMs?: number
  /** 队列上限（防失控常量，不做成配置项）：超出的**新**请求被拒并说明原因 */
  maxQueue?: number
  defaultDurationMs?: number
  minDurationMs?: number
  maxDurationMs?: number
}

/** 单条提醒的时长区间：太短看不清，太长会赖在屏幕上 */
const DURATION = { default: 6000, min: 2000, max: 30_000 } as const
/** 标题 / 正文上限：与插件 `ctx.notify` 的截断口径保持一致（超出裁掉并记 debug） */
export const BANNER_TITLE_MAX = 120
export const BANNER_BODY_MAX = 800
/** 队列上限：同时排 8 条已经足够，再多说明调用方在刷屏 */
const MAX_QUEUE = 8
/**
 * 展示载体自己失败时的兜底：正常路径由渲染层在 `durationMs` 到点时发 `banner:dismiss`，
 * 但窗口渲染进程崩掉 / 页面脚本异常时回执不会来 —— 这里晚一步强制收尾，避免卡片永远挂在屏幕上。
 */
const BACKSTOP_GRACE_MS = 1500

/**
 * 流光提醒服务（纯逻辑，不 import electron）。
 *
 * 状态机只有两态：`current`（正在显示）与 `queue`（排队）。`show()` 要么占住 `current`，
 * 要么进队列；`dismiss(id)` 只认**当前那一条的 id** —— 迟到的 / 重复的回执一律返回
 * `dismissed: false`，否则「上一张卡片晚到的超时回执」会把刚弹出来的新卡片关掉。
 */
export class BannerService {
  private readonly logger: Logger
  private readonly present: (payload: BannerShowPayload) => boolean
  private readonly hide: () => void
  private readonly speakDefault: () => boolean
  private readonly now: () => number
  private readonly dedupeWindowMs: number
  private readonly maxQueue: number
  private readonly defaultDurationMs: number
  private readonly minDurationMs: number
  private readonly maxDurationMs: number

  /** 去重表：key → 上次展示时刻 */
  private readonly recent = new Map<string, number>()
  private current: BannerShowPayload | undefined
  private readonly queue: BannerShowPayload[] = []
  /** 兜底收尾定时器（只在有 `current` 时存在） */
  private backstop: ReturnType<typeof setTimeout> | undefined
  private sequence = 0
  private shown = 0
  private disposed = false

  constructor(options: BannerServiceOptions) {
    this.logger = options.logger
    this.present = options.present
    this.hide = options.hide
    this.speakDefault = options.speakDefault ?? (() => false)
    this.now = options.now ?? (() => Date.now())
    this.dedupeWindowMs = options.dedupeWindowMs ?? 3_000
    this.maxQueue = Math.max(1, options.maxQueue ?? MAX_QUEUE)
    this.defaultDurationMs = options.defaultDurationMs ?? DURATION.default
    this.minDurationMs = options.minDurationMs ?? DURATION.min
    this.maxDurationMs = options.maxDurationMs ?? DURATION.max
  }

  /**
   * 请求展示一条流光提醒。
   *
   * 返回值只表示「**被接受**」（已显示或已排队），不表示用户看完了；
   * 需要知道是否真的显示出来，看 `ok` 与 `queued` 两个字段。
   */
  show(request: BannerRequest, options: { source?: BannerSource } = {}): BannerShowOutcome {
    if (this.disposed) return { ok: false, reason: '流光提醒服务已停止' }

    const title = clampText(request.title, BANNER_TITLE_MAX) || 'Aurora 提醒'
    // 正文允许空串（R2：缺正文时仍能显示标题），但纯空白按空处理 —— 卡片不留空第二行
    const body = clampText(request.body, BANNER_BODY_MAX)

    const key = request.dedupeKey ?? `${title}\u0000${body}`
    const now = this.now()
    const last = this.recent.get(key)
    if (last !== undefined && now - last < this.dedupeWindowMs) {
      this.logger.debug('流光提醒已去重', { source: options.source ?? 'unknown', title })
      return { ok: false, reason: '短时间内重复的提醒已合并（未重复显示）' }
    }
    this.recent.set(key, now)
    this.pruneRecent(now)

    const durationMs = clampNumber(
      request.durationMs ?? this.defaultDurationMs,
      this.minDurationMs,
      this.maxDurationMs,
    )
    const payload: BannerShowPayload = {
      id: `banner-${now.toString(36)}-${(this.sequence += 1)}`,
      title,
      body,
      speak: request.speak ?? this.safeSpeakDefault(),
      sound: request.sound ?? true,
      durationMs,
      level: normalizeLevel(request.level),
    }

    if (this.current !== undefined) {
      if (this.queue.length >= this.maxQueue) {
        this.logger.warn('流光提醒队列已满，丢弃新请求', {
          source: options.source ?? 'unknown',
          title,
          queue: this.queue.length,
        })
        return { ok: false, reason: `提醒队列已满（${this.maxQueue} 条），本条未显示` }
      }
      this.queue.push(payload)
      this.logger.info('流光提醒已排队', {
        source: options.source ?? 'unknown',
        title,
        pending: this.queue.length,
      })
      return { ok: true, id: payload.id, queued: true }
    }

    this.display(payload, options.source)
    return { ok: true, id: payload.id, queued: false }
  }

  /**
   * 渲染层回执：关闭 **id 对应的那一条**（用户点关闭 / 超时 / 播完）。
   *
   * `id` 不匹配 = 迟到或重复的回执，只回报当前队列长度，绝不动正在显示的新卡片。
   */
  dismiss(id: string): { dismissed: boolean; pending: number } {
    const current = this.current
    if (current === undefined || current.id !== id) {
      this.logger.debug('忽略迟到的流光提醒回执', { id, current: current?.id ?? '' })
      return { dismissed: false, pending: this.queue.length }
    }
    this.finishCurrent()
    return { dismissed: true, pending: this.queue.length }
  }

  /** 运行态读数（自测 / 诊断用；不含原生窗口信息，那部分由 `WindowManager` 提供）。 */
  diagnostics(): { visible: boolean; pending: number; shownCount: number } {
    return {
      visible: this.current !== undefined,
      pending: this.queue.length,
      shownCount: this.shown,
    }
  }

  /** 正在显示的 id（没有则为空串）：渲染层 / 自测排障用。 */
  currentId(): string {
    return this.current?.id ?? ''
  }

  /** 应用退出：清掉定时器与队列，不再尝试操作已经销毁的窗口。 */
  dispose(): void {
    this.disposed = true
    this.clearBackstop()
    this.current = undefined
    this.queue.length = 0
  }

  // ───────────────────────── 内部 ─────────────────────────

  /** `speakDefault()` 是用户配置的取值器，抛错时按「不朗读」处理（不能因设置读失败而不弹提醒） */
  private safeSpeakDefault(): boolean {
    try {
      return this.speakDefault()
    } catch (error) {
      this.logger.debug('读取 TTS 朗读缺省值失败，按不朗读处理', { error: String(error) })
      return false
    }
  }

  private display(payload: BannerShowPayload, source: BannerSource | undefined): void {
    this.current = payload
    let shown = false
    try {
      shown = this.present(payload)
    } catch (error) {
      this.logger.warn('流光提醒展示失败（不影响主流程）', {
        source: source ?? 'unknown',
        title: payload.title,
        error: String(error),
      })
    }
    if (!shown) {
      // 载体失败（窗口没建出来）：跳过这一条，直接让队首补上，而不是把队列卡死在这里
      this.current = undefined
      this.startNext()
      return
    }
    this.shown += 1
    this.armBackstop(payload)
    // 正文可能含用户输入（提问的卡片内容也在内），日志只留标题与长度
    this.logger.info('流光提醒', {
      source: source ?? 'unknown',
      id: payload.id,
      title: payload.title,
      bodyChars: payload.body.length,
      speak: payload.speak,
      sound: payload.sound,
      durationMs: payload.durationMs,
    })
  }

  private armBackstop(payload: BannerShowPayload): void {
    this.clearBackstop()
    this.backstop = setTimeout(() => {
      this.backstop = undefined
      if (this.current?.id !== payload.id) return
      this.logger.debug('流光提醒超时未收到回执，强制收尾', { id: payload.id })
      this.finishCurrent()
    }, payload.durationMs + BACKSTOP_GRACE_MS)
    // 定时器不该拖住进程退出（主进程里 `unref` 存在；浏览器环境没有它）
    this.backstop.unref?.()
  }

  private clearBackstop(): void {
    if (this.backstop === undefined) return
    clearTimeout(this.backstop)
    this.backstop = undefined
  }

  /** 收掉当前这条（隐藏窗口）并推进队列 */
  private finishCurrent(): void {
    this.current = undefined
    this.clearBackstop()
    try {
      this.hide()
    } catch (error) {
      this.logger.debug('隐藏流光提醒窗口失败', { error: String(error) })
    }
    this.startNext()
  }

  private startNext(): void {
    const next = this.queue.shift()
    if (next !== undefined) this.display(next, undefined)
  }

  private pruneRecent(now: number): void {
    if (this.recent.size < 100) return
    for (const [key, at] of this.recent) {
      if (now - at > this.dedupeWindowMs) this.recent.delete(key)
    }
  }
}

/** 去首尾空白 + 折叠换行，再按上限截断（标题里的换行会把单行标题撑成两行） */
function clampText(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

function normalizeLevel(level: BannerLevel | undefined): BannerLevel {
  return level === 'success' || level === 'warning' || level === 'error' ? level : 'info'
}
