/**
 * 对话状态（P3：真实内核 + 会话水合）。
 *
 * 与主进程的契约：`chat:send` → `chat:event` 流式事件 + `chat:history` 水合。
 * 事件按 `sessionId` 过滤，并按 `requestId` 丢弃**已结束请求的迟到事件**
 * （docs/06 §16.1：`done` / `error` 之后同一 requestId 的事件一律是陈旧事件，
 * 曾经这些事件会被当成新一轮内容插进对话，表现为「工具卡跑到别的回复里」）。
 *
 * 顺序与归属（2026-09 增强）：
 * - 消息顺序由事件 `seq` 决定：新消息按 seq **插到正确位置**，而不是一律追加到末尾；
 * - 思考链与正文都**边收边写进同一条助手消息**（docs/06 §16.2）：该消息的 id 由内核在
 *   这一轮流开始前预领，`reasoning` / `text` 事件都带着它，因此「正在思考」在正文之前
 *   就能显示出来，也不需要再按轮次聚合（早先思考不带 messageId，只能先攒着、等正文到达
 *   才绑到消息上，代价是**纯思考阶段界面一片空白**）。
 *
 * 多会话（docs/06 §4）：`sessionId` 是可切换的 ref；`chat:sessions` 提供列表，
 * `chat:newSession` 新建。默认会话由入参 `context` 决定（`main` / `quick` / `settings`）。
 */
import { computed, onScopeDispose, ref } from 'vue'
import { deepClone } from '@aurora/shared/browser'
import type {
  AgentJob,
  AgentToolCall,
  ChatMessageDto,
  ChatSessionSummary,
  JobSummary,
  SendMessageRequest,
  SubagentSnapshot,
  TokenUsage,
  WindowName,
} from '@aurora/shared'
import { createDeltaBuffer } from './useChatDeltaBuffer.js'

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
 * 一条待写入的流式增量（text / reasoning 两条链路共用同一个缓冲）。
 *
 * `kind` 不参与缓冲的分组键（键是 messageId）：同一条消息在同帧内的
 * 思考增量与正文增量必须按**到达顺序**依次落库，否则「正文开始写就把思考中标记清掉」
 * 这条语义会在帧边界上翻车。
 */
type ChatDelta =
  | { kind: 'text'; messageId: string; seq: number; delta: string }
  | { kind: 'reasoning'; messageId: string; seq: number; delta: string }

/** 对话上下文（原为窗口名映射；mini-chat 删除后改为显式声明，会话 id 保持不变） */
export type ChatContext = 'main' | 'quick' | 'settings'

/**
 * 上下文 → 会话 id。
 *
 * 映射刻意保持不变（`quick` / `main` / `settings`）：老会话文件继续可读，
 * 现在「快速会话」由交互窗侧栏与提示条共用（docs/06 §4）。
 */
export function sessionIdFor(context: ChatContext): string {
  if (context === 'quick') return 'quick'
  if (context === 'main') return 'main'
  return 'settings'
}

/**
 * 暂停原因 → 用户可读文案（docs/06 §4.1 的 Job 契约）。
 *
 * `done` 事件的提示与「任务」面板（`JobPanel.vue` 的「暂停原因」一行）**共用这一份**：
 * 同一句话在两处各写一遍迟早会漂移（面板说「轮次上限」、提示说「预算」）。
 */
export const PENDING_REASON_TEXT: Record<NonNullable<AgentJob['pendingReason']>, string> = {
  'max-rounds': '已达到轮次上限，已暂停',
  budget: '已达到 token 预算，已暂停',
  aborted: '已取消',
}

/**
 * `windowName` 仍然保留：它是 `chat:send` 的 `origin`（`SendMessageRequest.origin` 是 `WindowName`），
 * 主进程据此判断消息来自哪个窗口；会话 id 由显式的 `context` 决定。
 */
export function useChat(windowName: WindowName, context: ChatContext) {
  const defaultSessionId = sessionIdFor(context)
  /** 当前会话 id（可切换）。切换会话后旧会话的流式状态一并复位。 */
  const sessionId = ref(defaultSessionId)
  const messages = ref<ChatMessage[]>([])
  const streaming = ref(false)
  const unread = ref(false)
  const error = ref<string | null>(null)
  /** 会话列表（`chat:sessions`），仅交互窗使用 */
  const sessions = ref<ChatSessionSummary[]>([])
  let activeRequest: string | null = null
  /** 当前正在流式接收的助手消息 id（服务端生成的存储 id） */
  let assistantId: string | null = null
  /** 已水合过的会话 id（切换会话时按新 id 重新水合） */
  const hydrated = new Set<string>()
  /**
   * 已结束的请求 id（本窗口视角）：`done` / `error` 到达后同一 requestId 的后续事件
   * 一律丢弃。集合只保留最近若干条，避免长会话无限增长。
   */
  const finishedRequests = new Set<string>()
  const FINISHED_REQUEST_LIMIT = 64
  /**
   * 正在流式接收思考的助手消息 id（MessageList 的「自动展开 + 思考中动效」依据，docs/06 §16.1）。
   *
   * 该轮正文一开始写就把这里清空 —— 思考已经结束，块头文案随之从「思考中…」翻回
   * 「已深度思考」，但已展开的思考内容不会自己收起来（收起来是请求结束的事）。
   * 界面上「思考中」的判据就是这一个 ref（早先还有一个只增不减的 `reasoningLive` 镜像，
   * 没有任何消费方，已删除）。
   */
  const reasoningTargetId = ref<string | null>(null)
  /** 本会话的子代理运行（实时，key = 工具调用 id）；切换会话时清空 */
  const liveSubagents = ref<SubagentRun[]>([])
  /**
   * 本会话的**任务（Job）**列表（新的在前）：「任务」面板的数据源（docs/06 §4.1）。
   *
   * 两个来源合并进同一份状态：`chat:jobs` 水合（切换会话 / 挂载）+ `job` 事件推送
   * （就地更新，见事件分支）。长任务暂停后用户必须能看到它并点「继续」——
   * 因此这里存的是**完整** `AgentJob`（含 stepsDone / todos），不是事件里的 `JobSummary`。
   */
  const jobs = ref<AgentJob[]>([])
  /**
   * 长任务被暂停的一句话提示（`done` 事件的 `pendingReason`）。
   *
   * 只在**带了原因**时写值；没有原因（正常收尾 / 未落地的老事件）保持 null，
   * 既有行为一字不变。下一次发送、清空消息区或切会话时复位。
   */
  const pendingNotice = ref<string | null>(null)
  /**
   * 最近一轮 LLM 调用的 token 用量（输入框底部「上下文详解」的数据源，docs/07 §2.3）。
   *
   * `latest` 的 `promptTokens` 就是**当前上下文占用**（系统提示词 + 历史 + 本轮内容），
   * `totals` 是本会话自窗口打开以来逐轮累加的消耗。provider 未回传 usage 时保持 null，
   * 界面此时只显示条数与字符数，**不编造 token 数**。
   */
  const usage = ref<{
    /** 最近一轮的用量（`promptTokens` 即当前上下文占用） */
    latest: TokenUsage | null
    /** 本会话累计（逐轮相加） */
    totals: TokenUsage
  }>({
    latest: null,
    totals: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
  })
  /** 已计入 `usage.totals` 的 `(requestId, round)`，防重复累加（同一序号只来一次） */
  const countedUsage = new Set<string>()

  const statusTone = computed<'idle' | 'running' | 'unread' | 'error'>(() => {
    if (error.value) return 'error'
    if (streaming.value) return 'running'
    if (unread.value) return 'unread'
    return 'idle'
  })

  const lastAssistant = computed(() => {
    for (let index = messages.value.length - 1; index >= 0; index -= 1) {
      const message = messages.value[index]
      if (message && message.role === 'assistant') return message
    }
    return null
  })

  /**
   * 「子代理」页面用：本会话的子代理运行（新的在前）。
   *
   * 两个来源合并：实时事件（`liveSubagents`，含未落盘的步骤）与历史消息里的工具卡快照
   * （重启后仍可回看）。同一 `callId` 以实时那份为准 —— 它更新。
   */
  const subagentRuns = computed<SubagentRun[]>(() => {
    const merged = new Map<string, SubagentRun>()
    for (const run of liveSubagents.value) {
      merged.set(run.callId === '' ? run.taskId : run.callId, run)
    }
    for (const message of messages.value) {
      for (const call of message.toolCalls ?? []) {
        if (call.subagent === undefined) continue
        const key = call.subagent.callId === '' ? call.subagent.taskId : call.subagent.callId
        if (merged.has(key)) continue
        merged.set(key, { ...call.subagent, messageId: message.id })
      }
    }
    return [...merged.values()].sort((left, right) => right.startedAt - left.startedAt)
  })

  /**
   * 流式增量的按帧合并缓冲。
   *
   * 一个 SSE token = 一次 IPC 推送，真实推理模型 100+ token/s 时渲染层每秒被叫醒上百次；
   * text / reasoning 只入队，真正的累加合并到**下一帧**一次做完（每帧一次组件渲染）。
   * 语义与边界见 `useChatDeltaBuffer.ts`；这里只负责注入 rAF 与把批次写进消息。
   */
  const deltaBuffer = createDeltaBuffer<ChatDelta>(
    (batches) => {
      for (const batch of batches) {
        for (const delta of batch.values) {
          // messageFor 必须**在 apply 时**才调用：它可能新建消息并按 seq 插入，
          // 提前调用会把「入队顺序」换成「到达顺序」，帧边界上的插入位置就会变
          const message = messageFor(delta.messageId, delta.seq)
          if (message === undefined) continue
          if (delta.kind === 'text') {
            message.content += delta.delta
            // 正文开始写 = 这一轮的思考已经结束：撤掉「思考中…」的实时标记
            //（块本身仍保持展开，直到请求结束才收起为摘要行）
            if (reasoningTargetId.value === message.id) reasoningTargetId.value = null
            continue
          }
          // 思考增量带该轮预领的 messageId，因此**在正文之前**就能建出这条助手消息并把
          // 「正在思考」显示出来（纯思考阶段界面不再空白）。逐条增量直接累加到消息上，
          // 不再需要按轮次聚合 —— 每条增量都明确属于哪条消息（docs/06 §16.2）。
          message.reasoning = (message.reasoning ?? '') + delta.delta
          reasoningTargetId.value = message.id
        }
      }
    },
    {
      requestFrame: (callback) => window.requestAnimationFrame(callback),
      cancelFrame: (handle) => window.cancelAnimationFrame(handle),
    },
  )

  const dispose = window.aurora.chat.onEvent((event) => {
    // 任务（Job）事件是**会话级**的、逐条到达，必须走在「在途请求」两道过滤之前：
    // 暂停恰恰发生在请求收尾之后（`done` 已把 requestId 记进 finishedRequests），
    // 按 requestId 过滤会让「任务已暂停」这条最该看到的更新永远进不来。
    // 会话归属按事件里的 `job.sessionId` 判定（它一定带着，不依赖事件的公共字段）。
    if (event.type === 'job') {
      if (event.job.sessionId !== sessionId.value) return
      applyJobSummary(event.job)
      return
    }
    // 远程会话（center-*，docs/12 §5）由网页端发起：会话在主进程落盘后，本窗口的
    // 会话列表可能还没拉到它 —— 事件来自列表里没有的会话时补拉一次。拉回来之后
    // 列表里就有了，后续事件不再触发；in-flight 守卫挡住流式期间的高频重入。
    if (
      event.sessionId !== sessionId.value &&
      !sessions.value.some((item) => item.id === event.sessionId)
    ) {
      void refreshSessionsForUnknown()
    }
    if (event.sessionId !== sessionId.value) return
    if (finishedRequests.has(event.requestId)) return
    if (activeRequest !== null && event.requestId !== activeRequest) return

    // text / reasoning 之外的事件一律**先把在途增量刷出去**再走原分支：它们的语义与顺序
    // 必须逐字不变 —— 尤其 `done` 读的是消息终态（正文是否为空、还有没有 pending），
    // 不先 flush 就会在「正文还在缓冲里」时判定成「暂无回复」。
    if (event.type !== 'text' && event.type !== 'reasoning') deltaBuffer.flush()

    switch (event.type) {
      case 'user-message': {
        // user 消息广播（docs/06 §4）：主界面 / 提示条任一侧发出的提问，另一侧实时可见。
        // **不能按 requestId 过滤**：该事件在内核 run() 开始时广播，早于 chat:send 的
        // invoke 返回 —— 发送方此刻的 activeRequest 还没拿到这个 requestId，而且发送方
        // 在 send() 里已本地 push 过同一条消息。因此按内容去重：事件时间戳往前 30 秒内
        // 已存在同文本的 user 消息就跳过，否则（其它窗口发的）追加一条。
        // 刻意不动 streaming / assistantId / activeRequest 等流式状态。
        const content = event.content
        const cutoff = event.createdAt - 30_000
        let duplicateIndex = -1
        for (let index = messages.value.length - 1; index >= 0; index -= 1) {
          const message = messages.value[index]
          if (message === undefined || message.createdAt < cutoff) break
          if (message.role === 'user' && message.content === content) {
            duplicateIndex = index
            break
          }
        }
        if (duplicateIndex >= 0) {
          // 命中的是发送方本地 push 的气泡（临时 id、无 seq）：把主进程分配的 seq /
          // 时间对齐回去 —— 它就是同一条消息。不补 seq 的话，后续按 seq 插入的回复
          // 会越过这条气泡排到它前面（用户消息被压到整轮回复之后，2026-09-25 报告）。
          const existing = messages.value[duplicateIndex]
          if (existing) {
            existing.seq = event.seq
            existing.createdAt = event.createdAt
          }
          break
        }
        messages.value.push({
          id: `u-evt-${event.requestId}`,
          role: 'user',
          content,
          createdAt: event.createdAt,
          seq: event.seq,
        })
        break
      }
      case 'text': {
        deltaBuffer.push(event.messageId, {
          kind: 'text',
          messageId: event.messageId,
          seq: event.seq,
          delta: event.delta,
        })
        break
      }
      case 'reasoning': {
        deltaBuffer.push(event.messageId, {
          kind: 'reasoning',
          messageId: event.messageId,
          seq: event.seq,
          delta: event.delta,
        })
        break
      }
      case 'usage': {
        // token 用量（docs/06 §16.2）：`latest` 供「上下文占用」展示，`totals` 逐轮累加。
        // 同一 (requestId, round) 只计一次 —— 事件重放 / 迟到事件不该把用量翻倍。
        // 缓存命中量（docs/06 §21.4）provider 未回传时缺省，累加按 0 计 —— 但不影响
        // `latest` 上「有没有这个字段」的判定（展示侧靠缺省决定整段渲不渲染）。
        const key = `${event.requestId}#${event.round}`
        if (!countedUsage.has(key)) {
          countedUsage.add(key)
          usage.value = {
            latest: event.usage,
            totals: {
              promptTokens: usage.value.totals.promptTokens + event.usage.promptTokens,
              completionTokens: usage.value.totals.completionTokens + event.usage.completionTokens,
              totalTokens: usage.value.totals.totalTokens + event.usage.totalTokens,
              cachedTokens:
                (usage.value.totals.cachedTokens ?? 0) + (event.usage.cachedTokens ?? 0),
            },
          }
        }
        break
      }
      case 'tool': {
        const message = messageFor(event.messageId, event.seq)
        if (message) upsertToolCall(message, event.call)
        break
      }
      case 'subagent': {
        // 子代理进度（docs/06 §19）：同时更新工具卡上的快照（卡片就地长出进度）
        // 与「子代理」页面的实时列表
        const message = messageFor(event.messageId, event.seq)
        if (message) patchToolCall(message, event.callId, event.subagent)
        const run: SubagentRun = { ...event.subagent, messageId: event.messageId }
        const key = run.callId === '' ? run.taskId : run.callId
        const existingIndex = liveSubagents.value.findIndex(
          (item) => (item.callId === '' ? item.taskId : item.callId) === key,
        )
        if (existingIndex >= 0) liveSubagents.value.splice(existingIndex, 1, run)
        else liveSubagents.value = [run, ...liveSubagents.value]
        break
      }
      case 'done': {
        streaming.value = false
        const message = currentAssistant()
        settleReasoning()
        settlePending()
        if (message) {
          if (message.content === '') message.content = '（暂无回复）'
        }
        // 暂停原因（Job 契约，docs/06 §4.1）：v15 起 `done` 会带 `pendingReason`，
        // 文案由它决定；**没有它时保持 null**（既有行为一字不变）。
        // 刻意不看保留字段 `pending`：它只能说「还有未完的轮次」，说不出是轮次用尽还是预算触顶。
        pendingNotice.value =
          event.pendingReason === undefined ? null : PENDING_REASON_TEXT[event.pendingReason]
        unread.value = true
        finishRequest(event.requestId)
        // 任务可能刚进入 paused（轮次用尽 / 预算触顶）：立即对齐一次列表，
        // 让「继续」按钮在回复结束的同一刻出现，而不是等下一次切会话。
        void refreshJobs()
        break
      }
      case 'error': {
        streaming.value = false
        error.value = event.message
        const message = currentAssistant() ?? lastAssistant.value
        settleReasoning()
        settlePending()
        if (message) {
          message.error = true
          message.content = message.content === '' ? `请求失败：${event.message}` : message.content
        }
        finishRequest(event.requestId)
        break
      }
      default:
        break
    }
  })

  /**
   * 远程会话激活（docs/12 §6.3 `chat:remoteActivate`）：Center 网页端要求客户端主界面
   * 切到指定会话时，主进程向本窗口推送 `{ sessionId }`。推送前主进程已对该会话
   * `sessions.get()` 兜底装载（未落盘的登记为空会话），因此这里直接走现成
   * `switchSession` 就能走通「网页端打开一个历史 center- 会话」：`hydrate` 能读到
   * 历史（新装载的会话是空），收尾的 `loadSessions()` 把列表里原本没有的会话补进来。
   * 被隐藏（`centerVisible === false`）的会话同样响应 —— 隐藏只是左栏不展示，
   * 不影响远程输入与激活（docs/12 §5）。
   */
  const disposeRemoteActivate = window.aurora.chat.onRemoteActivate((event) => {
    void activateRemoteSession(event.sessionId)
  })

  /**
   * 远程会话可见性变更（docs/12 §5 第 8 步 `chat:centerVisibilityChanged`）：
   * Center 网页端开关某会话在客户端左栏的可见性且落盘成功后，主进程推到这里。
   * 会话列表是左栏过滤（`centerVisible === false` 不进列表）的唯一数据源，
   * 重拉一次即可对齐 —— 与 remoteActivate 不同，这不切换当前会话。
   */
  const disposeCenterVisibility = window.aurora.chat.onCenterVisibilityChanged(() => {
    void loadSessions()
  })

  onScopeDispose(() => {
    // 先 flush 再 dispose：卸载瞬间已入队的增量不能丢（消息正文会缺尾），
    // dispose 只负责取消在途帧与清空缓冲（组件已经没了，不再 apply）
    deltaBuffer.flush()
    deltaBuffer.dispose()
    dispose()
    disposeRemoteActivate()
    disposeCenterVisibility()
  })

  /**
   * 执行一次远程激活（`chat:remoteActivate` 的处理体，docs/12 §6.3）。
   *
   * 目标会话不在本地列表时先补拉一次（与未知会话事件的补拉共用
   * `refreshSessionsForUnknown` 的 in-flight 守卫；`switchSession` 收尾也会
   * `loadSessions`，这里提前拉只是让切换动作与列表状态对齐）。
   * 推送驱动的切换**不允许抛未捕获错误**：任何失败只 warn 一句，界面留在原会话。
   */
  async function activateRemoteSession(id: string): Promise<void> {
    try {
      if (!sessions.value.some((item) => item.id === id)) await refreshSessionsForUnknown()
      await switchSession(id)
    } catch (cause) {
      window.console?.warn('远程会话激活失败', id, cause)
    }
  }

  function finishRequest(requestId: string): void {
    activeRequest = null
    assistantId = null
    finishedRequests.add(requestId)
    // 只保留最近若干条：Set 的迭代顺序即插入顺序，超限时丢最早的
    while (finishedRequests.size > FINISHED_REQUEST_LIMIT) {
      const oldest = finishedRequests.values().next().value
      if (oldest === undefined) break
      finishedRequests.delete(oldest)
    }
  }

  function messageById(id: string): ChatMessage | undefined {
    return messages.value.find((message) => message.id === id)
  }

  /**
   * 找到事件所属的助手消息；不在列表里则新建，并**按事件 seq 插到正确位置**。
   *
   * 早先一律 `push` 到末尾：一旦事件顺序略有出入（陈旧请求、水合竞态），
   * 工具卡就会挂到列表末尾的新消息上，看起来就是「顺序错乱」。
   */
  function messageFor(messageId: string, seq: number): ChatMessage | undefined {
    const existing = messageById(messageId)
    if (existing) {
      assistantId = messageId
      return existing
    }
    const created: ChatMessage = {
      id: messageId,
      role: 'assistant',
      content: '',
      pending: true,
      createdAt: Date.now(),
      seq,
    }
    assistantId = messageId
    insertOrdered(created)
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
  function insertOrdered(message: ChatMessage): void {
    const seq = message.seq
    if (seq === undefined) {
      messages.value.push(message)
      return
    }
    for (let index = messages.value.length - 1; index >= 0; index -= 1) {
      const candidate = messages.value[index]
      if (candidate === undefined) break
      if (candidate.seq === undefined || candidate.seq < seq) {
        messages.value.splice(index + 1, 0, message)
        return
      }
    }
    messages.value.push(message)
  }

  function currentAssistant(): ChatMessage | undefined {
    if (assistantId === null) return undefined
    return messageById(assistantId)
  }

  /**
   * 请求收尾（done / error / abort）：复位思考的实时镜像。
   *
   * 思考文本从 2026-09 流式轮起**逐条累加在它自己的消息上**（增量自带 messageId），
   * 因此收尾没有「无主草稿」可固化 —— 这里只剩下把「正在思考」的实时标记清掉，
   * 免得下一个请求还带着上一轮的目标消息。
   */
  function settleReasoning(): void {
    resetReasoning()
  }

  /**
   * 请求收尾（done / error / abort）：把**所有**还在 `pending` 的消息一次性收口。
   *
   * 为什么不能只清「当前那条助手消息」：一轮只调工具、没有正文时（模型直接 `read_file`），
   * 那条消息由 `tool` 事件建出来，`currentAssistant()` 早已指向后面轮次的消息 ——
   * 只清最后一条，前面那条会永远停在 `pending: true`，界面上的三点动画在已结束的消息上一直转
   * （2026-09 复核发现；见 docs/06 §16.2）。
   */
  function settlePending(): void {
    for (const message of messages.value) {
      if (message.pending === true) message.pending = false
    }
  }

  /** 切换会话 / 清空会话时复位 token 用量（它记的是「这一个会话」的消耗） */
  function resetUsage(): void {
    usage.value = {
      latest: null,
      totals: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
    }
    countedUsage.clear()
  }

  /** 切换会话 / 发起新请求前复位思考镜像（旧请求的增量不能泄进新请求） */
  function resetReasoning(): void {
    reasoningTargetId.value = null
  }

  /** 同一 call id 原地更新状态（running → success/error） */
  function upsertToolCall(message: ChatMessage, call: AgentToolCall): void {
    const list = message.toolCalls ?? []
    const index = list.findIndex((item) => item.id === call.id)
    if (index >= 0) list[index] = { ...call }
    else list.push({ ...call })
    message.toolCalls = [...list]
    // 刻意**不碰 `pending`**：它表达的是「这条消息还在生成中」，只有请求收尾（done / error /
    // abort）才该把它清掉。早先这里写 `pending = content === ''`，后果是「正文已到、工具还在跑」
    // 的那一轮中途就把 pending 清成 false —— 依赖 `pending === false` 的入口（朗读按钮）
    // 会在流式途中闪出来，而工具轮那条没正文的消息又永远清不掉（三点动画在已结束的消息上一直转）。
  }

  /** 把子代理快照补进已存在的工具卡（子代理进度事件不带完整工具调用） */
  function patchToolCall(message: ChatMessage, callId: string, snapshot: SubagentSnapshot): void {
    const list = message.toolCalls ?? []
    const index = list.findIndex((item) => item.id === callId)
    if (index < 0) return
    const current = list[index]
    if (current === undefined) return
    list[index] = { ...current, subagent: snapshot }
    message.toolCalls = [...list]
  }

  /**
   * 挂载时水合历史（docs/06 §4：重启后交互窗仍能看到历史）。
   *
   * - `options.force`：绕过 `hydrated` 守卫强制重拉 —— 窗口常驻，只在挂载时水合一次的话，
   *   切回同一会话 / 其它窗口发出的新消息永远进不来（docs/07 §2.2 提示条实时刷新）；
   * - `options.limit`：只拉最近 N 条（220px 提示条面板装不下长历史）。
   *
   * 合并策略（曾经是「服务端快照整体替换本地」）：
   * - 服务端没有的本地消息保底保留；
   * - 服务端有、本地也有的同 id 消息**就地合并**：内容取更长的那份，本地流式状态
   *   （`pending` / `error` / 附件 / 思考中）优先保留 —— 否则水合会把正在流式接收的
   *   消息对象换掉，界面上的「正在输入」与已长出的工具卡会闪一下甚至消失。
   */
  async function hydrate(options?: { force?: boolean; limit?: number }): Promise<void> {
    const target = sessionId.value
    if (options?.force !== true && hydrated.has(target)) return
    hydrated.add(target)
    const result = await window.aurora.chat.history({
      sessionId: target,
      ...(options?.limit === undefined ? {} : { limit: options.limit }),
    })
    // 水合期间用户可能已经切走了会话：丢弃这次结果，避免把 A 的历史塞进 B
    if (sessionId.value !== target) return
    if (!result.ok) {
      window.console?.warn('会话历史读取失败', result.message)
      return
    }
    const server = result.value.map(toChatMessage)
    const localById = new Map(messages.value.map((message) => [message.id, message]))
    const merged = server.map((item) => {
      const local = localById.get(item.id)
      if (local === undefined) return item
      localById.delete(item.id)
      return {
        ...item,
        content: local.content.length > item.content.length ? local.content : item.content,
        ...(local.reasoning !== undefined ? { reasoning: local.reasoning } : {}),
        ...(local.pending === undefined ? {} : { pending: local.pending }),
        ...(local.error === undefined ? {} : { error: local.error }),
        ...(local.attachments === undefined ? {} : { attachments: local.attachments }),
      }
    })
    // 本地多出来的消息（服务端还没有的流式消息 / 自己刚发的 user 气泡）按原顺序跟在后面。
    // 本地 user 气泡用的是 `u-` 临时 id，与服务端 id 不同：同 role 同文本视为同一条，不重复追加。
    for (const message of messages.value) {
      if (!localById.has(message.id)) continue
      localById.delete(message.id)
      if (sameAsServer(server, message)) continue
      merged.push(message)
    }
    messages.value = merged
  }

  /**
   * 只读拉取「快速会话」的最近几条（交互窗侧栏「快速」栏用）。
   *
   * 刻意**不碰** `sessionId` / `messages`：快速会话是独立于当前会话的预览，
   * 塞进消息流会把两个会话串在一起。渲染成什么样由调用方决定。
   */
  async function loadQuickPreview(): Promise<ChatMessageDto[]> {
    const result = await window.aurora.chat.history({ sessionId: 'quick', limit: 5 })
    if (!result.ok) {
      window.console?.warn('快速会话预览读取失败', result.message)
      return []
    }
    return result.value
  }

  /** 拉取会话列表（交互窗的「历史」侧栏用）。 */
  async function loadSessions(): Promise<void> {
    const result = await window.aurora.chat.sessions()
    if (!result.ok) {
      window.console?.warn('会话列表读取失败', result.message)
      return
    }
    // active 由渲染层判定：主进程不知道哪个窗口正在看哪个会话
    sessions.value = result.value.map((item) => ({
      ...item,
      active: item.id === sessionId.value,
    }))
  }

  /**
   * 未知会话事件触发的列表补拉（center-* 远程会话可见性机制）。
   *
   * 流式期间同一会话的事件逐 token 到达，重入时直接跳过（in-flight 守卫）：
   * 一次 IPC 往返后列表里有了该会话，后续事件自然不再触发。
   */
  let refreshingUnknownSession = false
  async function refreshSessionsForUnknown(): Promise<void> {
    if (refreshingUnknownSession) return
    refreshingUnknownSession = true
    try {
      await loadSessions()
    } finally {
      refreshingUnknownSession = false
    }
  }

  // ───────────────────────── 任务（Job，docs/06 §4.1） ─────────────────────────

  /**
   * 把一条 `JobSummary`（`job` 事件 / 列表接口共用的小对象）**就地**合并进 `jobs`。
   *
   * 合并而不是替换：summary 里根本没有 `text` / `stepsDone` / `todos` / `cursor` / `origin`，
   * 整条换掉会让面板上的进度账本与待办在每次状态推送时被清空。
   *
   * 列表里还没有这条（窗口刚打开、事件先于列表水合到达）时**插到最前**再回一次 `chat:jobs`：
   * 先让「任务已暂停」这一类状态（summary 里都有）立刻可见，随后由服务端的完整对象替换。
   * 占位行只活一个 IPC 往返 —— 服务端始终是这份数据的唯一事实来源。
   */
  function applyJobSummary(summary: JobSummary): void {
    const index = jobs.value.findIndex((job) => job.id === summary.id)
    if (index < 0) {
      jobs.value = [placeholderFor(summary), ...jobs.value]
      void refreshJobs()
      return
    }
    const current = jobs.value[index]
    if (current === undefined) return
    jobs.value.splice(index, 1, {
      ...current,
      status: summary.status,
      round: summary.round,
      maxRounds: summary.maxRounds,
      budget: {
        maxTotalTokens: summary.maxTotalTokens,
        usedTokens: summary.usedTokens,
        autoContinued: summary.autoContinued,
      },
      updatedAt: summary.updatedAt,
      // 这两个字段是「覆盖」而不是「有才写」：续跑后再暂停之前的原因/错误必须能被清掉
      pendingReason: summary.pendingReason,
      error: summary.error,
    })
  }

  /**
   * 用 `JobSummary` 拼一条**临时**卡（列表水合之前用）。
   *
   * 只有状态类字段是真的（状态 / 轮次 / token / 暂停原因 —— 也正是面板一行要显示的那些）；
   * `text` / `stepsDone` / `todos` 事件里没有，留空由紧随的 `refreshJobs()` 补齐，
   * `origin` 取本窗口名（发起这条 job 的窗口），`createdAt` 借用 `updatedAt`。
   * 它**不是**持久数据：服务端列表一回来就会被同名 id 的完整对象替换。
   */
  function placeholderFor(summary: JobSummary): AgentJob {
    return {
      id: summary.id,
      sessionId: summary.sessionId,
      status: summary.status,
      origin: windowName === 'edge-bar' ? 'edge-bar' : 'chat',
      text: '',
      round: summary.round,
      maxRounds: summary.maxRounds,
      stepsDone: [],
      todos: [],
      cursor: { nextRound: summary.round },
      budget: {
        maxTotalTokens: summary.maxTotalTokens,
        usedTokens: summary.usedTokens,
        autoContinued: summary.autoContinued,
      },
      ...(summary.pendingReason === undefined ? {} : { pendingReason: summary.pendingReason }),
      createdAt: summary.updatedAt,
      updatedAt: summary.updatedAt,
      ...(summary.error === undefined ? {} : { error: summary.error }),
    }
  }

  /**
   * 拉取当前会话的任务列表（`chat:jobs`）。
   *
   * 失败**保留旧列表**（只 warn 一句）：面板宁可显示上一次的快照，也不要因为一次 IPC 抖动
   * 整块变空 —— 空列表与「真的没有任务」在界面上是同一个样子。
   * 切换会话期间到达的结果直接丢弃（与 `hydrate` 同一口径：别把 A 会话的任务显示在 B 会话里）。
   */
  async function refreshJobs(): Promise<void> {
    const target = sessionId.value
    const result = await window.aurora.chat.jobs({ sessionId: target })
    if (!result.ok) {
      window.console?.warn('任务列表读取失败', result.message)
      return
    }
    if (sessionId.value !== target) return
    jobs.value = result.value
  }

  /**
   * 续跑一条暂停的任务（`chat:resumeJob`）：主进程从 `cursor.nextRound` 接着跑，
   * 成功后重拉列表 —— 状态一律以主进程为准，渲染层不做乐观改写
   * （否则「点了继续但其实没跑起来」会看不出来）。
   *
   * 失败把主进程给的原因写进既有错误通道（`error`，与 `setArchived` 同一口径），不抛。
   */
  async function resumeJob(jobId: string): Promise<void> {
    let result: Awaited<ReturnType<typeof window.aurora.chat.resumeJob>>
    try {
      result = await window.aurora.chat.resumeJob({ sessionId: sessionId.value, jobId })
    } catch (cause) {
      // invoke 本身也可能抛（序列化失败等），与 send() / setArchived() 同款兜底
      error.value = String(cause)
      return
    }
    if (!result.ok) {
      error.value = result.message
      return
    }
    await refreshJobs()
  }

  /** 取消一条在跑 / 排队 / 暂停的任务（`chat:cancelJob`）；回执口径同上。 */
  async function cancelJob(jobId: string): Promise<void> {
    let result: Awaited<ReturnType<typeof window.aurora.chat.cancelJob>>
    try {
      result = await window.aurora.chat.cancelJob({ sessionId: sessionId.value, jobId })
    } catch (cause) {
      error.value = String(cause)
      return
    }
    if (!result.ok) {
      error.value = result.message
      return
    }
    await refreshJobs()
  }

  /**
   * 归档 / 取消归档一个会话，随后重拉列表（分组由渲染层按 `archived` 判定）。
   *
   * 主进程侧是幂等且 await 落盘完成的（`SessionStore.setArchived`），所以这里紧接的
   * `loadSessions()` 一定能读到新状态——不需要本地乐观改写，也就不会出现「界面已挪走、
   * 磁盘还没写」的两份事实。
   *
   * 刻意**不碰** `sessionId` / `messages`：归档只是给会话文件挂一个标记（docs/07 §2.3），
   * 当前正打开的那个会话被归档时要留在原地继续可读，不切走、不清空。
   *
   * 失败只把错误写进 `error`（与其它会话操作同一口径），不抛。
   */
  async function setArchived(targetId: string, archived: boolean): Promise<boolean> {
    let result: Awaited<ReturnType<typeof window.aurora.chat.archiveSession>>
    try {
      result = await window.aurora.chat.archiveSession({ sessionId: targetId, archived })
    } catch (cause) {
      // invoke 本身也可能抛（序列化失败等），与 send() 同款兜底
      error.value = String(cause)
      return false
    }
    if (!result.ok) {
      error.value = result.message
      return false
    }
    await loadSessions()
    return true
  }

  /**
   * 绑定 / 解绑一个会话的项目（docs/06 §5.1 会话级项目），随后重拉列表。
   *
   * 主进程侧是幂等且 await 落盘完成的（`SessionStore.setProject`，与 `setArchived`
   * 同一条惯例），所以这里紧接的 `loadSessions()` 一定能读到新绑定 ——
   * 不做本地乐观改写，避免「下拉框已变、磁盘还没写」的两份事实。
   * `projectId` 空串 = 清除绑定（会话回落全局当前项目）。
   *
   * 失败只把错误写进 `error`（与其它会话操作同一口径），不抛。
   */
  async function setSessionProject(targetId: string, projectId: string): Promise<boolean> {
    let result: Awaited<ReturnType<typeof window.aurora.chat.setSessionProject>>
    try {
      result = await window.aurora.chat.setSessionProject({ sessionId: targetId, projectId })
    } catch (cause) {
      // invoke 本身也可能抛（序列化失败等），与 send() / setArchived() 同款兜底
      error.value = String(cause)
      return false
    }
    if (!result.ok) {
      error.value = result.message
      return false
    }
    await loadSessions()
    return true
  }

  /** 切换到指定会话（重新水合）。切换会中断本地流式状态，但不 abort 服务端请求。 */
  async function switchSession(id: string): Promise<void> {
    if (id === sessionId.value) return
    // 在途增量先落地：下面要整表换掉 messages，留着缓冲会在新会话里凭空插出一条旧消息
    deltaBuffer.flush()
    sessionId.value = id
    messages.value = []
    error.value = null
    unread.value = false
    streaming.value = false
    activeRequest = null
    assistantId = null
    finishedRequests.clear()
    liveSubagents.value = []
    // 任务列表也是「本会话」的：旧会话的条目不能留在面板上（下面的 refreshJobs 重新拉）
    jobs.value = []
    pendingNotice.value = null
    resetUsage()
    resetReasoning()
    // force：目标会话可能已在 hydrated 里（二次进入同一会话），不强制的话
    // 守卫会吞掉这次水合，界面停在刚清空的空列表上
    await hydrate({ force: true })
    await loadSessions()
    // 任务列表与消息一起水合：暂停的长任务必须在切进这个会话时就看得见
    await refreshJobs()
  }

  /** 新建会话并切过去。新会话此时还没有标题，发完第一条消息后列表会刷新。 */
  async function newSession(): Promise<void> {
    const result = await window.aurora.chat.newSession()
    if (!result.ok) {
      error.value = result.message
      return
    }
    await switchSession(result.value)
  }

  async function send(text: string, attachments: string[] = []): Promise<void> {
    const trimmed = text.trim()
    // 允许「只发附件」：有附件时文本可以为空
    if (trimmed === '' && attachments.length === 0) return
    if (streaming.value) return

    error.value = null
    // 上一条「已暂停」提示在新请求发出后不再成立（它描述的是上一次收尾）
    pendingNotice.value = null
    const names = attachments.map(fileNameOf)
    messages.value.push({
      id: `u-${Date.now()}-${messages.value.length}`,
      role: 'user',
      content: trimmed,
      createdAt: Date.now(),
      ...(names.length === 0 ? {} : { attachments: names }),
    })

    streaming.value = true
    unread.value = false
    activeRequest = null
    assistantId = null
    resetReasoning()

    const request: SendMessageRequest = {
      sessionId: sessionId.value,
      text: trimmed,
      origin: windowName,
      // `attachments` 来自 `ref<string[]>`，是 Vue 的 reactive Proxy —— 结构化克隆不能传 Proxy
      // （见 shared/stores.ts 的同一处理），必须转成纯数组，否则整条发送链路以
      // DataCloneError 静默失败、输入区还会永远停在「流式中」。
      ...(attachments.length === 0 ? {} : { attachments: deepClone(attachments) }),
    }
    let result: Awaited<ReturnType<typeof window.aurora.chat.send>>
    try {
      result = await window.aurora.chat.send(request)
    } catch (cause) {
      // invoke 本身也可能抛（序列化失败等）：必须复位 streaming，否则输入区永久停在「流式中」
      streaming.value = false
      error.value = String(cause)
      messages.value.push({
        id: `e-${Date.now()}`,
        role: 'assistant',
        content: `发送失败：${String(cause)}`,
        error: true,
        createdAt: Date.now(),
      })
      return
    }
    if (!result.ok) {
      streaming.value = false
      error.value = result.message
      messages.value.push({
        id: `e-${Date.now()}`,
        role: 'assistant',
        content: `发送失败：${result.message}`,
        error: true,
        createdAt: Date.now(),
      })
      return
    }
    activeRequest = result.value.requestId
  }

  async function abort(): Promise<void> {
    if (activeRequest === null) return
    const requestId = activeRequest
    await window.aurora.chat.abort(requestId)
    streaming.value = false
    settleReasoning()
    settlePending()
    // 本地主动中止：紧随其后的内核事件一律丢弃（否则「已停止」之后还会继续长内容）
    finishRequest(requestId)
  }

  function clear(): void {
    // 同上：整表清空之前先把在途增量落地，否则清空后它会把消息又插回来
    deltaBuffer.flush()
    messages.value = []
    unread.value = false
    error.value = null
    pendingNotice.value = null
    liveSubagents.value = []
    resetUsage()
    resetReasoning()
  }

  function markRead(): void {
    unread.value = false
  }

  return {
    sessionId,
    messages,
    sessions,
    streaming,
    unread,
    error,
    statusTone,
    lastAssistant,
    /** 正在接收思考过程的助手消息 id（供 MessageList 自动展开思考块）；空闲时为 null */
    reasoningTargetId,
    /** 本会话 token 用量（输入框底部「上下文详解」的数据源，docs/07 §2.3） */
    usage,
    /** 本会话的子代理运行（「子代理」页面用，新的在前） */
    subagentRuns,
    /** 本会话的任务列表（「任务」面板用，新的在前；docs/06 §4.1） */
    jobs,
    /** 长任务被暂停时的一句话提示（`done` 的 pendingReason；无原因时为 null） */
    pendingNotice,
    hydrate,
    loadQuickPreview,
    loadSessions,
    /** 重拉任务列表（挂载 / 切会话后对齐；失败保留旧列表） */
    refreshJobs,
    /** 续跑一条暂停的任务（渲染层唯一的「继续」入口） */
    resumeJob,
    /** 取消一条在跑 / 排队 / 暂停的任务 */
    cancelJob,
    /** 归档 / 取消归档（左栏分组与主区提示条共用，docs/07 §2.3） */
    setArchived,
    /** 绑定 / 解绑会话项目（右栏「会话项目」下拉用，docs/06 §5.1 会话级项目） */
    setSessionProject,
    switchSession,
    newSession,
    send,
    abort,
    clear,
    markRead,
  }
}

/** 服务端快照里是否已有同 role 同文本的消息（本地 `u-` 临时 id 气泡的去重口径） */
function sameAsServer(server: ChatMessage[], local: ChatMessage): boolean {
  return server.some((item) => item.role === local.role && item.content === local.content)
}

function toChatMessage(dto: ChatMessageDto): ChatMessage {
  return {
    id: dto.id,
    role: dto.role,
    content: dto.content,
    createdAt: Date.parse(dto.createdAt) || Date.now(),
    ...(dto.toolCalls === undefined ? {} : { toolCalls: dto.toolCalls }),
    ...(dto.reasoning === undefined || dto.reasoning === '' ? {} : { reasoning: dto.reasoning }),
  }
}

/** 从绝对路径取文件名（Windows 反斜杠与 POSIX 斜杠都处理） */
function fileNameOf(path: string): string {
  const segments = path.split(/[\\/]/)
  return segments[segments.length - 1] ?? path
}
