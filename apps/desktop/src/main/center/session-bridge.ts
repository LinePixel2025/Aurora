/**
 * 远程会话桥（docs/12 §5）：Center 的 `session.input` / `session.abort` 走与
 * `chat:send` **同一条** `agent.send()` 通路（`origin: 'center'`），并把
 * `center-` 前缀会话的 AgentEvent 原样转发给连接器（再发往 Center）。
 *
 * 不另开一条"远程专用"发送链 —— job 体系 / E_BUSY / 确认卡片 / 事件顺序
 * 全部与本地发送一致，远程会话在主界面历史里也照常可见。
 */
import { CENTER_SESSION_PREFIX, type AgentEvent, type ConfirmRequestPayload } from '@aurora/shared'
import type { AskUserRequest, AskUserRequestPayload, Logger, SensitiveToolRequest } from '@aurora/shared'

/** 内核 AgentHost 的最小依赖面（`DesktopAgentHost` 结构性满足） */
export interface AgentLike {
  send(request: {
    sessionId: string
    text: string
    origin: 'center'
  }): Promise<{ requestId: string }>
  abort(requestId: string): boolean
  onEvent(listener: (event: AgentEvent) => void): () => void
}

export interface SessionBridgeOptions {
  agent: AgentLike
  logger?: Logger
}

export interface SessionSendView {
  requestId: string
  sessionId: string
}

export interface SessionCommandResult {
  ok: boolean
  data?: { agentRequestId: string }
  error?: string
}

export class SessionBridge {
  private readonly agent: AgentLike
  private readonly logger?: Logger
  /** 连接器在线时的发送回调；离线时事件直接丢弃（服务器本来就收不到） */
  private emit: ((message: unknown) => void) | undefined
  private detach: (() => void) | undefined

  constructor(options: SessionBridgeOptions) {
    this.agent = options.agent
    this.logger = options.logger
    this.detach = options.agent.onEvent((event) => this.forward(event))
  }

  bindEmit(emit: ((message: unknown) => void) | undefined): void {
    this.emit = emit
  }

  dispose(): void {
    this.detach?.()
    this.emit = undefined
  }

  isCenterSession(sessionId: string): boolean {
    return sessionId.startsWith(CENTER_SESSION_PREFIX)
  }

  async handleInput(message: SessionSendView & { text: string }): Promise<SessionCommandResult> {
    if (!this.isCenterSession(message.sessionId)) {
      return { ok: false, error: 'E_BAD_SESSION' }
    }
    if (message.text.trim() === '') {
      return { ok: false, error: 'E_INVALID_ARGUMENT' }
    }
    const result = await this.agent.send({
      sessionId: message.sessionId,
      text: message.text,
      origin: 'center',
    })
    return { ok: true, data: { agentRequestId: result.requestId } }
  }

  handleAbort(message: SessionSendView & { agentRequestId: string }): SessionCommandResult {
    if (!this.isCenterSession(message.sessionId)) {
      return { ok: false, error: 'E_BAD_SESSION' }
    }
    const aborted = this.agent.abort(message.agentRequestId)
    return { ok: aborted, ...(aborted ? {} : { error: 'E_NOT_RUNNING' }) }
  }

  /** 只转发 `center-` 前缀会话的事件；本地会话（quick / 普通会话）绝不出网 */
  private forward(event: AgentEvent): void {
    const emit = this.emit
    if (emit === undefined) return
    if (!('sessionId' in event) || !this.isCenterSession(event.sessionId)) return
    try {
      emit({ type: 'session.event', sessionId: event.sessionId, event })
    } catch (error) {
      this.logger?.warn('转发远程会话事件失败', { error: String(error) })
    }
  }
}

/**
 * 敏感工具确认请求 → `confirm.request` 上行消息（docs/12 §5.1 的纯映射，导出供单测）。
 *
 * 主进程的 `SensitiveToolRequest` 与协议的 `ConfirmRequestPayload` 只差一个
 * `createdAt`（调度器没有该字段，发送时刻即创建时刻）；`input` 已是纯数据
 * （跨 IPC 结构化克隆而来），可直接 JSON 序列化。
 */
export function toConfirmRequest(request: SensitiveToolRequest): {
  type: 'confirm.request'
  request: ConfirmRequestPayload
} {
  return {
    type: 'confirm.request',
    request: {
      confirmId: request.confirmId,
      sessionId: request.sessionId,
      toolName: request.toolName,
      input: request.input,
      createdAt: new Date().toISOString(),
      expiresAt: request.expiresAt,
    },
  }
}

/**
 * 向用户提问的请求 → `ask.request` 上行消息（docs/12 §5 的纯映射，导出供单测）。
 *
 * 形状**逐字段照搬** `AskUserRequest`（协议的 `AskUserRequestPayload` 就是它的别名）
 * ——不做转换，也就不会出现「网页端按 ISO 字符串解析而这里其实给了毫秒数」这类错配。
 */
export function toAskRequest(request: AskUserRequest): {
  type: 'ask.request'
  request: AskUserRequestPayload
} {
  return {
    type: 'ask.request',
    request: {
      requestId: request.requestId,
      sessionId: request.sessionId,
      question: request.question,
      ...(request.header === undefined ? {} : { header: request.header }),
      ...(request.options === undefined ? {} : { options: request.options }),
      multiSelect: request.multiSelect,
      expiresAt: request.expiresAt,
    },
  }
}
