/**
 * 提示条（edge-bar）的独立勿扰时段（docs/07 §2.2、docs/08 §1 `general.edgeBar.quietHours`）。
 *
 * 与 `advanced.quietHours` 的区别：后者管「主动打扰」（敏感工具确认、课前提醒），
 * 本项只管**提示条自己是否显示** —— 用户可能希望课前提醒照常弹，但不想要那条贴边竖条。
 * 两者相互独立，之前本项只是配置里的死字段。
 *
 * 纯逻辑 + 注入副作用，可在 Node 里单测（与 `pre-class-reminder.ts` 同一套路数）。
 */
import type { Logger } from '@aurora/shared'
import { isQuietHour } from './proactive.js'

export interface EdgeBarScheduleOptions {
  /** 是否启用提示条（`general.edgeBar.enabled`），每次 tick 即时读取 */
  enabled: () => boolean
  /** 勿扰时段（`general.edgeBar.quietHours`）；null 表示不限 */
  quietHours: () => { start: string; end: string } | null
  /** 显示提示条 */
  show: () => void
  /** 隐藏提示条 */
  hide: () => void
  logger: Logger
  /** 检查间隔，默认 30s（与课前提醒一致，够用且不费电） */
  intervalMs?: number
}

const DEFAULT_INTERVAL_MS = 30_000

export class EdgeBarScheduler {
  private readonly options: EdgeBarScheduleOptions
  private readonly intervalMs: number
  private timer: NodeJS.Timeout | undefined
  /** 上一次应用的可见性；`undefined` 表示还没判断过 */
  private lastVisible: boolean | undefined

  constructor(options: EdgeBarScheduleOptions) {
    this.options = options
    this.intervalMs = Math.max(1_000, options.intervalMs ?? DEFAULT_INTERVAL_MS)
  }

  start(): void {
    if (this.timer !== undefined) return
    this.tick(new Date())
    this.timer = setInterval(() => this.tick(new Date()), this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * 计算并应用期望可见性。
   *
   * 只在**状态真的翻转**时才调 show/hide：每 30s 无条件 show 会把用户刚
   * 手动关掉的提示条又拉回来（窗口管理器里 show 是幂等但会抢焦点/重排顺序）。
   */
  tick(now: Date = new Date()): boolean {
    const enabled = this.options.enabled()
    const quiet = enabled && isQuietHour(now, this.options.quietHours())
    const visible = enabled && !quiet

    if (visible === this.lastVisible) return visible
    const previous = this.lastVisible
    this.lastVisible = visible

    try {
      if (visible) this.options.show()
      else this.options.hide()
    } catch (error) {
      this.options.logger.warn('切换提示条可见性失败', { error: String(error) })
      return visible
    }

    if (quiet) this.options.logger.debug('提示条进入勿扰时段，已隐藏')
    else if (previous === false && visible) this.options.logger.debug('提示条勿扰时段结束，已恢复')
    return visible
  }
}
