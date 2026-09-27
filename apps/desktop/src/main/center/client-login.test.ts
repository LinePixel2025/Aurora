import { describe, expect, it } from 'vitest'
import { httpBaseUrlOf, requestClientLogin } from './client-login.js'

/** 假 fetch：按脚本返回（状态码 + JSON 体），并记录收到的请求 */
function fakeFetch(script: Array<{ status: number; body: unknown }>): {
  fetch: typeof fetch
  calls: Array<{ url: string; init: RequestInit }>
} {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fn = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit })
    const next = script.shift()
    if (next === undefined) throw new Error('脚本耗尽')
    return new Response(JSON.stringify(next.body), { status: next.status })
  }) as typeof fetch
  return { fetch: fn, calls }
}

describe('httpBaseUrlOf', () => {
  it('ws(s)/http(s) 统一换算成 http(s)；非法地址 undefined', () => {
    expect(httpBaseUrlOf('http://c.example:8787')).toBe('http://c.example:8787/')
    expect(httpBaseUrlOf('ws://c.example:8787/')).toBe('http://c.example:8787/')
    expect(httpBaseUrlOf('https://c.example')).toBe('https://c.example/')
    expect(httpBaseUrlOf('wss://c.example/sub')).toBe('https://c.example/sub')
    expect(httpBaseUrlOf('ftp://c.example')).toBeUndefined()
    expect(httpBaseUrlOf('不是地址')).toBeUndefined()
  })
})

describe('requestClientLogin', () => {
  const input = {
    serverUrl: 'http://120.24.223.65:8787',
    username: 'alice',
    password: 'secret-pass',
    clientId: 'client-1',
  }

  it('成功：POST 到 /api/client/login，返回令牌明文', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: { token: 'ac-tok', clientId: 'client-1', user: { id: 'u-1' } } },
    ])
    const outcome = await requestClientLogin(input, { fetchImpl: fetch })
    expect(outcome).toEqual({ ok: true, token: 'ac-tok', account: 'alice' })
    expect(calls[0]?.url).toBe('http://120.24.223.65:8787/api/client/login')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      username: 'alice',
      password: 'secret-pass',
      clientId: 'client-1',
    })
  })

  it('401：透出服务器给的错误文案', async () => {
    const { fetch } = fakeFetch([{ status: 401, body: { error: '用户名或口令不正确' } }])
    const outcome = await requestClientLogin(input, { fetchImpl: fetch })
    expect(outcome).toEqual({ ok: false, message: '登录失败：用户名或口令不正确' })
  })

  it('非 JSON 响应回退到 HTTP 状态码文案', async () => {
    const fn = (async () => new Response('<html>', { status: 502 })) as typeof fetch
    const outcome = await requestClientLogin(input, { fetchImpl: fn })
    expect(outcome).toEqual({ ok: false, message: '登录失败：HTTP 502' })
  })

  it('网络失败与超时给可读文案', async () => {
    const fail = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    expect(await requestClientLogin(input, { fetchImpl: fail })).toEqual({
      ok: false,
      message: '无法连接服务器：Error: ECONNREFUSED',
    })
    const hang = ((_input: unknown, init: unknown) => {
      return new Promise((_resolve, reject) => {
        ;(init as RequestInit).signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        )
      })
    }) as unknown as typeof fetch
    expect(await requestClientLogin(input, { fetchImpl: hang, timeoutMs: 30 })).toEqual({
      ok: false,
      message: '连接服务器超时（0 秒）',
    })
  })

  it('非法服务器地址直接失败，不发请求', async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: {} }])
    const outcome = await requestClientLogin(
      { ...input, serverUrl: 'ftp://x' },
      { fetchImpl: fetch },
    )
    expect(outcome.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })
})
