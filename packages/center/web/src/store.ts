/**
 * Aurora Center Web —— 组合式全局状态（登录用户 / 客户端列表 / 会话消息聚合）。
 *
 * SPA 体量小，不引入 pinia：模块级响应式单例就是全部状态。
 *
 * 事件聚合口径（docs/12 §4.2 / §10）：
 * - 下行 `clients` 是全量快照，直接替换列表；
 * - `client.event` 按 (clientId, sessionId) 过滤后按 `event.messageId` 聚合：
 *   text 增量累加、reasoning 聚成折叠块、tool 按 call.id 合并成工具卡；
 * - `user-message` 按内容去重（本地发送时已乐观插入同一条）；
 * - 未知 event / message 类型一律忽略（协议只增不改）。
 */
import { computed, reactive, ref } from 'vue'
import type {
  AgentEvent,
  CenterWebMessage,
  CenterWebServerMessage,
  ClientInfo,
  ClientStatus,
  ConfirmRequestPayload,
  JobSummary,
  SubagentSnapshot,
} from '@aurora/shared'
import {
  api,
  CenterSocket,
  clearAuth,
  getToken,
  loadStoredAuth,
  saveAuth,
  type Me,
  type SocketStatus,
} from './api'

// ───────────────────────── 界面模型 ─────────────────────────

export interface ToolItem {
  /** 工具调用 id（AgentToolCall.id），同一调用的后续事件按它合并 */
  id: string
  name: string
  state: 'running' | 'success' | 'error'
  /** 输入单行摘要（不堆全量 JSON） */
  inputSummary: string
  outputSummary?: string
}

export interface ChatItem {
  id: string
  kind: 'user' | 'assistant' | 'error' | 'job' | 'subagent'
  content: string
  /** 思考过程增量聚合（按 messageId 归属到助手消息） */
  reasoning?: string
  tools: ToolItem[]
  /** 助手消息仍在接收增量时为 true（done 后清除） */
  streaming?: boolean
  /** kind = error 时的错误码 */
  code?: string
  /** kind = job：最新一条任务摘要（后续 job 事件原地覆盖，一个会话只留一张卡） */
  job?: JobSummary
  /** kind = subagent：该 task 调用的最新快照（按 callId 合并覆盖） */
  subagent?: SubagentSnapshot
}

export interface SessionState {
  clientId: string
  sessionId: string
  items: ChatItem[]
  /** 最近一次 session.input 回执携带的 agentRequestId（session.abort 必需） */
  agentRequestId: string | null
  /** 本轮请求尚未收到 done / error */
  pending: boolean
}

export interface FileItem {
  fileId: string
  name: string
  size: number
  note?: string
  at: string
}

export interface ClientEntry {
  client: ClientInfo
  /** 最近一次 client.status 快照（会话页展示模式 / 权限档） */
  status: ClientStatus | null
  /** 本页签内创建过的远程会话（时间序，只展示最近一个） */
  sessionIds: string[]
  /** 该客户端发来的文件（新的在前，内存持有） */
  files: FileItem[]
}

/** 待批复的敏感工具确认卡（WS confirm.request 转发，docs/12 §5.1） */
export interface ConfirmEntry {
  clientId: string
  sessionId: string
  request: ConfirmRequestPayload
}

// ───────────────────────── 状态 ─────────────────────────

interface CenterState {
  booted: boolean
  user: Me | null
  clients: Map<string, ClientEntry>
  sessions: Map<string, SessionState>
  selectedClientId: string
  activeSessionKey: string
  /** 待批复确认卡（新到追加，批复 / 过期后移除） */
  confirms: ConfirmEntry[]
}

/** 响应式全局状态（组件可直接读字段；写操作一律走下面的动作函数） */
export const state = reactive<CenterState>({
  booted: false,
  user: null,
  clients: new Map(),
  sessions: new Map(),
  selectedClientId: '',
  activeSessionKey: '',
  confirms: [],
})

export const wsStatus = ref<SocketStatus>('idle')

/** 确认卡批复 / 过期的非阻断提示（自动消隐） */
export const confirmNotice = ref('')

export const booted = computed(() => state.booted)
export const currentUser = computed(() => state.user)
export const clientsSorted = computed<ClientEntry[]>(() =>
  [...state.clients.values()].sort((a, b) => compareClientInfo(a.client, b.client)),
)
export const selectedEntry = computed<ClientEntry | null>(
  () => state.clients.get(state.selectedClientId) ?? null,
)
export const activeSession = computed<SessionState | null>(() =>
  state.activeSessionKey ? (state.sessions.get(state.activeSessionKey) ?? null) : null,
)

const sessionKey = (clientId: string, sessionId: string): string => `${clientId}:${sessionId}`

/** 在线优先，其次按名称排序（ClientInfo 层面，快照与条目排序共用） */
function compareClientInfo(a: ClientInfo, b: ClientInfo): number {
  if (a.online !== b.online) return a.online ? -1 : 1
  return a.name.localeCompare(b.name, 'zh-Hans-CN')
}

// ───────────────────────── WS 与命令回执 ─────────────────────────

const socket = new CenterSocket()
socket.onStatus = (status) => {
  wsStatus.value = status
}
socket.onMessage = (message) => handleServerMessage(message)

interface PendingCommand {
  resolve: (data: unknown) => void
  reject: (error: Error) => void
  timer: number
}

const pendingCommands = new Map<string, PendingCommand>()
let requestSeq = 0

function nextRequestId(): string {
  requestSeq += 1
  return `web-${requestSeq}`
}

/** 上行一条命令并等 result 回执；ok=false / 超时 / 连接未就绪都按错误处理 */
function command<T>(message: CenterWebMessage, timeoutMs = 30_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!socket.send(message)) {
      reject(new Error('与 Center 的连接尚未建立，请稍候重试'))
      return
    }
    const timer = window.setTimeout(() => {
      pendingCommands.delete(message.requestId)
      reject(new Error('Center 未在时限内回执（客户端可能离线或正忙）'))
    }, timeoutMs)
    pendingCommands.set(message.requestId, {
      resolve: resolve as (data: unknown) => void,
      reject,
      timer,
    })
  })
}

function handleServerMessage(message: CenterWebServerMessage): void {
  switch (message.type) {
    case 'clients':
      replaceClients(message.clients)
      break
    case 'client.status': {
      const entry = state.clients.get(message.clientId)
      if (entry) entry.status = message.status
      break
    }
    case 'client.event':
      applyEvent(message.clientId, message.sessionId, message.event)
      break
    case 'result': {
      const pending = pendingCommands.get(message.requestId)
      if (!pending) break
      pendingCommands.delete(message.requestId)
      window.clearTimeout(pending.timer)
      if (message.ok) pending.resolve(message.data)
      else pending.reject(new Error(message.error || '命令执行失败'))
      break
    }
    case 'file.received': {
      const entry = state.clients.get(message.clientId)
      if (entry) {
        entry.files.unshift({
          fileId: message.fileId,
          name: message.name,
          size: message.size,
          note: message.note,
          at: message.at,
        })
        if (entry.files.length > 50) entry.files.length = 50
      }
      break
    }
    case 'confirm.request': {
      // 敏感工具确认卡：同一 confirmId 只入列一次（服务器可能向属主与管理员各转发一份）
      if (!state.confirms.some((c) => c.request.confirmId === message.request.confirmId)) {
        state.confirms.push({
          clientId: message.clientId,
          sessionId: message.sessionId,
          request: message.request,
        })
      }
      break
    }
    default:
      // 未知消息类型一律忽略（协议只增不改）
      break
  }
}

function replaceClients(list: ClientInfo[]): void {
  const seen = new Set<string>()
  for (const info of list) {
    seen.add(info.clientId)
    const entry = state.clients.get(info.clientId)
    if (entry) entry.client = info
    else state.clients.set(info.clientId, { client: info, status: null, sessionIds: [], files: [] })
  }
  for (const clientId of [...state.clients.keys()]) {
    if (!seen.has(clientId)) state.clients.delete(clientId)
  }
  // 首次拿到快照时自动选中第一个客户端（在线的优先）
  if (!state.selectedClientId && list.length > 0) {
    const first = [...list].sort(compareClientInfo)[0]
    if (first) selectClient(first.clientId)
  }
}

// ───────────────────────── 会话事件聚合 ─────────────────────────

function ensureAssistant(session: SessionState, messageId: string): ChatItem {
  const existing = session.items.find((item) => item.kind === 'assistant' && item.id === messageId)
  if (existing) return existing
  const created: ChatItem = {
    id: messageId,
    kind: 'assistant',
    content: '',
    tools: [],
    streaming: true,
  }
  session.items.push(created)
  return created
}

/** 工具输入的单行摘要：过长截断，工具卡里不堆全量 JSON（docs/12 §10） */
export function summarizeInput(input: unknown): string {
  if (input === undefined || input === null) return ''
  if (typeof input === 'string') return input
  try {
    const json = JSON.stringify(input) ?? String(input)
    return json.length > 160 ? `${json.slice(0, 160)}…` : json
  } catch {
    return String(input)
  }
}

function applyEvent(clientId: string, sessionId: string, event: AgentEvent): void {
  const session = state.sessions.get(sessionKey(clientId, sessionId))
  if (!session) return // 未见过的会话（他端创建 / 页面刷新后）不渲染
  switch (event.type) {
    case 'user-message': {
      // 去重：同一会话内相同内容已存在则跳过（本地发送时已乐观插入）
      const duplicated = session.items.some(
        (item) => item.kind === 'user' && item.content === event.content,
      )
      if (!duplicated) {
        session.items.push({
          id: `user-${event.seq}`,
          kind: 'user',
          content: event.content,
          tools: [],
        })
      }
      break
    }
    case 'text':
      ensureAssistant(session, event.messageId).content += event.delta
      break
    case 'reasoning': {
      const item = ensureAssistant(session, event.messageId)
      item.reasoning = (item.reasoning ?? '') + event.delta
      break
    }
    case 'tool': {
      const item = ensureAssistant(session, event.messageId)
      const call = event.call
      const existing = item.tools.find((tool) => tool.id === call.id)
      if (existing) {
        existing.state = call.state
        if (call.outputSummary) existing.outputSummary = call.outputSummary
      } else {
        item.tools.push({
          id: call.id,
          name: call.name,
          state: call.state,
          inputSummary: summarizeInput(call.input),
          outputSummary: call.outputSummary,
        })
      }
      break
    }
    case 'job': {
      // 任务清单卡：一个会话只保留最新一条 job 摘要，后续事件原地覆盖
      const existing = session.items.find((item) => item.kind === 'job')
      if (existing) existing.job = event.job
      else
        session.items.push({
          id: `job-${event.job.id}`,
          kind: 'job',
          content: '',
          tools: [],
          job: event.job,
        })
      break
    }
    case 'subagent': {
      // 子代理卡：同一 task 调用（callId）的最新快照覆盖旧值
      const existing = session.items.find(
        (item) => item.kind === 'subagent' && item.subagent?.callId === event.callId,
      )
      if (existing) existing.subagent = event.subagent
      else
        session.items.push({
          id: `subagent-${event.callId}`,
          kind: 'subagent',
          content: '',
          tools: [],
          subagent: event.subagent,
        })
      break
    }
    case 'done': {
      session.pending = false
      for (const item of session.items) item.streaming = false
      break
    }
    case 'error': {
      session.pending = false
      session.items.push({
        id: `error-${event.seq}`,
        kind: 'error',
        content: event.message,
        code: event.code,
        tools: [],
      })
      break
    }
    default:
      // queued / usage / 未知类型：不渲染（协议只增不改）
      break
  }
}

// ───────────────────────── 动作 ─────────────────────────

export function selectClient(clientId: string): void {
  state.selectedClientId = clientId
  const entry = state.clients.get(clientId)
  const last = entry?.sessionIds.at(-1)
  state.activeSessionKey = last ? sessionKey(clientId, last) : ''
}

/** 新建远程会话：session.create → result 回执 data.sessionId → 进入会话视图 */
export async function startSession(clientId: string): Promise<void> {
  const data = await command<{ sessionId: string }>({
    type: 'session.create',
    requestId: nextRequestId(),
    clientId,
  })
  const entry = state.clients.get(clientId)
  const session: SessionState = {
    clientId,
    sessionId: data.sessionId,
    items: [],
    agentRequestId: null,
    pending: false,
  }
  state.sessions.set(sessionKey(clientId, data.sessionId), session)
  entry?.sessionIds.push(data.sessionId)
  state.activeSessionKey = sessionKey(clientId, data.sessionId)
}

/** 发送输入：乐观插入用户气泡（后续 user-message 事件按内容去重） */
export async function sendInput(session: SessionState, text: string): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed || session.pending) return
  session.items.push({
    id: `local-${Date.now()}-${session.items.length}`,
    kind: 'user',
    content: trimmed,
    tools: [],
  })
  session.pending = true
  try {
    const data = await command<{ agentRequestId?: string }>({
      type: 'session.input',
      requestId: nextRequestId(),
      clientId: session.clientId,
      sessionId: session.sessionId,
      text: trimmed,
    })
    if (typeof data?.agentRequestId === 'string') session.agentRequestId = data.agentRequestId
  } catch (error) {
    session.pending = false
    session.items.push({
      id: `error-${Date.now()}`,
      kind: 'error',
      content: error instanceof Error ? error.message : String(error),
      tools: [],
    })
  }
}

/** 中止本轮：需要 session.input 回执带出的 agentRequestId */
export async function abortSession(session: SessionState): Promise<void> {
  if (!session.agentRequestId) {
    throw new Error('尚未取得可中止的请求（客户端还没受理本轮输入）')
  }
  await command({
    type: 'session.abort',
    requestId: nextRequestId(),
    clientId: session.clientId,
    sessionId: session.sessionId,
    agentRequestId: session.agentRequestId,
  })
}

// ───────────────────────── 确认卡批复 ─────────────────────────

let noticeTimer: number | undefined

function showConfirmNotice(text: string): void {
  confirmNotice.value = text
  if (noticeTimer !== undefined) window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => {
    confirmNotice.value = ''
    noticeTimer = undefined
  }, 6000)
}

function removeConfirm(confirmId: string): void {
  const index = state.confirms.findIndex((c) => c.request.confirmId === confirmId)
  if (index >= 0) state.confirms.splice(index, 1)
}

/** 批复一张确认卡；result 回执成功才静默移除，失败按拒绝处理并提示（docs/12 §5.1） */
export async function resolveConfirm(entry: ConfirmEntry, approved: boolean): Promise<void> {
  try {
    await command({
      type: 'confirm.resolve',
      requestId: nextRequestId(),
      clientId: entry.clientId,
      confirmId: entry.request.confirmId,
      approved,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    showConfirmNotice(
      approved ? `确认批复未生效，已按拒绝处理：${reason}` : `拒绝批复未送达：${reason}`,
    )
  } finally {
    removeConfirm(entry.request.confirmId)
  }
}

/** 倒计时归零：客户端侧超时同样按拒绝收尾，这里把卡摘掉并提示 */
export function expireConfirm(entry: ConfirmEntry): void {
  removeConfirm(entry.request.confirmId)
  showConfirmNotice('确认请求已过期，客户端会按拒绝处理')
}

// ───────────────────────── 登录 / 启动 ─────────────────────────

/** 页面加载时调用：恢复本地登录态（过期则清除），并尝试水合客户端列表 */
/** 远程切换客户端模式（docs/12 §6.2：客户端侧白名单最终裁决） */
export async function switchMode(clientId: string, mode: ClientStatus['mode']): Promise<void> {
  await command<void>({
    type: 'mode.switch',
    requestId: nextRequestId(),
    clientId,
    mode,
  })
  // 成功后客户端会回推新的 client.status；这里不重复改本地状态
}

/** 远程更新客户端配置（仅白名单路径：agent.tools.* 开关等） */
export async function updateConfig(
  clientId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await command<void>({
    type: 'config.update',
    requestId: nextRequestId(),
    clientId,
    patch,
  })
}

export async function boot(): Promise<void> {
  const stored = loadStoredAuth()
  if (stored) {
    try {
      state.user = await api.me()
      // WS 快照到达前先用 REST 水合一次（离线也能立刻看到设备）；失败不阻塞启动
      try {
        const data = await api.clients()
        replaceClients(data.clients)
      } catch {
        // 等 WS 快照兜底
      }
      connectSocket()
    } catch {
      clearAuth() // 令牌无效 / 已过期
    }
  }
  state.booted = true
}

export async function login(username: string, password: string): Promise<void> {
  const result = await api.login(username, password)
  saveAuth(result.token, result.user)
  state.user = result.user
  connectSocket()
}

/** 自助注册：成功即登录（响应与 login 同形状），调用方进入控制台 */
export async function register(username: string, password: string): Promise<void> {
  const result = await api.register(username, password)
  saveAuth(result.token, result.user)
  state.user = result.user
  connectSocket()
}

export function logout(): void {
  socket.close()
  for (const pending of pendingCommands.values()) window.clearTimeout(pending.timer)
  pendingCommands.clear()
  if (noticeTimer !== undefined) window.clearTimeout(noticeTimer)
  noticeTimer = undefined
  confirmNotice.value = ''
  clearAuth()
  state.user = null
  state.clients.clear()
  state.sessions.clear()
  state.confirms.splice(0)
  state.selectedClientId = ''
  state.activeSessionKey = ''
  window.location.hash = '#/login'
}

function connectSocket(): void {
  const token = getToken()
  if (token) socket.connect(token)
}
