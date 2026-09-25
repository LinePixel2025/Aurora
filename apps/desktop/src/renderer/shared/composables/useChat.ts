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
 * - 思考链按 `(requestId, round)` 聚合，再由同一 `round` 的文本 / 工具事件绑定到对应助手
 *   消息 —— 增量事件本身没有 messageId，早先按 requestId 全局累积，多轮工具调用时
 *   第二条助手消息会带上第一轮的思考全文。
 *
 * 多会话（docs/06 §4）：`sessionId` 是可切换的 ref；`chat:sessions` 提供列表，
 * `chat:newSession` 新建。默认会话由入参 `context` 决定（`main` / `quick` / `settings`）。
 */
import { computed, onScopeDispose, ref } from 'vue'
import { deepClone } from '@aurora/shared/browser'
import type {
  AgentToolCall,
  ChatMessageDto,
  ChatSessionSummary,
  SendMessageRequest,
  SubagentSnapshot,
  WindowName,
} from '@aurora/shared'

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
   * 思考链聚合（docs/06 §16.1）：按轮次分桶。
   * - `roundDrafts`：`round` → 该轮已累积的思考文本（增量事件不带 messageId）；
   * - `roundOwners`：`round` → 该轮的助手消息 id（由同轮 text / tool 事件绑定）；
   * - `reasoningLive`：当前轮的文本（响应式镜像，供界面判断「正在思考」）；
   * - `reasoningTargetId`：最近收到思考的助手消息 id（MessageList 自动展开依据）。
   */
  const roundDrafts = new Map<number, string>()
  const roundOwners = new Map<number, string>()
  const reasoningLive = ref('')
  const reasoningTargetId = ref<string | null>(null)
  /** 本会话的子代理运行（实时，key = 工具调用 id）；切换会话时清空 */
  const liveSubagents = ref<SubagentRun[]>([])

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

  const dispose = window.aurora.chat.onEvent((event) => {
    if (event.sessionId !== sessionId.value) return
    if (finishedRequests.has(event.requestId)) return
    if (activeRequest !== null && event.requestId !== activeRequest) return

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
        const message = messageFor(event.messageId, event.round, event.seq)
        if (message) {
          bindRound(event.round, message)
          message.content += event.delta
          message.pending = false
        }
        break
      }
      case 'reasoning': {
        // 增量事件不带 messageId：按「请求 + 轮次」分桶累积，等该轮的 text / tool 事件
        // 到达后绑定到具体消息（docs/06 §16.1）。这样第二轮的消息不会带上第一轮的思考全文。
        const draft = (roundDrafts.get(event.round) ?? '') + event.delta
        roundDrafts.set(event.round, draft)
        reasoningLive.value = draft
        const owner = roundOwners.get(event.round)
        const message = owner === undefined ? undefined : messageById(owner)
        if (message) {
          message.reasoning = draft
          reasoningTargetId.value = message.id
        }
        break
      }
      case 'tool': {
        const message = messageFor(event.messageId, event.round, event.seq)
        if (message) {
          bindRound(event.round, message)
          upsertToolCall(message, event.call)
        }
        break
      }
      case 'subagent': {
        // 子代理进度（docs/06 §19）：同时更新工具卡上的快照（卡片就地长出进度）
        // 与「子代理」页面的实时列表
        const message = messageFor(event.messageId, event.round, event.seq)
        if (message) {
          bindRound(event.round, message)
          patchToolCall(message, event.callId, event.subagent)
        }
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
        settleReasoning(message)
        if (message) {
          message.pending = false
          if (message.content === '') message.content = '（暂无回复）'
        }
        unread.value = true
        finishRequest(event.requestId)
        break
      }
      case 'error': {
        streaming.value = false
        error.value = event.message
        const message = currentAssistant() ?? lastAssistant.value
        settleReasoning(message)
        if (message) {
          message.pending = false
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

  onScopeDispose(dispose)

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
  function messageFor(messageId: string, round: number, seq: number): ChatMessage | undefined {
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
      // 该轮的思考可能先于正文到达：消息此刻才出现，把这一轮已聚合的文本补上
      ...(() => {
        const draft = roundDrafts.get(round)
        return draft === undefined || draft === '' ? {} : { reasoning: draft }
      })(),
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

  /** 把某一轮绑定到它的助手消息：该轮已聚合的思考文本一次性并入（长度只增不减） */
  function bindRound(round: number, message: ChatMessage): void {
    roundOwners.set(round, message.id)
    const draft = roundDrafts.get(round)
    if (draft !== undefined && draft !== '' && (message.reasoning ?? '').length < draft.length) {
      message.reasoning = draft
      reasoningTargetId.value = message.id
    }
  }

  function currentAssistant(): ChatMessage | undefined {
    if (assistantId === null) return undefined
    return messageById(assistantId)
  }

  /**
   * 请求收尾（done / error / abort）：固化「从未绑定到消息」的思考尾巴，复位聚合状态。
   *
   * 只处理**无主**的轮次草稿：有主的桶（`roundOwners` 已绑定）已经完整落在对应消息上。
   * 不能直接灌 `reasoningLive` —— 它只在收到思考增量时更新，最后一轮若没有思考，
   * 它保留的是更早轮次的残留镜像，灌进收尾时活跃的消息就是「已深度思考」重复出现
   * 两次（2026-09-25 报告；见 docs/06 §16.1 症状表）。
   */
  function settleReasoning(message: ChatMessage | null | undefined): void {
    let orphanDraft: string | undefined
    for (const [round, draft] of roundDrafts) {
      if (draft !== '' && roundOwners.get(round) === undefined) orphanDraft = draft
    }
    if (message !== null && message !== undefined && orphanDraft !== undefined) {
      if ((message.reasoning ?? '').length < orphanDraft.length) {
        message.reasoning = orphanDraft
      }
    }
    resetReasoning()
  }

  /** 切换会话 / 发起新请求前复位思考聚合（旧请求的增量不能泄进新请求） */
  function resetReasoning(): void {
    roundDrafts.clear()
    roundOwners.clear()
    reasoningLive.value = ''
    reasoningTargetId.value = null
  }

  /** 同一 call id 原地更新状态（running → success/error） */
  function upsertToolCall(message: ChatMessage, call: AgentToolCall): void {
    const list = message.toolCalls ?? []
    const index = list.findIndex((item) => item.id === call.id)
    if (index >= 0) list[index] = { ...call }
    else list.push({ ...call })
    message.toolCalls = [...list]
    message.pending = message.content === ''
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

  /** 切换到指定会话（重新水合）。切换会中断本地流式状态，但不 abort 服务端请求。 */
  async function switchSession(id: string): Promise<void> {
    if (id === sessionId.value) return
    sessionId.value = id
    messages.value = []
    error.value = null
    unread.value = false
    streaming.value = false
    activeRequest = null
    assistantId = null
    finishedRequests.clear()
    liveSubagents.value = []
    resetReasoning()
    // force：目标会话可能已在 hydrated 里（二次进入同一会话），不强制的话
    // 守卫会吞掉这次水合，界面停在刚清空的空列表上
    await hydrate({ force: true })
    await loadSessions()
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
    const message = currentAssistant()
    settleReasoning(message)
    if (message) message.pending = false
    // 本地主动中止：紧随其后的内核事件一律丢弃（否则「已停止」之后还会继续长内容）
    finishRequest(requestId)
  }

  function clear(): void {
    messages.value = []
    unread.value = false
    error.value = null
    liveSubagents.value = []
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
    /** 流式期间的思考过程聚合文本（当前轮；请求结束后为空串，增量已并入消息） */
    reasoningLive,
    /** 正在接收思考过程的助手消息 id（供 MessageList 自动展开思考块）；空闲时为 null */
    reasoningTargetId,
    /** 本会话的子代理运行（「子代理」页面用，新的在前） */
    subagentRuns,
    hydrate,
    loadQuickPreview,
    loadSessions,
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
