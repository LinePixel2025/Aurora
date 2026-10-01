/**
 * Aurora Center Web —— 组合式全局状态（登录用户 / 客户端列表 / 会话消息聚合）。
 *
 * SPA 体量小，不引入 pinia：模块级响应式单例就是全部状态。
 *
 * 事件聚合口径（docs/12 §4.2 / §10）：
 * - 下行 `clients` 是全量快照，直接替换列表；
 * - `client.event` 按 (clientId, sessionId) 过滤后按 `event.messageId` 聚合：
 *   text 增量累加、reasoning 聚成折叠块、tool 按 call.id 合并成工具卡；
 * - `user-message` 与本地乐观气泡按「内容 + 出现次数」逐条配对（同内容连续两条不会丢，
 *   见 applyEvent 的说明）；
 * - 未知 event / message 类型一律忽略（协议只增不改）。
 */
import { computed, reactive, ref } from 'vue'
import type {
  AgentEvent,
  AutomationCatalog,
  AutomationDefinition,
  AutomationHistoryQuery,
  AutomationListResult,
  AutomationRun,
  CenterProjectOption,
  CenterSessionHistoryMessage,
  CenterSessionSummary,
  CenterWebMessage,
  CenterWebServerMessage,
  ClientInfo,
  ClientStatus,
  ConfirmRequestPayload,
  JobSummary,
  PermissionMode,
  ReasoningEffort,
  SubagentSnapshot,
  TokenUsage,
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
  /**
   * 历史回放状态（docs/12 §5 第 7 步，v0.2.4）：打开会话时拉一次 `session.history`。
   * true = 已拉过（成功或已发起）；拉取失败且会话仍为空时回 false 允许重试。
   * 新建的远程会话直接置 true（没有历史可拉）。
   */
  historyLoaded?: boolean
}

export interface FileItem {
  fileId: string
  name: string
  size: number
  note?: string
  at: string
}

/** 单会话的 token 用量聚合（usage 事件驱动，docs/06 §16.2 / docs/12 §10） */
export interface SessionUsage {
  /** 最新一轮用量（promptTokens 即该轮的上下文占用） */
  latest: TokenUsage | null
  /** 本会话逐轮累加的消耗 */
  totals: { promptTokens: number; completionTokens: number; totalTokens: number }
  /** 防重：已累加过的 (requestId, round) 组合（事件重放 / 迟到不把用量翻倍） */
  counted: Set<string>
}

/** config.get 回传（脱敏）里网页端关心的 LLM 切片：模型切换与 contextWindow 占比展示用 */
export interface RemoteLlmConfig {
  /** 当前激活 provider id（对应 `llm.active`） */
  active: string
  providers: Record<
    string,
    { model: string; modelList: string[]; contextWindow: number; reasoningEffort: ReasoningEffort }
  >
}

export interface ClientEntry {
  client: ClientInfo
  /** 最近一次 client.status 快照（会话页展示模式 / 权限档 / LLM 快照 llm） */
  status: ClientStatus | null
  /** 本页签内创建过的远程会话（时间序，只展示最近一个） */
  sessionIds: string[]
  /** 该客户端的 center- 会话（session.list 结果 ∪ 本页签新建占位，updatedAt 倒序） */
  remoteSessions: CenterSessionSummary[]
  /** 每会话的 token 用量聚合（键 = sessionId；事件先到、会话未见也照常累计） */
  usageBySession: Map<string, SessionUsage>
  /** 最近一次 config.get（脱敏）解析出的 LLM 配置切片；未拉取 / 失败为 null */
  remoteLlm: RemoteLlmConfig | null
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
  /**
   * 远程自动化（docs/13 §10）：客户端存数据、Center 只转发不缓存 ——
   * 三张 Map 都只是**网页本页签的展示缓存**，刷新即重拉。
   */
  /** 自动化列表（clientId → user + builtin） */
  automationsByClient: Map<string, AutomationListResult>
  /** 组件目录（clientId → 表单元数据；编辑器动态渲染用） */
  automationCatalogByClient: Map<string, AutomationCatalog>
  /** 运行历史（clientId → triggeredAt 倒序） */
  automationHistoryByClient: Map<string, AutomationRun[]>
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
  automationsByClient: new Map(),
  automationCatalogByClient: new Map(),
  automationHistoryByClient: new Map(),
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

/**
 * 命令 `requestId`（P1-03）。**必须不可预测**：旧实现是每页从 `web-1` 起的顺序自增，
 * 任意已配对客户端只要在 30s 待回执窗口内逐个猜 `web-N`，就能把伪造 `result` 投进
 * 别人的网页会话（跨租户完整性破坏）。
 *
 * 优先 `crypto.randomUUID()`；明文 HTTP 直连 IP 部署时不是安全上下文（`randomUUID`
 * 在该上下文不存在，调用会抛错），退化为 `getRandomValues` 拼 128 位随机十六进制 ——
 * 两条路径都满足"猜不到"。服务器侧另有 pending 键按连接隔离兜底（hub.ts）。
 */
function nextRequestId(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()
  const bytes = new Uint8Array(16)
  cryptoApi?.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
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
      // llm 快照（activeProviderId / model / reasoningEffort）随 ClientStatus 一起进来，
      // 存在 entry.status 上即可（SessionListPanel / SessionView 直接读）
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
    else
      state.clients.set(info.clientId, {
        client: info,
        status: null,
        sessionIds: [],
        remoteSessions: [],
        usageBySession: new Map(),
        remoteLlm: null,
        files: [],
      })
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
  // usage 事件独立于消息流：会话未见（历史 center- 会话事件回落）也照常累计
  if (event.type === 'usage') {
    const entry = state.clients.get(clientId)
    if (entry) applyUsage(entry, sessionId, event)
    return
  }
  // 未见过的会话（他端创建 / 页面刷新后 / 事件先于列表刷新到达）：补建空壳再应用，
  // 不再丢弃 —— 丢弃会让「刷新页面后打开的会话」永远只有历史、看不到正在进行的事件。
  // 空壳的 historyLoaded 未置位：用户打开它时仍会补拉一次历史与实时条目合并。
  const session = ensureSessionState(clientId, sessionId)
  switch (event.type) {
    case 'user-message': {
      /*
       * 回显配对（P2-18）：本地发送时已乐观插入一条 `local-` 气泡，服务器随后把同一条
       * `user-message` 广播回来 —— 只能把这**一条**事件配对掉，不能"内容已存在就跳过"
       * （先后发两条相同内容的消息时，第二条会被当成第一条的回显整条丢掉）。
       * 配对口径与 mergeHistory 一致：内容 + 出现次数，逐条抵消且只认**本地乐观气泡**；
       * 配对成功就把气泡就地升级成带 seq 的权威 id，同一条事件重复到达时按 id 幂等。
       */
      if (session.items.some((item) => item.id === `user-${event.seq}`)) break
      const optimistic = session.items.find(
        (item) =>
          item.kind === 'user' && item.id.startsWith('local-') && item.content === event.content,
      )
      if (optimistic) {
        optimistic.id = `user-${event.seq}`
        break
      }
      session.items.push({
        id: `user-${event.seq}`,
        kind: 'user',
        content: event.content,
        tools: [],
      })
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
      // queued / 未知类型：不渲染（协议只增不改）
      break
  }
}

/**
 * token 用量聚合（对齐桌面端 useChat 的防重思路，docs/06 §16.2）：
 * - `latest` 直接覆盖（promptTokens 就是该轮的上下文占用）；
 * - `totals` 逐轮累加，但同一 (requestId, round) 只累加一次 ——
 *   事件重放 / 迟到事件不该把用量翻倍（round 会在新一轮请求里重新从小数起，
 *   所以键必须带 requestId 而不只是 round）。
 */
function applyUsage(
  entry: ClientEntry,
  sessionId: string,
  event: Extract<AgentEvent, { type: 'usage' }>,
): void {
  let usage = entry.usageBySession.get(sessionId)
  if (!usage) {
    usage = {
      latest: null,
      totals: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      counted: new Set<string>(),
    }
    entry.usageBySession.set(sessionId, usage)
  }
  usage.latest = event.usage
  const key = `${event.requestId}#${event.round}`
  if (usage.counted.has(key)) return
  usage.counted.add(key)
  usage.totals = {
    promptTokens: usage.totals.promptTokens + event.usage.promptTokens,
    completionTokens: usage.totals.completionTokens + event.usage.completionTokens,
    totalTokens: usage.totals.totalTokens + event.usage.totalTokens,
  }
  if (usage.counted.size > 200) {
    // 防泄漏：只留最近 200 轮的防重键（正常远小于此；超限只影响极端重放场景）
    usage.counted = new Set([...usage.counted].slice(-200))
  }
}

// ───────────────────────── 动作 ─────────────────────────

/** 取会话状态，没有则补建空壳（applyEvent 对未知会话补壳 / openRemoteSession 共用） */
function ensureSessionState(clientId: string, sessionId: string): SessionState {
  const key = sessionKey(clientId, sessionId)
  let session = state.sessions.get(key)
  if (session === undefined) {
    session = {
      clientId,
      sessionId,
      items: [],
      agentRequestId: null,
      pending: false,
    }
    state.sessions.set(key, session)
  }
  return session
}

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
    historyLoaded: true, // 新建的会话没有历史可拉
  }
  state.sessions.set(sessionKey(clientId, data.sessionId), session)
  entry?.sessionIds.push(data.sessionId)
  // 会话列表合并：本页签新建的会话若还没在 session.list 结果里，先插占位条目
  //（title 用「远程会话」，下次 listSessions 以真实数据覆盖）
  if (entry && !entry.remoteSessions.some((s) => s.sessionId === data.sessionId)) {
    mergeRemoteSessions(entry, [
      { sessionId: data.sessionId, title: '远程会话', updatedAt: new Date().toISOString() },
    ])
  }
  state.activeSessionKey = sessionKey(clientId, data.sessionId)
}

/** 打开某个远程会话（含 session.list 拉回的历史会话）：无本地会话态时先建空壳再切过去 */
export function openRemoteSession(clientId: string, sessionId: string): void {
  const key = sessionKey(clientId, sessionId)
  const session = ensureSessionState(clientId, sessionId)
  state.activeSessionKey = key
  // 历史回放（docs/12 §5 第 7 步，v0.2.4）：还没拉过历史就拉一次。
  // 回执到达时若实时事件已经落了条目（流式期间打开），mergeHistory 按
  // id / 内容去重后把历史排在实时条目之前，不重复、不错序。
  if (session.historyLoaded !== true) {
    session.historyLoaded = true
    void fetchSessionHistory(clientId, sessionId)
      .then((history) => {
        const target = state.sessions.get(key)
        if (target) mergeHistory(target, history)
      })
      .catch(() => {
        // 拉取失败且会话仍为空：回退标记，下次打开重试（失败时不闪错误，会话照常可用）
        const target = state.sessions.get(key)
        if (target && target.items.length === 0) target.historyLoaded = false
      })
  }
}

// ───────────────────────── 历史回放（docs/12 §5 第 7 步，v0.2.4） ─────────────────────────

/** 拉取某个远程会话的历史（客户端从 SessionStore 读盘回传，最近 200 条） */
async function fetchSessionHistory(
  clientId: string,
  sessionId: string,
): Promise<CenterSessionHistoryMessage[]> {
  const data = await command<CenterSessionHistoryMessage[]>({
    type: 'session.history',
    requestId: nextRequestId(),
    clientId,
    sessionId,
  })
  return Array.isArray(data) ? data : []
}

/** 历史消息 → 助手 ChatItem（工具卡入参经 summarizeInput 压成单行，与实时聚合同口径） */
function historyToAssistant(msg: CenterSessionHistoryMessage): ChatItem {
  return {
    id: msg.id,
    kind: 'assistant',
    content: msg.content,
    ...(msg.reasoning === undefined || msg.reasoning === '' ? {} : { reasoning: msg.reasoning }),
    tools: (msg.toolCalls ?? []).map((call) => ({
      id: call.id,
      name: call.name,
      state: call.state,
      inputSummary: summarizeInput(call.input),
      ...(call.outputSummary === undefined ? {} : { outputSummary: call.outputSummary }),
    })),
    streaming: false, // 历史条目都是已收尾的消息，不显示流式光标
  }
}

/**
 * 把历史合并进会话 items：历史条目排前、实时条目排后。
 *
 * 实时条目只可能来自页面打开后的事件（比历史快照新），所以这个顺序天然正确；
 * 去重保证流式期间拉取也不重复：
 * - 助手消息按**存储消息 id** 对齐（内核预领的 messageId 就是落盘 id，实时与历史同源）；
 * - 用户消息按「内容 + 出现次数」配对：live 里同内容的是**最新**的若干条，
 *   与历史里**末尾**同样多条配对跳过，更早的同内容历史条目照常保留
 *   （按纯内容 Set 去重会把「历史两条、live 一条」里的第一条也吞掉）。
 */
function mergeHistory(session: SessionState, history: CenterSessionHistoryMessage[]): void {
  if (history.length === 0) return
  const liveUserCounts = new Map<string, number>()
  for (const item of session.items) {
    if (item.kind !== 'user') continue
    liveUserCounts.set(item.content, (liveUserCounts.get(item.content) ?? 0) + 1)
  }
  const historyUserTotals = new Map<string, number>()
  for (const msg of history) {
    if (msg.role !== 'user') continue
    historyUserTotals.set(msg.content, (historyUserTotals.get(msg.content) ?? 0) + 1)
  }
  const historyUserSeen = new Map<string, number>()
  const liveAssistantIds = new Set(
    session.items.filter((item) => item.kind === 'assistant').map((item) => item.id),
  )
  const prefix: ChatItem[] = []
  for (const msg of history) {
    if (msg.role === 'user') {
      const seen = (historyUserSeen.get(msg.content) ?? 0) + 1
      historyUserSeen.set(msg.content, seen)
      // 倒数第 N 条（N = live 同内容条数）之内才跳过：live 对应历史的末尾若干条
      const remaining = (historyUserTotals.get(msg.content) ?? 0) - seen
      if (remaining < (liveUserCounts.get(msg.content) ?? 0)) continue
      prefix.push({
        id: `user-hist-${msg.id}`,
        kind: 'user',
        content: msg.content,
        tools: [],
      })
      continue
    }
    if (liveAssistantIds.has(msg.id)) continue
    prefix.push(historyToAssistant(msg))
  }
  if (prefix.length === 0) return
  session.items = [...prefix, ...session.items]
}

// ───────────────────────── 远程会话管理（docs/12 §6.3） ─────────────────────────

/** session.list 结果 ∪ 已有列表（含本页签占位），按 updatedAt 倒序 */
function mergeRemoteSessions(entry: ClientEntry, list: CenterSessionSummary[]): void {
  const merged = new Map<string, CenterSessionSummary>()
  for (const item of entry.remoteSessions) merged.set(item.sessionId, item)
  for (const item of list) merged.set(item.sessionId, item)
  entry.remoteSessions = [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** 拉取客户端的 center- 会话列表并合并进本地状态 */
export async function listSessions(clientId: string): Promise<CenterSessionSummary[]> {
  const data = await command<CenterSessionSummary[]>({
    type: 'session.list',
    requestId: nextRequestId(),
    clientId,
  })
  const entry = state.clients.get(clientId)
  if (entry && Array.isArray(data)) mergeRemoteSessions(entry, data)
  return Array.isArray(data) ? data : []
}

/** 让客户端主界面切到指定会话 */
export async function activateSession(clientId: string, sessionId: string): Promise<void> {
  await command({
    type: 'session.activate',
    requestId: nextRequestId(),
    clientId,
    sessionId,
  })
}

/** 开关会话在客户端左栏的可见性（缺省可见；隐藏仍可远程输入） */
export async function setSessionVisibility(
  clientId: string,
  sessionId: string,
  visible: boolean,
): Promise<void> {
  await command({
    type: 'session.visibility',
    requestId: nextRequestId(),
    clientId,
    sessionId,
    visible,
  })
  // 回执成功后再落本地视图状态（失败时组件侧会重新拉列表对齐）
  const summary = state.clients.get(clientId)?.remoteSessions.find((s) => s.sessionId === sessionId)
  if (summary) summary.centerVisible = visible
}

/** 会话级权限档覆盖（不动全局 agent.permissionMode；「跟随全局」无清除命令，见 SessionListPanel） */
export async function setSessionPermission(
  clientId: string,
  sessionId: string,
  permissionMode: PermissionMode,
): Promise<void> {
  await command({
    type: 'session.setPermission',
    requestId: nextRequestId(),
    clientId,
    sessionId,
    permissionMode,
  })
  const summary = state.clients.get(clientId)?.remoteSessions.find((s) => s.sessionId === sessionId)
  if (summary) summary.permissionMode = permissionMode
}

/** 会话绑定项目（'' = 清除绑定） */
export async function setSessionProject(
  clientId: string,
  sessionId: string,
  projectId: string,
): Promise<void> {
  await command({
    type: 'session.setProject',
    requestId: nextRequestId(),
    clientId,
    sessionId,
    projectId,
  })
  const summary = state.clients.get(clientId)?.remoteSessions.find((s) => s.sessionId === sessionId)
  if (summary) summary.projectId = projectId
}

/** 客户端项目选项（绑定下拉用） */
export async function listProjects(clientId: string): Promise<CenterProjectOption[]> {
  const data = await command<CenterProjectOption[]>({
    type: 'project.list',
    requestId: nextRequestId(),
    clientId,
  })
  return Array.isArray(data) ? data : []
}

/**
 * 远程切模型 / 思考等级（专用命令，不走 config.update 白名单，docs/12 §6.3）。
 * 成功后乐观更新本地 llm 快照（client.status 随后也会推新值兜底）。
 */
export async function switchLlm(
  clientId: string,
  patch: { providerId?: string; model?: string; reasoningEffort?: ReasoningEffort },
): Promise<void> {
  await command({
    type: 'llm.switch',
    requestId: nextRequestId(),
    clientId,
    ...patch,
  })
  const entry = state.clients.get(clientId)
  const llm = entry?.status?.llm
  if (!entry || !llm) return
  if (patch.providerId) {
    llm.activeProviderId = patch.providerId
    // 切 provider 时把该 provider 的默认模型 / 思考等级一并带上，避免展示串位
    const provider = entry.remoteLlm?.providers[patch.providerId]
    if (provider) {
      llm.model = patch.model ?? provider.model
      llm.reasoningEffort = patch.reasoningEffort ?? provider.reasoningEffort
    }
  }
  if (patch.model) llm.model = patch.model
  if (patch.reasoningEffort) llm.reasoningEffort = patch.reasoningEffort
}

/** config.get（脱敏全量配置）→ 解析出网页端关心的 LLM 切片并缓存到客户端条目 */
export async function fetchRemoteConfig(clientId: string): Promise<RemoteLlmConfig | null> {
  const data = await command<unknown>({
    type: 'config.get',
    requestId: nextRequestId(),
    clientId,
  })
  const llm = extractRemoteLlm(data)
  const entry = state.clients.get(clientId)
  if (entry) entry.remoteLlm = llm
  return llm
}

function extractRemoteLlm(data: unknown): RemoteLlmConfig | null {
  if (typeof data !== 'object' || data === null) return null
  const llm = (data as { llm?: unknown }).llm
  if (typeof llm !== 'object' || llm === null) return null
  const active = (llm as { active?: unknown }).active
  const providers = (llm as { providers?: unknown }).providers
  const result: RemoteLlmConfig = {
    active: typeof active === 'string' ? active : '',
    providers: {},
  }
  if (typeof providers !== 'object' || providers === null) return result
  for (const [id, raw] of Object.entries(providers as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue
    const provider = raw as Record<string, unknown>
    const modelList = Array.isArray(provider.modelList)
      ? provider.modelList.filter((m): m is string => typeof m === 'string')
      : []
    result.providers[id] = {
      model: typeof provider.model === 'string' ? provider.model : '',
      modelList,
      contextWindow: typeof provider.contextWindow === 'number' ? provider.contextWindow : 0,
      reasoningEffort:
        provider.reasoningEffort === 'low' ||
        provider.reasoningEffort === 'medium' ||
        provider.reasoningEffort === 'high'
          ? provider.reasoningEffort
          : 'auto',
    }
  }
  return result
}

// ───────────────────────── 远程自动化管理（docs/13 §10） ─────────────────────────

/** 拉取客户端的自动化列表（user + builtin）并缓存到展示状态 */
export async function listAutomations(clientId: string): Promise<AutomationListResult> {
  const data = await command<AutomationListResult>({
    type: 'automation.list',
    requestId: nextRequestId(),
    clientId,
  })
  if (data && typeof data === 'object') {
    state.automationsByClient.set(clientId, {
      user: Array.isArray(data.user) ? data.user : [],
      builtin: Array.isArray(data.builtin) ? data.builtin : [],
    })
  }
  return {
    user: Array.isArray(data?.user) ? data.user : [],
    builtin: Array.isArray(data?.builtin) ? data.builtin : [],
  }
}

/** 拉取客户端的组件目录（触发器 / 操作表单元数据）并缓存 */
export async function fetchAutomationCatalog(clientId: string): Promise<AutomationCatalog> {
  const data = await command<AutomationCatalog>({
    type: 'automation.catalog',
    requestId: nextRequestId(),
    clientId,
  })
  const catalog: AutomationCatalog = {
    conditions: Array.isArray(data?.conditions) ? data.conditions : [],
    actions: Array.isArray(data?.actions) ? data.actions : [],
  }
  state.automationCatalogByClient.set(clientId, catalog)
  return catalog
}

/**
 * 新建 / 修改一份自动化（id 为空 = 新建；启停开关也走它 —— 整份定义回传）。
 * 成功后重拉列表，让本地视图对齐客户端的真实落盘结果。
 */
export async function saveAutomation(
  clientId: string,
  definition: AutomationDefinition,
): Promise<AutomationDefinition> {
  const data = await command<AutomationDefinition>({
    type: 'automation.save',
    requestId: nextRequestId(),
    clientId,
    definition,
  })
  await listAutomations(clientId).catch(() => {})
  return data
}

/** 删除一份自动化；成功后重拉列表 */
export async function deleteAutomation(clientId: string, id: string): Promise<void> {
  await command({
    type: 'automation.delete',
    requestId: nextRequestId(),
    clientId,
    id,
  })
  await listAutomations(clientId).catch(() => {})
}

/** 手动触发一次；返回 runId（Agent Mode 下同时是会话 id） */
export async function runAutomation(clientId: string, id: string): Promise<string> {
  const data = await command<{ runId: string }>({
    type: 'automation.run',
    requestId: nextRequestId(),
    clientId,
    id,
  })
  return typeof data?.runId === 'string' ? data.runId : ''
}

/**
 * 拉取运行历史（triggeredAt 倒序）并缓存。传 automationId 时回执已按客户端过滤，
 * 此时缓存里只剩该自动化最近的历史（网页端以整表拉取为主，传参用于按行筛选刷新）。
 */
export async function fetchAutomationHistory(
  clientId: string,
  query?: AutomationHistoryQuery,
): Promise<AutomationRun[]> {
  const data = await command<AutomationRun[]>({
    type: 'automation.history',
    requestId: nextRequestId(),
    clientId,
    ...(query?.automationId === undefined ? {} : { automationId: query.automationId }),
    ...(query?.mode === undefined ? {} : { mode: query.mode }),
    ...(query?.limit === undefined ? {} : { limit: query.limit }),
  })
  const list = Array.isArray(data) ? data : []
  state.automationHistoryByClient.set(clientId, list)
  return list
}

/** 发送输入：乐观插入用户气泡（后续 user-message 事件按「内容 + 出现次数」逐条配对，不整类去重） */
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
  state.automationsByClient.clear()
  state.automationCatalogByClient.clear()
  state.automationHistoryByClient.clear()
  state.selectedClientId = ''
  state.activeSessionKey = ''
  window.location.hash = '#/login'
}

function connectSocket(): void {
  const token = getToken()
  if (token) socket.connect(token)
}
