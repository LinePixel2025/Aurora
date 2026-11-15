import { describe, expect, it } from 'vitest'
import { createVerify, generateKeyPairSync, verify as cryptoVerify, constants } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CENTER_PUSH_DEVICES_PER_USER } from '@aurora/shared'
import {
  AgcPushSender,
  DEFAULT_NOTIFICATION_PREFS,
  PUSH_PER_USER_PER_MINUTE,
  PushError,
  PushService,
  type PushNotification,
  type PushSender,
} from './push.js'
import { createSecretBox } from './secrets.js'

/** 假发送器：记录调用，可配置回执（无效 token 列表） */
function fakeSender(invalidTokens: string[] = []): PushSender & {
  calls: Array<{ tokens: string[]; notification: PushNotification }>
} {
  const calls: Array<{ tokens: string[]; notification: PushNotification }> = []
  return {
    calls,
    async send(tokens, notification) {
      calls.push({ tokens: [...tokens], notification })
      return { invalidTokens }
    },
  }
}

async function makePush(sender?: PushSender): Promise<{ push: PushService; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'aurora-center-push-'))
  const push = new PushService({
    dataDir: dir,
    secrets: createSecretBox('unit-test-secret'),
    ...(sender === undefined ? {} : { sender }),
  })
  await push.init()
  return { push, dir }
}

const CONFIRM: PushNotification = {
  kind: 'confirm',
  title: 'Aurora 请求确认',
  body: 'PC：敏感操作待批准',
  collapseKey: 'aurora-confirm-c1',
  ttlMs: 45_000,
  data: { kind: 'confirm', clientId: 'c1', sessionId: 'center-x', confirmId: 'cf1' },
}

describe('PushService · 登记与偏好（docs/12 §15.2）', () => {
  it('通道未配置时 register 回 E_PUSH_UNAVAILABLE；enabled + 注入发送器后可用', async () => {
    const sender = fakeSender()
    const { push } = await makePush(sender)
    expect(push.available).toBe(false)
    await expect(
      push.register('u1', 's1', { platform: 'harmony', token: 'tok-a' }),
    ).rejects.toMatchObject({ code: 'E_PUSH_UNAVAILABLE' })
    await push.updateConfig({ enabled: true })
    expect(push.available).toBe(true)
    const { id } = await push.register('u1', 's1', { platform: 'harmony', token: 'tok-a' })
    expect(id).not.toBe('')
  })

  it('同 token upsert（换会话重登不重复登记）；非法入参拒绝', async () => {
    const { push } = await makePush(fakeSender())
    await push.updateConfig({ enabled: true })
    const first = await push.register('u1', 's1', { platform: 'harmony', token: 'tok-a' })
    const second = await push.register('u1', 's2', {
      platform: 'harmony',
      token: 'tok-a',
      deviceName: '手机',
    })
    expect(second.id).toBe(first.id)
    await expect(
      push.register('u1', 's1', { platform: 'harmony', token: '' }),
    ).rejects.toBeInstanceOf(PushError)
    await expect(
      push.register('u1', 's1', { platform: 'android' as 'harmony', token: 'x' }),
    ).rejects.toMatchObject({ code: 'E_INVALID_ARGUMENT' })
  })

  it('每用户设备上限淘汰最旧；登出 / 删户级联清理', async () => {
    const sender = fakeSender()
    const { push } = await makePush(sender)
    await push.updateConfig({ enabled: true })
    for (let i = 0; i < CENTER_PUSH_DEVICES_PER_USER + 1; i += 1) {
      await push.register('u1', 's1', { platform: 'harmony', token: `tok-${i}` })
    }
    await push.register('u2', 's2', { platform: 'harmony', token: 'tok-other' })
    // u1 的第 0 台已被淘汰：给 u1 发通知只带 10 个 token
    push.notify(['u1'], CONFIRM)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sender.calls[0]?.tokens).toHaveLength(CENTER_PUSH_DEVICES_PER_USER)
    expect(sender.calls[0]?.tokens).not.toContain('tok-0')

    await push.unregisterSession('s2')
    push.notify(['u2'], CONFIRM)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sender.calls).toHaveLength(1) // u2 已无设备，不再发
    await push.unregisterUser('u1')
    push.notify(['u1'], CONFIRM)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sender.calls).toHaveLength(1)
  })

  it('偏好缺省 confirm/ask/file 开、sessionDone 关；部分更新合并；非法类型拒绝', async () => {
    const { push } = await makePush(fakeSender())
    expect(push.prefsOf('u1')).toEqual(DEFAULT_NOTIFICATION_PREFS)
    const merged = await push.setPrefs('u1', { sessionDone: true, confirm: false })
    expect(merged).toEqual({ confirm: false, ask: true, file: true, sessionDone: true })
    expect(push.prefsOf('u1').confirm).toBe(false)
    await expect(push.setPrefs('u1', { ask: 'yes' as unknown as boolean })).rejects.toMatchObject({
      code: 'E_INVALID_ARGUMENT',
    })
  })

  it('notify 按偏好过滤；回执判无效的 token 被剔除登记', async () => {
    const sender = fakeSender(['tok-bad'])
    const { push } = await makePush(sender)
    await push.updateConfig({ enabled: true })
    await push.register('u1', 's1', { platform: 'harmony', token: 'tok-bad' })
    await push.setPrefs('u2', { confirm: false })
    await push.register('u2', 's2', { platform: 'harmony', token: 'tok-u2' })
    push.notify(['u1', 'u2'], CONFIRM)
    await new Promise((resolve) => setTimeout(resolve, 20))
    // u2 关了 confirm 偏好 → 只有 u1 收到
    expect(sender.calls).toHaveLength(1)
    expect(sender.calls[0]?.tokens).toEqual(['tok-bad'])
    // 无效 token 已剔除：再发一次 u1 无设备可调
    push.notify(['u1'], CONFIRM)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sender.calls).toHaveLength(1)
  })

  it('每用户推送限速（超出丢弃，不影响其他用户）', async () => {
    const sender = fakeSender()
    const { push } = await makePush(sender)
    await push.updateConfig({ enabled: true })
    await push.register('u1', 's1', { platform: 'harmony', token: 'tok-1' })
    for (let i = 0; i < PUSH_PER_USER_PER_MINUTE + 5; i += 1) {
      push.notify(['u1'], { ...CONFIRM, collapseKey: `k-${i}` })
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sender.calls).toHaveLength(PUSH_PER_USER_PER_MINUTE)
  })

  it('管理端配置：私钥只写不回显；主密钥缺失时如实报错', async () => {
    const { push } = await makePush(fakeSender())
    const view = await push.updateConfig({
      enabled: true,
      projectId: 'proj-1',
      keyId: 'key-1',
      subAccount: 'sub-1',
      privateKey: '-----BEGIN PRIVATE KEY-----fake-----END PRIVATE KEY-----',
    })
    expect(view.keySet).toBe(true)
    expect(JSON.stringify(view)).not.toContain('fake')
    const cleared = await push.updateConfig({ privateKey: null })
    expect(cleared.keySet).toBe(false)
    // 空串 = 不动
    await push.updateConfig({ privateKey: 'pem-2' })
    expect((await push.updateConfig({ privateKey: '' })).keySet).toBe(true)

    const dir = await mkdtemp(join(tmpdir(), 'aurora-center-push-nosecret-'))
    const noSecret = new PushService({ dataDir: dir, secrets: createSecretBox(undefined) })
    await noSecret.init()
    expect(noSecret.adminConfig().error).toContain('AURORA_CENTER_SECRET')
    await expect(noSecret.updateConfig({ privateKey: 'pem' })).rejects.toMatchObject({
      code: 'E_SECRET_UNAVAILABLE',
    })
  })
})

describe('AgcPushSender · Push Kit v3（docs/12 §15.3）', () => {
  const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const privatePem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const publicPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString()

  interface Captured {
    url: string
    headers: Record<string, string>
    body: Record<string, unknown>
  }

  function fakeFetch(response: { code: string; msg?: string }): {
    fetchImpl: typeof fetch
    captured: Captured[]
  } {
    const captured: Captured[] = []
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      captured.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    return { fetchImpl, captured }
  }

  function makeSender(
    fetchImpl: typeof fetch,
    algorithm: 'RS256' | 'PS256' = 'RS256',
  ): AgcPushSender {
    return new AgcPushSender({
      projectId: 'proj-1',
      keyId: 'kid-1',
      subAccount: 'sub-1',
      privateKeyPem: privatePem,
      category: 'WORK',
      algorithm,
      fetchImpl,
    })
  }

  it('v3 端点 + push-type:0 + JWT 鉴权（RS256 签名可验证，claims 齐全）', async () => {
    const { fetchImpl, captured } = fakeFetch({ code: '80000000' })
    const sender = makeSender(fetchImpl)
    const result = await sender.send(['tok-1', 'tok-2'], CONFIRM)
    expect(result.invalidTokens).toEqual([])
    expect(captured).toHaveLength(1)
    const call = captured[0] as Captured
    expect(call.url).toBe('https://push-api.cloud.huawei.com/v3/proj-1/messages:send')
    expect(call.headers['push-type']).toBe('0')
    const jwt = (call.headers['Authorization'] ?? '').replace('Bearer ', '')
    const [headerB64, claimsB64, signatureB64] = jwt.split('.')
    const header = JSON.parse(Buffer.from(headerB64 as string, 'base64url').toString('utf8')) as {
      alg: string
      kid: string
    }
    const claims = JSON.parse(Buffer.from(claimsB64 as string, 'base64url').toString('utf8')) as {
      iss: string
      aud: string
      exp: number
      iat: number
    }
    expect(header.alg).toBe('RS256')
    expect(header.kid).toBe('kid-1')
    expect(claims.iss).toBe('sub-1')
    expect(claims.aud).toBe('https://oauth-login.cloud.huawei.com/oauth2/v3/token')
    expect(claims.exp - claims.iat).toBe(3600)
    const ok = createVerify('RSA-SHA256')
      .update(`${headerB64}.${claimsB64}`)
      .verify(publicPem, Buffer.from(signatureB64 as string, 'base64url'))
    expect(ok).toBe(true)
    // 消息体：notification + target.token + pushOptions（ttl 秒 / collapseKey 分组 / biTag）
    const body = call.body as {
      payload: { notification: Record<string, unknown> }
      target: { token: string[] }
      pushOptions: Record<string, unknown>
    }
    expect(body.payload.notification['category']).toBe('WORK')
    expect(body.payload.notification['clickAction']).toEqual({
      actionType: 0,
      data: CONFIRM.data,
    })
    expect(body.target.token).toEqual(['tok-1', 'tok-2'])
    expect(body.pushOptions['ttl']).toBe(45)
    expect(body.pushOptions['collapseKey']).toBe(1)
    expect(body.pushOptions['biTag']).toBe('aurora-confirm-c1')
  })

  it('PS256 可配（PSS 填充签名可验证）；JWT 缓存复用', async () => {
    const { fetchImpl, captured } = fakeFetch({ code: '80000000' })
    const sender = makeSender(fetchImpl, 'PS256')
    await sender.send(['tok-1'], CONFIRM)
    await sender.send(['tok-1'], { ...CONFIRM, kind: 'ask' })
    expect(captured).toHaveLength(2)
    const jwt = ((captured[0] as Captured).headers['Authorization'] ?? '').replace('Bearer ', '')
    const [headerB64, claimsB64, signatureB64] = jwt.split('.')
    const header = JSON.parse(Buffer.from(headerB64 as string, 'base64url').toString('utf8')) as {
      alg: string
    }
    expect(header.alg).toBe('PS256')
    const ok = cryptoVerify(
      'sha256',
      Buffer.from(`${headerB64}.${claimsB64}`),
      { key: publicPem, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
      Buffer.from(signatureB64 as string, 'base64url'),
    )
    expect(ok).toBe(true)
    // 1h 内复用同一 JWT
    expect((captured[1] as Captured).headers['Authorization']).toBe(
      (captured[0] as Captured).headers['Authorization'],
    )
  })

  it('80300007：按 msg.illegalTokens 剔除；其他错误码只记日志不剔', async () => {
    const invalid = fakeFetch({
      code: '80300007',
      msg: JSON.stringify({ failure: 1, illegalTokens: { noPushTypeRight: ['tok-bad'] } }),
    })
    const sender = makeSender(invalid.fetchImpl)
    const result = await sender.send(['tok-bad', 'tok-good'], CONFIRM)
    expect(result.invalidTokens).toEqual(['tok-bad'])

    const denied = fakeFetch({ code: '80300002', msg: 'no permission' })
    const deniedResult = await makeSender(denied.fetchImpl).send(['tok-1'], CONFIRM)
    expect(deniedResult.invalidTokens).toEqual([])
  })

  it('testMessage 标记进 pushOptions；data 超 1024 字节降级为最小路由集', async () => {
    const { fetchImpl, captured } = fakeFetch({ code: '80000000' })
    const sender = new AgcPushSender({
      projectId: 'p',
      keyId: 'k',
      subAccount: 's',
      privateKeyPem: privatePem,
      category: 'WORK',
      algorithm: 'RS256',
      testMessage: true,
      fetchImpl,
    })
    const bigData: Record<string, string> = {
      kind: 'confirm',
      clientId: 'c1',
      blob: 'x'.repeat(2000),
    }
    await sender.send(['tok-1'], { ...CONFIRM, data: bigData })
    const body = (captured[0] as Captured).body as {
      payload: { notification: { clickAction: { data: Record<string, string> } } }
      pushOptions: Record<string, unknown>
    }
    expect(body.pushOptions['testMessage']).toBe(true)
    expect(body.payload.notification.clickAction.data).toEqual({ kind: 'confirm', clientId: 'c1' })
  })

  it('网络失败不抛异常（返回空无效列表，主链路不受影响）', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const result = await makeSender(fetchImpl).send(['tok-1'], CONFIRM)
    expect(result.invalidTokens).toEqual([])
  })
})
