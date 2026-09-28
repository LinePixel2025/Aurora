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
