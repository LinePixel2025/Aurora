/**
 * AgentHost 装配层（docs/02 §3.1、docs/06 §5）。
 *
 * P1 行为：窗口可输入消息，主进程返回**真实感知摘要 + 当前模式提示词**，
 * 并明确标注"AI 内核将在下一阶段接入"。P3 会用 agent-core 的
 * `session` / `loop` / `llm` 替换 `buildReply`，IPC 契约保持不变。
 */
import type {
  AgentEvent,
  AgentHost,
  Logger,
  ModeManagerLike,
  PerceptionLike,
  SendMessageRequest,
  SettingsStoreLike,
} from './contracts.js'

export interface AgentHostOptions {
  settings: SettingsStoreLike
  modes: ModeManagerLike
  perception: PerceptionLike
  logger: Logger
}

export class PlaceholderAgentHost implements AgentHost {
  private readonly options: AgentHostOptions
  private readonly listeners = new Set<(event: AgentEvent) => void>()
  private counter = 0
  private readonly aborted = new Set<string>()

  constructor(options: AgentHostOptions) {
    this.options = options
  }

  isReady(): boolean {
    return false
  }

  send(request: SendMessageRequest): Promise<{ requestId: string }> {
    this.counter += 1
    const requestId = `req-${Date.now()}-${this.counter}`
    this.emit({ type: 'queued', requestId })

    void this.deliver(requestId, request)
    return Promise.resolve({ requestId })
  }

  abort(requestId: string): boolean {
    this.aborted.add(requestId)
    return true
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 当前模式提示词 + 感知摘要，供 P3 复用与设置页预览。 */
  buildSystemPrompt(): string {
    return [this.options.modes.systemPrompt(), this.replyContext()]
      .filter((part) => part !== '')
      .join('\n\n')
  }

  private replyContext(): string {
    return ''
  }

  private async deliver(requestId: string, request: SendMessageRequest): Promise<void> {
    const text = await this.buildReply(request)
    if (this.aborted.has(requestId)) {
      this.aborted.delete(requestId)
      this.emit({ type: 'done', requestId })
      return
    }
    // 模拟流式输出，让渲染层的打字机与状态机在 P1 就能被验证
    for (const chunk of chunkText(text)) {
      if (this.aborted.has(requestId)) {
        this.aborted.delete(requestId)
        this.emit({ type: 'done', requestId })
        return
      }
      this.emit({ type: 'text', requestId, delta: chunk })
      await delay(18)
    }
    this.emit({ type: 'done', requestId, pending: true })
  }

  private async buildReply(request: SendMessageRequest): Promise<string> {
    const settings = this.options.settings.get()
    const active = settings.llm.active
    const provider = active === '' ? undefined : settings.llm.providers[active]

    const header: string[] = []
    if (!provider || provider.apiKeyEnc === '') {
      header.push('⚠️ 还没有可用的 AI 模型配置，请先在「设置 → AI 模型」中完成配置。')
    } else {
      header.push(`已就绪的模型：${provider.model}（${active}）`)
    }

    const summary = await this.options.perception.contextSummary()
    const mode = this.options.modes.currentSummary()
    const lines = [
      ...header,
      '',
      `当前模式：${mode.displayName}${mode.placeholder ? '（建设中）' : ''}`,
      `系统状态：${summary}`,
      '',
      `你说的是：「${truncate(request.text, 200)}」`,
      '',
      'AI 对话内核将在下一阶段（v0.3.0 · Agent 内核）接入：届时这里会返回模型的真实回复，',
      '并支持工具调用、Skill 与 MCP。当前版本可先在「设置」中完成模型与模式配置。',
    ]
    this.options.logger.info('收到占位回复请求', {
      origin: request.origin,
      sessionId: request.sessionId,
      hasModel: Boolean(provider),
    })
    return lines.join('\n')
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        this.options.logger.warn('Agent 事件监听器抛错', { error: String(error) })
      }
    }
  }
}

function chunkText(text: string, size = 6): string[] {
  const chunks: string[] = []
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size))
  }
  return chunks
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
