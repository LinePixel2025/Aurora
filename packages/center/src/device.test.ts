import { describe, expect, it } from 'vitest'
import { DeviceAuthStore, DEVICE_POLL_INTERVAL_MS, formatUserCode } from './device.js'

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
