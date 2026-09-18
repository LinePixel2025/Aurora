import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryLogger, type SensitiveToolRequest } from '@aurora/shared'
import {
  DEFAULT_CONFIRM_TIMEOUT_MS,
  ProactiveScheduler,
  isQuietHour,
  type ProactiveSchedulerOptions,
} from './proactive.js'

/** 2026-03-02 是星期一 */
const MONDAY = new Date(2026, 2, 2, 10, 0, 0)
const CROSS_DAY = { start: '22:30', end: '07:00' }

function at(hours: number, minutes: number): Date {
  return new Date(2026, 2, 2, hours, minutes, 0)
}

describe('isQuietHour', () => {
  it('未配置勿扰时段时永远不静默', () => {
    expect(isQuietHour(MONDAY, null)).toBe(false)
  })

  it('跨天时段（22:30–07:00）：两端覆盖、边界结束', () => {
    expect(isQuietHour(at(23, 0), CROSS_DAY)).toBe(true)
    expect(isQuietHour(at(22, 30), CROSS_DAY)).toBe(true)
    expect(isQuietHour(at(3, 0), CROSS_DAY)).toBe(true)
    expect(isQuietHour(at(6, 59), CROSS_DAY)).toBe(true)
    expect(isQuietHour(at(22, 29), CROSS_DAY)).toBe(false)
    expect(isQuietHour(at(7, 0), CROSS_DAY)).toBe(false)
    expect(isQuietHour(at(12, 0), CROSS_DAY)).toBe(false)
  })

  it('同日时段（13:00–14:00）', () => {
    const sameDay = { start: '13:00', end: '14:00' }
    expect(isQuietHour(at(12, 59), sameDay)).toBe(false)
    expect(isQuietHour(at(13, 0), sameDay)).toBe(true)
    expect(isQuietHour(at(13, 59), sameDay)).toBe(true)
    expect(isQuietHour(at(14, 0), sameDay)).toBe(false)
  })

  it('时间非法或起止相同时不静默（降级而非整天静默）', () => {
    expect(isQuietHour(at(23, 0), { start: 'oops', end: '07:00' })).toBe(false)
    expect(isQuietHour(at(23, 0), { start: '22:30', end: '' })).toBe(false)
    expect(isQuietHour(at(23, 0), { start: '23:00', end: '23:00' })).toBe(false)
  })
})

describe('ProactiveScheduler', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function createScheduler(options: Partial<ProactiveSchedulerOptions> = {}) {
    const presented: SensitiveToolRequest[] = []
    const logger = createMemoryLogger()
    const scheduler = new ProactiveScheduler({
      quietHours: () => null,
      logger,
      present: (request) => {
        presented.push(request)
      },
      ...options,
    })
    return { scheduler, presented, logger }
  }

  const request = {
    sessionId: 'quick',
    toolName: 'mcp.files.move',
    input: { from: 'a.txt', to: 'b.txt' },
  }

  it('默认超时为 60s', () => {
    expect(DEFAULT_CONFIRM_TIMEOUT_MS).toBe(60_000)
  })

  it('推送确认卡片并等待回执：允许执行', async () => {
    const { scheduler, presented } = createScheduler()
    const pending = scheduler.requestSensitiveToolConfirm(request)
    expect(presented).toHaveLength(1)
    expect(scheduler.pendingCount).toBe(1)

    const confirmId = presented[0]?.confirmId ?? ''
    expect(confirmId).not.toBe('')
    expect(presented[0]?.toolName).toBe('mcp.files.move')
    expect(presented[0]?.sessionId).toBe('quick')
    expect(presented[0]?.input).toEqual({ from: 'a.txt', to: 'b.txt' })
    expect(presented[0]?.expiresAt).toBeDefined()

    expect(scheduler.resolve(confirmId, true)).toBe(true)
    await expect(pending).resolves.toBe(true)
    expect(scheduler.pendingCount).toBe(0)
  })

  it('拒绝时返回 false', async () => {
    const { scheduler, presented } = createScheduler()
    const pending = scheduler.requestSensitiveToolConfirm(request)
    expect(scheduler.resolve(presented[0]?.confirmId ?? '', false)).toBe(true)
    await expect(pending).resolves.toBe(false)
  })

  it('每次确认使用不同的 confirmId', async () => {
    const { scheduler, presented } = createScheduler()
    const first = scheduler.requestSensitiveToolConfirm(request)
    const second = scheduler.requestSensitiveToolConfirm(request)
    expect(scheduler.pendingCount).toBe(2)
    expect(presented[0]?.confirmId).not.toBe(presented[1]?.confirmId)
    scheduler.resolve(presented[0]?.confirmId ?? '', true)
    scheduler.resolve(presented[1]?.confirmId ?? '', false)
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(false)
  })

  it('未知 / 重复的 confirmId 回执返回 false（且不改变已结算结果）', async () => {
    const { scheduler, presented } = createScheduler()
    expect(scheduler.resolve('confirm-unknown', true)).toBe(false)

    const pending = scheduler.requestSensitiveToolConfirm(request)
    const confirmId = presented[0]?.confirmId ?? ''
    expect(scheduler.resolve(confirmId, true)).toBe(true)
    expect(scheduler.resolve(confirmId, false)).toBe(false)
    await expect(pending).resolves.toBe(true)
  })

  it('超时按拒绝处理（默认 60s）', async () => {
    vi.useFakeTimers({ now: MONDAY })
    const { scheduler, logger } = createScheduler()
    const pending = scheduler.requestSensitiveToolConfirm(request)
    expect(scheduler.pendingCount).toBe(1)

    await vi.advanceTimersByTimeAsync(DEFAULT_CONFIRM_TIMEOUT_MS)
    await expect(pending).resolves.toBe(false)
    expect(scheduler.pendingCount).toBe(0)
    expect(logger.entries.some((entry) => entry.includes('超时'))).toBe(true)
  })

  it('自定义超时生效', async () => {
    vi.useFakeTimers({ now: MONDAY })
    const { scheduler } = createScheduler({ confirmTimeoutMs: 1_000 })
    const pending = scheduler.requestSensitiveToolConfirm(request)
    // 超时前回执仍然有效
    await vi.advanceTimersByTimeAsync(500)
    expect(scheduler.pendingCount).toBe(1)
    await vi.advanceTimersByTimeAsync(500)
    await expect(pending).resolves.toBe(false)
  })

  it('勿扰时段内直接拒绝，不推送卡片', async () => {
    vi.useFakeTimers({ now: at(23, 30) })
    const { scheduler, presented, logger } = createScheduler({ quietHours: () => CROSS_DAY })
    await expect(scheduler.requestSensitiveToolConfirm(request)).resolves.toBe(false)
    expect(presented).toEqual([])
    expect(scheduler.pendingCount).toBe(0)
    expect(logger.entries.some((entry) => entry.includes('勿扰'))).toBe(true)
  })

  it('卡片推送失败时按拒绝处理（不让工具卡住）', async () => {
    const logger = createMemoryLogger()
    const scheduler = new ProactiveScheduler({
      quietHours: () => null,
      logger,
      present: () => {
        throw new Error('交互窗已销毁')
      },
    })
    await expect(scheduler.requestSensitiveToolConfirm(request)).resolves.toBe(false)
    expect(scheduler.pendingCount).toBe(0)
    expect(logger.entries.some((entry) => entry.includes('推送失败'))).toBe(true)
  })

  it('rejectAll 让所有在途确认立即失败', async () => {
    const { scheduler, logger } = createScheduler()
    const first = scheduler.requestSensitiveToolConfirm(request)
    const second = scheduler.requestSensitiveToolConfirm(request)
    expect(scheduler.pendingCount).toBe(2)

    scheduler.rejectAll('session-abort')
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
    expect(scheduler.pendingCount).toBe(0)
    expect(logger.entries.some((entry) => entry.includes('session-abort'))).toBe(true)
    // 空集合时是安全的 no-op
    scheduler.rejectAll('again')
  })

  it('onRequest 订阅与 present 都会收到请求（接线时只选一条）', async () => {
    const { scheduler, presented } = createScheduler()
    const seen: SensitiveToolRequest[] = []
    const off = scheduler.onRequest((item) => seen.push(item))

    const pending = scheduler.requestSensitiveToolConfirm(request)
    expect(seen).toHaveLength(1)
    expect(presented).toHaveLength(1)

    off()
    scheduler.resolve(presented[0]?.confirmId ?? '', true)
    await expect(pending).resolves.toBe(true)
  })

  it('dispose 后不再接受新的确认', async () => {
    const { scheduler, presented } = createScheduler()
    const pending = scheduler.requestSensitiveToolConfirm(request)
    scheduler.dispose()
    await expect(pending).resolves.toBe(false)

    await expect(scheduler.requestSensitiveToolConfirm(request)).resolves.toBe(false)
    expect(presented).toHaveLength(1)
    expect(scheduler.pendingCount).toBe(0)
  })
})
