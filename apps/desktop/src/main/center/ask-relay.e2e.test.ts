/**
 * 提问卡中转到 Center 的**真端到端**（docs/12 §5，v0.3.3）。
 *
 * 为什么值得单列一条集成用例：把「真 Center 服务器 + 真连接器（真 WS）+ 真会话桥 +
 * 真 ask-relay + 真 AskUserService」串起来跑一遍，覆盖的正是**装配层**那几行 ——
 * 单测只能验各自的判定，验不了"它们接在一起会不会通"。与 `server.test.ts` 的分工：
 * 那边用脚本化的客户端验服务器路由，这边用**生产装配**（连接器 + 服务实例）验，
 * 且不需要 Electron（`ask-user.ts` / `connector.ts` / `center/*` 都是纯 Node）。
 *
 * 覆盖四条验收：① 远程会话的提问到得了网页（含 requestId / 选项原样）；
 * ② 网页作答结算内核 Promise 且回执 `{ settled: true }`；③ 本地会话的提问**绝不出网**；
 * ④ 重复批复 / 迟到的批复幂等（先到先得，回 `settled: false`）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { AuthStore, createCenterServer, type RunningCenterServer } from '@aurora/center'
import { createAskUserService, type AskUserService } from '../ask-user.js'
import { createAskRelay } from './ask-relay.js'
import { CenterConnector } from './connector.js'
import { SessionBridge } from './session-bridge.js'
import type { Logger } from '@aurora/shared'

const ADMIN = { username: 'e2e-admin', password: 'e2e-pass-123' }
const CLIENT_ID = 'client-ask-e2e'

const logger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger

let server: RunningCenterServer
let base = ''
let wsBase = ''
let clientToken = ''
let webToken = ''
let connector: CenterConnector | undefined
let askUser: AskUserService | undefined
/** 每次提问的 requestId（本地会话那条要在本机结算，见第二个用例） */
const askedIds: string[] = []

/** 收集 WS 帧并提供「等到某类帧」的等待器（同 server.test.ts 的思路） */
function collector(socket: WebSocket) {
  const frames: Array<Record<string, unknown>> = []
  const waiters: Array<{ match: (frame: Record<string, unknown>) => boolean; done: () => void }> =
    []
  socket.on('message', (raw) => {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(String(raw)) as Record<string, unknown>
    } catch {
      return
    }
    frames.push(parsed)
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]
      if (waiter !== undefined && waiter.match(parsed)) {
        waiters.splice(index, 1)
        waiter.done()
      }
    }
  })
  return {
    frames,
    wait: (match: (frame: Record<string, unknown>) => boolean, timeoutMs = 5000) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const existing = frames.find(match)
        if (existing !== undefined) {
          resolve(existing)
          return
        }
        const timer = setTimeout(() => reject(new Error('等待 WS 帧超时')), timeoutMs)
        waiters.push({
          match,
          done: () => {
            clearTimeout(timer)
            resolve(frames.find(match) ?? {})
          },
        })
      }),
  }
}

async function connectWebSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
  return socket
}

beforeAll(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'aurora-ask-e2e-'))
  const boot = new AuthStore({ dataDir })
  await boot.init()
  await boot.createUser({ username: ADMIN.username, password: ADMIN.password, role: 'admin' })

  server = createCenterServer({ dataDir })
  const { port } = await server.listen(0, '127.0.0.1')
  base = `http://127.0.0.1:${port}`
  wsBase = `ws://127.0.0.1:${port}`

  const loginResponse = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ADMIN),
  })
  expect(loginResponse.status).toBe(200)
  webToken = ((await loginResponse.json()) as { token: string }).token

  const clientLogin = await fetch(`${base}/api/client/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...ADMIN, clientId: CLIENT_ID }),
  })
  expect(clientLogin.status).toBe(200)
  clientToken =
    ((await clientLogin.json()) as { data?: { token?: string }; token?: string }).token ?? ''

  askUser = createAskUserService({
    logger,
    // 生产里这一步是把对话窗显示并聚焦（提问卡片得有地方显示）；测试里没有窗口，给个空实现
    present: () => {},
  })

  // 生产装配：会话桥（真 agent 桩）+ 连接器（真 ws）+ 上行 emit 的绑定方式与 index.ts 一致
  const sentInputs: Array<{ sessionId: string; text: string }> = []
  const bridge = new SessionBridge({
    agent: {
      send: async (request) => {
        sentInputs.push({ sessionId: request.sessionId, text: request.text })
        return { requestId: 'req-e2e' }
      },
      abort: () => true,
      onEvent: () => () => {},
    },
    logger,
  })

  let relayEmit: ((message: unknown) => void) | undefined
  connector = new CenterConnector({
    logger,
    config: () => ({
      enabled: true,
      serverUrl: wsBase,
      token: clientToken,
      clientId: CLIENT_ID,
      displayName: '提问机',
      allowRemoteSession: true,
      allowRemoteConfig: true,
      allowFileTransfer: true,
    }),
    statusSnapshot: () => ({
      mode: 'work',
      version: '0.3.3-e2e',
      platform: 'win32',
      agent: {
        permissionMode: 'auto',
        tools: { enabled: true, files: true, search: true, open: true, terminal: true },
      },
      center: { allowRemoteSession: true, allowRemoteConfig: true, allowFileTransfer: true },
      llm: { activeProviderId: 'p1', model: 'e2e-model', reasoningEffort: 'auto' },
      voice: { stt: true, tts: true },
    }),
    version: '0.3.3-e2e',
    platform: 'win32',
    hostname: () => 'E2E-HOST',
    applyRemotePatch: async () => undefined,
    switchMode: async () => undefined,
    getRedactedConfig: () => ({}),
    sessionHandler: bridge,
    resolveConfirm: () => false,
    resolveAsk: (input) => askUser?.resolve(input) ?? false,
    bindSessionEmit: (emit) => {
      bridge.bindEmit(emit)
      relayEmit = emit
    },
  })

  askUser.onRequest((request) => {
    askedIds.push(request.requestId)
  })

  askUser.onRequest(
    createAskRelay({
      emit: () => relayEmit,
      allowRemoteSession: () => true,
      enqueue: (message) => connector?.enqueueAsk(message),
      logger,
    }),
  )

  connector.start()
  // 等连接就绪（连接器自己会重连，这里只等一次成功）
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (connector.connectionState().state === 'connected') break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  expect(connector.connectionState().state).toBe('connected')
  expect(sentInputs).toEqual([])
}, 30_000)

afterAll(async () => {
  connector?.dispose?.()
  await server.close()
})

describe('ask_user 中转到 Center · 真端到端（docs/12 §5）', () => {
  it('远程会话的提问到达网页 → 网页作答结算内核 Promise → 重复批复幂等', async () => {
    const web = await connectWebSocket(`${wsBase}/api/ws?token=${webToken}`)
    const webFrames = collector(web)
    try {
      // 网页建一个远程会话（服务器分配 center- 前缀 id 并记账属主）
      web.send(
        JSON.stringify({ type: 'session.create', requestId: 'w-create', clientId: CLIENT_ID }),
      )
      const created = await webFrames.wait((frame) => frame['requestId'] === 'w-create')
      expect(created['ok']).toBe(true)
      const sessionId = (created['data'] as { sessionId: string }).sessionId
      expect(sessionId.startsWith('center-')).toBe(true)

      // 内核侧发起一次提问（真实链路：AskUserPort.ask → onRequest → ask-relay → 连接器 → 服务器）
      const answerPromise = askUser?.ask(
        {
          question: '整理的课表放哪个目录？',
          header: '目标目录',
          options: [{ label: 'dist', description: '构建产物目录' }, { label: 'out' }],
          multiSelect: false,
        },
        { sessionId },
      )

      const askFrame = await webFrames.wait((frame) => frame['type'] === 'ask.request')
      expect(askFrame['clientId']).toBe(CLIENT_ID)
      expect(askFrame['sessionId']).toBe(sessionId)
      const request = askFrame['request'] as {
        requestId: string
        question: string
        options: Array<{ label: string }>
        expiresAt: number
      }
      expect(request.question).toBe('整理的课表放哪个目录？')
      expect(request.options.map((option) => option.label)).toEqual(['dist', 'out'])
      // expiresAt 是毫秒时间戳（不是 ISO 串），网页端据此倒计时
      expect(typeof request.expiresAt).toBe('number')
      expect(request.expiresAt).toBeGreaterThan(Date.now())

      // 网页作答 → 客户端结算 → 内核 Promise 拿到答案
      web.send(
        JSON.stringify({
          type: 'ask.resolve',
          requestId: request.requestId,
          clientId: CLIENT_ID,
          sessionId,
          answers: ['dist'],
        }),
      )
      const answer = await answerPromise
      expect(answer).toEqual({ answers: ['dist'] })

      // 网页端拿到 `{ settled: true }` 回执（同一 requestId）
      const result = await webFrames.wait(
        (frame) => frame['type'] === 'result' && frame['requestId'] === request.requestId,
      )
      expect(result['ok']).toBe(true)
      expect(result['data']).toEqual({ settled: true })

      // 先到先得：再答一次同一张卡 → settled:false（卡片早已结算），不抛错
      web.send(
        JSON.stringify({
          type: 'ask.resolve',
          requestId: request.requestId,
          clientId: CLIENT_ID,
          sessionId,
          answers: ['out'],
        }),
      )
      const second = await webFrames.wait(
        (frame) =>
          frame['type'] === 'result' &&
          frame['requestId'] === request.requestId &&
          frame !== result,
      )
      expect(second['ok']).toBe(true)
      expect(second['data']).toEqual({ settled: false })
    } finally {
      web.close()
    }
  }, 20_000)

  it('本地会话（非 center-）的提问绝不出网', async () => {
    const web = await connectWebSocket(`${wsBase}/api/ws?token=${webToken}`)
    const webFrames = collector(web)
    try {
      const answerPromise = askUser?.ask(
        { question: '这条只该问本机', multiSelect: false },
        { sessionId: 'quick' },
      )
      // 给链路一点时间（真的发了就会被收到）
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(webFrames.frames.filter((frame) => frame['type'] === 'ask.request')).toHaveLength(0)
      expect(askUser?.pendingCount()).toBe(1)
      // 未知 requestId 的批复幂等返回 false（不会把别的提问结算掉）
      expect(askUser?.resolve({ requestId: 'ask-不存在的-id', answers: ['x'] })).toBe(false)
      // 本机作答照常（本地卡片那条通道不受影响）——顺带把这条提问结算掉，
      // 否则服务里的 3 分钟超时定时器会吊住测试进程
      const localId = askedIds[askedIds.length - 1] ?? ''
      expect(localId).not.toBe('')
      expect(askUser?.resolve({ requestId: localId, answers: ['本机作答'] })).toBe(true)
      expect(await answerPromise).toEqual({ answers: ['本机作答'] })
    } finally {
      web.close()
    }
  }, 20_000)
})
