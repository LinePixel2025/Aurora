/**
 * 提示条独立勿扰时段单测（docs/07 §2.2、docs/08 §1 `general.edgeBar.quietHours`）。
 *
 * 这一项之前是死字段。接线后的关键不变量是「**只在状态翻转时**才调 show/hide」：
 * 若每 30s 无条件 show，用户刚手动隐藏的提示条会被反复拉回来。
 */
import { describe, expect, it, vi } from 'vitest'
import { createMemoryLogger } from '@aurora/shared'
import { EdgeBarScheduler } from './edge-bar-scheduler.js'

interface Harness {
  scheduler: EdgeBarScheduler
  show: ReturnType<typeof vi.fn>
  hide: ReturnType<typeof vi.fn>
  setEnabled: (value: boolean) => void
  setQuietHours: (value: { start: string; end: string } | null) => void
}

function harness(
  options: { enabled?: boolean; quietHours?: { start: string; end: string } | null } = {},
): Harness {
  let enabled = options.enabled ?? true
  let quietHours = options.quietHours ?? null
  const show = vi.fn()
  const hide = vi.fn()
  const scheduler = new EdgeBarScheduler({
    enabled: () => enabled,
    quietHours: () => quietHours,
    show,
    hide,
    logger: createMemoryLogger(),
  })
  return {
    scheduler,
    show,
    hide,
    setEnabled: (value) => {
      enabled = value
    },
    setQuietHours: (value) => {
      quietHours = value
    },
  }
}

/** 2026-09-19 是周六；用固定本地时间构造，避免受运行时区影响 */
const NOON = new Date(2026, 8, 19, 12, 0, 0)
const MIDNIGHT = new Date(2026, 8, 19, 23, 30, 0)

describe('EdgeBarScheduler', () => {
  it('启用且非勿扰 → 显示', () => {
    const h = harness()
    expect(h.scheduler.tick(NOON)).toBe(true)
    expect(h.show).toHaveBeenCalledTimes(1)
    expect(h.hide).not.toHaveBeenCalled()
  })

  it('勿扰时段内隐藏，结束后恢复', () => {
    const h = harness({ quietHours: { start: '22:00', end: '07:00' } })

    h.scheduler.tick(NOON)
    expect(h.scheduler.tick(MIDNIGHT)).toBe(false)
    expect(h.hide).toHaveBeenCalledTimes(1)

    h.scheduler.tick(NOON)
    expect(h.scheduler.tick(NOON)).toBe(true)
    expect(h.show).toHaveBeenCalledTimes(2)
  })

  it('状态未翻转时不重复调用 show / hide（否则会抢回用户手动隐藏的提示条）', () => {
    const h = harness()
    h.scheduler.tick(NOON)
    h.scheduler.tick(NOON)
    h.scheduler.tick(NOON)
    expect(h.show).toHaveBeenCalledTimes(1)
    expect(h.hide).not.toHaveBeenCalled()
  })

  it('总开关关闭时隐藏，且关闭期间不因勿扰反复调用', () => {
    const h = harness({ enabled: false })
    h.scheduler.tick(NOON)
    h.scheduler.tick(NOON)
    expect(h.hide).toHaveBeenCalledTimes(1)
    expect(h.show).not.toHaveBeenCalled()
  })

  it('总开关关闭优先于勿扰设置（不显示即无需讨论勿扰）', () => {
    const h = harness({ enabled: false, quietHours: { start: '22:00', end: '07:00' } })
    expect(h.scheduler.tick(NOON)).toBe(false)
    expect(h.show).not.toHaveBeenCalled()
  })

  it('运行时改开 / 关即时生效', () => {
    const h = harness()
    h.scheduler.tick(NOON)
    h.setEnabled(false)
    h.scheduler.tick(NOON)
    expect(h.hide).toHaveBeenCalledTimes(1)
    h.setEnabled(true)
    h.scheduler.tick(NOON)
    expect(h.show).toHaveBeenCalledTimes(2)
  })

  it('运行时配置勿扰时段即时生效', () => {
    const h = harness()
    h.scheduler.tick(NOON)
    h.setQuietHours({ start: '22:00', end: '07:00' })
    expect(h.scheduler.tick(MIDNIGHT)).toBe(false)
    expect(h.hide).toHaveBeenCalledTimes(1)
  })

  it('show / hide 抛错时不向外抛，也不影响后续判定', () => {
    let enabled = true
    const scheduler = new EdgeBarScheduler({
      enabled: () => enabled,
      quietHours: () => null,
      show: () => {
        throw new Error('窗口已被销毁')
      },
      hide: () => undefined,
      logger: createMemoryLogger(),
    })
    expect(() => scheduler.tick(NOON)).not.toThrow()
    enabled = false
    expect(() => scheduler.tick(NOON)).not.toThrow()
  })

  it('start 幂等（重复调用不会累积定时器）', () => {
    const h = harness()
    h.scheduler.start()
    h.scheduler.start()
    h.scheduler.stop()
    h.scheduler.stop()
    // 首次 start 已同步跑过一次 tick
    expect(h.show).toHaveBeenCalledTimes(1)
  })
})
