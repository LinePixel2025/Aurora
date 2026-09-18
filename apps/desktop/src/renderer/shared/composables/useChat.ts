/**
 * 对话状态（P1 为"外壳 + 占位回复"）。
 *
 * 与主进程的 IPC 契约已按 P3 设计好：`chat:send` → `chat:event` 流式事件。
 * 目前 `PlaceholderAgentHost` 会返回真实感知摘要 + 下一阶段说明，
 * 因此窗口交互（打字机、状态点、中止）在 P1 就能被完整验证。
 */
import { computed, onScopeDispose, ref } from 'vue'
import type { AgentEvent, SendMessageRequest, WindowName } from '@aurora/shared'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  pending?: boolean
  error?: boolean
  createdAt: number
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
  let assistantId: string | null = null

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

  const dispose = window.aurora.chat.onEvent((event: AgentEvent) => {
    if (activeRequest !== null && event.requestId !== activeRequest) return

    switch (event.type) {
      case 'text': {
        const message = currentAssistant()
        if (message) message.content += event.delta
        break
      }
      case 'done': {
        streaming.value = false
        const message = currentAssistant()
        if (message) {
          message.pending = false
          message.content += message.content === '' ? '（暂无回复）' : ''
        }
        unread.value = true
        activeRequest = null
        assistantId = null
        break
      }
      case 'error': {
        streaming.value = false
        error.value = event.message
        const message = currentAssistant()
        if (message) {
          message.pending = false
          message.error = true
          message.content = `请求失败：${event.message}`
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

  function currentAssistant(): ChatMessage | undefined {
    if (assistantId === null) return undefined
    return messages.value.find((message) => message.id === assistantId)
  }

  async function send(text: string): Promise<void> {
    const trimmed = text.trim()
    if (trimmed === '' || streaming.value) return

    error.value = null
    messages.value.push({
      id: `u-${Date.now()}`,
      role: 'user',
      content: trimmed,
      createdAt: Date.now(),
    })

    assistantId = `a-${Date.now()}`
    messages.value.push({
      id: assistantId,
      role: 'assistant',
      content: '',
      pending: true,
      createdAt: Date.now(),
    })
    streaming.value = true
    unread.value = false

    const request: SendMessageRequest = { sessionId, text: trimmed, origin: windowName }
    const result = await window.aurora.chat.send(request)
    if (!result.ok) {
      streaming.value = false
      error.value = result.message
      const message = currentAssistant()
      if (message) {
        message.pending = false
        message.error = true
        message.content = `发送失败：${result.message}`
      }
      return
    }
    activeRequest = result.value.requestId
  }

  async function abort(): Promise<void> {
    if (activeRequest === null) return
    await window.aurora.chat.abort(activeRequest)
    streaming.value = false
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
    send,
    abort,
    clear,
    markRead,
  }
}
