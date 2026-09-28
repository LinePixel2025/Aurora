import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CenterConnector,
  backoffDelayMs,
  wsUrlOf,
  type CenterConfig,
  type CenterConnectorDeps,
  type WsLike,
} from './connector.js'
import type { Logger, ModeId } from '@aurora/shared'

/** 可脚本化的假 socket：测试里手动触发 open/message/close */
class FakeSocket implements WsLike {
  readonly sent: string[] = []
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  closed = false

  on(event: string, listener: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }

  send(data: string): void {
    if (this.closed) throw new Error('socket closed')
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    this.emit('close')
  }

  lastMessage(): Record<string, unknown> {
    return JSON.parse(this.sent[this.sent.length - 1] as string) as Record<string, unknown>
  }
}

interface Harness {
  connector: CenterConnector
  sockets: FakeSocket[]
  lastSocket(): FakeSocket
  config: CenterConfig
  deps: CenterConnectorDeps
  mode: ModeId
}

function makeConnector(overrides?: Partial<CenterConfig>): Harness {
  const config: CenterConfig = {
    enabled: true,
    serverUrl: 'ws://center.example.com',
    token: 'ac-token',
    clientId: 'client-1',
    displayName: '测试机',
    allowRemoteSession: true,
    allowRemoteConfig: true,
    allowFileTransfer: true,
    ...overrides,
  }
  let mode: ModeId = 'work'
  const sockets: FakeSocket[] = []
  const deps: CenterConnectorDeps = {
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as Logger,
    config: () => config,
    statusSnapshot: () => ({
      mode,
      version: '0.1.6',
      platform: 'win32',
      agent: {
        permissionMode: 'confirm',
        tools: { enabled: true, files: true, search: true, open: true, terminal: true },
      },
      center: {
        allowRemoteSession: config.allowRemoteSession,
        allowRemoteConfig: config.allowRemoteConfig,
        allowFileTransfer: config.allowFileTransfer,
      },
      llm: { activeProviderId: 'p1', model: 'gpt-x', reasoningEffort: 'auto' },
    }),
    version: '0.1.6',
    platform: 'win32',
    hostname: () => 'TEST-PC',
    wsFactory: (url, options) => {
      void url
      void options
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    applyRemotePatch: async () => undefined,
    getRedactedConfig: () => ({ center: { tokenEnc: '***' } }),
    switchMode: async (next) => {
      mode = next
      return undefined
    },
    sessionHandler: {
      handleInput: async (message) => ({
        ok: true,
        data: { agentRequestId: `req-${message.requestId}` },
      }),
      handleAbort: () => ({ ok: true }),
    },
  }
  const connector = new CenterConnector(deps)
  return {
    connector,
    sockets,
    lastSocket: () => sockets[sockets.length - 1] as FakeSocket,
    config,
    deps,
    mode,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('CenterConnector · 连接状态机', () => {
  it('start → 连接 → open 后发 hello + status；hello 携带 clientId 与能力位', () => {
    const harness = makeConnector()
    harness.connector.start()
    expect(harness.connector.connectionState().state).toBe('connecting')
    vi.advanceTimersByTime(1)
    const socket = harness.lastSocket()
    socket.emit('open')
    expect(harness.connector.connectionState().state).toBe('connected')
    const hello = JSON.parse(socket.sent[0] as string)
    expect(hello.type).toBe('hello')
    expect(hello.hello.clientId).toBe('client-1')
    expect(hello.hello.name).toBe('测试机')
    expect(hello.hello.capabilities).toEqual({
      session: true,
      remoteConfig: true,
      fileTransfer: true,
    })
    expect(JSON.parse(socket.sent[1] as string).type).toBe('status')
  })

  it('未配置地址 / 令牌时进入 error 且不发起连接', () => {
    const harness = makeConnector({ token: '' })
    harness.connector.start()
    expect(harness.connector.connectionState().state).toBe('error')
    expect(harness.connector.connectionState().lastError).toContain('尚未配置')
    expect(harness.sockets).toHaveLength(0)
  })

  it('断开后指数退避重连；配置签名变化触发立即重连', () => {
    const harness = makeConnector()
    harness.connector.start()
    vi.advanceTimersByTime(1)
    const first = harness.lastSocket()
    first.emit('open')
    first.emit('close')
    expect(harness.connector.connectionState().state).toBe('error')
    // 1s 后重连（第一次断开 attempt=0 → 1s）
    vi.advanceTimersByTime(1000)
    vi.advanceTimersByTime(1)
    expect(harness.sockets.length).toBe(2)

    // 改 serverUrl → 签名变化 → 立即重连（teardown + 新连接）
    harness.config.serverUrl = 'ws://other.example.com'
    harness.connector.onConfigChanged()
    vi.advanceTimersByTime(1)
    expect(harness.sockets.length).toBe(3)
  })

  it('enabled=false 时 stop：状态回到 disabled，不再重连', () => {
    const harness = makeConnector()
    harness.connector.start()
    vi.advanceTimersByTime(1)
    const socket = harness.lastSocket()
    harness.config.enabled = false
    harness.connector.onConfigChanged()
    expect(harness.connector.connectionState().state).toBe('disabled')
    expect(socket.closed).toBe(true)
    const count = harness.sockets.length
    vi.advanceTimersByTime(60_000)
    expect(harness.sockets.length).toBe(count)
  })

  it('wsUrlOf：ws(s)/http(s) 都折算成 /api/client 的 WS 地址', () => {
    expect(wsUrlOf('ws://center:8787')).toBe('ws://center:8787/api/client')
    expect(wsUrlOf('https://center.example.com/')).toBe('wss://center.example.com/api/client')
    expect(wsUrlOf('http://10.0.0.2:8787')).toBe('ws://10.0.0.2:8787/api/client')
    expect(wsUrlOf('not-a-url')).toBeUndefined()
  })

  it('backoffDelayMs：1s 起步、指数、30s 封顶', () => {
    expect(backoffDelayMs(0)).toBe(1000)
    expect(backoffDelayMs(1)).toBe(2000)
    expect(backoffDelayMs(2)).toBe(4000)
    expect(backoffDelayMs(10)).toBe(30_000)
  })
})

describe('CenterConnector · 命令处理', () => {
  it('session.input：回执 agentRequestId；ping 回 pong', async () => {
    const harness = makeConnector()
    harness.connector.start()
    vi.advanceTimersByTime(1)
    const socket = harness.lastSocket()
    socket.emit('open')
    socket.emit(
      'message',
      JSON.stringify({
        type: 'cmd',
        cmd: { kind: 'session.input', requestId: 'c-1', sessionId: 'center-abc', text: '你好' },
      }),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(socket.lastMessage()).toMatchObject({
      type: 'result',
      requestId: 'c-1',
      ok: true,
      data: { agentRequestId: 'req-c-1' },
    })
    socket.emit('message', JSON.stringify({ type: 'ping' }))
    expect(socket.lastMessage()).toEqual({ type: 'pong' })
  })

  it('allowRemoteSession=false：会话命令被本地闸门拒绝（E_REMOTE_DISABLED）', async () => {
    const harness = makeConnector({ allowRemoteSession: false })
    harness.connector.start()
    vi.advanceTimersByTime(1)
    const socket = harness.lastSocket()
    socket.emit('open')
    socket.emit(
      'message',
      JSON.stringify({
        type: 'cmd',
        cmd: { kind: 'session.input', requestId: 'c-2', sessionId: 'center-abc', text: '你好' },
      }),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(socket.lastMessage()).toMatchObject({
      type: 'result',
      ok: false,
      error: 'E_REMOTE_DISABLED',
    })
  })

  it('config.update：白名单外的补丁整条拒绝；白名单内应用并回 status', async () => {
    const applied: Array<Record<string, unknown>> = []
    const harness = makeConnector()
    harness.deps.applyRemotePatch = async (patch) => {
      applied.push(patch)
      return undefined
    }
    harness.connector.start()
    vi.advanceTimersByTime(1)
    const socket = harness.lastSocket()
    socket.emit('open')
    socket.emit(
      'message',
      JSON.stringify({
        type: 'cmd',
        cmd: { kind: 'config.update', requestId: 'c-3', patch: { 'agent.tools.enabled': false } },
      }),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(applied).toEqual([{ 'agent.tools.enabled': false }])
    // 应用成功后紧跟一条 status 快照
    const statusIndex = socket.sent.findIndex(
      (m) => JSON.parse(m).type === 'status' && JSON.parse(m).status?.mode,
    )
    expect(statusIndex).toBeGreaterThan(0)

    socket.emit(
      'message',
      JSON.stringify({
        type: 'cmd',
        cmd: { kind: 'config.update', requestId: 'c-4', patch: { 'llm.active': 'evil' } },
      }),
    )
    await Promise.resolve()
    expect(socket.lastMessage()).toMatchObject({ type: 'result', ok: false })
    expect((socket.lastMessage()['error'] as string).startsWith('E_FORBIDDEN_PATH')).toBe(true)
  })

  it('mode.switch 走注入的 switchMode 并回执；allowRemoteConfig=false 时拒绝', async () => {
    const harness = makeConnector({ allowRemoteConfig: false })
    harness.connector.start()
    vi.advanceTimersByTime(1)
    const socket = harness.lastSocket()
    socket.emit('open')
    socket.emit(
      'message',
      JSON.stringify({ type: 'cmd', cmd: { kind: 'mode.switch', requestId: 'c-5', mode: 'code' } }),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(socket.lastMessage()).toMatchObject({
      type: 'result',
      ok: false,
      error: 'E_REMOTE_DISABLED',
    })
  })
})

describe('CenterConnector · confirm.resolve（docs/12 §5.1）', () => {
  function openSocket(harness: Harness): FakeSocket {
    harness.connector.start()
    vi.advanceTimersByTime(1)
    const socket = harness.lastSocket()
    socket.emit('open')
    return socket
  }

  it('网页端批复命中在途确认：调 resolveConfirm 并回 settled=true', async () => {
    const harness = makeConnector()
    const resolved: Array<[string, boolean]> = []
    harness.deps.resolveConfirm = (confirmId, approved) => {
      resolved.push([confirmId, approved])
      return true
    }
    const socket = openSocket(harness)
    socket.emit(
      'message',
      JSON.stringify({
        type: 'cmd',
        cmd: { kind: 'confirm.resolve', requestId: 'c-9', confirmId: 'confirm-1', approved: true },
      }),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(resolved).toEqual([['confirm-1', true]])
    expect(socket.lastMessage()).toMatchObject({
      type: 'result',
      requestId: 'c-9',
      ok: true,
      data: { settled: true },
    })
  })

  it('未命中（已超时 / 已本地结算）也回 ok，settled=false 交给网页端提示', async () => {
    const harness = makeConnector()
    harness.deps.resolveConfirm = () => false
    const socket = openSocket(harness)
    socket.emit(
      'message',
      JSON.stringify({
        type: 'cmd',
        cmd: {
          kind: 'confirm.resolve',
          requestId: 'c-10',
          confirmId: 'confirm-x',
          approved: false,
        },
      }),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(socket.lastMessage()).toMatchObject({
      type: 'result',
      requestId: 'c-10',
      ok: true,
      data: { settled: false },
    })
  })

  it('未注入 resolveConfirm 时不拦截命令，settled=false（端口可缺省）', async () => {
    const harness = makeConnector()
    const socket = openSocket(harness)
    socket.emit(
      'message',
      JSON.stringify({
        type: 'cmd',
        cmd: { kind: 'confirm.resolve', requestId: 'c-11', confirmId: 'confirm-y', approved: true },
      }),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(socket.lastMessage()).toMatchObject({
      type: 'result',
      ok: true,
      data: { settled: false },
    })
  })
})

describe('CenterConnector · 远程会话管理命令（docs/12 §6.3）', () => {
  interface ManagerSpies {
    listSessions: ReturnType<typeof vi.fn>
    activateSession: ReturnType<typeof vi.fn>
    setVisibility: ReturnType<typeof vi.fn>
    setPermissionMode: ReturnType<typeof vi.fn>
    setProject: ReturnType<typeof vi.fn>
    listProjects: ReturnType<typeof vi.fn>
    switchLlm: ReturnType<typeof vi.fn>
    history: ReturnType<typeof vi.fn>
  }

  /** 装好 sessionManager 的 harness（默认全部成功，测试可改返回值 / 换实现） */
  function makeManagedConnector(overrides?: Partial<CenterConfig>): {
    harness: Harness
    spies: ManagerSpies
  } {
    const harness = makeConnector(overrides)
    const spies: ManagerSpies = {
      listSessions: vi.fn(async () => [
        {
          sessionId: 'center-abc',
          title: '远程会话',
          updatedAt: '2026-09-27T00:00:00.000Z',
          permissionMode: 'confirm' as const,
          centerVisible: false,
        },
      ]),
      activateSession: vi.fn(async () => ({ ok: true })),
      setVisibility: vi.fn(async () => ({ ok: true })),
      setPermissionMode: vi.fn(async () => ({ ok: true })),
      setProject: vi.fn(async () => ({ ok: true })),
      listProjects: vi.fn(() => [{ id: 'proj-1', name: '演示项目' }]),
      switchLlm: vi.fn(async () => ({ ok: true })),
      history: vi.fn(async () => ({ ok: true, data: [] })),
    }
    harness.deps.sessionManager = {
      listSessions: spies.listSessions,
      activateSession: spies.activateSession,
      setVisibility: spies.setVisibility,
      setPermissionMode: spies.setPermissionMode,
      setProject: spies.setProject,
      listProjects: spies.listProjects,
      switchLlm: spies.switchLlm,
      history: spies.history,
    }
    return { harness, spies }
  }

  async function sendCmd(socket: FakeSocket, cmd: Record<string, unknown>): Promise<void> {
    socket.emit('message', JSON.stringify({ type: 'cmd', cmd }))
    await Promise.resolve()
    await Promise.resolve()
  }

  function openSocket(harness: Harness): FakeSocket {
    harness.connector.start()
    vi.advanceTimersByTime(1)
    const socket = harness.lastSocket()
    socket.emit('open')
    return socket
  }

  it('session.list：回执注入的 CenterSessionSummary 列表', async () => {
    const { harness, spies } = makeManagedConnector()
    const socket = openSocket(harness)
    await sendCmd(socket, { kind: 'session.list', requestId: 'm-1' })
    expect(spies.listSessions).toHaveBeenCalledTimes(1)
    expect(socket.lastMessage()).toMatchObject({
      type: 'result',
      requestId: 'm-1',
      ok: true,
      data: [{ sessionId: 'center-abc', title: '远程会话', centerVisible: false }],
    })
  })

  it('session.activate / visibility / setPermission / setProject / project.list 各自分派', async () => {
    const { harness, spies } = makeManagedConnector()
    const socket = openSocket(harness)

    await sendCmd(socket, { kind: 'session.activate', requestId: 'm-2', sessionId: 'center-abc' })
    expect(spies.activateSession).toHaveBeenCalledWith('center-abc')
    expect(socket.lastMessage()).toMatchObject({ type: 'result', requestId: 'm-2', ok: true })

    await sendCmd(socket, {
      kind: 'session.visibility',
      requestId: 'm-3',
      sessionId: 'center-abc',
      visible: false,
    })
    expect(spies.setVisibility).toHaveBeenCalledWith('center-abc', false)

    await sendCmd(socket, {
      kind: 'session.setPermission',
      requestId: 'm-4',
      sessionId: 'center-abc',
      permissionMode: 'auto',
    })
    expect(spies.setPermissionMode).toHaveBeenCalledWith('center-abc', 'auto')

    await sendCmd(socket, {
      kind: 'session.setProject',
      requestId: 'm-5',
      sessionId: 'center-abc',
      projectId: 'proj-1',
    })
    expect(spies.setProject).toHaveBeenCalledWith('center-abc', 'proj-1')

    await sendCmd(socket, { kind: 'project.list', requestId: 'm-6' })
    expect(socket.lastMessage()).toMatchObject({
      type: 'result',
      requestId: 'm-6',
      ok: true,
      data: [{ id: 'proj-1', name: '演示项目' }],
    })
  })

  it('session.history：分派 history 并把历史消息数组放进 result.data', async () => {
    const { harness, spies } = makeManagedConnector()
    const socket = openSocket(harness)
    spies.history.mockImplementation(async () => ({
      ok: true,
      data: [{ id: 'm-1', role: 'user', content: 'hi', createdAt: '2026-09-28T00:00:00.000Z' }],
    }))

    await sendCmd(socket, { kind: 'session.history', requestId: 'm-12', sessionId: 'center-abc' })
    expect(spies.history).toHaveBeenCalledWith('center-abc')
    expect(socket.lastMessage()).toMatchObject({
      type: 'result',
      requestId: 'm-12',
      ok: true,
      data: [{ id: 'm-1', role: 'user', content: 'hi' }],
    })

    // 本地会话 id 同样被前缀校验拦下（历史对 Center 不可见）
    await sendCmd(socket, { kind: 'session.history', requestId: 'm-13', sessionId: 'main' })
    expect(socket.lastMessage()).toMatchObject({
      type: 'result',
      requestId: 'm-13',
      ok: false,
      error: 'E_SESSION_NOT_FOUND',
    })
  })

  it('center- 前缀校验：本地会话 id 一律回 E_SESSION_NOT_FOUND（不可见 / 不可切换）', async () => {
    const { harness, spies } = makeManagedConnector()
    const socket = openSocket(harness)

    await sendCmd(socket, { kind: 'session.activate', requestId: 'm-7', sessionId: 'quick' })
    await sendCmd(socket, {
      kind: 'session.visibility',
      requestId: 'm-8',
      sessionId: 'chat-123-1',
      visible: true,
    })
    await sendCmd(socket, {
      kind: 'session.setProject',
      requestId: 'm-9',
      sessionId: 'main',
      projectId: '',
    })

    expect(spies.activateSession).not.toHaveBeenCalled()
    expect(spies.setVisibility).not.toHaveBeenCalled()
    expect(spies.setProject).not.toHaveBeenCalled()
    for (const requestId of ['m-7', 'm-8', 'm-9']) {
      expect(socket.sent.some((m) => JSON.parse(m).requestId === requestId)).toBe(true)
    }
    expect(socket.lastMessage()).toMatchObject({
      type: 'result',
      ok: false,
      error: 'E_SESSION_NOT_FOUND',
    })
  })

  it('allowRemoteSession=false：会话管理命令被本地闸门拒绝', async () => {
    const { harness, spies } = makeManagedConnector({ allowRemoteSession: false })
    const socket = openSocket(harness)
    await sendCmd(socket, { kind: 'session.list', requestId: 'm-10' })
    expect(spies.listSessions).not.toHaveBeenCalled()
    expect(socket.lastMessage()).toMatchObject({ ok: false, error: 'E_REMOTE_DISABLED' })
  })

  it('llm.switch：分派注入的 switchLlm，成功后紧跟一条 status 重报', async () => {
    const { harness, spies } = makeManagedConnector()
    const socket = openSocket(harness)
    const statusCountBefore = socket.sent.filter((m) => JSON.parse(m).type === 'status').length

    await sendCmd(socket, {
      kind: 'llm.switch',
      requestId: 'm-11',
      providerId: 'p2',
      model: 'gpt-next',
      reasoningEffort: 'high',
    })
    expect(spies.switchLlm).toHaveBeenCalledWith({
      providerId: 'p2',
      model: 'gpt-next',
      reasoningEffort: 'high',
    })
    expect(socket.lastMessage()).toMatchObject({ type: 'result', requestId: 'm-11', ok: true })
    // 与 config.update / mode.switch 同款：应用成功后紧跟一条 status 快照
    const statusCountAfter = socket.sent.filter((m) => JSON.parse(m).type === 'status').length
    expect(statusCountAfter).toBe(statusCountBefore + 1)
  })

  it('llm.switch 失败：回执错误、不重报 status；allowRemoteConfig=false 走闸门拒绝', async () => {
    const { harness, spies } = makeManagedConnector()
    spies.switchLlm.mockResolvedValue({ ok: false, error: 'E_INVALID_ARGUMENT: provider 不存在' })
    const socket = openSocket(harness)
    const statusCountBefore = socket.sent.filter((m) => JSON.parse(m).type === 'status').length
    await sendCmd(socket, { kind: 'llm.switch', requestId: 'm-12', providerId: 'nope' })
    expect(socket.lastMessage()).toMatchObject({
      type: 'result',
      ok: false,
      error: 'E_INVALID_ARGUMENT: provider 不存在',
    })
    expect(socket.sent.filter((m) => JSON.parse(m).type === 'status').length).toBe(
      statusCountBefore,
    )

    const gated = makeManagedConnector({ allowRemoteConfig: false })
    const gatedSocket = openSocket(gated.harness)
    await sendCmd(gatedSocket, { kind: 'llm.switch', requestId: 'm-13', providerId: 'p1' })
    expect(gated.spies.switchLlm).not.toHaveBeenCalled()
    expect(gatedSocket.lastMessage()).toMatchObject({ ok: false, error: 'E_REMOTE_DISABLED' })
  })

  it('sessionManager 未注入：会话管理命令回 E_SESSION_NOT_FOUND（老装配器兼容）', async () => {
    const harness = makeConnector()
    const socket = openSocket(harness)
    await sendCmd(socket, { kind: 'session.list', requestId: 'm-14' })
    expect(socket.lastMessage()).toMatchObject({ ok: false, error: 'E_SESSION_NOT_FOUND' })
  })
})

describe('CenterConnector · 确认请求补发队列（docs/12 §5 第 4 步）', () => {
  function openSocket(harness: Harness): FakeSocket {
    harness.connector.start()
    vi.advanceTimersByTime(1)
    const socket = harness.lastSocket()
    socket.emit('open')
    return socket
  }

  it('离线入队 → open 后按 FIFO flush（顺序保持，排在 hello / status 之后）', () => {
    const harness = makeConnector()
    harness.connector.enqueueConfirm({ type: 'confirm.request', n: 1 })
    harness.connector.enqueueConfirm({ type: 'confirm.request', n: 2 })
    expect(harness.connector.pendingConfirmCount()).toBe(2)

    const socket = openSocket(harness)
    // hello(0) status(1) 之后是两条补发
    expect(JSON.parse(socket.sent[2] as string)).toMatchObject({ type: 'confirm.request', n: 1 })
    expect(JSON.parse(socket.sent[3] as string)).toMatchObject({ type: 'confirm.request', n: 2 })
    expect(harness.connector.pendingConfirmCount()).toBe(0)
  })

  it('上限 20 条：满后丢最旧并保留最新', () => {
    const harness = makeConnector()
    for (let i = 0; i < 25; i += 1) {
      harness.connector.enqueueConfirm({ type: 'confirm.request', n: i })
    }
    expect(harness.connector.pendingConfirmCount()).toBe(20)
    // 最旧的 0–4 被丢，从 5 起保留
    const socket = openSocket(harness)
    const queued = socket.sent.slice(2).map((m) => JSON.parse(m).n)
    expect(queued).toHaveLength(20)
    expect(queued[0]).toBe(5)
    expect(queued[19]).toBe(24)
  })

  it('断开后再次入队，重连时再次 flush（队列跨连接存续）', () => {
    const harness = makeConnector()
    const socket = openSocket(harness)
    expect(harness.connector.pendingConfirmCount()).toBe(0)

    socket.emit('close')
    harness.connector.enqueueConfirm({ type: 'confirm.request', n: 1 })
    vi.advanceTimersByTime(1000) // 第一次退避 1s
    vi.advanceTimersByTime(1)
    const reconnected = harness.lastSocket()
    reconnected.emit('open')
    expect(JSON.parse(reconnected.sent[2] as string)).toMatchObject({
      type: 'confirm.request',
      n: 1,
    })
    expect(harness.connector.pendingConfirmCount()).toBe(0)
  })
})
