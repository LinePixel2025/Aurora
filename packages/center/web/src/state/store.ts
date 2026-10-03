/**
 * Aurora Center Web —— 界面模型与响应式全局状态。
 *
 * SPA 体量小，不引入 pinia：模块级响应式单例就是全部状态（写操作一律走 `state/commands.ts`
 * 的动作函数，事件聚合走 `state/events.ts`，装配与消息分发在 `state/index.ts`）。
 *
 * 会话事件聚合口径（docs/12 §4.2 / §10）：
 * - 下行 `clients` 是全量快照，直接替换列表；
 * - `client.event` 按 (clientId, sessionId) 聚合：text 增量累加、reasoning 聚成思考块、
 *   tool 按 call.id 合并成工具行；
 * - `user-message` 与本地乐观气泡按「内容 + 出现次数」逐条配对；
 * - 未知 event / message 类型一律忽略（协议只增不改）。
 */
import { computed, reactive, ref } from 'vue'
import type { RemoteLlmConfig } from '../lib/remote-llm'
import type {
  AskSettleOutcome,
  AskUserRequestPayload,
  AutomationCatalog,
  AutomationDefinition,
  AutomationListResult,
  AutomationRun,
  CenterSessionSummary,
  ChatDisplayImage,
  ClientInfo,
  ClientStatus,
  ConfirmRequestPayload,
  JobSummary,
  SubagentSnapshot,
  TokenUsage,
} from '@aurora/shared'
import type { Me } from '../lib/api'
import type { SocketStatus } from '../lib/socket'

// ───────────────────────── 界面模型 ─────────────────────────

export interface ToolItem {
  /** 工具调用 id（AgentToolCall.id），同一调用的后续事件按它合并 */
  id: string
  name: string
  state: 'running' | 'success' | 'error'
  /** 输入单行摘要（不堆全量 JSON，详细入参在展开体里按需展示） */
  inputSummary: string
  /** 原始入参（解析后的对象 / 字符串）：动宾标题查表与展开体的参数块都用它 */
  input?: unknown
  outputSummary?: string
  /** 渲染层观测的起止时刻（毫秒）：工具行右侧耗时列用；历史回放条目没有 */
  startedAt?: number
  endedAt?: number
  /**
   * `task` 工具的运行快照（docs/06 §19）：随工具事件一起到达（也随持久化的工具调用
   * 一起被历史回放带回来），渲染成工具行**内部**的子代理卡（与桌面端同构）。
   */
  subagent?: SubagentSnapshot
  /** 对话图片区（show_image / generate_image）：只含无路径元数据 */
  displayImages?: ChatDisplayImage[]
}

export interface ChatItem {
  id: string
  kind: 'user' | 'assistant' | 'error' | 'job' | 'subagent' | 'ask'
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
  /**
   * kind = ask：提问卡（本轮，docs/12 §5）。
   *
   * 实时路径来自 `ask.request`（网页端把卡插进该会话的流内），历史回放路径来自
   * `session.history` 的 `kind: 'ask'` 条目 —— 两条都带着已结算信息（`settled`），
   * 因此刷新 / 换设备后「刚才问了什么、答了什么」仍然可见。
   */
  ask?: AskCardItem
  /** 本条消息的起止时刻（渲染层观测）：轨迹摘要的耗时列用 */
  startedAt?: number
  endedAt?: number
  /** 思考增量最后到达时刻（思考块秒数心跳的基准；每轮思考重置） */
  reasoningAt?: number
}

/** 提问卡在会话流里的数据（提问原文 + 选项 + 结算结果） */
export interface AskCardItem {
  requestId: string
  question: string
  header?: string
  options?: { label: string; description?: string }[]
  multiSelect: boolean
  /** 过期时间点（毫秒）：未结算的卡用它显示倒计时 */
  expiresAt: number
  /** 是否允许自由文本作答（缺省 true；false 时不渲染自由输入框） */
  allowCustom?: boolean
  /** 一次多问（1–4 个）：渲染成卡内分节；缺省 = 单问 */
  questions?: {
    question: string
    header?: string
    options?: { label: string; description?: string }[]
    multiSelect: boolean
  }[]
  /** 结算结果（本地 / 网页端作答、超时、中止都会走到这里；undefined = 仍待作答） */
  settled?: AskSettleInfo
}

/** 提问的结算信息（`ask.settled` 下行 / 网页端自己作答 / 历史回放共用一份形状） */
export interface AskSettleInfo {
  outcome: AskSettleOutcome
  /** 作答内容（`outcome === 'answered'` 时非空） */
  answers: string[]
  answersByQuestion?: string[][]
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
   * 历史回放状态（docs/12 §5 第 7 步）：打开会话时拉一次 `session.history`。
   * true = 已拉过（成功或已发起）；拉取失败且会话仍为空时回 false 允许重试。
   * 新建的远程会话直接置 true（没有历史可拉）。
   */
  historyLoaded?: boolean
  /** 会话标题（远程会话列表里带回来的；网页端自建的会话显示「远程会话」） */
  title?: string
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

export interface ClientEntry {
  client: ClientInfo
  /** 最近一次 client.status 快照（会话页展示模式 / 权限档 / LLM 快照 llm / 语音能力位） */
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

/** 待作答的提问卡（WS ask.request 转发，docs/12 §5，v0.3.3） */
export interface AskEntry {
  clientId: string
  sessionId: string
  request: AskUserRequestPayload
}
// ───────────────────────── 状态 ─────────────────────────

export interface CenterState {
  booted: boolean
  user: Me | null
  clients: Map<string, ClientEntry>
  sessions: Map<string, SessionState>
  selectedClientId: string
  activeSessionKey: string
  /** 待批复确认卡（新到追加，批复 / 过期后移除） */
  confirms: ConfirmEntry[]
  /** 待作答提问卡（同上；与确认卡同一条待办栏，先到先得） */
  asks: AskEntry[]
  /**
   * 远程自动化（docs/13 §10）：客户端存数据、Center 只转发不缓存 ——
   * 三张 Map 都只是**网页本页签的展示缓存**，刷新即重拉。
   */
  automationsByClient: Map<string, AutomationListResult>
  automationCatalogByClient: Map<string, AutomationCatalog>
  automationHistoryByClient: Map<string, AutomationRun[]>
}

/** 响应式全局状态（组件可直接读字段；写操作一律走 `state/commands.ts` 的动作函数） */
export const state = reactive<CenterState>({
  booted: false,
  user: null,
  clients: new Map(),
  sessions: new Map(),
  selectedClientId: '',
  activeSessionKey: '',
  confirms: [],
  asks: [],
  automationsByClient: new Map(),
  automationCatalogByClient: new Map(),
  automationHistoryByClient: new Map(),
})

/** 当前生效的自动化列表 / 组件目录（选中客户端维度，视图直接读） */
export function automationsOf(clientId: string): AutomationListResult {
  return state.automationsByClient.get(clientId) ?? { user: [], builtin: [] }
}

export function automationCatalogOf(clientId: string): AutomationCatalog {
  return state.automationCatalogByClient.get(clientId) ?? { conditions: [], actions: [] }
}

export function automationDefinitionsOf(clientId: string): AutomationDefinition[] {
  const list = automationsOf(clientId)
  return [...list.user, ...list.builtin]
}

export const wsStatus = ref<SocketStatus>('idle')

/** 待办栏批复 / 过期的非阻断提示（自动消隐） */
export const actionNotice = ref('')

/**
 * 「有会话被打开」信号：`openRemoteSession` 每次被调用都自增（**包括**打开的就是
 * 当前激活会话的情况——那种时候 `activeSessionKey` 不变，watch 它收不到）。
 * 消费方只有移动端抽屉的自动收起。
 */
export const sessionViewTick = ref(0)

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

export const sessionKey = (clientId: string, sessionId: string): string =>
  `${clientId}:${sessionId}`

/** 在线优先，其次按名称排序（ClientInfo 层面，快照与条目排序共用） */
export function compareClientInfo(a: ClientInfo, b: ClientInfo): number {
  if (a.online !== b.online) return a.online ? -1 : 1
  return a.name.localeCompare(b.name, 'zh-Hans-CN')
}

/** 取会话状态，没有则补建空壳（applyEvent 对未知会话补壳 / openRemoteSession 共用） */
export function ensureSessionState(clientId: string, sessionId: string): SessionState {
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

/**
 * `client.status` 的**暂存区**（非响应式）。
 *
 * 为什么需要：`client.status` 可能在 `clients` 快照之前到达（新页签先连上 WS、
 * REST 水合还没回来，或推送先于快照）—— 旧实现 `if (entry)` 会把这种状态**静默丢弃**，
 * 于是该客户端在本次页面停留期间一直显示不出状态（模式 / 权限档 / 模型 / 语音按钮）。
 * 现在先存这里，`replaceClients` 建出条目后立刻补投。
 */
export const statusBuffer = new Map<string, ClientStatus>()

/** 用全量快照替换客户端列表（`clients` 消息与 REST 水合共用） */
export function replaceClients(list: ClientInfo[]): void {
  const seen = new Set<string>()
  for (const info of list) {
    seen.add(info.clientId)
    const entry = state.clients.get(info.clientId)
    if (entry) {
      entry.client = info
      continue
    }
    const buffered = statusBuffer.get(info.clientId) ?? null
    statusBuffer.delete(info.clientId)
    state.clients.set(info.clientId, {
      client: info,
      status: buffered,
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

/**
 * 选中客户端（并在它有本页签会话时切到最近那个）。
 * 这里直接写 state 而不调 commands 的动作，避免 store ↔ commands 的循环引用。
 */
export function selectClient(clientId: string): void {
  state.selectedClientId = clientId
  const entry = state.clients.get(clientId)
  const last = entry?.sessionIds.at(-1)
  state.activeSessionKey = last ? sessionKey(clientId, last) : ''
}

// ───────────────────────── 提问卡（docs/12 §5，本轮） ─────────────────────────

/** 流内提问卡条目的 id：与待办栏的 requestId 同源，便于两条路径互相定位 */
export function askItemId(requestId: string): string {
  return `ask-${requestId}`
}

/**
 * 把一张提问卡插进**该会话的流内**（实时路径；幂等）。
 *
 * 与待办栏（`state.asks`）并存：控制台顶部那条只在「该提问所属会话未打开」时展示，
 * 流内这张则跟着消息一起排 —— 同一张卡不会同时出现两处。
 * 会话状态不存在时先建（事件可能早于网页端打开会话到达）。
 */
export function pushAskItem(
  clientId: string,
  sessionId: string,
  request: AskUserRequestPayload,
): void {
  const session = ensureSessionState(clientId, sessionId)
  const id = askItemId(request.requestId)
  if (session.items.some((item) => item.id === id)) return
  session.items.push({
    id,
    kind: 'ask',
    content: request.question,
    tools: [],
    ask: {
      requestId: request.requestId,
      question: request.question,
      ...(request.header === undefined ? {} : { header: request.header }),
      ...(request.options === undefined ? {} : { options: request.options }),
      multiSelect: request.multiSelect,
      expiresAt: request.expiresAt,
      // 本轮：只许选 / 一次多问都随卡片带过来（网页端与桌面端同一套渲染口径）
      ...(request.allowCustom === false ? { allowCustom: false } : {}),
      ...(request.questions === undefined ? {} : { questions: request.questions }),
    },
  })
}

/**
 * 结算一张提问卡（本地作答 / 网页端自己作答 / 超时 / 中止都走这里）。
 *
 * 两处状态一起收：待办栏条目**移除**（它只列待答的），流内条目**保留并打上结算结果**
 * （留痕：刷新后仍能从历史回放看到「问了什么、答了什么」）。
 */
export function settleAsk(clientId: string, requestId: string, info: AskSettleInfo): void {
  const index = state.asks.findIndex(
    (entry) => entry.clientId === clientId && entry.request.requestId === requestId,
  )
  if (index >= 0) state.asks.splice(index, 1)
  const id = askItemId(requestId)
  for (const session of state.sessions.values()) {
    if (session.clientId !== clientId) continue
    const item = session.items.find((entry) => entry.id === id)
    if (item?.ask !== undefined) item.ask.settled = info
  }
}

/** 待办栏里的提问条目 → 卡片数据（AskCard 的数据驱动形状，与流内条目同形） */
export function askCardOf(entry: AskEntry): AskCardItem {
  return {
    requestId: entry.request.requestId,
    question: entry.request.question,
    ...(entry.request.header === undefined ? {} : { header: entry.request.header }),
    ...(entry.request.options === undefined ? {} : { options: entry.request.options }),
    multiSelect: entry.request.multiSelect,
    expiresAt: entry.request.expiresAt,
    ...(entry.request.allowCustom === false ? { allowCustom: false } : {}),
    ...(entry.request.questions === undefined ? {} : { questions: entry.request.questions }),
  }
}
