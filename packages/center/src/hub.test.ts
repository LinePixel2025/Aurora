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
      const sent: unknown[] = []
      const conn: WebConn = {
        id: `w-${sent.length}-${user.id}`,
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

  it('客户端断开后会话记账被清理，事件不再外发', async () => {
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
    expect(owner.sent.filter((m) => (m as { type: string }).type === 'client.event')).toHaveLength(
      0,
    )
  })
})
