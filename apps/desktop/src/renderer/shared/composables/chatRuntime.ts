/**
 * 会话级运行态（SessionRuntime）与活动态（SessionActivity）的纯逻辑（2026-11-07，docs/06 §4.3）。
 *
 * 为什么单独一个模块：`useChat` 的 IPC 接线 / 水合 / 会话命令已经够长，而"一条事件属于哪个会话、
 * 切走再切回还剩什么"是**最容易写错、也最值得单测**的部分。这里不依赖 Electron / DOM / Vue 响应式，
 * 只吃纯数据（响应式容器由 `useChat` 负责包），因此 `vitest` 的 node 环境能直接覆盖：
 * - 两个会话交错到达的增量绝不互相污染；
 * - `finishedRequests` / `activeRequest` 的陈旧事件过滤是**每会话一套**；
 * - 后台会话收尾只写活动态（未读 / 失败），不碰当前会话；
 * - 水合合并、按 seq 插入、LRU 淘汰、隐藏会话过滤都是纯函数。
 *
 * 文本 / 思考增量不在这里入缓冲：`useChat` 先把它们交给共享的 `createDeltaBuffer`（按帧合并），
 * 再由本模块的 `applyStreamDelta` 落到对应会话的消息上。
 */
import type {
  AgentEvent,
  AgentJob,
  AgentToolCall,
  ChatMessageDto,
  JobSummary,
  SubagentSnapshot,
  TokenUsage,
} from '@aurora/shared'

/** 一条渲染层消息（原定义在 `useChat.ts`，2026-11-07 起随运行态下沉到这里） */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  pending?: boolean
  error?: boolean
  createdAt: number
  /**
   * 创建这条消息的事件序号（主进程分配的会话内单调序号）。
   * 本地消息（自己发的 user 气泡、发送失败提示）push 时没有 seq、保持数组原位；
   * user 气泡随后会由 `user-message` 广播补上 seq（同一条消息的确认）。
   */
  seq?: number
  /** 产生这条消息的 Agent 请求 id（实时事件 / 历史回放透传）。 */
  requestId?: string
  /**
   * 排队中（docs/06 §5.3）：会话正在回复时发出去的那句话，内核把它排进了队列而不是立即执行，
   * 会在下一次轮次边界插进正在跑的请求。界面据此在气泡上挂一枚「排队中」，
   * 并由 `user-message` 的回声（同文本对账）把它转正；点「停止」时这些气泡会被收回输入框。
   */
  queued?: boolean
  /** 工具执行卡片（运行中 / 成功 / 失败） */
  toolCalls?: AgentToolCall[]
  /** 本条用户消息携带的附件文件名（仅用于气泡内展示） */
  attachments?: string[]
  /**
   * 模型思考过程（reasoning_content 聚合）。
   * 流式期间由 `reasoning` 事件按轮次实时同步进对应助手消息；请求收尾后固化，
   * 历史（`chat:history`）水合的消息自带该字段。
   */
  reasoning?: string
}

/** 子代理运行记录：快照 + 它挂在哪条助手消息上（「子代理」页面按会话聚合展示） */
export interface SubagentRun extends SubagentSnapshot {
  messageId: string
}

/**
 * 排队中又被收回的那句话（docs/06 §5.3）：文本 + 原始附件路径。
 *
 * 单独一份是因为气泡上只有**文件名**（展示用），而「停止 / 打断并发送」要能把这句话
 * 连同附件一起还原回输入框或立刻发出去。
 */
export interface QueuedDraft {
  text: string
  attachments: string[]
}

/** token 用量状态（`latest` 是本轮占用，`totals` 是本会话累计） */
export interface UsageState {
  latest: TokenUsage | null
  totals: TokenUsage
}

/** 一条待写入的流式增量（text / reasoning 两条链路共用同一个缓冲） */
export type ChatDelta =
  | {
      kind: 'text'
      sessionId: string
      messageId: string
      requestId: string
      seq: number
      delta: string
    }
  | {
      kind: 'reasoning'
      sessionId: string
      messageId: string
      requestId: string
      seq: number
      delta: string
    }

/**
 * 一个会话的完整运行态（纯内存、不落盘）。
 *
 * 当前会话只是把这份**投影**到界面（`useChat` 的 computed），切会话不搬状态：
 * 消息、在途请求、已完成请求集合、排队草稿、子代理、job、用量、未读 / 错误全部留在本会话。
 */
export interface ChatSessionRuntime {
  id: string
  messages: ChatMessage[]
  streaming: boolean
  /** 正在跑的请求 id（事件里补；远端请求没有本地 `send()` 返回值也靠它支撑「停止」） */
  activeRequest: string | null
  /** 最近一次见过的请求 id（`activeRequest` 为空时停止按钮的兜底） */
  lastRequestId: string | null
  /** 当前正在流式接收的助手消息 id（服务端生成的存储 id） */
  assistantId: string | null
  /** 正在流式接收思考的助手消息 id（MessageList 的「自动展开 + 思考中动效」依据） */
  reasoningTargetId: string | null
  /** 已结束的请求 id（本会话视角）：done / error 之后同一 requestId 的后续事件一律丢弃 */
  finishedRequests: Set<string>
  /** 本会话的子代理运行（实时，key = 工具调用 id） */
  liveSubagents: SubagentRun[]
  /** 已落盘子代理快照索引（非响应式 Map；用版本号触发重算） */
  historicalSubagents: Map<string, SubagentRun>
  historicalSubagentsVersion: number
  jobs: AgentJob[]
  queuedDrafts: Map<string, QueuedDraft>
  pendingNotice: string | null
  error: string | null
  unread: boolean
  usage: UsageState
  lastSettledRequestId: string | null
  lastSettledAt: number | null
  latestTurnGroupable: boolean
  /** 是否已从 `chat:history` 水合过（`force` 会绕过） */
  hydrated: boolean
  /**
   * 本轮是否可能在本地缺了前半段（2026-11-07）：窗口创建前 / 渲染层重载时请求已经在跑，
   * 事件订阅晚于首片增量。收尾后需要水合一次把磁盘上刚落盘的完整回复换进来；
   * 正常情况下（本地从头看着流）**不**在每次 done 后水合 —— 那会把用户上翻的历史拽回底部。
   */
  resyncOnSettle: boolean
  lastTouchedAt: number
}

/** 已完成请求集合上限（只留最近若干条；与旧实现一致） */
export const FINISHED_REQUEST_LIMIT = 64
/** 已计入 `usage.totals` 的 `(requestId, round)` 上限（全局一份，键本身全局唯一） */
export const COUNTED_USAGE_LIMIT = 512
/** 会话运行态缓存上限（LRU；当前会话 / 正在流式的永不淘汰） */
export const RUNTIME_CACHE_LIMIT = 8

/**
 * 暂停原因 → 用户可读文案（docs/06 §4.1 的 Job 契约）。
 *
 * `done` 事件的提示与「任务」面板（`JobPanel.vue` 的「暂停原因」一行）**共用这一份**：
 * 同一句话在两处各写一遍迟早会漂移（面板说「轮次上限」、提示说「预算」）。
 */
export const PENDING_REASON_TEXT: Record<NonNullable<AgentJob['pendingReason']>, string> = {
  'max-rounds': '已达到轮次上限，已暂停',
  aborted: '已取消',
}

export function createSessionRuntime(id: string, now = Date.now()): ChatSessionRuntime {
  return {
    id,
    messages: [],
    streaming: false,
    activeRequest: null,
    lastRequestId: null,
    assistantId: null,
    reasoningTargetId: null,
    finishedRequests: new Set(),
    liveSubagents: [],
    historicalSubagents: new Map(),
    historicalSubagentsVersion: 0,
    jobs: [],
    queuedDrafts: new Map(),
    pendingNotice: null,
    error: null,
    unread: false,
    usage: {
      latest: null,
      totals: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
    },
    lastSettledRequestId: null,
    lastSettledAt: null,
    latestTurnGroupable: true,
    hydrated: false,
    resyncOnSettle: false,
    lastTouchedAt: now,
  }
}

/** 服务端历史 DTO → 渲染层消息 */
export function toChatMessage(dto: ChatMessageDto): ChatMessage {
  return {
    id: dto.id,
    role: dto.role,
    content: dto.content,
    createdAt: Date.parse(dto.createdAt) || Date.now(),
    ...(dto.requestId === undefined ? {} : { requestId: dto.requestId }),
    ...(dto.toolCalls === undefined ? {} : { toolCalls: dto.toolCalls }),
    ...(dto.reasoning === undefined || dto.reasoning === '' ? {} : { reasoning: dto.reasoning }),
  }
}

/**
 * `user-message` 广播要回填哪一条本地气泡（返回下标；`-1` 表示没有可对账的本地气泡）。
 *
 * 判定口径（P2-19，`docs/06 §4` 的跨窗口实时同步）：
 * - 只看**无 `seq` 的本地临时气泡**（`send()` 本地 push 的那条，尚未被广播确认）：
 *   已带 `seq` 的气泡是**已确认过**的消息，`content` 相同也可能是**另一条**同文本消息
 *   —— 跨窗口 30 秒内重发「继续」是现实用法，命中上一轮的 `u-evt-` 气泡会把它的
 *   seq / createdAt 覆写成这一轮的（第二条被吞、第一条被错锚，2026-09-30 报告）。
 *   因此**带 seq 的一律跳过**，只与临时气泡对账。
 * - 时间窗：只在事件时间戳往前 `windowMs` 内回扫；一旦越出窗口（下标往前扫到的消息
 *   `createdAt` 更早）立即停止 —— 比窗口更早的气泡不可能是这次广播的原作者。
 * - 从数组末尾往前扫，取**最近**一条匹配（重发同文本时命中的是最后一次本地 push）。
 *
 * 抽成不依赖 electron / DOM 的纯函数，供 `chatRuntime.test.ts` 直接覆盖（含「带 seq 跳过」
 * 与「同文本重发不吞」两条回归）。
 */
export function matchUserMessageEcho(
  messages: readonly ChatMessage[],
  content: string,
  eventCreatedAt: number,
  windowMs = USER_MESSAGE_ECHO_WINDOW_MS,
): number {
  const cutoff = eventCreatedAt - windowMs
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message.createdAt < cutoff) break
    if (message.role !== 'user') continue
    // 已带 seq 的气泡是「已确认」的消息，跳过 content 匹配（P2-19 的核心）
    if (message.seq !== undefined) continue
    if (message.content === content) return index
  }
  return -1
}

/**
 * `user-message` 广播的回扫时间窗（毫秒）。
 *
 * 30 秒是历史值，语义是「同一窗口内本地刚 push 的气泡」——广播到达与本地 push 间隔
 * 通常只有一次 IPC 往返，给足 30 秒只是容错（本地气泡本身无 seq，越晚匹配越容易误判，
 * 但带 seq 的气泡已由上面跳过，误判面只剩「广播丢失且同文本重发」这一窄角）。
 */
export const USER_MESSAGE_ECHO_WINDOW_MS = 30_000

/**
 * 会话级 token 用量累计（usage 事件）。
 *
 * 只计一次 `(requestId, round)`：事件重放 / 迟到事件不该把用量翻倍。`counted` 是**全局**
 * 一份（键本身全局唯一），切会话不清 —— 切走再切回后迟到的 usage 靠它挡住。
 */
export function applyUsageEvent(
  rt: ChatSessionRuntime,
  event: Extract<AgentEvent, { type: 'usage' }>,
  counted: Set<string>,
): void {
  const key = `${event.requestId}#${event.round}`
  if (counted.has(key)) return
  counted.add(key)
  while (counted.size > COUNTED_USAGE_LIMIT) {
    const oldest = counted.values().next().value
    if (oldest === undefined) break
    counted.delete(oldest)
  }
  rt.usage = {
    latest: event.usage,
    totals: {
      promptTokens: rt.usage.totals.promptTokens + event.usage.promptTokens,
      completionTokens: rt.usage.totals.completionTokens + event.usage.completionTokens,
      totalTokens: rt.usage.totals.totalTokens + event.usage.totalTokens,
      cachedTokens: (rt.usage.totals.cachedTokens ?? 0) + (event.usage.cachedTokens ?? 0),
    },
  }
}

/** 会话事件的应用上下文（纯函数注入，避免模块级单例） */
export interface ChatEventContext {
  /** 当前正在展示的会话 id（只影响未读 / 收尾语义，不影响消息归属） */
  currentSessionId: string
  /** 已计入 totals 的 `requestId#round`（全局一份） */
  countedUsage: Set<string>
  /** `job` 事件先于列表水合到达时，占位卡片使用的 origin */
  jobOrigin: AgentJob['origin']
  now?: () => number
}

/**
 * `applyChatEvent` 的返回值：
 * - `accepted`：这条事件是否被接受（陈旧请求 / 别的在途请求的事件是 false；文本增量**只有
 *   被接受才可入缓冲**，否则 done 之后的迟到增量仍会被写进消息）；
 * - `refreshJobs`：需要调用方补一次 `chat:jobs`（占位行只活一个 IPC 往返）。
 */
export interface ChatEventEffect {
  accepted: boolean
  refreshJobs: boolean
}

/**
 * 把一条事件应用到它所属的会话运行态（docs/06 §4.3）。
 *
 * 过滤口径（与旧实现逐条对齐，但**作用域从全局变成每会话**）：
 * 1. `finishedRequests` 里有的 requestId 一律丢弃（done / error 之后的迟到增量）；
 * 2. `activeRequest` 已指向别的请求时丢弃（同一会话同时只有一个 active；排队句子由内核在
 *    轮次边界以「正在跑的 requestId」广播 `user-message`，不会走到这条）；
 * 3. 被接受的事件会补 `activeRequest` / `lastRequestId`，因此远端 / Center 发起、渲染层
 *    没走 `send()` 的请求也能被「停止」。
 */
export function applyChatEvent(
  rt: ChatSessionRuntime,
  event: AgentEvent,
  context: ChatEventContext,
): ChatEventEffect {
  const now = context.now ?? Date.now
  // job 事件必须走在两道请求过滤之前：暂停恰恰发生在请求收尾之后（`done` 已把 requestId
  // 记进 finishedRequests），按 requestId 过滤会让「任务已暂停」这条最该看到的更新永远进不来。
  if (event.type === 'job') {
    const stamp = now()
    if (rt.lastTouchedAt !== stamp) rt.lastTouchedAt = stamp
    return { accepted: true, refreshJobs: applyJobSummary(rt, event.job, context.jobOrigin) }
  }
  if (rt.finishedRequests.has(event.requestId)) return { accepted: false, refreshJobs: false }
  if (rt.activeRequest !== null && rt.activeRequest !== event.requestId) {
    return { accepted: false, refreshJobs: false }
  }
  // 接受：补齐在途请求标记（远端 / 渲染层重载后的请求靠这几行支撑「停止」与流式态）。
  // **只在值真的变化时写**：一个 token 一条事件，逐条写同值的响应式字段会白白触发
  // 依赖它的 computed / 模板（2026-10-04 性能轮的口径）。
  rt.lastTouchedAt = now()
  if (rt.lastRequestId !== event.requestId) rt.lastRequestId = event.requestId
  if (rt.activeRequest === null) rt.activeRequest = event.requestId
  if (event.type !== 'usage' && event.type !== 'done' && event.type !== 'error' && !rt.streaming) {
    rt.streaming = true
  }

  let refreshJobs = false
  switch (event.type) {
    case 'queued':
      // 排队 / 开跑的握手事件：只用来补 activeRequest（上面已做），不进消息区
      break
    case 'user-message': {
      // user 消息广播（docs/06 §4）：主界面 / 提示条任一侧发出的提问，另一侧实时可见。
      // **不能按 requestId 过滤**：该事件在内核 run() 开始时广播，早于 chat:send 的
      // invoke 返回 —— 发送方此刻的 activeRequest 还没拿到这个 requestId，而且发送方
      // 在 send() 里已本地 push 过同一条消息。
      // 去重判定见 `matchUserMessageEcho`（P2-19）：只与**无 seq 的本地临时气泡**对账，
      // 已带 seq 的气泡一律跳过 —— 否则跨窗口 30 秒内重发同文本会命中上一轮的
      // `u-evt-` 气泡，把它的 seq/createdAt 覆写成这一轮的（吞掉第二条、错锚第一条）。
      const content = event.content
      const matched = matchUserMessageEcho(rt.messages, content, event.createdAt)
      if (matched >= 0) {
        // 命中的是发送方本地 push 的气泡（临时 id、无 seq）：把主进程分配的 seq /
        // 时间对齐回去 —— 它就是同一条消息。不补 seq 的话，后续按 seq 插入的回复
        // 会越过这条气泡排到它前面（用户消息被压到整轮回复之后，2026-09-25 报告）。
        const existing = rt.messages[matched]
        if (existing) {
          existing.seq = event.seq
          existing.createdAt = event.createdAt
          existing.requestId = event.requestId
          // 排队的那句此刻真的进了请求（docs/06 §5.3）：气泡摘掉「排队中」转正。
          // 靠文本对账而不是靠 id —— 注入事件的 requestId 属于正在跑的那次请求，
          // 拿排队时那个 id 去比对永远不相等（内核刻意这么广播，见 docs/06 §5.3）。
          existing.queued = false
          // 这句已经真的进了请求，草稿不再是"待发"（docs/06 §5.3）
          rt.queuedDrafts.delete(existing.id)
        }
        break
      }
      rt.messages.push({
        id: `u-evt-${event.requestId}`,
        role: 'user',
        content,
        createdAt: event.createdAt,
        seq: event.seq,
        requestId: event.requestId,
      })
      break
    }
    case 'text':
    case 'reasoning':
      // 正文 / 思考增量由 useChat 的按帧缓冲调用 `applyStreamDelta`，这里不重复处理
      break
    case 'usage':
      applyUsageEvent(rt, event, context.countedUsage)
      break
    case 'tool': {
      const message = messageFor(rt, event.messageId, event.seq, event.requestId)
      if (message) upsertToolCall(rt, message, event.call)
      break
    }
    case 'subagent': {
      // 子代理进度（docs/06 §19）：同时更新工具卡上的快照（卡片就地长出进度）
      // 与「子代理」页面的实时列表
      const message = messageFor(rt, event.messageId, event.seq, event.requestId)
      if (message) patchToolCall(rt, message, event.callId, event.subagent)
      const run: SubagentRun = { ...event.subagent, messageId: event.messageId }
      const key = run.callId === '' ? run.taskId : run.callId
      const existingIndex = rt.liveSubagents.findIndex(
        (item) => (item.callId === '' ? item.taskId : item.callId) === key,
      )
      if (existingIndex >= 0) rt.liveSubagents.splice(existingIndex, 1, run)
      else rt.liveSubagents = [run, ...rt.liveSubagents]
      break
    }
    case 'done': {
      rt.streaming = false
      const message = currentAssistant(rt)
      settleReasoning(rt)
      settlePending(rt)
      if (message) {
        if (message.content === '') message.content = '（暂无回复）'
      }
      // 暂停原因（Job 契约，docs/06 §4.1）：v15 起 `done` 会带 `pendingReason`，
      // 文案由它决定；**没有它时保持 null**（既有行为一字不变）。
      rt.pendingNotice =
        event.pendingReason === undefined ? null : PENDING_REASON_TEXT[event.pendingReason]
      rt.unread = true
      finishRequest(rt, event.requestId)
      // 收尾信号（P2-20）：MessageList 的折叠收尾据此触发 —— 非本窗口发起的轮次
      // 在 `streaming` 上无边沿，只有这条显式信号能让它收拢成一行摘要。
      rt.lastSettledRequestId = event.requestId
      rt.lastSettledAt = now()
      rt.latestTurnGroupable = event.pendingReason === undefined
      refreshJobs = true
      break
    }
    case 'error': {
      rt.streaming = false
      rt.error = event.message
      const message = currentAssistant(rt) ?? lastAssistant(rt)
      settleReasoning(rt)
      settlePending(rt)
      if (message) {
        message.error = true
        message.content = message.content === '' ? `请求失败：${event.message}` : message.content
      }
      finishRequest(rt, event.requestId)
      // 出错同样是「本轮收尾」：轨迹与思考块照收（与 done 同一条收拢路径，P2-20）
      rt.lastSettledRequestId = event.requestId
      rt.lastSettledAt = now()
      rt.latestTurnGroupable = false
      refreshJobs = true
      break
    }
    default:
      break
  }
  return { accepted: true, refreshJobs }
}

/** 把一条流式增量落到它自己的消息上（逐帧调用，见 `useChat` 的 deltaBuffer） */
export function applyStreamDelta(rt: ChatSessionRuntime, delta: ChatDelta): void {
  // messageFor 必须**在 apply 时**才调用：它可能新建消息并按 seq 插入，
  // 提前调用会把「入队顺序」换成「到达顺序」，帧边界上的插入位置就会变
  const message = messageFor(rt, delta.messageId, delta.seq, delta.requestId)
  if (message === undefined) return
  if (delta.kind === 'text') {
    message.content += delta.delta
    // 正文开始写 = 这一轮的思考已经结束：撤掉「思考中…」的实时标记
    //（块本身仍保持展开，直到请求结束才收起为摘要行）
    if (rt.reasoningTargetId === message.id) rt.reasoningTargetId = null
    return
  }
  // 思考增量带该轮预领的 messageId，因此**在正文之前**就能建出这条助手消息并把
  // 「正在思考」显示出来（纯思考阶段界面不再空白）。
  message.reasoning = (message.reasoning ?? '') + delta.delta
  if (rt.reasoningTargetId !== message.id) rt.reasoningTargetId = message.id
}

function messageById(rt: ChatSessionRuntime, id: string): ChatMessage | undefined {
  return rt.messages.find((message) => message.id === id)
}

/**
 * 找到事件所属的助手消息；不在列表里则新建，并**按事件 seq 插到正确位置**。
 *
 * 早先一律 `push` 到末尾：一旦事件顺序略有出入（陈旧请求、水合竞态），
 * 工具卡就会挂到列表末尾的新消息上，看起来就是「顺序错乱」。
 */
function messageFor(
  rt: ChatSessionRuntime,
  messageId: string,
  seq: number,
  requestId: string,
): ChatMessage | undefined {
  const existing = messageById(rt, messageId)
  if (existing) {
    if (existing.requestId === undefined) existing.requestId = requestId
    rt.assistantId = messageId
    return existing
  }
  const created: ChatMessage = {
    id: messageId,
    role: 'assistant',
    content: '',
    pending: true,
    createdAt: Date.now(),
    seq,
    requestId,
  }
  rt.assistantId = messageId
  insertOrdered(rt, created)
  return created
}

/**
 * 按 seq 插入：放在最后一个 seq 更小的消息之后；尾部有无 seq 的本地消息时停在它后面。
 *
 * 无 seq 的消息（发送方本地 push 的 user 气泡、发送失败提示）在时间上晚于列表中
 * 它之前的所有内容 —— 新消息**不能越过它**往前插。曾经跳过无 seq 消息继续前扫，
 * 结果同一会话第二轮起每条新回复都插到用户气泡前面，看起来就是「消息顺序错乱」
 * （2026-09-25 报告；见 docs/06 §16.1 症状表）。
 */
function insertOrdered(rt: ChatSessionRuntime, message: ChatMessage): void {
  const seq = message.seq
  if (seq === undefined) {
    rt.messages.push(message)
    return
  }
  for (let index = rt.messages.length - 1; index >= 0; index -= 1) {
    const candidate = rt.messages[index]
    if (candidate === undefined) break
    if (candidate.seq === undefined || candidate.seq < seq) {
      rt.messages.splice(index + 1, 0, message)
      return
    }
  }
  rt.messages.push(message)
}

function currentAssistant(rt: ChatSessionRuntime): ChatMessage | undefined {
  if (rt.assistantId === null) return undefined
  return messageById(rt, rt.assistantId)
}

function lastAssistant(rt: ChatSessionRuntime): ChatMessage | null {
  for (let index = rt.messages.length - 1; index >= 0; index -= 1) {
    const message = rt.messages[index]
    if (message && message.role === 'assistant') return message
  }
  return null
}

function settleReasoning(rt: ChatSessionRuntime): void {
  rt.reasoningTargetId = null
}

/**
 * 请求收尾（done / error / abort）：把**所有**还在 `pending` 的消息一次性收口。
 *
 * 为什么不能只清「当前那条助手消息」：一轮只调工具、没有正文时（模型直接 `read_file`），
 * 那条消息由 `tool` 事件建出来，`currentAssistant()` 早已指向后面轮次的消息 ——
 * 只清最后一条，前面那条会永远停在 `pending: true`，界面上的三点动画在已结束的消息上一直转
 * （2026-09 复核发现；见 docs/06 §16.2）。
 */
function settlePending(rt: ChatSessionRuntime): void {
  for (const message of rt.messages) {
    if (message.pending === true) message.pending = false
  }
}

function finishRequest(rt: ChatSessionRuntime, requestId: string): void {
  rt.activeRequest = null
  rt.assistantId = null
  rt.finishedRequests.add(requestId)
  // 只保留最近若干条：Set 的迭代顺序即插入顺序，超限时丢最早的
  while (rt.finishedRequests.size > FINISHED_REQUEST_LIMIT) {
    const oldest = rt.finishedRequests.values().next().value
    if (oldest === undefined) break
    rt.finishedRequests.delete(oldest)
  }
}

/** 同一 call id 原地更新状态（running → success/error） */
function upsertToolCall(rt: ChatSessionRuntime, message: ChatMessage, call: AgentToolCall): void {
  const list = message.toolCalls ?? []
  const index = list.findIndex((item) => item.id === call.id)
  if (index >= 0) list[index] = { ...call }
  else list.push({ ...call })
  message.toolCalls = [...list]
  if (call.subagent !== undefined) {
    const key = call.subagent.callId === '' ? call.subagent.taskId : call.subagent.callId
    rt.historicalSubagents.set(key, { ...call.subagent, messageId: message.id })
    rt.historicalSubagentsVersion += 1
  }
  // 刻意**不碰 `pending`**：它表达的是「这条消息还在生成中」，只有请求收尾（done / error /
  // abort）才该把它清掉。早先这里写 `pending = content === ''`，后果是「正文已到、工具还在跑」
  // 的那一轮中途就把 pending 清成 false —— 依赖 `pending === false` 的入口（朗读按钮）
  // 会在流式途中闪出来，而工具轮那条没正文的消息又永远清不掉（三点动画在已结束的消息上一直转）。
}

/** 把子代理快照补进已存在的工具卡（子代理进度事件不带完整工具调用） */
function patchToolCall(
  rt: ChatSessionRuntime,
  message: ChatMessage,
  callId: string,
  snapshot: SubagentSnapshot,
): void {
  const list = message.toolCalls ?? []
  const index = list.findIndex((item) => item.id === callId)
  if (index < 0) return
  const current = list[index]
  if (current === undefined) return
  list[index] = { ...current, subagent: snapshot }
  message.toolCalls = [...list]
  const key = snapshot.callId === '' ? snapshot.taskId : snapshot.callId
  rt.historicalSubagents.set(key, { ...snapshot, messageId: message.id })
  rt.historicalSubagentsVersion += 1
}

/** 用当前消息整表重建已落盘子代理索引（水合后调用） */
export function rebuildHistoricalSubagents(rt: ChatSessionRuntime): void {
  rt.historicalSubagents.clear()
  for (const message of rt.messages) {
    for (const call of message.toolCalls ?? []) {
      if (call.subagent === undefined) continue
      const key = call.subagent.callId === '' ? call.subagent.taskId : call.subagent.callId
      rt.historicalSubagents.set(key, { ...call.subagent, messageId: message.id })
    }
  }
  rt.historicalSubagentsVersion += 1
}

/**
 * 把一条 `JobSummary`（`job` 事件 / 列表接口共用的小对象）**就地**合并进 `rt.jobs`。
 *
 * 合并而不是替换：summary 里根本没有 `text` / `stepsDone` / `todos` / `cursor` / `origin`，
 * 整条换掉会让面板上的进度账本与待办在每次状态推送时被清空。
 *
 * 列表里还没有这条（窗口刚打开、事件先于列表水合到达）时**插到最前**并返回 true（调用方随后
 * 回去拉 `chat:jobs`）：先让「任务已暂停」这一类状态立刻可见，再由服务端的完整对象替换。
 */
function applyJobSummary(
  rt: ChatSessionRuntime,
  summary: JobSummary,
  origin: AgentJob['origin'],
): boolean {
  const index = rt.jobs.findIndex((job) => job.id === summary.id)
  if (index < 0) {
    rt.jobs = [placeholderFor(summary, origin), ...rt.jobs]
    return true
  }
  const current = rt.jobs[index]
  if (current === undefined) return false
  rt.jobs.splice(index, 1, {
    ...current,
    status: summary.status,
    round: summary.round,
    maxRounds: summary.maxRounds,
    budget: { usedTokens: summary.usedTokens },
    updatedAt: summary.updatedAt,
    // 这两个字段是「覆盖」而不是「有才写」：续跑后再暂停之前的原因/错误必须能被清掉
    pendingReason: summary.pendingReason,
    error: summary.error,
  })
  return false
}

/**
 * 用 `JobSummary` 拼一条**临时**卡（列表水合之前用）。
 *
 * 只有状态类字段是真的（状态 / 轮次 / token / 暂停原因 —— 也正是面板一行要显示的那些）；
 * `text` / `stepsDone` / `todos` 事件里没有，留空由紧随的 `refreshJobs()` 补齐，
 * `origin` 取本窗口名（发起这条 job 的窗口），`createdAt` 借用 `updatedAt`。
 * 它**不是**持久数据：服务端列表一回来就会被同名 id 的完整对象替换。
 */
function placeholderFor(summary: JobSummary, origin: AgentJob['origin']): AgentJob {
  return {
    id: summary.id,
    sessionId: summary.sessionId,
    status: summary.status,
    origin,
    text: '',
    round: summary.round,
    maxRounds: summary.maxRounds,
    stepsDone: [],
    todos: [],
    cursor: { nextRound: summary.round },
    budget: { usedTokens: summary.usedTokens },
    ...(summary.pendingReason === undefined ? {} : { pendingReason: summary.pendingReason }),
    createdAt: summary.updatedAt,
    updatedAt: summary.updatedAt,
    ...(summary.error === undefined ? {} : { error: summary.error }),
  }
}

/** 服务端快照里是否已有同 role 同文本的消息（本地 `u-` 临时 id 气泡的去重口径） */
function sameAsServer(server: readonly ChatMessage[], local: ChatMessage): boolean {
  return server.some((item) => item.role === local.role && item.content === local.content)
}

/**
 * 历史水合与本地运行态的合并（切会话 / 收尾自愈共用）。
 *
 * 合并策略（曾经是「服务端快照整体替换本地」）：
 * - 服务端没有的本地消息保底保留；
 * - 服务端有、本地也有的同 id 消息**就地合并**：内容取更长的那份，本地流式状态
 *   （`pending` / `error` / 附件 / 思考）优先保留 —— 否则水合会把正在流式接收的
 *   消息对象换掉，界面上的「正在输入」与已长出的工具卡会闪一下甚至消失。
 * - 本地多出来的消息按原顺序跟在后面；user 气泡用 `u-` 临时 id，与服务端 id 不同，
 *   同 role 同文本视为同一条，不重复追加。
 */
export function mergeHydratedMessages(
  server: readonly ChatMessage[],
  local: readonly ChatMessage[],
): ChatMessage[] {
  const localById = new Map(local.map((message) => [message.id, message]))
  const merged = server.map((item) => {
    const localMessage = localById.get(item.id)
    if (localMessage === undefined) return item
    localById.delete(item.id)
    return {
      ...item,
      content:
        localMessage.content.length > item.content.length ? localMessage.content : item.content,
      ...(localMessage.reasoning !== undefined ? { reasoning: localMessage.reasoning } : {}),
      ...(localMessage.pending === undefined ? {} : { pending: localMessage.pending }),
      ...(localMessage.error === undefined ? {} : { error: localMessage.error }),
      ...(localMessage.attachments === undefined ? {} : { attachments: localMessage.attachments }),
    }
  })
  for (const message of local) {
    if (!localById.has(message.id)) continue
    localById.delete(message.id)
    if (sameAsServer(server, message)) continue
    merged.push(message)
  }
  return merged
}

// ───────────────────────── 活动态（左栏状态点 / 后台汇总） ─────────────────────────

/**
 * 一个会话的**轻量**活动态：不随消息运行态淘汰而丢失，只回答「在跑吗 / 有新结果吗 / 失败了吗」。
 *
 * 来源是事件流，`chat:sessions.running` 只作初值 / 兜底（窗口创建前就开跑、渲染层重载）。
 */
export interface SessionActivity {
  /** 正在跑 / 已排队但尚未收尾的请求 id（done / error 时移除） */
  activeRequests: Set<string>
  running: boolean
  /** 非当前会话收尾后置位；切到该会话即清除 */
  unread: boolean
  /** 最近一次收尾的结果（用于左栏红点）；切到该会话即清除 */
  attention: 'done' | 'error' | null
  lastTouchedAt: number
}

export function createSessionActivity(now = Date.now()): SessionActivity {
  return {
    activeRequests: new Set(),
    running: false,
    unread: false,
    attention: null,
    lastTouchedAt: now,
  }
}

/** 左栏状态点要显示哪一档（running > error > unread > 不显示） */
export type SessionStateTone = 'running' | 'unread' | 'error'

/**
 * 由一条事件推进活动态（docs/06 §4.3）。
 *
 * 只写「这个会话还忙不忙 / 后台完成后要不要亮灯」：
 * - `queued` / `user-message` / 首个流式事件 → 记入在途请求；
 * - `done` / `error` → 移除；该会话没有剩余请求且**不是当前会话**时置未读 / 失败态；
 * - `E_BUSY` / `E_QUEUE_FULL` 只是发送被拒，不算会话失败、也不亮未读。
 */
export function applyActivityEvent(
  activity: SessionActivity,
  event: AgentEvent,
  context: { currentSessionId: string; now?: () => number },
): void {
  const now = context.now ?? Date.now
  switch (event.type) {
    case 'queued':
    case 'user-message':
    case 'text':
    case 'reasoning':
    case 'tool':
    case 'subagent':
      // 流式期间逐 token 到达：只在**状态真的变化**时写响应式字段 / 记时间戳，
      // 否则每个 token 都会白白触发一次左栏与头部汇总的重算。
      if (!activity.activeRequests.has(event.requestId)) {
        activity.activeRequests.add(event.requestId)
      }
      if (!activity.running) {
        activity.running = true
        activity.lastTouchedAt = now()
      }
      return
    case 'done':
    case 'error': {
      activity.lastTouchedAt = now()
      const control =
        event.type === 'error' && (event.code === 'E_BUSY' || event.code === 'E_QUEUE_FULL')
      activity.activeRequests.delete(event.requestId)
      const running = activity.activeRequests.size > 0
      if (activity.running !== running) activity.running = running
      // 发送被拒不是「这一轮有结果」：不亮未读 / 失败，也不改已有注意态
      if (control) return
      if (context.currentSessionId === event.sessionId) return
      // 还有别的在途请求（同会话正常不会）时不提前宣布收尾
      if (activity.activeRequests.size > 0) return
      activity.unread = true
      activity.attention = event.type === 'error' ? 'error' : 'done'
      return
    }
    default:
      activity.lastTouchedAt = now()
      return
  }
}

/** 切到该会话 / 主动标记已读：清掉未读与失败注意态 */
export function markActivityViewed(activity: SessionActivity): void {
  activity.unread = false
  activity.attention = null
}

/** `chat:sessions.running` 的兜底种子：窗口创建前就开跑 / 渲染层重载后仍能显示「在跑」 */
export function seedActivityRunning(activity: SessionActivity, now = Date.now()): void {
  activity.running = true
  activity.lastTouchedAt = now
}

export function activityTone(activity: SessionActivity): SessionStateTone | undefined {
  if (activity.running) return 'running'
  if (activity.attention === 'error') return 'error'
  if (activity.unread) return 'unread'
  return undefined
}

// ───────────────────────── 隐藏会话 / 淘汰 ─────────────────────────

/**
 * 是否属于「不在 chat 里累积运行态」的隐藏后台会话（docs/06 §4.3）。
 *
 * 与主进程的三处前缀约定保持一致：`auto-`（自动化，`main/automation/session-id.ts`）、
 * `awareness-`（文件自感知，`main/file-awareness-run-profile.ts`）、`-sub`（task 子代理的
 * 内存会话）。它们不是当前会话时不需要把正文常驻在 chat 渲染进程里；当前会话例外 ——
 * 自动化历史回放 / Center 激活仍能正常显示。
 */
export function isHiddenSessionId(id: string): boolean {
  if (id === 'auto' || id.startsWith('auto-')) return true
  if (id.startsWith('awareness-')) return true
  return id.endsWith('-sub')
}

/**
 * 计算要淘汰的运行态 id（LRU，最多保留 `limit` 个）。
 *
 * 规则：当前会话与**正在流式**的会话永不淘汰；有暂停提示（`pendingNotice`）的也先留着 ——
 * 它是「要用户点继续」的一次性交代。淘汰只影响消息缓存，切回时由 `chat:history` 水合恢复，
 * 活动态（未读 / 失败点）独立保留。
 */
export function evictRuntimeIds(
  entries: readonly (readonly [string, ChatSessionRuntime])[],
  currentSessionId: string,
  limit = RUNTIME_CACHE_LIMIT,
): string[] {
  const excess = entries.length - limit
  if (excess <= 0) return []
  const candidates = entries
    .filter(([id, rt]) => id !== currentSessionId && !rt.streaming && rt.pendingNotice === null)
    .sort((left, right) => left[1].lastTouchedAt - right[1].lastTouchedAt)
  return candidates.slice(0, excess).map(([id]) => id)
}
