/**
 * 对话状态（P3：真实内核 + 会话水合）。
 *
 * 与主进程的契约：`chat:send` → `chat:event` 流式事件 + `chat:history` 水合。
 * 事件按 `sessionId` **与** `requestId` 双重过滤：快速会话由服务窗与迷你窗
 * 共享（docs/06 §4），只按 requestId 过滤会串窗。
 *
 * 多轮工具调用会产生多条助手消息，事件里的 `messageId` 就是会话存储中的消息 id，
 * 渲染层据此认领（首轮之前还不知道 id）。
 */
import { computed, onScopeDispose, ref } from 'vue'
import type { AgentToolCall, ChatMessageDto, SendMessageRequest, WindowName } from '@aurora/shared'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  pending?: boolean
  error?: boolean
  createdAt: number
  /** 工具执行卡片（运行中 / 成功 / 失败） */
  toolCalls?: AgentToolCall[]
}

/** 每个窗口一个会话：服务窗与迷你窗共享"快速会话"（docs/06 §4） */
export function sessionIdFor(windowName: WindowName): string {
  if (windowName === 'service-dock' || windowName === 'mini-chat') return 'quick'
  if (windowName === 'chat') return 'main'
  return 'settings'
}

export function useChat(windowName: WindowName) {
  const sessionId = sessionIdFor(windowName)
  const messages = ref<ChatMessage[]>([])
  const streaming = ref(false)
  const unread = ref(false)
  const error = ref<string | null>(null)
  let activeRequest: string | null = null
  /** 当前正在流式接收的助手消息 id（服务端生成的存储 id） */
  let assistantId: string | null = null
  let hydrated = false

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
    if (event.sessionId !== sessionId) return
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
    if (hydrated) return
    hydrated = true
    const result = await window.aurora.chat.history({ sessionId })
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

  async function send(text: string): Promise<void> {
    const trimmed = text.trim()
    if (trimmed === '' || streaming.value) return

    error.value = null
    messages.value.push({
      id: `u-${Date.now()}-${messages.value.length}`,
      role: 'user',
      content: trimmed,
      createdAt: Date.now(),
    })

    streaming.value = true
    unread.value = false
    activeRequest = null
    assistantId = null

    const request: SendMessageRequest = { sessionId, text: trimmed, origin: windowName }
    const result = await window.aurora.chat.send(request)
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
    streaming,
    unread,
    error,
    statusTone,
    lastAssistant,
    hydrate,
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
