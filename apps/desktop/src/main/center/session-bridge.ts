/**
 * 远程会话桥（docs/12 §5）：Center 的 `session.input` / `session.abort` 走与
 * `chat:send` **同一条** `agent.send()` 通路（`origin: 'center'`），并把
 * `center-` 前缀会话的 AgentEvent 原样转发给连接器（再发往 Center）。
 *
 * 不另开一条"远程专用"发送链 —— job 体系 / E_BUSY / 确认卡片 / 事件顺序
 * 全部与本地发送一致，远程会话在主界面历史里也照常可见。
 */
import {
  CENTER_INPUT_ATTACHMENT_LIMIT,
  CENTER_SESSION_PREFIX,
  type AgentEvent,
  type ConfirmRequestPayload,
} from '@aurora/shared'
import type {
  AskUserRequest,
  AskUserRequestPayload,
  Logger,
  SensitiveToolRequest,
} from '@aurora/shared'

/** 网页端随 `session.input` 上行的附件（服务器已补齐 `name`）。 */
export interface CenterInputAttachment {
  fileId: string
  name: string
}

/** 内核 AgentHost 的最小依赖面（`DesktopAgentHost` 结构性满足） */
export interface AgentLike {
  send(request: {
    sessionId: string
    text: string
    origin: 'center'
    /** 附件提取文本（与 `chat:send` 同一条通道） */
    extraContext?: string
    /** 本轮图片附件路径（与 `chat:send` 同一口径：读盘在内核注入的 `loadImages` 里） */
    images?: readonly string[]
  }): Promise<{ requestId: string }>
  abort(requestId: string): boolean
  onEvent(listener: (event: AgentEvent) => void): () => void
}

export interface SessionBridgeOptions {
  agent: AgentLike
  logger?: Logger
  /**
   * 把一个远程附件下载到本机（Center `session.input.attachments` 的落地）。
   * 返回本地绝对路径；失败抛错 —— SessionBridge 折成 `E_ATTACHMENT_FAILED` 且**不发送**。
   * 未注入 = 本端不支持远程图片附件（带附件的命令回 `E_UNSUPPORTED`）。
   */
  fetchAttachment?: (input: { fileId: string; name: string }) => Promise<string>
  /**
   * 与 `chat:send` **同一条**附件准备链（图片分流 / vision 降级 / 文档提取）。
   * 未注入时与 `fetchAttachment` 一样按不支持处理。
   */
  prepareAttachments?: (
    paths: string[],
  ) => Promise<{ extraContext?: string; images: readonly string[] }>
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
  private readonly fetchAttachment?: SessionBridgeOptions['fetchAttachment']
  private readonly prepareAttachments?: SessionBridgeOptions['prepareAttachments']
  /** 连接器在线时的发送回调；离线时事件直接丢弃（服务器本来就收不到） */
  private emit: ((message: unknown) => void) | undefined
  private detach: (() => void) | undefined

  constructor(options: SessionBridgeOptions) {
    this.agent = options.agent
    this.logger = options.logger
    this.fetchAttachment = options.fetchAttachment
    this.prepareAttachments = options.prepareAttachments
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

  async handleInput(
    message: SessionSendView & { text: string; attachments?: CenterInputAttachment[] },
  ): Promise<SessionCommandResult> {
    if (!this.isCenterSession(message.sessionId)) {
      return { ok: false, error: 'E_BAD_SESSION' }
    }
    // 跨进程入参来自服务器，形状不可假设（非数组 / 非对象一律拒绝，不静默吞掉附件）。
    const rawAttachments: unknown = message.attachments
    if (rawAttachments !== undefined && !Array.isArray(rawAttachments)) {
      return { ok: false, error: 'E_INVALID_ARGUMENT' }
    }
    const attachments: CenterInputAttachment[] = rawAttachments ?? []
    if (attachments.length > CENTER_INPUT_ATTACHMENT_LIMIT) {
      return { ok: false, error: 'E_INVALID_ARGUMENT' }
    }
    // 纯图片消息也允许（渲染层本地发送同款口径）：只要文本或附件有一个非空。
    if (message.text.trim() === '' && attachments.length === 0) {
      return { ok: false, error: 'E_INVALID_ARGUMENT' }
    }
    const malformed = attachments.some(
      (attachment) =>
        typeof attachment?.fileId !== 'string' ||
        attachment.fileId === '' ||
        typeof attachment?.name !== 'string',
    )
    if (malformed) return { ok: false, error: 'E_INVALID_ARGUMENT' }

    // 附件（docs/12 §5）：先下载到本机再走与 `chat:send` 同一条准备链。
    // 任何一步失败都**不发送**：半套附件进对话比直接失败更容易让人误判模型"看过图"。
    let prepared: { extraContext?: string; images: readonly string[] } = { images: [] }
    if (attachments.length > 0) {
      const fetchAttachment = this.fetchAttachment
      const prepareAttachments = this.prepareAttachments
      if (fetchAttachment === undefined || prepareAttachments === undefined) {
        return { ok: false, error: 'E_UNSUPPORTED' }
      }
      const paths: string[] = []
      try {
        for (const attachment of attachments) {
          const path = await fetchAttachment({ fileId: attachment.fileId, name: attachment.name })
          if (typeof path !== 'string' || path === '') {
            throw new Error(`附件下载返回了非法路径：${attachment.fileId}`)
          }
          paths.push(path)
        }
      } catch (error) {
        this.logger?.warn('远程附件下载失败，本次消息不发送', {
          sessionId: message.sessionId,
          count: attachments.length,
          error: String(error),
        })
        return { ok: false, error: 'E_ATTACHMENT_FAILED' }
      }
      try {
        prepared = await prepareAttachments(paths)
      } catch (error) {
        this.logger?.warn('远程附件准备失败，本次消息不发送', {
          sessionId: message.sessionId,
          error: String(error),
        })
        return { ok: false, error: 'E_ATTACHMENT_FAILED' }
      }
    }

    const extraContext = prepared.extraContext?.trim() ?? ''
    const result = await this.agent.send({
      sessionId: message.sessionId,
      text: message.text,
      origin: 'center',
      ...(extraContext === '' ? {} : { extraContext }),
      ...(prepared.images.length === 0 ? {} : { images: prepared.images }),
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
      ...(request.allowCustom === undefined ? {} : { allowCustom: request.allowCustom }),
      ...(request.questions === undefined ? {} : { questions: request.questions }),
      expiresAt: request.expiresAt,
    },
  }
}
