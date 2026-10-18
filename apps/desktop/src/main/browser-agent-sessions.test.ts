/**
 * 内置浏览器并发槽位（v35，docs/06 §27）：上限 / 复用 / 释放补位 / 空闲到期 / 硬上限。
 * 纯逻辑，不 import electron。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_AGENT_BROWSER_SESSIONS_HARD,
  createBrowserSessionSlots,
} from './browser-agent-sessions.js'

interface FakeClock {
  now: () => number
  setTimer: (callback: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  advance: (ms: number) => void
  pending: () => number
}

function fakeClock(): FakeClock {
  let current = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  let nextId = 1
  return {
    now: () => current,
    setTimer: (callback, ms) => {
      const id = nextId++
      timers.set(id, { at: current + ms, callback })
      return id
    },
    clearTimer: (handle) => {
      timers.delete(handle as number)
    },
    advance: (ms) => {
      current += ms
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > current) continue
        timers.delete(id)
        timer.callback()
      }
    },
    pending: () => timers.size,
  }
}

describe('createBrowserSessionSlots', () => {
  it('默认按 getter 上限放行；同会话第二次 acquire 返回 duplicate', () => {
    const slots = createBrowserSessionSlots({
      maxCount: () => 2,
      idleMs: () => 0,
      onIdle: () => {},
    })
    expect(slots.acquire('a')).toEqual({ ok: true })
    expect(slots.acquire('a')).toEqual({ ok: false, reason: 'duplicate' })
    expect(slots.acquire('b')).toEqual({ ok: true })
    expect(slots.acquire('c')).toEqual({ ok: false, reason: 'limit', limit: 2 })
    expect(slots.count()).toBe(2)
  })

  it('release 后名额补位；重复 release 幂等返回 false', () => {
    const slots = createBrowserSessionSlots({
      maxCount: () => 1,
      idleMs: () => 0,
      onIdle: () => {},
    })
    expect(slots.acquire('a').ok).toBe(true)
    expect(slots.acquire('b')).toEqual({ ok: false, reason: 'limit', limit: 1 })
    expect(slots.release('a')).toBe(true)
    expect(slots.release('a')).toBe(false)
    expect(slots.acquire('b').ok).toBe(true)
  })

  it('maxCount 是 live getter：设置调小后不再放行，但已有会话不被踢掉', () => {
    let limit = 3
    const slots = createBrowserSessionSlots({
      maxCount: () => limit,
      idleMs: () => 0,
      onIdle: () => {},
    })
    expect(slots.acquire('a').ok).toBe(true)
    expect(slots.acquire('b').ok).toBe(true)
    limit = 1
    expect(slots.acquire('c')).toEqual({ ok: false, reason: 'limit', limit: 1 })
    expect(slots.count()).toBe(2)
    expect(slots.ids()).toEqual(['a', 'b'])
  })

  it('上限夹到 1..硬上限 4（配置被绕过时也不会无限开）', () => {
    const slots = createBrowserSessionSlots({
      maxCount: () => 99,
      idleMs: () => 0,
      onIdle: () => {},
    })
    for (let index = 0; index < MAX_AGENT_BROWSER_SESSIONS_HARD; index += 1) {
      expect(slots.acquire(`s${index}`).ok).toBe(true)
    }
    expect(slots.acquire('overflow')).toEqual({
      ok: false,
      reason: 'limit',
      limit: MAX_AGENT_BROWSER_SESSIONS_HARD,
    })
    expect(slots.snapshot().limit).toBe(MAX_AGENT_BROWSER_SESSIONS_HARD)
  })

  it('touch 重置空闲计时；到期回调后由 manager 调 release 完成释放', () => {
    const clock = fakeClock()
    const idle = vi.fn()
    const slots = createBrowserSessionSlots({
      maxCount: () => 2,
      idleMs: () => 1_000,
      onIdle: idle,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })
    expect(slots.acquire('a').ok).toBe(true)
    clock.advance(600)
    slots.touch('a')
    clock.advance(600)
    // 距上次 touch 只有 600ms，不该到点
    expect(idle).not.toHaveBeenCalled()
    clock.advance(500)
    expect(idle).toHaveBeenCalledTimes(1)
    expect(idle).toHaveBeenCalledWith('a')
    // 回调只通知，不自己删：释放路径唯一（manager 调 release）
    expect(slots.count()).toBe(1)
    slots.release('a')
    expect(slots.count()).toBe(0)
    expect(clock.pending()).toBe(0)
  })

  it('idleMs <= 0 表示不自动释放', () => {
    const clock = fakeClock()
    const idle = vi.fn()
    const slots = createBrowserSessionSlots({
      maxCount: () => 1,
      idleMs: () => 0,
      onIdle: idle,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })
    slots.acquire('a')
    clock.advance(10 * 60_000)
    expect(idle).not.toHaveBeenCalled()
    expect(clock.pending()).toBe(0)
  })

  it('clear 释放全部并返回 id；dispose 后不再放行', () => {
    const slots = createBrowserSessionSlots({
      maxCount: () => 3,
      idleMs: () => 0,
      onIdle: () => {},
    })
    slots.acquire('a')
    slots.acquire('b')
    expect(slots.clear()).toEqual(['a', 'b'])
    expect(slots.count()).toBe(0)
    expect(slots.acquire('c').ok).toBe(true)
    slots.dispose()
    expect(slots.acquire('d')).toEqual({ ok: false, reason: 'limit', limit: 3 })
  })

  it('lastUsedAt / createdAt 用注入时钟（诊断可读）', () => {
    const clock = fakeClock()
    const slots = createBrowserSessionSlots({
      maxCount: () => 1,
      idleMs: () => 0,
      onIdle: () => {},
      now: clock.now,
    })
    slots.acquire('a')
    clock.advance(500)
    slots.touch('a')
    expect(slots.get('a')).toMatchObject({ sessionId: 'a', createdAt: 0, lastUsedAt: 500 })
    expect(slots.get('missing')).toBeUndefined()
  })
})
