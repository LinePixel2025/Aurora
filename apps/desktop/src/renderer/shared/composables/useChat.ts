/**
 * 对话状态（P3：真实内核 + 会话水合）。
 *
 * 与主进程的契约：`chat:send` → `chat:event` 流式事件 + `chat:history` 水合。
 * 事件按 `sessionId` **与** `requestId` 双重过滤：不同窗口可能解析到同一个会话
 * （docs/06 §4），只按 requestId 过滤会串窗。
 *
 * 多轮工具调用会产生多条助手消息，事件里的 `messageId` 就是会话存储中的消息 id，
 * 渲染层据此认领（首轮之前还不知道 id）。
 *
 * 多会话（docs/06 §4）：`sessionId` 是可切换的 ref；`chat:sessions` 提供列表，
 * `chat:newSession` 新建。默认会话由入参 `context` 决定（`main` / `quick` / `settings`），
 * 会话 id 与旧版一致，老数据继续可读。
 *
 * BetaV2 追加：`reasoning` 事件的思考过程增量按 requestId 聚合（`reasoningLive` /
 * `reasoningTargetId`），done / error / abort 后并入当条助手消息；历史水合的消息自带
 * `reasoning?` 字段（packages/shared/src/ipc/types.ts 的 ChatMessageDto）。
 */
import { computed, onScopeDispose, ref } from 'vue'
import { deepClone } from '@aurora/shared/browser'
import type {
  AgentToolCall,
  ChatMessageDto,
  ChatSessionSummary,
  SendMessageRequest,
  WindowName,
} from '@aurora/shared'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  pending?: boolean
  error?: boolean
  createdAt: number
  /** 工具执行卡片（运行中 / 成功 / 失败） */
  toolCalls?: AgentToolCall[]
  /** 本条用户消息携带的附件文件名（仅用于气泡内展示） */
  attachments?: string[]
  /**
   * 模型思考过程（reasoning_content 聚合，BetaV2）。
   * 流式期间由 `reasoning` 事件实时同步进当前助手消息；请求收尾后固化，
   * 历史（`chat:history`）水合的消息自带该字段。
   */
  reasoning?: string
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
  /**
   * 当前会话 id（可切换）。
   *
   * 事件按 `sessionId` **与** `requestId` 双重过滤：不同窗口可能解析到同一个会话
   * （docs/06 §4），只按 requestId 过滤会串窗；切换会话后旧会话的流式事件
   * 也必须被丢弃，否则历史会串到新会话气泡里。
   */
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
   * 思考过程（reasoning，BetaV2）的聚合状态：
   * - `reasoningDrafts` 按 requestId 累积增量——增量事件**不带 messageId**，
   *   同一次请求又可能产生多条助手消息（多轮工具调用），只能按请求聚合；
   * - `reasoningLive` 是当前请求聚合文本的响应式镜像（流式期间实时展示用）；
   * - `reasoningTargetId` 是「正在接收思考过程」的助手消息 id（首条 text/tool
   *   事件到达前渲染层还不知道 messageId，故可能暂时为 null），供 MessageList 自动展开。
   */
  const reasoningDrafts = new Map<string, string>()
  const reasoningLive = ref('')
  const reasoningTargetId = ref<string | null>(null)

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

  const dispose = window.aurora.chat.onEvent((event) => {
    if (event.sessionId !== sessionId.value) return
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
        let duplicate = false
        for (let index = messages.value.length - 1; index >= 0; index -= 1) {
          const message = messages.value[index]
          if (message === undefined || message.createdAt < cutoff) break
          if (message.role === 'user' && message.content === content) {
            duplicate = true
            break
          }
        }
        if (!duplicate) {
          messages.value.push({
            id: `u-evt-${event.requestId}`,
            role: 'user',
            content,
            createdAt: event.createdAt,
          })
        }
        break
      }
      case 'text': {
        const message = messageFor(event.messageId)
        if (message) {
          seedReasoning(message)
          message.content += event.delta
          message.pending = false
        }
        break
      }
      case 'reasoning': {
        // 增量事件不带 messageId：先按请求聚合，助手消息出现后（text/tool 先到）
        // 再把聚合文本同步进消息体，供 MessageList 流式展示
        const text = (reasoningDrafts.get(event.requestId) ?? '') + event.delta
        reasoningDrafts.set(event.requestId, text)
        reasoningLive.value = text
        const message = currentAssistant()
        if (message) {
          message.reasoning = text
          reasoningTargetId.value = message.id
        }
        break
      }
      case 'tool': {
        const message = messageFor(event.messageId)
        if (message) {
          seedReasoning(message)
          upsertToolCall(message, event.call)
        }
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
        activeRequest = null
        assistantId = null
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
        activeRequest = null
        assistantId = null
        break
      }
      default:
        break
    }
  })

  onScopeDispose(dispose)

  /** 找到事件所属的助手消息；不在列表里则按服务端 id 追加一条。 */
  function messageFor(messageId: string): ChatMessage | undefined {
    const existing = messages.value.find((message) => message.id === messageId)
    if (existing) {
      assistantId = messageId
      return existing
    }
    if (assistantId !== null && messageId !== assistantId) {
      // 多轮工具调用：上一轮已结束，服务端开始了新一轮助手消息
      assistantId = messageId
    }
    assistantId = messageId
    const created: ChatMessage = {
      id: messageId,
      role: 'assistant',
      content: '',
      pending: true,
      createdAt: Date.now(),
      // 思考过程先于正文到达：消息此刻才出现，把已聚合的文本一并补上
      ...(reasoningLive.value === '' ? {} : { reasoning: reasoningLive.value }),
    }
    messages.value.push(created)
    return created
  }

  function currentAssistant(): ChatMessage | undefined {
    if (assistantId === null) return undefined
    return messages.value.find((message) => message.id === assistantId)
  }

  /** 消息刚被认领时补种已聚合的思考文本，并把它标记为流式思考的展示目标 */
  function seedReasoning(message: ChatMessage): void {
    if (reasoningLive.value === '') return
    if ((message.reasoning ?? '').length < reasoningLive.value.length) {
      message.reasoning = reasoningLive.value
    }
    reasoningTargetId.value = message.id
  }

  /**
   * 请求收尾（done / error / abort）：把聚合文本固化进当条助手消息（本地），
   * 随后复位流式思考状态——MessageList 的「思考中」自动展开随之收起为摘要。
   * `lastAssistant` 的 computed 以 null 表示「没有助手消息」，入参一并兼容。
   */
  function settleReasoning(message: ChatMessage | null | undefined): void {
    if (message !== null && message !== undefined && reasoningLive.value !== '') {
      if ((message.reasoning ?? '').length < reasoningLive.value.length) {
        message.reasoning = reasoningLive.value
      }
    }
    reasoningDrafts.clear()
    reasoningLive.value = ''
    reasoningTargetId.value = null
  }

  /** 切换会话 / 发起新请求前复位思考聚合（旧请求的增量不能泄进新请求） */
  function resetReasoning(): void {
    reasoningDrafts.clear()
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

  /**
   * 挂载时水合历史（docs/06 §4：重启后交互窗仍能看到历史）。
   *
   * - `options.force`：绕过 `hydrated` 守卫强制重拉 —— 窗口常驻，只在挂载时水合一次的话，
   *   切回同一会话 / 其它窗口发出的新消息永远进不来（docs/07 §2.2 提示条实时刷新）；
   * - `options.limit`：只拉最近 N 条（220px 提示条面板装不下长历史）。
   *
   * 水合结果与本地消息合并：服务端没有的本地消息保底保留。注意本地 user 消息
   * （send() 里 push 的 `u-` 临时 id）与服务端存储的同一条消息 id 不同，
   * 仅按 id 去重会显示成两条，因此同 role 同文本也视为同一条。
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
    // 水合期间可能已有新消息进来（用户在窗口刚打开时就开始输入）
    const incoming = messages.value.filter(
      (message) =>
        !result.value.some((item) => item.id === message.id) &&
        !result.value.some(
          (item) => item.role === message.role && item.content === message.content,
        ),
    )
    messages.value = [...result.value.map(toChatMessage), ...incoming]
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
    await window.aurora.chat.abort(activeRequest)
    streaming.value = false
    const message = currentAssistant()
    settleReasoning(message)
    if (message) message.pending = false
    activeRequest = null
    assistantId = null
  }

  function clear(): void {
    messages.value = []
    unread.value = false
    error.value = null
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
    /** 流式期间的思考过程聚合文本（请求结束后为空串，增量已并入消息） */
    reasoningLive,
    /** 正在接收思考过程的助手消息 id（供 MessageList 自动展开思考块）；空闲时为 null */
    reasoningTargetId,
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
