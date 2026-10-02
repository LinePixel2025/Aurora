import { describe, expect, it, vi } from 'vitest'
import { Hub, type ClientConn, type WebConn } from './hub.js'
import { ClientRegistry } from './clients.js'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClientStatus } from '@aurora/shared'

interface Harness {
  hub: Hub
  clients: ClientRegistry
  connectClient(clientId: string): { sent: unknown[]; conn: ClientConn }
  connectWeb(user: { id: string; username: string; role: 'admin' | 'user' }): {
    id: string
    sent: unknown[]
    conn: WebConn
  }
}

/**
 * 网页连接 id 用模块级自增：`hub.registerWeb` 以 id 为键，同一用户连两条（两个页签）
 * 不能共用 id，否则第二条会把第一条从 `webConns` 里顶掉（多页签场景的用例需要它们共存）。
 */
let webConnSeq = 0

async function makeHub(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'aurora-center-hub-'))
  const clients = new ClientRegistry({ dataDir: dir })
  await clients.init()
  const hub = new Hub({
    clients,
    usernameOf: (id) => (id === 'u-admin' ? 'root' : `user-${id}`),
    serverVersion: () => '0.0.0-test',
  })
  return {
    hub,
    clients,
    connectClient(clientId) {
      const sent: unknown[] = []
      const conn: ClientConn = {
        clientId,
        send: (m) => sent.push(m),
        close: () => {},
      }
      hub.registerClient(conn, STATUS)
      return { sent, conn }
    },
    connectWeb(user) {
      webConnSeq += 1
      const sent: unknown[] = []
      const conn: WebConn = {
        id: `w-${webConnSeq}`,
        user,
        send: (m) => sent.push(m),
      }
      hub.registerWeb(conn)
      return { id: conn.id, sent, conn }
    },
  }
}

const STATUS: ClientStatus = {
  mode: 'work',
  version: '0.1.6',
  platform: 'win32',
  agent: {
    permissionMode: 'confirm',
    tools: { enabled: true, files: true, search: true, open: true, terminal: true },
  },
  center: { allowRemoteSession: true, allowRemoteConfig: true, allowFileTransfer: true },
  llm: { activeProviderId: 'p1', model: 'model-1', reasoningEffort: 'medium' },
}

async function seedClient(harness: Harness, clientId: string, ownerUserId: string): Promise<void> {
  await harness.clients.upsert({
    clientId,
    name: clientId,
    ownerUserId,
    version: '0.1.6',
    platform: 'win32',
    mode: 'work',
  })
}

describe('Hub · 会话命令路由', () => {
  it('session.create 分配 center- 前缀会话并记账属主；事件只回属主与管理员', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c1', 'u1')
    harness.connectClient('c1')
    const owner = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    const stranger = harness.connectWeb({ id: 'u2', username: 'u2', role: 'user' })
    const admin = harness.connectWeb({ id: 'u-admin', username: 'root', role: 'admin' })
    // 清掉注册快照，只看后续消息
    owner.sent.length = 0
    stranger.sent.length = 0
    admin.sent.length = 0

    harness.hub.handleWebMessage({ ...owner.conn, id: owner.id } as WebConn, {
      type: 'session.create',
      requestId: 'web-1',
      clientId: 'c1',
    })
    const result = owner.sent.at(-1) as { type: string; ok: boolean; data: { sessionId: string } }
    expect(result.ok).toBe(true)
    expect(result.data.sessionId.startsWith('center-')).toBe(true)

    // 客户端回事件 → 属主与管理员收到，陌生人收不到
    const event = {
      seq: 1,
      type: 'user-message',
      sessionId: result.data.sessionId,
      requestId: 'r',
      content: 'hi',
      createdAt: 0,
    } as never
    harness.hub.handleClientMessage('c1', {
      type: 'session.event',
      sessionId: result.data.sessionId,
      event,
    })
    expect(
      stranger.sent.filter((m) => (m as { type: string }).type === 'client.event'),
    ).toHaveLength(0)
    const ownerEvents = owner.sent.filter((m) => (m as { type: string }).type === 'client.event')
    const adminEvents = admin.sent.filter((m) => (m as { type: string }).type === 'client.event')
    expect(ownerEvents).toHaveLength(1)
    expect(adminEvents).toHaveLength(1)
  })

  it('陌生用户对自己名下之外的客户端发命令 → E_FORBIDDEN；未登记客户端 → E_CLIENT_NOT_FOUND', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c1', 'u1')
    harness.connectClient('c1')
    const stranger = harness.connectWeb({ id: 'u2', username: 'u2', role: 'user' })
    stranger.sent.length = 0

    harness.hub.handleWebMessage(stranger.conn, {
      type: 'session.input',
      requestId: 'web-2',
      clientId: 'c1',
      sessionId: 'center-x',
      text: 'hi',
    })
    expect((stranger.sent.at(-1) as { error?: string }).error).toBe('E_FORBIDDEN')

    harness.hub.handleWebMessage(stranger.conn, {
      type: 'session.input',
      requestId: 'web-3',
      clientId: 'ghost',
      sessionId: 'center-x',
      text: 'hi',
    })
    expect((stranger.sent.at(-1) as { error?: string }).error).toBe('E_CLIENT_NOT_FOUND')
  })

  it('离线客户端回 E_CLIENT_OFFLINE；回执按 requestId 路由回发起方', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c-off', 'u1')
    const owner = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    owner.sent.length = 0

    harness.hub.handleWebMessage(owner.conn, {
      type: 'config.get',
      requestId: 'web-4',
      clientId: 'c-off',
    })
    expect((owner.sent.at(-1) as { error?: string }).error).toBe('E_CLIENT_OFFLINE')

    // 在线后转发并回传回执
    const client = harness.connectClient('c-off')
    client.sent.length = 0
    harness.hub.handleWebMessage(owner.conn, {
      type: 'config.get',
      requestId: 'web-5',
      clientId: 'c-off',
    })
    const forwarded = client.sent.at(-1) as {
      type: string
      cmd: { kind: string; requestId: string }
    }
    expect(forwarded.cmd.kind).toBe('config.get')
    harness.hub.handleClientMessage('c-off', {
      type: 'result',
      requestId: 'web-5',
      ok: true,
      data: { redacted: true },
    })
    const result = owner.sent.at(-1) as { type: string; ok: boolean; data?: unknown }
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({ redacted: true })
  })

  it('config.update 白名单预检：白名单外整条拒绝，不转发', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c1', 'u1')
    const client = harness.connectClient('c1')
    client.sent.length = 0
    const owner = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    owner.sent.length = 0

    harness.hub.handleWebMessage(owner.conn, {
      type: 'config.update',
      requestId: 'web-6',
      clientId: 'c1',
      patch: { 'modes.current': 'code', 'llm.active': 'evil' },
    })
    const result = owner.sent.at(-1) as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    expect(result.error).toContain('E_FORBIDDEN_PATH')
    expect(client.sent).toHaveLength(0)

    owner.sent.length = 0
    harness.hub.handleWebMessage(owner.conn, {
      type: 'config.update',
      requestId: 'web-7',
      clientId: 'c1',
      patch: { 'agent.tools.enabled': false },
    })
    expect(client.sent).toHaveLength(1)
  })

  it('回执超时：15s 后向网页端合成 E_CLIENT_TIMEOUT', async () => {
    vi.useFakeTimers()
    try {
      const harness = await makeHub()
      await seedClient(harness, 'c1', 'u1')
      harness.connectClient('c1')
      const owner = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
      owner.sent.length = 0
      harness.hub.handleWebMessage(owner.conn, {
        type: 'config.get',
        requestId: 'web-8',
        clientId: 'c1',
      })
      await vi.advanceTimersByTimeAsync(16_000)
      const result = owner.sent.at(-1) as { ok: boolean; error?: string }
      expect(result.ok).toBe(false)
      expect(result.error).toBe('E_CLIENT_TIMEOUT')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Hub · 确认卡路由（confirm.request / confirm.resolve）', () => {
  const CONFIRM_REQUEST = {
    confirmId: 'cf-1',
    sessionId: 'center-abc',
    toolName: 'run_command',
    input: { command: 'npm test' },
    createdAt: '2026-09-27T00:00:00.000Z',
    expiresAt: '2026-09-27T00:01:00.000Z',
  }

  it('confirm.request 转发给属主 + 管理员，陌生人不收；未登记客户端忽略', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c1', 'u1')
    harness.connectClient('c1')
    const owner = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    const stranger = harness.connectWeb({ id: 'u2', username: 'u2', role: 'user' })
    const admin = harness.connectWeb({ id: 'u-admin', username: 'root', role: 'admin' })
    owner.sent.length = stranger.sent.length = admin.sent.length = 0

    harness.hub.handleClientMessage('c1', { type: 'confirm.request', request: CONFIRM_REQUEST })
    const ownerMsgs = owner.sent.filter((m) => (m as { type: string }).type === 'confirm.request')
    const adminMsgs = admin.sent.filter((m) => (m as { type: string }).type === 'confirm.request')
    expect(ownerMsgs).toHaveLength(1)
    expect(adminMsgs).toHaveLength(1)
    expect(stranger.sent).toHaveLength(0)
    const forwarded = ownerMsgs[0] as {
      clientId: string
      sessionId: string
      request: { confirmId: string }
    }
    expect(forwarded.clientId).toBe('c1')
    expect(forwarded.sessionId).toBe('center-abc')
    expect(forwarded.request.confirmId).toBe('cf-1')

    // 未登记的客户端发确认请求 → 无路由目标，静默忽略
    expect(() =>
      harness.hub.handleClientMessage('c-ghost', {
        type: 'confirm.request',
        request: CONFIRM_REQUEST,
      }),
    ).not.toThrow()
    expect(
      admin.sent.filter((m) => (m as { type: string }).type === 'confirm.request'),
    ).toHaveLength(1)
  })

  it('confirm.resolve 转发为 cmd 给客户端，result 回执按 requestId 转回网页端', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c1', 'u1')
    const client = harness.connectClient('c1')
    client.sent.length = 0
    const owner = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    owner.sent.length = 0

    harness.hub.handleWebMessage(owner.conn, {
      type: 'confirm.resolve',
      requestId: 'web-10',
      clientId: 'c1',
      confirmId: 'cf-1',
      approved: true,
    })
    const forwarded = client.sent.at(-1) as {
      type: string
      cmd: { kind: string; requestId: string; confirmId: string; approved: boolean }
    }
    expect(forwarded.cmd.kind).toBe('confirm.resolve')
    expect(forwarded.cmd.confirmId).toBe('cf-1')
    expect(forwarded.cmd.approved).toBe(true)

    // 客户端 result 回执走通用 pending 通道转回网页端
    harness.hub.handleClientMessage('c1', {
      type: 'result',
      requestId: 'web-10',
      ok: true,
      data: { confirmed: true },
    })
    const result = owner.sent.at(-1) as { type: string; ok: boolean; data?: unknown }
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({ confirmed: true })
  })

  it('confirm.resolve 属主校验：非属主拒绝；客户端离线回 E_CLIENT_OFFLINE', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c1', 'u1')
    harness.connectClient('c1')
    const stranger = harness.connectWeb({ id: 'u2', username: 'u2', role: 'user' })
    stranger.sent.length = 0
    harness.hub.handleWebMessage(stranger.conn, {
      type: 'confirm.resolve',
      requestId: 'web-11',
      clientId: 'c1',
      confirmId: 'cf-1',
      approved: false,
    })
    expect((stranger.sent.at(-1) as { error?: string }).error).toBe('E_FORBIDDEN')

    const owner = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    owner.sent.length = 0
    harness.hub.removeClient('c1')
    harness.hub.handleWebMessage(owner.conn, {
      type: 'confirm.resolve',
      requestId: 'web-12',
      clientId: 'c1',
      confirmId: 'cf-1',
      approved: true,
    })
    expect((owner.sent.at(-1) as { error?: string }).error).toBe('E_CLIENT_OFFLINE')
  })
})

describe('Hub · 提问卡路由（ask.request / ask.resolve，v0.3.3）', () => {
  const ASK_REQUEST = {
    requestId: 'ask-1',
    sessionId: 'center-abc',
    question: '把产物放哪个目录？',
    header: '目标目录',
    options: [{ label: 'dist' }, { label: 'out', description: '自定义输出' }],
    multiSelect: false,
    expiresAt: Date.now() + 180_000,
  }

  it('ask.request 转发给属主 + 管理员，陌生人不收；畸形帧与未登记客户端都不抛', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c1', 'u1')
    harness.connectClient('c1')
    const owner = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    const stranger = harness.connectWeb({ id: 'u2', username: 'u2', role: 'user' })
    const admin = harness.connectWeb({ id: 'u-admin', username: 'root', role: 'admin' })
    owner.sent.length = stranger.sent.length = admin.sent.length = 0

    harness.hub.handleClientMessage('c1', { type: 'ask.request', request: ASK_REQUEST })
    const ownerMsgs = owner.sent.filter((m) => (m as { type: string }).type === 'ask.request')
    const adminMsgs = admin.sent.filter((m) => (m as { type: string }).type === 'ask.request')
    expect(ownerMsgs).toHaveLength(1)
    expect(adminMsgs).toHaveLength(1)
    expect(stranger.sent).toHaveLength(0)
    const forwarded = ownerMsgs[0] as {
      clientId: string
      sessionId: string
      request: { requestId: string; question: string; multiSelect: boolean }
    }
    expect(forwarded.clientId).toBe('c1')
    expect(forwarded.sessionId).toBe('center-abc')
    expect(forwarded.request.requestId).toBe('ask-1')
    expect(forwarded.request.question).toBe('把产物放哪个目录？')
    expect(forwarded.request.multiSelect).toBe(false)

    // 缺 request 的畸形帧（P1-02 同族）：必须静默丢弃，不能抛 TypeError 逃出监听器
    expect(() =>
      harness.hub.handleClientMessage('c1', { type: 'ask.request' } as never),
    ).not.toThrow()
    expect(admin.sent.filter((m) => (m as { type: string }).type === 'ask.request')).toHaveLength(1)

    // 未登记的客户端 → 无路由目标，静默忽略
    expect(() =>
      harness.hub.handleClientMessage('c-ghost', { type: 'ask.request', request: ASK_REQUEST }),
    ).not.toThrow()
  })

  it('未过期的提问在新网页连上时回放；过期项入站即丢且不回放', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c1', 'u1')
    harness.connectClient('c1')
    const owner = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    owner.sent.length = 0
    harness.hub.handleClientMessage('c1', { type: 'ask.request', request: ASK_REQUEST })
    harness.hub.handleClientMessage('c1', {
      type: 'ask.request',
      request: { ...ASK_REQUEST, requestId: 'ask-old', expiresAt: Date.now() - 1 },
    })
    expect(owner.sent.filter((m) => (m as { type: string }).type === 'ask.request')).toHaveLength(1)

    // 新页签（用户刷新页面）连上：未过期的那条被回放
    const refreshed = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    const replayed = refreshed.sent.filter((m) => (m as { type: string }).type === 'ask.request')
    expect(replayed).toHaveLength(1)
    expect((replayed[0] as { request: { requestId: string } }).request.requestId).toBe('ask-1')
    // 陌生人的新页签不收
    const stranger = harness.connectWeb({ id: 'u2', username: 'u2', role: 'user' })
    expect(
      stranger.sent.filter((m) => (m as { type: string }).type === 'ask.request'),
    ).toHaveLength(0)
  })

  it('ask.resolve 转发为 cmd 并从待答表摘除；result 回执转回网页端', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c1', 'u1')
    const client = harness.connectClient('c1')
    client.sent.length = 0
    const owner = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    owner.sent.length = 0
    harness.hub.handleClientMessage('c1', { type: 'ask.request', request: ASK_REQUEST })

    // 更正 requestId 语义：ask.resolve 的 requestId **就是提问卡 id**（客户端分配），
    // 不是网页端新生成的命令 id —— 回执也用它关联（见 protocol.ts 的注释）。
    harness.hub.handleWebMessage(owner.conn, {
      type: 'ask.resolve',
      requestId: 'ask-1',
      clientId: 'c1',
      sessionId: 'center-abc',
      answers: ['dist'],
      answersByQuestion: [['dist'], ['nvidia', 'cuda']],
    })
    const forwarded = client.sent.at(-1) as {
      type: string
      cmd: {
        kind: string
        requestId: string
        sessionId: string
        answers: string[]
        answersByQuestion?: string[][]
        skipped?: boolean
      }
    }
    expect(forwarded.cmd.kind).toBe('ask.resolve')
    expect(forwarded.cmd.requestId).toBe('ask-1')
    expect(forwarded.cmd.sessionId).toBe('center-abc')
    expect(forwarded.cmd.answers).toEqual(['dist'])
    expect(forwarded.cmd.answersByQuestion).toEqual([['dist'], ['nvidia', 'cuda']])
    expect(forwarded.cmd.skipped).toBeUndefined()

    // 已作答 → 摘除；后续连上的页签不再回放
    const later = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    expect(later.sent.filter((m) => (m as { type: string }).type === 'ask.request')).toHaveLength(0)

    // 客户端 result（{ settled }）走通用 pending 通道转回网页端
    harness.hub.handleClientMessage('c1', {
      type: 'result',
      requestId: 'ask-1',
      ok: true,
      data: { settled: false },
    })
    const result = owner.sent.at(-1) as { type: string; ok: boolean; data?: unknown }
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({ settled: false })
  })

  it('ask.resolve 属主校验与离线判定同其他命令（非属主 E_FORBIDDEN、离线 E_CLIENT_OFFLINE）', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c1', 'u1')
    harness.connectClient('c1')
    const stranger = harness.connectWeb({ id: 'u2', username: 'u2', role: 'user' })
    stranger.sent.length = 0
    harness.hub.handleWebMessage(stranger.conn, {
      type: 'ask.resolve',
      requestId: 'web-21',
      clientId: 'c1',
      sessionId: 'center-abc',
      answers: ['dist'],
    })
    expect((stranger.sent.at(-1) as { error?: string }).error).toBe('E_FORBIDDEN')

    const owner = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    owner.sent.length = 0
    harness.hub.removeClient('c1')
    harness.hub.handleWebMessage(owner.conn, {
      type: 'ask.resolve',
      requestId: 'web-22',
      clientId: 'c1',
      sessionId: 'center-abc',
      answers: ['dist'],
    })
    expect((owner.sent.at(-1) as { error?: string }).error).toBe('E_CLIENT_OFFLINE')
  })

  it('ask.resolve 的畸形 answersByQuestion 清洗为 undefined 不下发（stringMatrixOf）', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c1', 'u1')
    const client = harness.connectClient('c1')
    client.sent.length = 0
    const owner = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    owner.sent.length = 0

    const send = (answersByQuestion: unknown) =>
      harness.hub.handleWebMessage(owner.conn, {
        type: 'ask.resolve',
        requestId: 'ask-x',
        clientId: 'c1',
        sessionId: 'center-abc',
        answers: ['x'],
        ...(answersByQuestion === undefined ? {} : { answersByQuestion }),
      } as Parameters<typeof harness.hub.handleWebMessage>[0])

    // 非数组 / 元素非数组 / 组内含非字符串：整体丢弃
    for (const bad of ['x', {}, [['a'], 3], [['a', 1]]]) {
      client.sent.length = 0
      send(bad)
      const forwarded = client.sent.at(-1) as {
        cmd: { answersByQuestion?: string[][] }
      }
      expect('answersByQuestion' in forwarded.cmd).toBe(false)
    }

    // 合法矩阵照常下发
    send([['a'], ['b', 'c']])
    const forwarded = client.sent.at(-1) as { cmd: { answersByQuestion?: string[][] } }
    expect(forwarded.cmd.answersByQuestion).toEqual([['a'], ['b', 'c']])
  })

  it('registerClient 重连时保留上一轮的 voice 能力位（hello 占位快照不含它）', async () => {
    const harness = await makeHub()
    const withVoice: ClientStatus = { ...STATUS, voice: { stt: true, tts: false } }
    harness.hub.registerClient({ clientId: 'c1', send: () => {}, close: () => {} }, withVoice)
    harness.hub.handleClientMessage('c1', { type: 'status', status: withVoice })
    expect(harness.hub.getStatus('c1')?.voice).toEqual({ stt: true, tts: false })

    // 重连：hello 派生的占位快照（无 voice）不得把能力位抹掉
    harness.hub.registerClient({ clientId: 'c1', send: () => {}, close: () => {} }, STATUS)
    expect(harness.hub.getStatus('c1')?.voice).toEqual({ stt: true, tts: false })

    // 真 status 到达后按新值刷新（用户重连前关掉了语音）
    harness.hub.handleClientMessage('c1', {
      type: 'status',
      status: { ...STATUS, voice: { stt: false, tts: false } },
    })
    expect(harness.hub.getStatus('c1')?.voice).toEqual({ stt: false, tts: false })

    // 从未上报过 voice 的客户端（旧版）重连后依旧没有该字段（不凭空造 true）
    harness.hub.registerClient({ clientId: 'c2', send: () => {}, close: () => {} }, STATUS)
    harness.hub.registerClient(
      { clientId: 'c2', send: () => {}, close: () => {} },
      { ...STATUS, mode: 'classroom' },
    )
    expect(harness.hub.getStatus('c2')?.voice).toBeUndefined()
    expect(harness.hub.getStatus('c2')?.mode).toBe('classroom')
  })
})

describe('Hub · 状态与文件通知', () => {
  it('clients 快照按角色过滤：user 只见自己的，admin 见全部；在线状态准确', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c1', 'u1')
    await seedClient(harness, 'c2', 'u2')
    harness.connectClient('c1')

    const u1 = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    const admin = harness.connectWeb({ id: 'u-admin', username: 'root', role: 'admin' })
    const u1Snap = u1.sent.filter((m) => (m as { type: string }).type === 'clients').at(-1) as {
      clients: Array<{ clientId: string; online: boolean; ownerUsername: string }>
    }
    const adminSnap = admin.sent
      .filter((m) => (m as { type: string }).type === 'clients')
      .at(-1) as {
      clients: Array<{ clientId: string; online: boolean }>
    }
    expect(u1Snap.clients.map((c) => c.clientId)).toEqual(['c1'])
    expect(u1Snap.clients[0]?.online).toBe(true)
    expect(u1Snap.clients[0]?.ownerUsername).toBe('user-u1')
    expect(adminSnap.clients).toHaveLength(2)
    expect(adminSnap.clients.find((c) => c.clientId === 'c2')?.online).toBe(false)
  })

  it('file.received 发给属主与管理员，不发给其他用户', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c1', 'u1')
    const owner = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    const stranger = harness.connectWeb({ id: 'u2', username: 'u2', role: 'user' })
    const admin = harness.connectWeb({ id: 'u-admin', username: 'root', role: 'admin' })
    owner.sent.length = stranger.sent.length = admin.sent.length = 0

    harness.hub.broadcastFileReceived(
      { fileId: 'f-1', clientId: 'c1', name: 'report.pdf', size: 12, at: new Date().toISOString() },
      'u1',
    )
    expect(owner.sent.filter((m) => (m as { type: string }).type === 'file.received')).toHaveLength(
      1,
    )
    expect(admin.sent.filter((m) => (m as { type: string }).type === 'file.received')).toHaveLength(
      1,
    )
    expect(
      stranger.sent.filter((m) => (m as { type: string }).type === 'file.received'),
    ).toHaveLength(0)
  })

  it('客户端断开后会话记账被清理；事件按登记表属主回落路由', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c1', 'u1')
    harness.connectClient('c1')
    const owner = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    owner.sent.length = 0
    harness.hub.handleWebMessage(owner.conn, {
      type: 'session.create',
      requestId: 'web-9',
      clientId: 'c1',
    })
    const { sessionId } = (owner.sent.at(-1) as { data: { sessionId: string } }).data
    harness.hub.removeClient('c1')
    harness.hub.dropClientSessions('c1')
    owner.sent.length = 0
    harness.hub.handleClientMessage('c1', {
      type: 'session.event',
      sessionId,
      event: { seq: 1 } as never,
    })
    // 记账已清，但客户端登记表仍在 → 事件按登记表属主回落路由（本地历史会话同款语义）
    expect(owner.sent.filter((m) => (m as { type: string }).type === 'client.event')).toHaveLength(
      1,
    )
  })

  it('重连竞态：旧连接的迟到 close 不会把新连接删掉（带上 conn 做身份校验）', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c1', 'u1')
    const first = harness.connectClient('c1')
    const admin = harness.connectWeb({ id: 'u-admin', username: 'root', role: 'admin' })

    // 同一 clientId 的新连接先注册完成（重连的常见顺序）
    const second = harness.connectClient('c1')
    expect(harness.hub.isOnline('c1')).toBe(true)

    // 旧连接的 close 现在才到达：传它自己 → 不该动新连接
    admin.sent.length = 0
    expect(harness.hub.removeClient('c1', first.conn)).toBe(false)
    expect(harness.hub.isOnline('c1')).toBe(true)
    // 也不该广播"离线"（没有任何 clients 快照发出）
    expect(admin.sent.filter((m) => (m as { type: string }).type === 'clients')).toHaveLength(0)

    // 新连接真的断开时才生效，并广播一次
    expect(harness.hub.removeClient('c1', second.conn)).toBe(true)
    expect(harness.hub.isOnline('c1')).toBe(false)
    expect(admin.sent.filter((m) => (m as { type: string }).type === 'clients')).toHaveLength(1)

    // 不带 conn（管理员主动踢人 / 心跳清场）仍按 clientId 无差别生效
    const third = harness.connectClient('c1')
    expect(third.conn.clientId).toBe('c1')
    expect(harness.hub.removeClient('c1')).toBe(true)
    expect(harness.hub.isOnline('c1')).toBe(false)
    // 已经没有这条连接了：重复调用返回 false，不重复广播
    expect(harness.hub.removeClient('c1')).toBe(false)
  })
})

describe('Hub · 远程自动化命令（docs/13 §10）', () => {
  const DEFINITION = {
    id: 'am-1',
    name: '每天问好',
    enabled: true,
    mode: 'agent' as const,
    trigger: { kind: 'daily' as const, params: { at: '08:00' } },
    prompt: '早安汇总',
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
  }

  it('6 个 automation 命令原样转发给目标客户端，cmd 形状正确；缺省字段不进 cmd', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c1', 'u1')
    const client = harness.connectClient('c1')
    client.sent.length = 0
    const owner = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    owner.sent.length = 0

    const cases: Array<{ message: Parameters<Hub['handleWebMessage']>[1]; expectCmd: unknown }> = [
      {
        message: { type: 'automation.list', requestId: 'au-1', clientId: 'c1' },
        expectCmd: { kind: 'automation.list', requestId: 'au-1' },
      },
      {
        message: { type: 'automation.catalog', requestId: 'au-2', clientId: 'c1' },
        expectCmd: { kind: 'automation.catalog', requestId: 'au-2' },
      },
      {
        message: {
          type: 'automation.save',
          requestId: 'au-3',
          clientId: 'c1',
          definition: DEFINITION,
        },
        expectCmd: {
          kind: 'automation.save',
          requestId: 'au-3',
          definition: DEFINITION,
        },
      },
      {
        message: { type: 'automation.delete', requestId: 'au-4', clientId: 'c1', id: 'am-1' },
        expectCmd: { kind: 'automation.delete', requestId: 'au-4', id: 'am-1' },
      },
      {
        message: { type: 'automation.run', requestId: 'au-5', clientId: 'c1', id: 'am-1' },
        expectCmd: { kind: 'automation.run', requestId: 'au-5', id: 'am-1' },
      },
      {
        message: {
          type: 'automation.history',
          requestId: 'au-6',
          clientId: 'c1',
          automationId: 'am-1',
          mode: 'agent',
          limit: 20,
        },
        expectCmd: {
          kind: 'automation.history',
          requestId: 'au-6',
          automationId: 'am-1',
          mode: 'agent',
          limit: 20,
        },
      },
      {
        message: { type: 'automation.history', requestId: 'au-7', clientId: 'c1' },
        expectCmd: { kind: 'automation.history', requestId: 'au-7' },
      },
    ]

    for (const [i, { message, expectCmd }] of cases.entries()) {
      harness.hub.handleWebMessage(owner.conn, message)
      const forwarded = client.sent.at(i) as { type: string; cmd: Record<string, unknown> }
      expect(forwarded.type).toBe('cmd')
      expect(forwarded.cmd).toEqual(expectCmd)
    }
    // 转发成功时网页端只有等回执，不立即收任何消息
    expect(owner.sent).toHaveLength(0)
  })

  it('automation.list 的 result 回执按 requestId 转回网页端；拒绝路径与既有命令一致', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c1', 'u1')
    const client = harness.connectClient('c1')
    client.sent.length = 0
    const stranger = harness.connectWeb({ id: 'u2', username: 'u2', role: 'user' })
    const owner = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    owner.sent.length = 0

    harness.hub.handleWebMessage(stranger.conn, {
      type: 'automation.list',
      requestId: 'au-10',
      clientId: 'c1',
    })
    expect((stranger.sent.at(-1) as { error?: string }).error).toBe('E_FORBIDDEN')

    harness.hub.handleWebMessage(owner.conn, {
      type: 'automation.list',
      requestId: 'au-11',
      clientId: 'c1',
    })
    harness.hub.handleClientMessage('c1', {
      type: 'result',
      requestId: 'au-11',
      ok: true,
      data: { user: [DEFINITION], builtin: [] },
    })
    const result = owner.sent.at(-1) as { type: string; ok: boolean; data?: unknown }
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({ user: [DEFINITION], builtin: [] })
  })
})

describe('Hub · 远程会话管理与 LLM 切换（docs/12 §6.3）', () => {
  it('7 个新命令原样转发给目标客户端，cmd 形状正确', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c1', 'u1')
    const client = harness.connectClient('c1')
    client.sent.length = 0
    const owner = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    owner.sent.length = 0

    const cases: Array<{ message: Parameters<Hub['handleWebMessage']>[1]; expectCmd: unknown }> = [
      {
        message: { type: 'session.list', requestId: 'r1', clientId: 'c1' },
        expectCmd: { kind: 'session.list', requestId: 'r1' },
      },
      {
        message: {
          type: 'session.activate',
          requestId: 'r2',
          clientId: 'c1',
          sessionId: 'center-a',
        },
        expectCmd: { kind: 'session.activate', requestId: 'r2', sessionId: 'center-a' },
      },
      {
        message: {
          type: 'session.visibility',
          requestId: 'r3',
          clientId: 'c1',
          sessionId: 'center-a',
          visible: false,
        },
        expectCmd: {
          kind: 'session.visibility',
          requestId: 'r3',
          sessionId: 'center-a',
          visible: false,
        },
      },
      {
        message: {
          type: 'session.setPermission',
          requestId: 'r4',
          clientId: 'c1',
          sessionId: 'center-a',
          permissionMode: 'auto',
        },
        expectCmd: {
          kind: 'session.setPermission',
          requestId: 'r4',
          sessionId: 'center-a',
          permissionMode: 'auto',
        },
      },
      {
        message: {
          type: 'session.setProject',
          requestId: 'r5',
          clientId: 'c1',
          sessionId: 'center-a',
          projectId: 'proj-1',
        },
        expectCmd: {
          kind: 'session.setProject',
          requestId: 'r5',
          sessionId: 'center-a',
          projectId: 'proj-1',
        },
      },
      {
        message: { type: 'project.list', requestId: 'r6', clientId: 'c1' },
        expectCmd: { kind: 'project.list', requestId: 'r6' },
      },
      {
        // 会话级模型（本轮，docs/06 §3）：原样透传 providerId + model
        message: {
          type: 'session.setModel',
          requestId: 'r6b',
          clientId: 'c1',
          sessionId: 'center-a',
          providerId: 'p2',
          model: 'model-9',
        },
        expectCmd: {
          kind: 'session.setModel',
          requestId: 'r6b',
          sessionId: 'center-a',
          providerId: 'p2',
          model: 'model-9',
        },
      },
      {
        message: {
          type: 'llm.switch',
          requestId: 'r7',
          clientId: 'c1',
          providerId: 'p2',
          model: 'model-9',
          reasoningEffort: 'high',
        },
        expectCmd: {
          kind: 'llm.switch',
          requestId: 'r7',
          providerId: 'p2',
          model: 'model-9',
          reasoningEffort: 'high',
        },
      },
    ]

    for (const [i, { message, expectCmd }] of cases.entries()) {
      harness.hub.handleWebMessage(owner.conn, message)
      const forwarded = client.sent.at(i) as { type: string; cmd: Record<string, unknown> }
      expect(forwarded.type).toBe('cmd')
      expect(forwarded.cmd).toEqual(expectCmd)
    }
    // 转发成功时网页端只有等回执，不立即收任何消息
    expect(owner.sent).toHaveLength(0)
  })

  it('llm.switch 缺省字段不进 cmd；不做白名单预检（路径像 config 路径也原样转发）', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c1', 'u1')
    const client = harness.connectClient('c1')
    client.sent.length = 0
    const owner = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    owner.sent.length = 0

    harness.hub.handleWebMessage(owner.conn, {
      type: 'llm.switch',
      requestId: 'r8',
      clientId: 'c1',
      model: 'model-2',
    })
    const forwarded = client.sent.at(-1) as { type: string; cmd: Record<string, unknown> }
    expect(forwarded.cmd).toEqual({ kind: 'llm.switch', requestId: 'r8', model: 'model-2' })
  })

  it('session.history 转发给目标客户端；result.data（历史消息数组）按 requestId 转回网页端', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c1', 'u1')
    const client = harness.connectClient('c1')
    client.sent.length = 0
    const stranger = harness.connectWeb({ id: 'u2', username: 'u2', role: 'user' })
    const owner = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    owner.sent.length = 0

    harness.hub.handleWebMessage(stranger.conn, {
      type: 'session.history',
      requestId: 'h0',
      clientId: 'c1',
      sessionId: 'center-a',
    })
    expect((stranger.sent.at(-1) as { error?: string }).error).toBe('E_FORBIDDEN')

    harness.hub.handleWebMessage(owner.conn, {
      type: 'session.history',
      requestId: 'h1',
      clientId: 'c1',
      sessionId: 'center-a',
    })
    const forwarded = client.sent.at(-1) as {
      type: string
      cmd: { kind: string; requestId: string; sessionId: string }
    }
    expect(forwarded.type).toBe('cmd')
    expect(forwarded.cmd).toEqual({
      kind: 'session.history',
      requestId: 'h1',
      sessionId: 'center-a',
    })

    harness.hub.handleClientMessage('c1', {
      type: 'result',
      requestId: 'h1',
      ok: true,
      data: [{ id: 'm1', role: 'user', content: 'hi', createdAt: '2026-09-28T00:00:00.000Z' }],
    })
    const result = owner.sent.at(-1) as { type: string; ok: boolean; data?: unknown }
    expect(result.ok).toBe(true)
    expect(Array.isArray(result.data)).toBe(true)
  })

  it('新命令的拒绝路径：非属主 E_FORBIDDEN、未登记客户端 E_CLIENT_NOT_FOUND、离线 E_CLIENT_OFFLINE', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c1', 'u1')
    harness.connectClient('c1')
    const stranger = harness.connectWeb({ id: 'u2', username: 'u2', role: 'user' })
    const owner = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })

    harness.hub.handleWebMessage(stranger.conn, {
      type: 'session.list',
      requestId: 'r10',
      clientId: 'c1',
    })
    expect((stranger.sent.at(-1) as { error?: string }).error).toBe('E_FORBIDDEN')

    harness.hub.handleWebMessage(owner.conn, {
      type: 'session.list',
      requestId: 'r11',
      clientId: 'ghost',
    })
    expect((owner.sent.at(-1) as { error?: string }).error).toBe('E_CLIENT_NOT_FOUND')

    harness.hub.removeClient('c1')
    harness.hub.handleWebMessage(owner.conn, {
      type: 'llm.switch',
      requestId: 'r12',
      clientId: 'c1',
      model: 'model-2',
    })
    expect((owner.sent.at(-1) as { error?: string }).error).toBe('E_CLIENT_OFFLINE')
  })

  it('session.event 属主回落：无 sessionOwners 记录时按客户端登记表属主 + 管理员路由', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c1', 'u1')
    harness.connectClient('c1')
    const owner = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    const stranger = harness.connectWeb({ id: 'u2', username: 'u2', role: 'user' })
    const admin = harness.connectWeb({ id: 'u-admin', username: 'root', role: 'admin' })
    owner.sent.length = stranger.sent.length = admin.sent.length = 0

    // 客户端本地已有历史 center- 会话：没有任何 session.create / 会话类命令记账
    harness.hub.handleClientMessage('c1', {
      type: 'session.event',
      sessionId: 'center-legacy',
      event: { seq: 1 } as never,
    })
    expect(owner.sent.filter((m) => (m as { type: string }).type === 'client.event')).toHaveLength(
      1,
    )
    expect(admin.sent.filter((m) => (m as { type: string }).type === 'client.event')).toHaveLength(
      1,
    )
    expect(
      stranger.sent.filter((m) => (m as { type: string }).type === 'client.event'),
    ).toHaveLength(0)

    // 客户端不在登记表 → 无法确定属主，丢弃
    expect(() =>
      harness.hub.handleClientMessage('c-ghost', {
        type: 'session.event',
        sessionId: 'center-legacy',
        event: { seq: 2 } as never,
      }),
    ).not.toThrow()
    expect(admin.sent.filter((m) => (m as { type: string }).type === 'client.event')).toHaveLength(
      1,
    )
  })

  it('session.activate 等会话类命令顺带补记属主：之后该会话的事件按记账属主路由', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c1', 'u1')
    harness.connectClient('c1')
    const owner = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    const stranger = harness.connectWeb({ id: 'u2', username: 'u2', role: 'user' })
    const admin = harness.connectWeb({ id: 'u-admin', username: 'root', role: 'admin' })

    // 直接 activate 一个未 create 的会话 → forwardCommand 补记 u1 为属主
    harness.hub.handleWebMessage(owner.conn, {
      type: 'session.activate',
      requestId: 'r20',
      clientId: 'c1',
      sessionId: 'center-adopted',
    })
    owner.sent.length = stranger.sent.length = admin.sent.length = 0

    harness.hub.handleClientMessage('c1', {
      type: 'session.event',
      sessionId: 'center-adopted',
      event: { seq: 1 } as never,
    })
    expect(owner.sent.filter((m) => (m as { type: string }).type === 'client.event')).toHaveLength(
      1,
    )
    expect(admin.sent.filter((m) => (m as { type: string }).type === 'client.event')).toHaveLength(
      1,
    )
    expect(
      stranger.sent.filter((m) => (m as { type: string }).type === 'client.event'),
    ).toHaveLength(0)
  })
})

/**
 * 畸形入站消息与回执隔离（2026-10-01 全量审查）：
 * - P0-01 / P1-02：入站 WS 消息在运行时**没有任何形状校验**（server.ts 盲转型），
 *   缺字段的 `config.update` / `confirm.request` 会让处理链抛 TypeError；全仓没有
 *   `process.on('uncaughtException')` 兜底，异常逃出监听器 = 整个服务器退出。
 *   下面的用例就是按**真实攻击形状**（JSON 里干脆没有那个字段）构造的。
 * - P1-03：回执必须只投递给发起命令的那条网页连接，且伪造的 `result` 无效。
 */
describe('Hub · 畸形入站消息与回执隔离（P0-01 / P1-02 / P1-03）', () => {
  /** 真实攻击形状：服务器只做 `JSON.parse` + 盲转型，字段缺了也没人拦 */
  const webMessage = (raw: string): Parameters<Hub['handleWebMessage']>[1] =>
    JSON.parse(raw) as Parameters<Hub['handleWebMessage']>[1]
  const clientMessage = (raw: string): Parameters<Hub['handleClientMessage']>[1] =>
    JSON.parse(raw) as Parameters<Hub['handleClientMessage']>[1]

  it('config.update 缺 patch / patch 为 null 或数组：回 E_INVALID_PATCH，不抛错也不转发', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c1', 'u1')
    const client = harness.connectClient('c1')
    client.sent.length = 0
    const owner = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    owner.sent.length = 0

    const cases = [
      '{"type":"config.update","requestId":"r1","clientId":"c1"}', // patch 字段整体缺失
      '{"type":"config.update","requestId":"r2","clientId":"c1","patch":null}',
      '{"type":"config.update","requestId":"r3","clientId":"c1","patch":["agent.tools.enabled"]}',
    ]
    for (const raw of cases) {
      expect(() => harness.hub.handleWebMessage(owner.conn, webMessage(raw))).not.toThrow()
      const result = owner.sent.at(-1) as { ok: boolean; error?: string }
      expect(result.ok).toBe(false)
      expect(result.error).toBe('E_INVALID_PATCH')
    }
    // 畸形帧一律不进转发链：客户端一条命令都没收到
    expect(client.sent).toHaveLength(0)
  })

  it('confirm.request 缺 request（或非纯对象）：丢弃不抛错，属主 / 管理员都收不到', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c1', 'u1')
    harness.connectClient('c1')
    const owner = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    const admin = harness.connectWeb({ id: 'u-admin', username: 'root', role: 'admin' })
    owner.sent.length = admin.sent.length = 0

    for (const raw of [
      '{"type":"confirm.request"}', // 缺 request（旧代码在 message.request.sessionId 处崩）
      '{"type":"confirm.request","request":null}',
      '{"type":"confirm.request","request":[1,2]}',
    ]) {
      expect(() => harness.hub.handleClientMessage('c1', clientMessage(raw))).not.toThrow()
    }
    expect(owner.sent).toHaveLength(0)
    expect(admin.sent).toHaveLength(0)

    // 合法请求照常转发（守卫没有误伤正常路径）
    harness.hub.handleClientMessage('c1', {
      type: 'confirm.request',
      request: {
        confirmId: 'cf-ok',
        sessionId: 'center-1',
        toolName: 'run_command',
        input: {},
        createdAt: '2026-10-01T00:00:00.000Z',
        expiresAt: '2026-10-01T00:01:00.000Z',
      },
    })
    expect(
      owner.sent.filter((m) => (m as { type: string }).type === 'confirm.request'),
    ).toHaveLength(1)
  })

  it('伪造回执：另一台客户端（跨属主）猜中 requestId 发 result 不投递，真主回执照常送达', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c1', 'u1')
    await seedClient(harness, 'c2', 'u2')
    harness.connectClient('c1')
    harness.connectClient('c2')
    const owner = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    owner.sent.length = 0

    harness.hub.handleWebMessage(owner.conn, {
      type: 'config.get',
      requestId: 'web-forge',
      clientId: 'c1',
    })
    // c2 猜中 requestId 发假回执 —— 旧实现按全局 requestId 取条目，会被原样投进 u1 的网页端
    harness.hub.handleClientMessage('c2', {
      type: 'result',
      requestId: 'web-forge',
      ok: true,
      data: { forged: true },
    })
    expect(owner.sent.filter((m) => (m as { type: string }).type === 'result')).toHaveLength(0)

    // 真主 c1 的回执照常送达
    harness.hub.handleClientMessage('c1', {
      type: 'result',
      requestId: 'web-forge',
      ok: true,
      data: { genuine: true },
    })
    const result = owner.sent.at(-1) as { ok: boolean; data?: unknown }
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({ genuine: true })

    // 条目已结算：同一 requestId 的重复回执不再重复投递
    owner.sent.length = 0
    harness.hub.handleClientMessage('c1', {
      type: 'result',
      requestId: 'web-forge',
      ok: true,
      data: { replay: true },
    })
    expect(owner.sent).toHaveLength(0)
  })

  it('两条网页连接用相同 requestId 打同一台客户端：pending 互不覆盖，回执按命令顺序各归各', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c1', 'u1')
    const client = harness.connectClient('c1')
    client.sent.length = 0
    // 同一账号的两个页签（同一用户、两条连接）—— 旧实现两页都从 web-1 开始，pending 互相覆盖
    const tabA = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    const tabB = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    expect(tabA.id).not.toBe(tabB.id)
    tabA.sent.length = tabB.sent.length = 0

    for (const tab of [tabA, tabB]) {
      harness.hub.handleWebMessage(tab.conn, {
        type: 'session.list',
        requestId: 'web-1', // 两页签同名（旧实现下这是常态）
        clientId: 'c1',
      })
    }
    expect(client.sent).toHaveLength(2) // 两条命令都真的转发了，谁也没被覆盖

    harness.hub.handleClientMessage('c1', {
      type: 'result',
      requestId: 'web-1',
      ok: true,
      data: { tab: 'A' },
    })
    harness.hub.handleClientMessage('c1', {
      type: 'result',
      requestId: 'web-1',
      ok: true,
      data: { tab: 'B' },
    })
    expect(tabA.sent).toHaveLength(1)
    expect(tabB.sent).toHaveLength(1)
    expect((tabA.sent.at(-1) as { data?: unknown }).data).toEqual({ tab: 'A' })
    expect((tabB.sent.at(-1) as { data?: unknown }).data).toEqual({ tab: 'B' })
  })

  it('两条网页连接用相同 requestId 各自超时：只向自己的连接合成 E_CLIENT_TIMEOUT', async () => {
    vi.useFakeTimers()
    try {
      const harness = await makeHub()
      await seedClient(harness, 'c1', 'u1')
      harness.connectClient('c1')
      const tabA = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
      const tabB = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
      tabA.sent.length = tabB.sent.length = 0

      for (const tab of [tabA, tabB]) {
        harness.hub.handleWebMessage(tab.conn, {
          type: 'config.get',
          requestId: 'web-dup',
          clientId: 'c1',
        })
      }
      await vi.advanceTimersByTimeAsync(16_000)
      expect((tabA.sent.at(-1) as { error?: string }).error).toBe('E_CLIENT_TIMEOUT')
      expect((tabB.sent.at(-1) as { error?: string }).error).toBe('E_CLIENT_TIMEOUT')
      expect(tabA.sent).toHaveLength(1)
      expect(tabB.sent).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Hub · 语音中转（docs/12 §6.4）', () => {
  it('stt.transcribe / tts.synthesize 原样转发成 cmd 给目标客户端；result 按 requestId 转回网页端', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c1', 'u1')
    const client = harness.connectClient('c1')
    client.sent.length = 0
    const owner = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    owner.sent.length = 0

    harness.hub.handleWebMessage(owner.conn, {
      type: 'stt.transcribe',
      requestId: 'web-v1',
      clientId: 'c1',
      audioBase64: 'QUBB',
      mime: 'audio/webm;codecs=opus',
    })
    harness.hub.handleWebMessage(owner.conn, {
      type: 'tts.synthesize',
      requestId: 'web-v2',
      clientId: 'c1',
      text: '你好，世界',
    })
    expect(client.sent).toEqual([
      {
        type: 'cmd',
        cmd: {
          kind: 'stt.transcribe',
          requestId: 'web-v1',
          audioBase64: 'QUBB',
          mime: 'audio/webm;codecs=opus',
        },
      },
      {
        type: 'cmd',
        cmd: { kind: 'tts.synthesize', requestId: 'web-v2', text: '你好，世界' },
      },
    ])

    // 客户端回执：成功带转写文本、失败带错误码，都按 requestId 转回发起的网页连接
    harness.hub.handleClientMessage('c1', {
      type: 'result',
      requestId: 'web-v1',
      ok: true,
      data: { text: '识别文本' },
    })
    harness.hub.handleClientMessage('c1', {
      type: 'result',
      requestId: 'web-v2',
      ok: false,
      error: 'E_VOICE_NOT_CONFIGURED',
    })
    expect(owner.sent).toEqual([
      { type: 'result', requestId: 'web-v1', ok: true, data: { text: '识别文本' } },
      { type: 'result', requestId: 'web-v2', ok: false, error: 'E_VOICE_NOT_CONFIGURED' },
    ])
  })

  it('拒绝路径与既有命令一致：非属主 E_FORBIDDEN、未登记 E_CLIENT_NOT_FOUND、离线 E_CLIENT_OFFLINE', async () => {
    const harness = await makeHub()
    await seedClient(harness, 'c1', 'u1')
    harness.connectClient('c1')
    const stranger = harness.connectWeb({ id: 'u2', username: 'u2', role: 'user' })
    const owner = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })

    harness.hub.handleWebMessage(stranger.conn, {
      type: 'tts.synthesize',
      requestId: 'web-v3',
      clientId: 'c1',
      text: '你好',
    })
    expect((stranger.sent.at(-1) as { error?: string }).error).toBe('E_FORBIDDEN')

    harness.hub.handleWebMessage(owner.conn, {
      type: 'stt.transcribe',
      requestId: 'web-v4',
      clientId: 'ghost',
      audioBase64: 'QUBB',
      mime: 'audio/webm',
    })
    expect((owner.sent.at(-1) as { error?: string }).error).toBe('E_CLIENT_NOT_FOUND')

    await seedClient(harness, 'c2', 'u1')
    harness.hub.handleWebMessage(owner.conn, {
      type: 'tts.synthesize',
      requestId: 'web-v5',
      clientId: 'c2',
      text: '你好',
    })
    expect((owner.sent.at(-1) as { error?: string }).error).toBe('E_CLIENT_OFFLINE')
  })

  it('语音命令的待回执超时放宽到 60s：15s 不合成超时，60s 后才报 E_CLIENT_TIMEOUT', async () => {
    vi.useFakeTimers()
    try {
      const harness = await makeHub()
      await seedClient(harness, 'c1', 'u1')
      harness.connectClient('c1')
      const owner = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
      owner.sent.length = 0
      harness.hub.handleWebMessage(owner.conn, {
        type: 'stt.transcribe',
        requestId: 'web-v6',
        clientId: 'c1',
        audioBase64: 'QUBB',
        mime: 'audio/webm',
      })
      // 15s（普通命令的超时点）不合成超时：客户端调本机 provider 是 30s 级耗时
      await vi.advanceTimersByTimeAsync(16_000)
      expect(owner.sent.filter((m) => (m as { type: string }).type === 'result')).toHaveLength(0)
      // 60s 后仍未回执才合成 E_CLIENT_TIMEOUT，不让请求悬死
      await vi.advanceTimersByTimeAsync(45_000)
      const result = owner.sent.at(-1) as { ok: boolean; error?: string }
      expect(result.ok).toBe(false)
      expect(result.error).toBe('E_CLIENT_TIMEOUT')
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * 文件下发（`file.send`，本轮 docs/12 §5）。
 *
 * 这是**唯一一条会往用户磁盘写东西**的下行命令，因此除了转发本身，必须钉住两条拒绝：
 * 文件不存在（已过期 / 已删）、以及「把别人上传的文件推给我名下的设备」。
 */
describe('Aurora Center · 文件下发（file.send）', () => {
  /** 带 fileLookup 的 hub：`files` 是 fileId → 归属客户端名 */
  async function makeFileHub(files: Record<string, string>): Promise<Harness> {
    const dir = await mkdtemp(join(tmpdir(), 'aurora-center-hub-files-'))
    const clients = new ClientRegistry({ dataDir: dir })
    await clients.init()
    const hub = new Hub({
      clients,
      usernameOf: (id) => `user-${id}`,
      serverVersion: () => '0.0.0-test',
      fileLookup: (fileId) => {
        const source = files[fileId]
        return source === undefined
          ? undefined
          : { clientId: source, name: `${fileId}.bin`, size: 42 }
      },
    })
    return {
      hub,
      clients,
      connectClient(clientId) {
        const sent: unknown[] = []
        const conn: ClientConn = { clientId, send: (m) => sent.push(m), close: () => {} }
        hub.registerClient(conn, STATUS)
        return { sent, conn }
      },
      connectWeb(user) {
        webConnSeq += 1
        const sent: unknown[] = []
        const conn: WebConn = { id: `w-${webConnSeq}`, user, send: (m) => sent.push(m) }
        hub.registerWeb(conn)
        return { id: conn.id, sent, conn }
      },
    }
  }

  it('服务器补齐 name/size 后转发（客户端不必自己 HEAD）', async () => {
    const harness = await makeFileHub({ 'f-1': 'c1' })
    await seedClient(harness, 'c1', 'u1')
    const target = harness.connectClient('c1')
    target.sent.length = 0
    const web = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    web.sent.length = 0

    harness.hub.handleWebMessage(web.conn, {
      type: 'file.send',
      requestId: 'fs-1',
      clientId: 'c1',
      fileId: 'f-1',
    })
    expect(target.sent.at(-1)).toMatchObject({
      type: 'cmd',
      cmd: { kind: 'file.send', requestId: 'fs-1', fileId: 'f-1', name: 'f-1.bin', size: 42 },
    })
  })

  it('文件不存在（已过期 / 已删）：直接回 E_NOT_FOUND，不下发命令', async () => {
    const harness = await makeFileHub({})
    await seedClient(harness, 'c1', 'u1')
    const target = harness.connectClient('c1')
    target.sent.length = 0
    const web = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    web.sent.length = 0

    harness.hub.handleWebMessage(web.conn, {
      type: 'file.send',
      requestId: 'fs-2',
      clientId: 'c1',
      fileId: 'missing',
    })
    expect(web.sent.at(-1)).toMatchObject({
      type: 'result',
      requestId: 'fs-2',
      ok: false,
      error: 'E_NOT_FOUND',
    })
    expect(target.sent).toEqual([])
  })

  it('跨租户：把我名下的文件推给别人的设备 → E_FORBIDDEN；推给自己名下另一台可以', async () => {
    const harness = await makeFileHub({ 'f-mine': 'c1', 'f-theirs': 'c9' })
    await seedClient(harness, 'c1', 'u1')
    await seedClient(harness, 'c2', 'u1')
    await seedClient(harness, 'c9', 'u2')
    harness.connectClient('c1')
    const target = harness.connectClient('c2')
    target.sent.length = 0
    const web = harness.connectWeb({ id: 'u1', username: 'u1', role: 'user' })
    web.sent.length = 0

    // 别人的客户端上传的文件：即使我想推给我自己的设备也不许（跨租户读）
    harness.hub.handleWebMessage(web.conn, {
      type: 'file.send',
      requestId: 'fs-3',
      clientId: 'c2',
      fileId: 'f-theirs',
    })
    expect(web.sent.at(-1)).toMatchObject({ ok: false, error: 'E_FORBIDDEN' })
    expect(target.sent).toEqual([])

    // 同一账号下 c1 → c2 的转发是允许的（文件来源也是我的）
    harness.hub.handleWebMessage(web.conn, {
      type: 'file.send',
      requestId: 'fs-4',
      clientId: 'c2',
      fileId: 'f-mine',
    })
    expect(target.sent.at(-1)).toMatchObject({ cmd: { kind: 'file.send', requestId: 'fs-4' } })
  })
})
