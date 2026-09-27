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
