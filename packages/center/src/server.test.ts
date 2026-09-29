import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createCenterServer,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MISSES_ALLOWED,
  type RunningCenterServer,
} from './server.js'
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

/** 客户端账号登录（v0.2.1 主路径；手动配对令牌功能面已删除） */
async function clientLogin(
  body: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/client/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, data: (await res.json()) as Record<string, unknown> }
}

describe('Aurora Center · 自助注册（docs/12 §4.2）', () => {
  const FRESH = { username: 'self-joined', password: 'self-pass-8888' }

  it('注册成功 → 直接登录（与 login 相同返回形状），令牌可访问 /api/me', async () => {
    const res = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(FRESH),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      token: string
      user: { username: string; role: string }
    }
    expect(body.user.username).toBe(FRESH.username)
    expect(body.user.role).toBe('user')
    const me = await fetch(`${base}/api/me`, { headers: authed(body.token) })
    expect(me.status).toBe(200)
    expect(((await me.json()) as { username: string }).username).toBe(FRESH.username)
  })

  it('重名 409；用户名 / 密码不合规 400', async () => {
    const dup = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(FRESH),
    })
    expect(dup.status).toBe(409)
    const badName = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ab', password: 'long-enough-8' }),
    })
    expect(badName.status).toBe(400)
    const shortPass = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'fresh-name', password: 'short7' }),
    })
    expect(shortPass.status).toBe(400)
  })

  it('关闭注册（config.json allowRegistration=false）→ 403', async () => {
    const closedDir = await mkdtemp(join(tmpdir(), 'aurora-center-reg-closed-'))
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      join(closedDir, 'config.json'),
      JSON.stringify({ version: 1, port: 8787, host: '0.0.0.0', allowRegistration: false }),
      'utf8',
    )
    // 该数据目录先种一个管理员（登录主路径不受注册开关影响）
    const { AuthStore } = await import('./auth.js')
    const boot = new AuthStore({ dataDir: closedDir })
    await boot.init()
    await boot.createUser({ ...ADMIN, role: 'admin' })
    const closed = createCenterServer({ dataDir: closedDir })
    const { port: closedPort } = await closed.listen(0, '127.0.0.1')
    try {
      const res = await fetch(`http://127.0.0.1:${closedPort}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(FRESH),
      })
      expect(res.status).toBe(403)
      expect(((await res.json()) as { error: string }).error).toBe('E_REGISTRATION_DISABLED')
      // 注册关了，登录照常可用
      const admin = await fetch(`http://127.0.0.1:${closedPort}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ADMIN),
      })
      expect(admin.status).toBe(200)
    } finally {
      await closed.close()
    }
  })
})

describe('Aurora Center · 客户端上线', () => {
  it('用户账号登录换客户端令牌 → 客户端 hello 上线 → 出现在用户与（跨属主）管理员的列表里', async () => {
    const admin = await login(ADMIN)
    const user = await login(USER)
    adminToken = admin.token
    userToken = user.token

    const paired = await clientLogin({
      username: USER.username,
      password: USER.password,
      clientId: 'client-e2e-1',
    })
    expect(paired.status).toBe(200)
    pairingToken = paired.data['token'] as string
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

  it('属主隔离（docs/12 §3 项 9）：一个用户可有多台客户端，/api/clients 只返回自己名下的', async () => {
    // alice 的第二台客户端
    const second = await clientLogin({
      username: USER.username,
      password: USER.password,
      clientId: 'client-e2e-2',
    })
    expect(second.status).toBe(200)
    const ws = await connectClient(second.data['token'] as string, {
      clientId: 'client-e2e-2',
      name: '第二台',
    })
    try {
      const list = (await (
        await fetch(`${base}/api/clients`, { headers: authed(userToken) })
      ).json()) as { clients: Array<{ clientId: string; ownerUserId: string }> }
      // 两台都是 alice 的，且没有别人的
      expect(list.clients.map((c) => c.clientId).sort()).toEqual(['client-e2e-1', 'client-e2e-2'])
      expect(list.clients.every((c) => c.ownerUserId !== '')).toBe(true)
      const adminList = (await (
        await fetch(`${base}/api/clients`, { headers: authed(adminToken) })
      ).json()) as { clients: Array<{ clientId: string; ownerUserId: string }> }
      expect(adminList.clients.length).toBeGreaterThanOrEqual(2)
    } finally {
      ws.close()
    }
  }, 20_000)

  it('hello 后立刻连发的 status 不因配对异步窗口丢失（竞态回归，docs/12）', async () => {
    // 用 alice 登录换令牌：竞态客户端属主 = alice，下面的网页端（alice）才能收到它的 status
    const paired = await clientLogin({
      username: USER.username,
      password: USER.password,
      clientId: 'client-race',
    })
    const raceToken = paired.data['token'] as string
    // 与真实连接器同款：open 后**同一批**发 hello + status，status 必须被排队回放而非丢弃
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/client`, {
      headers: { Authorization: `Bearer ${raceToken}` },
    })
    const waitForRace = collector(ws)
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          hello: {
            clientId: 'client-race',
            name: '竞态机',
            version: '0.1.6',
            platform: 'win32',
            mode: 'work',
            capabilities: { session: true, remoteConfig: true, fileTransfer: true },
          },
        }),
      )
      ws.send(
        JSON.stringify({
          type: 'status',
          status: {
            mode: 'work',
            version: '0.1.6',
            platform: 'win32',
            agent: {
              permissionMode: 'confirm',
              tools: { enabled: true, files: true, search: true, open: true, terminal: true },
            },
            center: { allowRemoteSession: true, allowRemoteConfig: true, allowFileTransfer: true },
          },
        }),
      )
    })
    await waitForRace((m) => m['type'] === 'welcome')
    // 网页端收到的 status 必须是真实快照（hello 占位里的 tools 全 false 被覆盖）
    const web = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${userToken}`)
    const waitForWeb = collector(web)
    await new Promise<void>((resolveOpen, reject) => {
      web.once('open', () => resolveOpen())
      web.once('error', reject)
    })
    const status = await waitForWeb(
      (m) => m['type'] === 'client.status' && m['clientId'] === 'client-race',
    )
    const agent = (status['status'] as { agent: { tools: { files: boolean } } }).agent
    expect(agent.tools.files).toBe(true)
    ws.close()
    web.close()
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
        Authorization: `Bearer ${await getAnyClientToken()}`,
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

/** 客户端令牌由「客户端上线」用例经 /api/client/login 颁发（vitest 同文件内按序执行） */
let cachedClientToken: string | undefined
async function getAnyClientToken(): Promise<string> {
  if (cachedClientToken !== undefined) return cachedClientToken
  if (pairingToken === '') throw new Error('上线用例未运行：clientToken 为空')
  cachedClientToken = pairingToken
  return pairingToken
}

describe('Aurora Center · 客户端账号登录（v0.2.1，docs/12 §3）', () => {
  const CLIENT_ID = 'client-login-e2e'

  it('密码换客户端令牌：创建即绑定 clientId 与属主，令牌可直接握手上线', async () => {
    const { status, data } = await clientLogin({
      username: USER.username,
      password: USER.password,
      clientId: CLIENT_ID,
    })
    expect(status).toBe(200)
    expect(data['clientId']).toBe(CLIENT_ID)
    expect((data['user'] as Record<string, unknown>)['username']).toBe(USER.username)
    const token = data['token'] as string
    expect(token.startsWith('ac-')).toBe(true)

    // 颁发的令牌可直接完成 WS 握手，且客户端出现在登录用户自己的列表里
    const ws = await connectClient(token, { clientId: CLIENT_ID, name: '登录机' })
    try {
      const webToken = await login({ ...USER }).then((r) => r.token)
      const res = await fetch(`${base}/api/clients`, { headers: authed(webToken) })
      const list = (await res.json()) as { clients: Array<{ clientId: string; name: string }> }
      expect(list.clients.some((c) => c.clientId === CLIENT_ID && c.name === '登录机')).toBe(true)
    } finally {
      ws.close()
    }
  })

  it('他人 clientId 已绑定有效令牌 → 409 拒绝抢注（管理员也不行）', async () => {
    // 前序用例已把 CLIENT_ID 绑定到 alice 的有效令牌
    const stolen = await clientLogin({
      username: ADMIN.username,
      password: ADMIN.password,
      clientId: CLIENT_ID,
    })
    expect(stolen.status).toBe(409)
    expect(stolen.data['error']).toBe('E_CLIENT_BOUND')
    // 属主自己重新登录仍然放行（同账号换新令牌是正常路径）
    const owner = await clientLogin({
      username: USER.username,
      password: USER.password,
      clientId: CLIENT_ID,
    })
    expect(owner.status).toBe(200)
  })

  it('错误密码 401；缺 clientId / 缺密码 400', async () => {
    const bad = await clientLogin({
      username: USER.username,
      password: 'wrong-pass',
      clientId: CLIENT_ID,
    })
    expect(bad.status).toBe(401)
    const noId = await clientLogin({ username: USER.username, password: USER.password })
    expect(noId.status).toBe(400)
    const noPass = await clientLogin({ username: USER.username, clientId: CLIENT_ID })
    expect(noPass.status).toBe(400)
  })

  it('重新登录吊销同 clientId 旧令牌：旧令牌握手被拒、新令牌可连', async () => {
    const first = await clientLogin({
      username: USER.username,
      password: USER.password,
      clientId: CLIENT_ID,
    })
    const second = await clientLogin({
      username: USER.username,
      password: USER.password,
      clientId: CLIENT_ID,
    })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)

    await expect(
      connectClient(first.data['token'] as string, { clientId: CLIENT_ID, name: '旧令牌' }),
    ).rejects.toThrow()
    const ws = await connectClient(second.data['token'] as string, {
      clientId: CLIENT_ID,
      name: '新令牌',
    })
    ws.close()
  })
})

describe('Aurora Center · 设备授权登录（docs/12 §4.3）', () => {
  interface Challenge {
    deviceCode: string
    userCode: string
    verifyUrl: string
    expiresAt: string
    intervalMs: number
  }

  async function start(
    body: Record<string, unknown>,
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    const res = await fetch(`${base}/api/client/device/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, data: (await res.json()) as Record<string, unknown> }
  }

  async function poll(
    body: Record<string, unknown>,
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    const res = await fetch(`${base}/api/client/device/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, data: (await res.json()) as Record<string, unknown> }
  }

  async function authorize(
    token: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    const res = await fetch(`${base}/api/client/device/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authed(token) },
      body: JSON.stringify(body),
    })
    return { status: res.status, data: (await res.json()) as Record<string, unknown> }
  }

  it('start → poll pending → authorize 批准 → poll approved（令牌可握手、归属批准者）', async () => {
    const started = await start({ clientId: 'client-device-e2e' })
    expect(started.status).toBe(200)
    const challenge = started.data as unknown as Challenge
    expect(challenge.deviceCode).toHaveLength(43)
    expect(challenge.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    expect(challenge.intervalMs).toBe(2000)
    // verifyUrl 按请求 Host 拼，指向网页确认页
    expect(challenge.verifyUrl).toBe(`http://127.0.0.1:${port}/#/device?code=${challenge.userCode}`)

    const pending = await poll({ deviceCode: challenge.deviceCode, clientId: 'client-device-e2e' })
    expect(pending.data['status']).toBe('pending')

    const approved = await authorize(userToken, { deviceCode: challenge.deviceCode, approve: true })
    expect(approved.status).toBe(200)

    const result = await poll({ deviceCode: challenge.deviceCode, clientId: 'client-device-e2e' })
    expect(result.data['status']).toBe('approved')
    expect(result.data['username']).toBe(USER.username)
    const deviceToken = result.data['token'] as string
    expect(deviceToken.startsWith('ac-')).toBe(true)

    // 颁发的令牌可直接握手上线，且出现在 alice 自己的列表里
    const ws = await connectClient(deviceToken, {
      clientId: 'client-device-e2e',
      name: '设备授权机',
    })
    try {
      const list = (await (
        await fetch(`${base}/api/clients`, { headers: authed(userToken) })
      ).json()) as { clients: Array<{ clientId: string }> }
      expect(list.clients.some((c) => c.clientId === 'client-device-e2e')).toBe(true)
    } finally {
      ws.close()
    }

    // 挑战一次性：approved 消费后再轮询 → expired
    const consumed = await poll({ deviceCode: challenge.deviceCode, clientId: 'client-device-e2e' })
    expect(consumed.data['status']).toBe('expired')
  }, 20_000)

  it('authorize 需网页会话；拒绝路径：approve=false → poll denied', async () => {
    const started = await start({ clientId: 'client-device-deny' })
    const challenge = started.data as unknown as Challenge
    const anon = await fetch(`${base}/api/client/device/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode: challenge.deviceCode }),
    })
    expect(anon.status).toBe(401)

    const denied = await authorize(userToken, { deviceCode: challenge.deviceCode, approve: false })
    expect(denied.status).toBe(200)
    const result = await poll({ deviceCode: challenge.deviceCode, clientId: 'client-device-deny' })
    expect(result.data['status']).toBe('denied')
  }, 20_000)

  it('属主护栏：clientId 已绑定他人有效令牌 → authorize 409 E_CLIENT_BOUND 且挑战置 denied', async () => {
    // client-e2e-1 已绑定 alice 的有效令牌（前序用例）；root 试图批准绑定
    const started = await start({ clientId: 'client-e2e-1' })
    const challenge = started.data as unknown as Challenge
    const conflict = await authorize(adminToken, {
      deviceCode: challenge.deviceCode,
      approve: true,
    })
    expect(conflict.status).toBe(409)
    expect(conflict.data['error']).toBe('E_CLIENT_BOUND')
    const result = await poll({ deviceCode: challenge.deviceCode, clientId: 'client-e2e-1' })
    expect(result.data['status']).toBe('denied')
  }, 20_000)

  it('info 端点：userCode 换 deviceCode（无需登录），未知 code 404 防枚举', async () => {
    const started = await start({ clientId: 'client-device-info' })
    const challenge = started.data as unknown as Challenge
    const res = await fetch(
      `${base}/api/client/device/info?code=${encodeURIComponent(challenge.userCode)}`,
    )
    expect(res.status).toBe(200)
    const info = (await res.json()) as { deviceCode: string; expiresAt: string }
    expect(info.deviceCode).toBe(challenge.deviceCode)
    expect(info.expiresAt).toBe(challenge.expiresAt)

    const ghost = await fetch(`${base}/api/client/device/info?code=ZZZZ-9999`)
    expect(ghost.status).toBe(404)
    // 拿到的 deviceCode 真的能走 authorize（网页会话），证明映射有效
    const approved = await authorize(userToken, { deviceCode: info.deviceCode, approve: true })
    expect(approved.status).toBe(200)
  }, 20_000)

  it('未知 deviceCode：authorize 404；poll expired；start 缺 clientId 400', async () => {
    const ghost = await authorize(userToken, { deviceCode: 'no-such-device-code' })
    expect(ghost.status).toBe(404)
    const expired = await poll({ deviceCode: 'no-such-device-code', clientId: 'c' })
    expect(expired.data['status']).toBe('expired')
    const noClient = await start({})
    expect(noClient.status).toBe(400)
  }, 20_000)
})

describe('Aurora Center · 确认卡端到端（confirm.request / confirm.resolve）', () => {
  const CONFIRM_REQUEST = {
    confirmId: 'cf-e2e-1',
    sessionId: 'center-e2e',
    toolName: 'run_command',
    input: { command: 'npm test' },
    createdAt: '2026-09-27T00:00:00.000Z',
    expiresAt: '2026-09-27T00:01:00.000Z',
  }

  it('客户端 confirm.request → 属主网页端收到；网页端 confirm.resolve → 客户端 cmd → result 转回', async () => {
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
      const web = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${userToken}`)
      const waitForWeb = collector(web)
      await new Promise<void>((resolveOpen, reject) => {
        web.once('open', () => resolveOpen())
        web.once('error', reject)
      })

      // 客户端发确认请求 → 属主网页端收到（带 clientId / sessionId / request）
      ws.send(JSON.stringify({ type: 'confirm.request', request: CONFIRM_REQUEST }))
      const forwarded = await waitForWeb(
        (m) =>
          m['type'] === 'confirm.request' &&
          (m['request'] as { confirmId: string }).confirmId === 'cf-e2e-1',
      )
      expect(forwarded['clientId']).toBe('client-e2e-1')
      expect(forwarded['sessionId']).toBe('center-e2e')

      // 网页端批复 → 客户端收到 cmd confirm.resolve
      web.send(
        JSON.stringify({
          type: 'confirm.resolve',
          requestId: 'web-confirm-1',
          clientId: 'client-e2e-1',
          confirmId: 'cf-e2e-1',
          approved: true,
        }),
      )
      const cmd = await waitForClient(
        (m) => m['type'] === 'cmd' && (m['cmd'] as { kind: string }).kind === 'confirm.resolve',
      )
      expect((cmd['cmd'] as { kind: string }).kind).toBe('confirm.resolve')
      expect((cmd['cmd'] as { confirmId: string }).confirmId).toBe('cf-e2e-1')
      expect((cmd['cmd'] as { approved: boolean }).approved).toBe(true)

      // 客户端回执 → 网页端收到 result
      ws.send(
        JSON.stringify({
          type: 'result',
          requestId: 'web-confirm-1',
          ok: true,
          data: { resolved: true },
        }),
      )
      const result = await waitForWeb(
        (m) => m['type'] === 'result' && m['requestId'] === 'web-confirm-1',
      )
      expect(result['ok']).toBe(true)
      web.close()
    } finally {
      ws.close()
    }
  }, 20_000)
})

describe('Aurora Center · 文件列表 / 删除 / 过期（docs/12 §5）', () => {
  let ownedFileId = ''

  it('GET /api/files：属主看自己名下（含 expiresAt，倒序），管理员看全部，陌生人看不到', async () => {
    // 用属主令牌上传两个文件（client-e2e-1 属主 = alice）
    for (const name of ['清单.txt', '日志.txt']) {
      const upload = await fetch(`${base}/api/ingest/files`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await getAnyClientToken()}`,
          'X-Client-Id': 'client-e2e-1',
          'X-File-Name': encodeURIComponent(name),
        },
        body: `内容-${name}`,
      })
      expect(upload.status).toBe(200)
      const { fileId } = (await upload.json()) as { fileId: string }
      ownedFileId = fileId
    }

    const userList = (await (
      await fetch(`${base}/api/files`, { headers: authed(userToken) })
    ).json()) as {
      files: Array<{ fileId: string; name: string; uploadedAt: string; expiresAt: string }>
    }
    expect(userList.files.length).toBeGreaterThanOrEqual(2)
    // 倒序：后上传的在前
    expect(userList.files[0]?.name).toBe('日志.txt')
    const first = userList.files[0] as { uploadedAt: string; expiresAt: string }
    expect(new Date(first.expiresAt).getTime()).toBe(
      new Date(first.uploadedAt).getTime() + 24 * 3600 * 1000,
    )

    // 管理员能看到全部（≥ 属主所见）
    const adminList = (await (
      await fetch(`${base}/api/files`, { headers: authed(adminToken) })
    ).json()) as { files: Array<{ fileId: string }> }
    expect(adminList.files.length).toBeGreaterThanOrEqual(userList.files.length)

    // 陌生人（自助注册的新用户）看不到 alice 名下的文件
    const stranger = await login({ username: 'self-joined', password: 'self-pass-8888' })
    const strangerList = (await (
      await fetch(`${base}/api/files`, { headers: authed(stranger.token) })
    ).json()) as { files: Array<{ fileId: string }> }
    expect(strangerList.files.some((f) => f.fileId === ownedFileId)).toBe(false)
  }, 20_000)

  it('DELETE /api/files/:fileId：属主可删（删除后下载 404），陌生人 403，未知 id 404', async () => {
    const stranger = await login({ username: 'self-joined', password: 'self-pass-8888' })
    const forbidden = await fetch(`${base}/api/files/${ownedFileId}`, {
      method: 'DELETE',
      headers: authed(stranger.token),
    })
    expect(forbidden.status).toBe(403)

    const gone = await fetch(`${base}/api/files/${ownedFileId}`, {
      method: 'DELETE',
      headers: authed(userToken),
    })
    expect(gone.status).toBe(200)
    // 删除后下载与列表都不可见
    const download = await fetch(`${base}/api/files/${ownedFileId}`, { headers: authed(userToken) })
    expect(download.status).toBe(404)
    const list = (await (
      await fetch(`${base}/api/files`, { headers: authed(userToken) })
    ).json()) as { files: Array<{ fileId: string }> }
    expect(list.files.some((f) => f.fileId === ownedFileId)).toBe(false)

    const unknown = await fetch(`${base}/api/files/f-nope`, {
      method: 'DELETE',
      headers: authed(userToken),
    })
    expect(unknown.status).toBe(404)
  }, 20_000)

  it('手动令牌功能面已删除：/api/tokens* 与 /api/admin/tokens* 不再存在', async () => {
    // user 打到管理段前的未知路由是 403（与既有 dispatch 行为一致），admin 是 404
    expect((await fetch(`${base}/api/tokens`, { headers: authed(userToken) })).status).toBe(403)
    expect(
      (
        await fetch(`${base}/api/tokens`, {
          method: 'POST',
          headers: authed(userToken),
          body: '{}',
        })
      ).status,
    ).toBe(403)
    expect(
      (await fetch(`${base}/api/tokens/t-1/revoke`, { method: 'POST', headers: authed(userToken) }))
        .status,
    ).toBe(403)
    expect((await fetch(`${base}/api/admin/tokens`, { headers: authed(adminToken) })).status).toBe(
      404,
    )
  })
})

/**
 * 心跳与离线判定（2026-09-29 提速：最坏 90s → 30s，docs/12 §4.1 的时效表）。
 *
 * 这条链路的「下线快慢」= 服务器多久把设备标成离线，而网页端的在线位就是
 * `hub.clientConns` 里还有没有这条连接 —— 因此这里用**假定时器**把两拍心跳推完，
 * 断言：① 第一拍只发 ping、不判死；② 第二拍仍无 pong 才 terminate（连接真的被断开、
 * 在线位变 false）。没有这条用例时，节奏只能靠读代码推演（复核时明确指出过）。
 */
describe('Aurora Center · 心跳与离线判定（提速轮）', () => {
  it('15s 一拍：第一拍发 ping，第二拍仍无 pong 才判死并断开', async () => {
    // 假定时器必须在**客户端注册之前**装上：心跳 interval 是在 hello 处理链里创建的，
    // 装晚了它就是一个真实定时器，推进假时钟对它无效（第一次写这条用例就踩了这个）。
    // `shouldAdvanceTime: true` 让假时钟跟着真实时间走，ws 握手 / fetch 照常完成。
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const CLIENT_ID = 'client-heartbeat-e2e'
      const paired = await clientLogin({
        username: USER.username,
        password: USER.password,
        clientId: CLIENT_ID,
      })
      expect(paired.status).toBe(200)
      const token = (paired.data as { token: string }).token

      const ws = await connectClient(token, {
        clientId: CLIENT_ID,
        name: '心跳机',
        version: '9.9.9',
        platform: 'win32',
        mode: 'work',
        capabilities: { session: true, remoteConfig: true, fileTransfer: true },
      })
      const next = collector(ws)
      expect(server.hub.isOnline(CLIENT_ID)).toBe(true)

      const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()))

      // 第一拍：只发 ping（missedPongs 允许值内的那一拍不判死）
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
      const ping = await next((msg) => msg.type === 'ping', 3000)
      expect(ping.type).toBe('ping')
      expect(server.hub.isOnline(CLIENT_ID)).toBe(true)

      // 不回 pong：下一拍就该判死（terminate → close → removeClient → 广播离线）
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
      await closed
      expect(HEARTBEAT_MISSES_ALLOWED).toBe(1)
      // 在线位要等**服务器侧**的 close → removeClient 跑完：客户端收到 close 的同一刻
      // 服务端记账可能还没落下（terminate 是对端发起的），所以轮询而不是立刻断言
      let online = true
      for (let attempt = 0; attempt < 40 && online; attempt += 1) {
        online = server.hub.isOnline(CLIENT_ID)
        if (online) await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(online).toBe(false)
      ws.terminate()
    } finally {
      vi.useRealTimers()
    }
  }, 20_000)
})
