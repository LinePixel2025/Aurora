/**
 * 主动引导 / 敏感工具确认调度（docs/06 §5、§9）。
 *
 * v1 的确认载体是"确认卡片"：主进程把 `SensitiveToolRequest` 推给渲染层，
 * 渲染层用 `confirmId` 回执；超时（默认 60s）与勿扰时段一律按**拒绝**处理，
 * 避免会话永久挂起。
 *
 * **不依赖 Electron**：推送载体（`present`）由主进程注入，因此可单测。
 */
import type { Logger, SensitiveToolRequest } from '@aurora/shared'
import { parseClock } from './schedule.js'

export interface ProactiveSchedulerOptions {
  /** 勿扰时段（设置项 `advanced.quietHours`）；null 表示不启用 */
  quietHours: () => { start: string; end: string } | null
  logger: Logger
  /** 展示确认卡片的载体（主进程注入：推送到交互窗） */
  present: (request: SensitiveToolRequest) => void
  /** 确认超时，默认 60_000 */
  confirmTimeoutMs?: number
}

export const DEFAULT_CONFIRM_TIMEOUT_MS = 60_000

interface PendingConfirm {
  request: SensitiveToolRequest
  resolve: (approved: boolean) => void
  timer: NodeJS.Timeout
}

/**
 * 纯函数：判断给定时间是否落在勿扰时段内（支持跨天，如 22:30–07:00）。
 * 时段缺失或时间非法时返回 `false`（不抑制），绝不抛错。
 */
export function isQuietHour(now: Date, quietHours: { start: string; end: string } | null): boolean {
  if (quietHours === null) return false
  const start = parseClock(quietHours.start)
  const end = parseClock(quietHours.end)
  if (start === undefined || end === undefined) return false
  // 起止相同视为"未配置有效时段"，不抑制（否则 0 长度时段会变成全天勿扰）
  if (start === end) return false
  const current = now.getHours() * 60 + now.getMinutes()
  if (start < end) return current >= start && current < end
  // 跨天：22:30–07:00 → [22:30, 24:00) ∪ [00:00, 07:00)
  return current >= start || current < end
}

export class ProactiveScheduler {
  private readonly options: ProactiveSchedulerOptions
  private readonly confirmTimeoutMs: number
  private readonly pending = new Map<string, PendingConfirm>()
  private readonly listeners = new Set<(request: SensitiveToolRequest) => void>()
  private counter = 0
  private disposed = false

  constructor(options: ProactiveSchedulerOptions) {
    this.options = options
    this.confirmTimeoutMs = Math.max(1, options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS)
  }

  /** 在途确认数量（供状态展示与测试） */
  get pendingCount(): number {
    return this.pending.size
  }

  /**
   * 同进程内订阅确认请求（供 IPC 层广播到交互窗，见 `contracts.ProactiveLike`）。
   * 与 `present` 是两条独立通道，接线时只用其中一条，避免同一张卡片推两次。
   */
  onRequest(listener: (request: SensitiveToolRequest) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 勿扰时段内直接拒绝并返回 false；否则推送确认卡并等待回执/超时。
   * 推送失败同样按拒绝处理（不能让工具卡在半途）。
   */
  async requestSensitiveToolConfirm(input: {
    sessionId: string
    toolName: string
    input: unknown
  }): Promise<boolean> {
    if (this.disposed) {
      this.options.logger.warn('主动引导已释放，敏感工具确认直接拒绝', { tool: input.toolName })
      return false
    }
    if (isQuietHour(new Date(), this.options.quietHours())) {
      this.options.logger.info('处于勿扰时段，敏感工具确认直接拒绝', { tool: input.toolName })
      return false
    }

    this.counter += 1
    const request: SensitiveToolRequest = {
      confirmId: `confirm-${Date.now().toString(36)}-${this.counter}`,
      toolName: input.toolName,
      input: input.input,
      sessionId: input.sessionId,
      expiresAt: new Date(Date.now() + this.confirmTimeoutMs).toISOString(),
    }

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.confirmId)
        this.options.logger.warn('敏感工具确认超时，按拒绝处理', {
          confirmId: request.confirmId,
          toolName: request.toolName,
          timeoutMs: this.confirmTimeoutMs,
        })
        resolve(false)
      }, this.confirmTimeoutMs)
      timer.unref?.()

      this.pending.set(request.confirmId, { request, resolve, timer })

      try {
        this.options.present(request)
        for (const listener of this.listeners) {
          try {
            listener(request)
          } catch (error) {
            this.options.logger.warn('确认请求监听器抛错', { error: String(error) })
          }
        }
      } catch (error) {
        const settled = this.settle(request.confirmId, false)
        if (settled) {
          this.options.logger.error('确认卡片推送失败，按拒绝处理', {
            confirmId: request.confirmId,
            error: String(error),
          })
        }
      }
    })
  }

  /** IPC 回执入口：未知/已超时的 confirmId 返回 false。 */
  resolve(confirmId: string, approved: boolean): boolean {
    const settled = this.settle(confirmId, approved)
    if (!settled) {
      this.options.logger.warn('收到未知或已过期的敏感工具确认回执', { confirmId, approved })
    }
    return settled
  }

  /** 让所有在途确认立即拒绝（会话 abort / 退出时调用）。 */
  rejectAll(reason: string): void {
    const ids = [...this.pending.keys()]
    if (ids.length === 0) return
    for (const confirmId of ids) this.settle(confirmId, false)
    this.options.logger.info('已拒绝全部在途敏感工具确认', { count: ids.length, reason })
  }

  dispose(): void {
    this.rejectAll('dispose')
    this.listeners.clear()
    this.disposed = true
  }

  // ───────────────────────── 内部 ─────────────────────────

  /** 结算一次在途确认；返回是否命中（未命中说明已超时或 id 未知）。 */
  private settle(confirmId: string, approved: boolean): boolean {
    const entry = this.pending.get(confirmId)
    if (entry === undefined) return false
    this.pending.delete(confirmId)
    clearTimeout(entry.timer)
    entry.resolve(approved)
    this.options.logger.debug('敏感工具确认已回执', { confirmId, approved })
    return true
  }
}
