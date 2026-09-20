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
 * `chat:newSession` 新建。窗口默认会话仍是 `main` / `quick`，老数据继续可读。
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
}

/** 每个窗口的**默认**会话：迷你窗使用"快速会话"（docs/06 §4） */
export function sessionIdFor(windowName: WindowName): string {
  if (windowName === 'mini-chat') return 'quick'
  if (windowName === 'chat') return 'main'
  return 'settings'
}

export function useChat(windowName: WindowName) {
  const defaultSessionId = sessionIdFor(windowName)
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
      case 'text': {
        const message = messageFor(event.messageId)
        if (message) {
          message.content += event.delta
          message.pending = false
        }
        break
      }
      case 'tool': {
        const message = messageFor(event.messageId)
        if (message) upsertToolCall(message, event.call)
        break
      }
      case 'done': {
        streaming.value = false
        const message = currentAssistant()
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
    }
    messages.value.push(created)
    return created
  }

  function currentAssistant(): ChatMessage | undefined {
    if (assistantId === null) return undefined
    return messages.value.find((message) => message.id === assistantId)
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

  /** 挂载时水合历史（docs/06 §4：重启后交互窗仍能看到历史）。 */
  async function hydrate(): Promise<void> {
    const target = sessionId.value
    if (hydrated.has(target)) return
    hydrated.add(target)
    const result = await window.aurora.chat.history({ sessionId: target })
    // 水合期间用户可能已经切走了会话：丢弃这次结果，避免把 A 的历史塞进 B
    if (sessionId.value !== target) return
    if (!result.ok) {
      window.console?.warn('会话历史读取失败', result.message)
      return
    }
    // 水合期间可能已有新消息进来（用户在窗口刚打开时就开始输入）
    const incoming = messages.value.filter(
      (message) => !result.value.some((item) => item.id === message.id),
    )
    messages.value = [...result.value.map(toChatMessage), ...incoming]
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
    await hydrate()
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
    if (message) message.pending = false
    activeRequest = null
    assistantId = null
  }

  function clear(): void {
    messages.value = []
    unread.value = false
    error.value = null
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
    hydrate,
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
  }
}

/** 从绝对路径取文件名（Windows 反斜杠与 POSIX 斜杠都处理） */
function fileNameOf(path: string): string {
  const segments = path.split(/[\\/]/)
  return segments[segments.length - 1] ?? path
}
