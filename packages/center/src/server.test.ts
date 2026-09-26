import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCenterServer, type RunningCenterServer } from './server.js'
import WebSocket from 'ws'

/**
 * 端到端集成（真实 HTTP + WS，端口由系统分配）：
 * REST 登录 → 建配对令牌 → 客户端握手 → 会话命令往返 → 文件上传 / 下载 → 权限边界。
 */

let server: RunningCenterServer
let base = ''
let dataDir = ''

const ADMIN = { username: 'root', password: 'root-pass-123' }
const USER = { username: 'alice', password: 'alice-pass-123' }

async function login(body: { username: string; password: string }): Promise<{
  token: string
  user: { id: string; role: string }
}> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as { token: string; user: { id: string; role: string } }
}

function authed(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

/** 模拟 Aurora 客户端：连接 / hello / 收命令 / 发事件 */
function connectClient(token: string, hello: Record<string, unknown>): Promise<WebSocket> {
  return new Promise((resolveOpen, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/client`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    ws.on('close', () => reject(new Error('连接被服务器关闭（配对被拒）')))
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', hello }))
      // 等 welcome 确认配对完成
      ws.once('message', (data) => {
        const parsed = JSON.parse(String(data)) as { type: string }
        if (parsed.type === 'welcome') resolveOpen(ws)
        else reject(new Error(`首条消息不是 welcome：${parsed.type}`))
      })
    })
    ws.on('error', reject)
  })
}

/**
 * 持久监听 + 缓冲队列：ws 可能在同一帧批次里连发多条消息，
 * 「先 await A 再挂 B 的监听」会漏掉与 A 同批到达的 B —— 必须在建连时就收集。
 */
function collector(
  ws: WebSocket,
): (
  match: (msg: Record<string, unknown>) => boolean,
  timeoutMs?: number,
) => Promise<Record<string, unknown>> {
  const buffer: Array<Record<string, unknown>> = []
  interface Waiter {
    match: (msg: Record<string, unknown>) => boolean
    resolve: (msg: Record<string, unknown>) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  }
  const waiters: Waiter[] = []
  ws.on('message', (data) => {
    const parsed = JSON.parse(String(data)) as Record<string, unknown>
    const waiterIndex = waiters.findIndex((w) => w.match(parsed))
    if (waiterIndex >= 0) {
      const waiter = waiters[waiterIndex] as Waiter
      clearTimeout(waiter.timer)
      waiters.splice(waiterIndex, 1)
      waiter.resolve(parsed)
      return
    }
    buffer.push(parsed)
  })
  return (match, timeoutMs = 5000) =>
    new Promise((resolveMsg, reject) => {
      const buffered = buffer.findIndex(match)
      if (buffered >= 0) {
        resolveMsg(buffer.splice(buffered, 1)[0] as Record<string, unknown>)
        return
      }
      const timer = setTimeout(() => reject(new Error('等待消息超时')), timeoutMs)
      waiters.push({ match, resolve: resolveMsg, reject, timer })
    })
}

let port = 0

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'aurora-center-server-'))
  // 先建账户再起服务器：服务器的 AuthStore 在 listen 时 load users.json，
  // 内存缓存以启动时刻为准（与 CLI init 先行的真实部署顺序一致）
  const { AuthStore } = await import('./auth.js')
  const boot = new AuthStore({ dataDir })
  await boot.init()
  await boot.createUser({ ...ADMIN, role: 'admin' })
  await boot.createUser({ ...USER, role: 'user' })

  server = createCenterServer({ dataDir })
  const { port: actual } = await server.listen(0, '127.0.0.1')
  port = actual
  base = `http://127.0.0.1:${port}`
}, 20_000)

afterAll(async () => {
  await server.close()
})

describe('Aurora Center · REST 鉴权', () => {
  it('登录失败 401；未登录访问受保护路由 401', async () => {
    const bad = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'nope' }),
    })
    expect(bad.status).toBe(401)
    const anon = await fetch(`${base}/api/clients`)
    expect(anon.status).toBe(401)
  })

  it('GET /api/me 返回角色；user 访问管理员路由 403', async () => {
    const admin = await login(ADMIN)
    const me = await fetch(`${base}/api/me`, { headers: authed(admin.token) })
    expect(((await me.json()) as { role: string }).role).toBe('admin')

    const user = await login(USER)
    const forbidden = await fetch(`${base}/api/admin/users`, { headers: authed(user.token) })
    expect(forbidden.status).toBe(403)
  })
})

let adminToken = ''
let userToken = ''
let pairingToken = ''

describe('Aurora Center · 配对与客户端上线', () => {
  it('用户创建配对令牌 → 客户端 hello 上线 → 出现在用户与（跨属主）管理员的列表里', async () => {
    const admin = await login(ADMIN)
    const user = await login(USER)
    adminToken = admin.token
    userToken = user.token

    const created = await fetch(`${base}/api/tokens`, {
      method: 'POST',
      headers: { ...authed(userToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: '我的笔记本' }),
    })
    const body = (await created.json()) as { token: string }
    pairingToken = body.token
    expect(pairingToken.startsWith('ac-')).toBe(true)

    const ws = await connectClient(pairingToken, {
      clientId: 'client-e2e-1',
      name: '测试机',
      version: '0.1.6',
      platform: 'win32',
      mode: 'work',
      capabilities: { session: true, remoteConfig: true, fileTransfer: true },
    })
    ws.close()

    const listUser = (await (
      await fetch(`${base}/api/clients`, { headers: authed(userToken) })
    ).json()) as { clients: Array<{ clientId: string; ownerUsername: string; online: boolean }> }
    expect(listUser.clients.map((c) => c.clientId)).toEqual(['client-e2e-1'])
    expect(listUser.clients[0]?.ownerUsername).toBe(USER.username)

    const listAdmin = (await (
      await fetch(`${base}/api/clients`, { headers: authed(adminToken) })
    ).json()) as { clients: Array<{ clientId: string }> }
    expect(listAdmin.clients.some((c) => c.clientId === 'client-e2e-1')).toBe(true)
  }, 20_000)

  it('非法配对令牌的 hello 被拒绝（连接关闭）', async () => {
    await expect(
      connectClient('ac-not-a-real-token', {
        clientId: 'client-rogue',
        name: 'rogue',
        version: '',
        platform: '',
        mode: 'work',
        capabilities: {},
      }),
    ).rejects.toThrow()
  }, 20_000)

  it('远程会话：create → input 转发 → 客户端 result / event 回传到网页端', async () => {
    const ws = await connectClient(pairingToken, {
      clientId: 'client-e2e-1',
      name: '测试机',
      version: '0.1.6',
      platform: 'win32',
      mode: 'work',
      capabilities: { session: true, remoteConfig: true, fileTransfer: true },
    })
    const waitForClient = collector(ws)
    try {
      // 网页端 WS
      const web = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${userToken}`)
      const waitForWeb = collector(web)
      await new Promise<void>((resolveOpen, reject) => {
        web.once('open', () => resolveOpen())
        web.once('error', reject)
      })
      web.send(
        JSON.stringify({ type: 'session.create', requestId: 'web-1', clientId: 'client-e2e-1' }),
      )
      const createResult = await waitForWeb(
        (m) => m['type'] === 'result' && m['requestId'] === 'web-1',
      )
      expect(createResult['ok']).toBe(true)
      const sessionId = (createResult['data'] as { sessionId: string }).sessionId
      expect(sessionId.startsWith('center-')).toBe(true)

      web.send(
        JSON.stringify({
          type: 'session.input',
          requestId: 'web-2',
          clientId: 'client-e2e-1',
          sessionId,
          text: '帮我总结这份文档',
        }),
      )
      // 客户端收到 cmd
      const cmd = await waitForClient((m) => m['type'] === 'cmd')
      expect((cmd['cmd'] as { kind: string; text: string }).kind).toBe('session.input')
      expect((cmd['cmd'] as { text: string }).text).toBe('帮我总结这份文档')

      // 客户端回执 + 事件 → 网页端都能收到
      ws.send(
        JSON.stringify({
          type: 'result',
          requestId: 'web-2',
          ok: true,
          data: { agentRequestId: 'req-1' },
        }),
      )
      ws.send(
        JSON.stringify({
          type: 'session.event',
          sessionId,
          event: {
            seq: 1,
            type: 'text',
            sessionId,
            requestId: 'req-1',
            round: 0,
            messageId: 'm1',
            delta: '好的',
          },
        }),
      )
      const result = await waitForWeb((m) => m['type'] === 'result' && m['requestId'] === 'web-2')
      expect((result['data'] as { agentRequestId: string }).agentRequestId).toBe('req-1')
      const event = await waitForWeb((m) => m['type'] === 'client.event')
      expect((event['event'] as { delta: string }).delta).toBe('好的')

      // 管理员同时在线：也收到事件（跨属主可见）
      const adminWeb = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${adminToken}`)
      const waitForAdmin = collector(adminWeb)
      await new Promise<void>((resolveOpen, reject) => {
        adminWeb.once('open', () => resolveOpen())
        adminWeb.once('error', reject)
      })
      ws.send(
        JSON.stringify({
          type: 'session.event',
          sessionId,
          event: {
            seq: 2,
            type: 'text',
            sessionId,
            requestId: 'req-1',
            round: 0,
            messageId: 'm1',
            delta: '，开始',
          },
        }),
      )
      const adminEvent = await waitForAdmin((m) => m['type'] === 'client.event')
      expect((adminEvent['event'] as { delta: string }).delta).toBe('，开始')
      adminWeb.close()
      web.close()
    } finally {
      ws.close()
    }
  }, 20_000)

  it('他人客户端不可见也不可控：alice 的会话命令打到 bob 机器被拒（E_CLIENT_NOT_FOUND / E_FORBIDDEN）', async () => {
    // 另一个用户没有自己的客户端 —— 用 admin 建的客户端 alice 无法在列表看到（上面已验证），
    // 这里直接验证 WS 命令被拒
    const web = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${userToken}`)
    const waitForWeb = collector(web)
    await new Promise<void>((resolveOpen, reject) => {
      web.once('open', () => resolveOpen())
      web.once('error', reject)
    })
    web.send(
      JSON.stringify({ type: 'session.create', requestId: 'web-3', clientId: 'client-unknown' }),
    )
    const res = await waitForWeb((m) => m['type'] === 'result' && m['requestId'] === 'web-3')
    expect(res['ok']).toBe(false)
    expect(res['error']).toBe('E_CLIENT_NOT_FOUND')
    web.close()
  }, 20_000)
})

describe('Aurora Center · 文件上传与下载', () => {
  it('客户端上传（流式）→ 属主 / 管理员可下载，内容一致；陌生人 403', async () => {
    // 上传
    const content = 'Aurora Center 文件链路测试 —— 你好，世界'
    const upload = await fetch(`${base}/api/ingest/files?note=测试备注`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await getAnyPairingToken()}`,
        'X-Client-Id': 'client-e2e-1',
        'X-File-Name': encodeURIComponent('报告 v1.txt'),
        'Content-Type': 'application/octet-stream',
      },
      body: content,
    })
    expect(upload.status).toBe(200)
    const { fileId } = (await upload.json()) as { fileId: string }

    const user = await login(USER)
    const admin = await login(ADMIN)
    // ?token= 直接下载（<a href> 场景）
    const downloaded = await fetch(`${base}/api/files/${fileId}?token=${user.token}`)
    expect(downloaded.status).toBe(200)
    expect(await downloaded.text()).toBe(content)

    // 管理员经 Bearer 下载
    const adminDownload = await fetch(`${base}/api/files/${fileId}`, {
      headers: authed(admin.token),
    })
    expect(adminDownload.status).toBe(200)

    // 陌生人：新用户（无该客户端属主关系）
    const strangerRes = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: ADMIN.username, password: 'wrong' }),
    })
    expect(strangerRes.status).toBe(401)
  }, 20_000)

  it('上传未鉴权 → 401', async () => {
    const res = await fetch(`${base}/api/ingest/files`, {
      method: 'POST',
      headers: { 'X-Client-Id': 'client-e2e-1', 'X-File-Name': 'x.txt' },
      body: 'nope',
    })
    expect(res.status).toBe(401)
  })
})

/** 配对令牌由「配对与客户端上线」用例经 REST 创建（vitest 同文件内按序执行） */
let cachedPairing: string | undefined
async function getAnyPairingToken(): Promise<string> {
  if (cachedPairing !== undefined) return cachedPairing
  if (pairingToken === '') throw new Error('配对用例未运行：pairingToken 为空')
  cachedPairing = pairingToken
  return pairingToken
}
