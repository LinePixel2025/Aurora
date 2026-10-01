import { describe, expect, it } from 'vitest'
import {
  DeviceAuthStore,
  DEVICE_MAX_CHALLENGES,
  DEVICE_POLL_INTERVAL_MS,
  formatUserCode,
} from './device.js'

/** 可拨动时钟：挑战过期 / 一次性消费都靠它精确验证 */
function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let current = 1_700_000_000_000
  return {
    now: () => current,
    advance: (ms) => {
      current += ms
    },
  }
}

function makeStore(ttlMs = 10 * 60 * 1000): {
  store: DeviceAuthStore
  clock: ReturnType<typeof makeClock>
} {
  const clock = makeClock()
  return { store: new DeviceAuthStore({ ttlMs, now: clock.now }), clock }
}

describe('DeviceAuthStore · 设备授权挑战', () => {
  it('start：deviceCode 43 字符、userCode 形如 ABCD-1234、verifyUrl 带展示码、intervalMs 2000', () => {
    const { store } = makeStore()
    const challenge = store.start('client-a', (code) => `http://center.test/#/device?code=${code}`)
    expect(challenge.deviceCode).toHaveLength(43)
    expect(challenge.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    expect(challenge.verifyUrl).toContain(`#/device?code=${challenge.userCode}`)
    expect(challenge.intervalMs).toBe(DEVICE_POLL_INTERVAL_MS)
    // 未批准前轮询 pending
    expect(store.poll(challenge.deviceCode, 'client-a')).toEqual({ status: 'pending' })
  })

  it('批准 → 轮询拿到 approved（一次性）：第二次轮询 expired', () => {
    const { store } = makeStore()
    const challenge = store.start('client-a', () => '')
    expect(
      store.resolve(challenge.deviceCode, true, () => ({ token: 'ac-t1', username: 'alice' })),
    ).toBe(true)
    expect(store.poll(challenge.deviceCode, 'client-a')).toEqual({
      status: 'approved',
      token: 'ac-t1',
      username: 'alice',
    })
    // 挑战一次性：结果消费后即删除
    expect(store.poll(challenge.deviceCode, 'client-a')).toEqual({ status: 'expired' })
  })

  it('拒绝 → 轮询 denied；unknown deviceCode → expired', () => {
    const { store } = makeStore()
    const challenge = store.start('client-a', () => '')
    expect(store.resolve(challenge.deviceCode, false, () => ({ token: '', username: '' }))).toBe(
      true,
    )
    expect(store.poll(challenge.deviceCode, 'client-a')).toEqual({ status: 'denied' })
    expect(store.poll('no-such-code', 'client-a')).toEqual({ status: 'expired' })
  })

  it('过期：poll / peek / findByUserCode 都视为不存在', () => {
    const { store, clock } = makeStore()
    const challenge = store.start('client-a', () => '')
    clock.advance(10 * 60 * 1000 + 1)
    expect(store.poll(challenge.deviceCode, 'client-a')).toEqual({ status: 'expired' })
    expect(store.peek(challenge.deviceCode)).toBeUndefined()
    expect(store.findByUserCode(challenge.userCode)).toBeUndefined()
    // 过期后批复也无效
    expect(store.resolve(challenge.deviceCode, true, () => ({ token: '', username: '' }))).toBe(
      false,
    )
  })

  it('clientId 不匹配的轮询不算数（返回 expired，不泄露批准结果）', () => {
    const { store } = makeStore()
    const challenge = store.start('client-a', () => '')
    store.resolve(challenge.deviceCode, true, () => ({ token: 'ac-secret', username: 'alice' }))
    expect(store.poll(challenge.deviceCode, 'client-b')).toEqual({ status: 'expired' })
  })

  it('resolve 只对 pending 挑战生效：已批准 / 已拒绝后重复批复返回 false', () => {
    const { store } = makeStore()
    const challenge = store.start('client-a', () => '')
    expect(store.resolve(challenge.deviceCode, true, () => ({ token: 't', username: 'u' }))).toBe(
      true,
    )
    expect(store.resolve(challenge.deviceCode, false, () => ({ token: '', username: '' }))).toBe(
      false,
    )
  })

  it('peek 暴露 clientId（属主护栏预检用）', () => {
    const { store } = makeStore()
    const challenge = store.start('client-xyz', () => '')
    expect(store.peek(challenge.deviceCode)?.clientId).toBe('client-xyz')
  })

  it('formatUserCode：8 位折成 4+4', () => {
    expect(formatUserCode('ABCD1234')).toBe('ABCD-1234')
  })
})

/**
 * 挑战表清扫与上限（P2-13）：`start` 无需登录，原先既不 sweep 也没有上界 ——
 * 光刷这个端点就能让 Map 永续增长，而每条新 start 的撞码检查还要线性扫全表
 * （总量二次方放大，事件循环被拖垮）。
 */
describe('DeviceAuthStore · 挑战表清扫与上限（P2-13）', () => {
  it('start 开头就清扫过期挑战（不再只靠四个查询方法顺带扫）', () => {
    const { store, clock } = makeStore()
    store.start('client-a', () => '')
    expect(store.size).toBe(1)

    clock.advance(10 * 60 * 1000 + 1)
    store.start('client-b', () => '')
    // 旧的过期挑战已在 start 里被清掉，表里只剩刚建的这条
    expect(store.size).toBe(1)
  })

  it('超过上限时淘汰最旧（新挑战照常可发起，最旧的按 expired 处理）', () => {
    const clock = makeClock()
    const store = new DeviceAuthStore({ ttlMs: 10 * 60 * 1000, maxChallenges: 3, now: clock.now })
    const oldest = store.start('client-0', () => '')
    for (let i = 1; i < 3; i += 1) store.start(`client-${i}`, () => '')
    expect(store.size).toBe(3)

    const newest = store.start('client-new', () => '')
    expect(store.size).toBe(3)
    // 最旧的那条被淘汰：它的轮询与展示码查询都查不到了
    expect(store.poll(oldest.deviceCode, 'client-0')).toEqual({ status: 'expired' })
    expect(store.findByUserCode(oldest.userCode)).toBeUndefined()
    expect(store.poll(newest.deviceCode, 'client-new')).toEqual({ status: 'pending' })
  })

  it('默认上限是个正整数（生产口径常量）', () => {
    expect(DEVICE_MAX_CHALLENGES).toBeGreaterThan(0)
    const store = new DeviceAuthStore()
    expect(store.size).toBe(0)
  })
})
