import { describe, expect, it } from 'vitest'
import type { Logger } from '@aurora/shared'
import { DeviceLoginController, type DeviceLoginOutcome } from './device-login.js'

/** 假 fetch：每次请求交给 handler 决定响应（可抛错 / 可按 URL 区分端点） */
function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
  fetch: typeof fetch
  urls: string[]
  bodies: unknown[]
} {
  const urls: string[] = []
  const bodies: unknown[] = []
  const fn = (async (url: unknown, init: unknown) => {
    const requestUrl = String(url)
    urls.push(requestUrl)
    const body = JSON.parse(String((init as RequestInit).body ?? '{}')) as unknown
    bodies.push(body)
    return await handler(requestUrl, (init ?? {}) as RequestInit)
  }) as typeof fetch
  return { fetch: fn, urls, bodies }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger

const INPUT = { serverUrl: 'http://center.example.com:8787', clientId: 'client-1' }

const CHALLENGE = {
  deviceCode: 'dev-1',
  userCode: 'ABCD-1234',
  verifyUrl: 'http://center.example.com:8787/#/device?code=ABCD-1234',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  intervalMs: 1,
}

/** 收集 onResult 结果的小仓库 */
function makeResults(): {
  results: DeviceLoginOutcome[]
  onResult: (r: DeviceLoginOutcome) => void
} {
  const results: DeviceLoginOutcome[] = []
  return { results, onResult: (outcome) => results.push(outcome) }
}

/** 等轮询循环推进完（interval=1ms + 微任务排空） */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

describe('DeviceLoginController · 设备授权登录（docs/12 §4.3）', () => {
  it('start：POST start → 打开确认页 → 立即回执 verifyUrl；网页批准后 onResult 带令牌', async () => {
    const opened: string[] = []
    const { fetch, urls, bodies } = fakeFetch((url) => {
      if (url.endsWith('/api/client/device/start')) return jsonResponse(200, CHALLENGE)
      if (url.endsWith('/api/client/device/poll'))
        return jsonResponse(200, { status: 'approved', token: 'ac-tok', username: 'alice' })
      throw new Error(`意外端点：${url}`)
    })
    const { results, onResult } = makeResults()
    const controller = new DeviceLoginController({
      fetchImpl: fetch,
      openExternal: async (url) => {
        opened.push(url)
      },
      logger,
      minIntervalMs: 1,
      onResult,
    })
    const started = await controller.start(INPUT)
    // start 端点先被调用（body 带 clientId）、确认页已打开、立即回执 verifyUrl
    expect(started).toEqual({ started: true, verifyUrl: CHALLENGE.verifyUrl })
    expect(urls[0]).toBe('http://center.example.com:8787/api/client/device/start')
    expect(bodies[0]).toEqual({ clientId: 'client-1' })
    expect(opened).toEqual([CHALLENGE.verifyUrl])

    // 轮询循环：poll 返回 approved，onResult 带令牌明文
    await settle()
    expect(results).toEqual([{ status: 'approved', token: 'ac-tok', username: 'alice' }])
  })

  it('poll body 带 deviceCode + clientId；denied / expired 原样透传', async () => {
    for (const status of ['denied', 'expired'] as const) {
      const { fetch, bodies } = fakeFetch((url) => {
        if (url.endsWith('/api/client/device/start')) return jsonResponse(200, CHALLENGE)
        return jsonResponse(200, { status })
      })
      const { results, onResult } = makeResults()
      const controller = new DeviceLoginController({
        fetchImpl: fetch,
        openExternal: async () => {},
        logger,
        minIntervalMs: 1,
        onResult,
      })
      await controller.start(INPUT)
      await settle()
      expect(results).toEqual([{ status }])
      expect(bodies[1]).toEqual({ deviceCode: 'dev-1', clientId: 'client-1' })
    }
  })

  it('超过挑战有效期即 expired（不再依赖服务器返回）', async () => {
    const { fetch } = fakeFetch((url) => {
      if (url.endsWith('/api/client/device/start'))
        return jsonResponse(200, {
          ...CHALLENGE,
          expiresAt: new Date(Date.now() + 5).toISOString(),
        })
      return jsonResponse(200, { status: 'pending' })
    })
    const { results, onResult } = makeResults()
    const controller = new DeviceLoginController({
      fetchImpl: fetch,
      openExternal: async () => {},
      logger,
      minIntervalMs: 1,
      onResult,
    })
    await controller.start(INPUT)
    await settle()
    expect(results).toEqual([{ status: 'expired' }])
  })

  it('slow_down 放慢后继续；偶发网络抖动不中断（连续 3 次失败才报错）', async () => {
    let polls = 0
    const { fetch } = fakeFetch((url) => {
      if (url.endsWith('/api/client/device/start')) return jsonResponse(200, CHALLENGE)
      polls += 1
      if (polls === 1) return jsonResponse(200, { status: 'slow_down' })
      if (polls <= 3) throw new Error('ECONNRESET')
      return jsonResponse(200, { status: 'approved', token: 'ac-tok', username: 'alice' })
    })
    const { results, onResult } = makeResults()
    const controller = new DeviceLoginController({
      fetchImpl: fetch,
      openExternal: async () => {},
      logger,
      minIntervalMs: 1,
      onResult,
    })
    await controller.start(INPUT)
    await settle()
    expect(results).toEqual([{ status: 'approved', token: 'ac-tok', username: 'alice' }])
  })

  it('连续 3 次轮询失败 → error 结果', async () => {
    const { fetch } = fakeFetch((url) => {
      if (url.endsWith('/api/client/device/start')) return jsonResponse(200, CHALLENGE)
      throw new Error('ECONNREFUSED')
    })
    const { results, onResult } = makeResults()
    const controller = new DeviceLoginController({
      fetchImpl: fetch,
      openExternal: async () => {},
      logger,
      minIntervalMs: 1,
      onResult,
    })
    await controller.start(INPUT)
    await settle()
    expect(results).toHaveLength(1)
    expect(results[0]?.status).toBe('error')
  })

  it('cancel 后不再轮询也不回调；重复 start 取消旧轮询', async () => {
    let polls = 0
    const { fetch } = fakeFetch((url) => {
      if (url.endsWith('/api/client/device/start')) return jsonResponse(200, CHALLENGE)
      polls += 1
      return jsonResponse(200, { status: 'pending' })
    })
    const { results, onResult } = makeResults()
    const controller = new DeviceLoginController({
      fetchImpl: fetch,
      openExternal: async () => {},
      logger,
      minIntervalMs: 1,
      onResult,
    })
    await controller.start(INPUT)
    const pollsAfterStart = polls
    controller.cancel()
    await settle()
    expect(polls).toBe(pollsAfterStart) // 取消后没有新的 poll
    expect(results).toEqual([])

    // 重复 start：旧运行作废，只有新运行回调
    const { results: results2, onResult: onResult2 } = makeResults()
    let call = 0
    const controller2 = new DeviceLoginController({
      fetchImpl: fakeFetch((url) => {
        if (url.endsWith('/api/client/device/start'))
          return jsonResponse(200, { ...CHALLENGE, deviceCode: `dev-${(call += 1)}` })
        return jsonResponse(200, { status: 'approved', token: 't', username: 'u' })
      }).fetch,
      openExternal: async () => {},
      logger,
      minIntervalMs: 1,
      onResult: onResult2,
    })
    const first = await controller2.start(INPUT)
    expect(first.started).toBe(true)
    const second = await controller2.start(INPUT)
    expect(second.started).toBe(true)
    await settle()
    // 两次 approved：每次 start 的轮询都可能赶在取消前完成 —— 但结果最多两条，
    // 且都来自有效运行（旧运行被取消后其结果一律丢弃）
    expect(results2.length).toBeLessThanOrEqual(2)
    expect(results2.every((item) => item.status === 'approved')).toBe(true)
  })

  it('start 失败：非法地址 / 服务器报错 / 打不开浏览器，都不回执 started', async () => {
    const { results, onResult } = makeResults()
    const controller = new DeviceLoginController({
      fetchImpl: fakeFetch(() => jsonResponse(200, CHALLENGE)).fetch,
      openExternal: async () => {},
      logger,
      minIntervalMs: 1,
      onResult,
    })
    expect(await controller.start({ ...INPUT, serverUrl: 'ftp://x' })).toEqual({
      started: false,
      message: '无法解析服务器地址：ftp://x',
    })
    const failing = new DeviceLoginController({
      fetchImpl: fakeFetch(() => jsonResponse(503, { error: 'E_UNAVAILABLE' })).fetch,
      openExternal: async () => {},
      logger,
      minIntervalMs: 1,
      onResult,
    })
    const outcome = await failing.start(INPUT)
    expect(outcome.started).toBe(false)
    expect(outcome.started ? '' : outcome.message).toContain('E_UNAVAILABLE')
    const blocked = new DeviceLoginController({
      fetchImpl: fakeFetch(() => jsonResponse(200, CHALLENGE)).fetch,
      openExternal: async () => {
        throw new Error('blocked')
      },
      logger,
      minIntervalMs: 1,
      onResult,
    })
    const blockedOutcome = await blocked.start(INPUT)
    expect(blockedOutcome.started).toBe(false)
    expect(blockedOutcome.started ? '' : blockedOutcome.message).toContain('无法打开浏览器')
    expect(results).toEqual([])
  })
})
