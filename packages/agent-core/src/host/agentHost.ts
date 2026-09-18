/**
 * KernelAgentHost —— 把内核各模块装配成 `AgentHost`（docs/02 §3.1、docs/06 §5）。
 *
 * 纯逻辑：所有系统能力（模型凭据解密、模式提示词、感知摘要、会话存储）
 * 由主进程以依赖形式注入，因此可在 Node 里完整单测。
 */
import type { AgentEvent, AgentHost as AgentHostContract, AgentToolCall } from '@aurora/shared'
import type { Logger } from '@aurora/shared'
import { createNoopLogger } from '@aurora/shared'
import { buildSystemPrompt, describeTools } from '../context/systemPrompt.js'
import { runAgentLoop, type LoopProvider } from '../loop/agentLoop.js'
import type { SkillsBridge } from '../skills/bridge.js'
import { truncateHistory, DEFAULT_MAX_CHARS } from '../session/history.js'
import type { SessionStore } from '../session/store.js'
import type { NewMessage, StoredToolCall } from '../session/types.js'
import type { ToolRegistry } from '../tools/registry.js'

export interface ProviderConfig {
  provider: LoopProvider
  model: string
  temperature?: number
}

export interface AgentProviderFactory {
  /** 每次请求即时构造（保证设置页改 Key 后立即生效） */
  create(): ProviderConfig | undefined
}

export interface AgentHostDeps {
  sessions: SessionStore
  provider: AgentProviderFactory
  tools: ToolRegistry
  skills: SkillsBridge
  logger?: Logger
  /** 当前模式提示词片段 */
  modePrompt?(): string
  /** 系统感知摘要 */
  perceptionSummary?(): Promise<string>
  /** 单次请求的会话历史字符预算 */
  maxChars?: number
  /** 工具调用轮次上限 */
  maxRounds?: number
  /**
   * 敏感工具执行前的用户确认（docs/06 §5）。
   * 未注入时保持 v0.3.0 行为（不拦截，仅由 `onToolCall` 留痕）。
   */
  confirmTool?(info: {
    name: string
    input: unknown
    sessionId: string
    sensitivity: 'confirm'
  }): Promise<boolean>
}

export const ERROR_NO_MODEL = 'E_NO_MODEL'
export const ERROR_BUSY = 'E_BUSY'

export class KernelAgentHost implements AgentHostContract {
  private readonly deps: AgentHostDeps
  private readonly logger: Logger
  private readonly listeners = new Set<(event: AgentEvent) => void>()
  private readonly active = new Map<string, { requestId: string; controller: AbortController }>()
  private counter = 0

  constructor(deps: AgentHostDeps) {
    this.deps = deps
    this.logger = deps.logger ?? createNoopLogger()
  }

  isReady(): boolean {
    return this.deps.provider.create() !== undefined
  }

  async send(request: {
    sessionId: string
    text: string
    origin: string
  }): Promise<{ requestId: string }> {
    const sessionId = request.sessionId
    this.counter += 1
    const requestId = `req-${Date.now()}-${this.counter}`

    this.emit({ type: 'queued', sessionId, requestId })

    const text = request.text.trim()
    if (text === '') {
      this.emit({
        type: 'error',
        sessionId,
        requestId,
        code: 'E_INVALID_ARGUMENT',
        message: '消息内容为空',
      })
      return { requestId }
    }

    if (this.active.has(sessionId)) {
      this.emit({
        type: 'error',
        sessionId,
        requestId,
        code: ERROR_BUSY,
        message: '该会话正在回复中，请等待或先停止当前回复',
      })
      return { requestId }
    }

    const config = this.deps.provider.create()
    if (config === undefined) {
      this.emit({
        type: 'error',
        sessionId,
        requestId,
        code: ERROR_NO_MODEL,
        message: '还没有可用的 AI 模型配置：请在「设置 → AI 模型」中填写并保存 API Key',
      })
      return { requestId }
    }

    const controller = new AbortController()
    this.active.set(sessionId, { requestId, controller })

    // 后台推进；事件通过 onEvent 推送，异常不越过 IPC 边界
    void this.run({ sessionId, requestId, text, origin: request.origin, config, controller })
    return { requestId }
  }

  abort(requestId: string): boolean {
    for (const [sessionId, entry] of this.active) {
      if (entry.requestId !== requestId) continue
      entry.controller.abort()
      this.active.delete(sessionId)
      this.logger.info('已取消 Agent 请求', { requestId, sessionId })
      // 立即结束渲染层的 loading 状态；循环内部的 abort 会自然退出
      this.emit({ type: 'done', sessionId, requestId })
      return true
    }
    return false
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 当前是否已有请求在跑（供测试与状态展示） */
  isBusy(sessionId: string): boolean {
    return this.active.has(sessionId)
  }

  // ───────────────────────── 内部 ─────────────────────────

  private async run(input: {
    sessionId: string
    requestId: string
    text: string
    origin: string
    config: ProviderConfig
    controller: AbortController
  }): Promise<void> {
    const { sessionId, requestId } = input
    try {
      const explicit = this.deps.skills.parseExplicitInvocation(input.text)
      const userInput =
        explicit === undefined ? input.text : explicit.rest === '' ? input.text : explicit.rest
      const extraContext =
        explicit === undefined ? undefined : this.deps.skills.render(explicit.skillName)

      const history = truncateHistory(await this.deps.sessions.get(sessionId), {
        maxChars: this.deps.maxChars ?? DEFAULT_MAX_CHARS,
      }).messages

      const systemPrompt = buildSystemPrompt({
        ...(this.deps.modePrompt === undefined ? {} : { modePrompt: this.deps.modePrompt() }),
        ...(this.deps.perceptionSummary === undefined
          ? {}
          : { perceptionSummary: await this.deps.perceptionSummary() }),
        skillCatalog: this.deps.skills.catalogPrompt,
        ...(() => {
          const catalog = describeTools(this.deps.tools.list())
          return catalog === undefined ? {} : { toolCatalog: catalog }
        })(),
      })

      const loop = runAgentLoop({
        provider: input.config.provider,
        model: input.config.model,
        ...(input.config.temperature === undefined
          ? {}
          : { temperature: input.config.temperature }),
        systemPrompt,
        userInput,
        ...(extraContext === undefined ? {} : { extraContext }),
        history,
        tools: this.deps.tools,
        sessionId,
        signal: input.controller.signal,
        ...(this.deps.maxRounds === undefined ? {} : { maxRounds: this.deps.maxRounds }),
        ...(this.deps.confirmTool === undefined ? {} : { confirmTool: this.deps.confirmTool }),
        append: (message: NewMessage) => this.deps.sessions.append(sessionId, message),
        updateToolCall: (messageId: string, call: StoredToolCall) =>
          this.deps.sessions.updateToolCall(messageId, call),
        onToolCall: (info) => {
          this.logger.info('工具调用', {
            name: info.name,
            sensitivity: info.sensitivity,
            isError: info.isError,
          })
        },
      })

      for await (const event of loop) {
        switch (event.type) {
          case 'text': {
            this.emit({
              type: 'text',
              sessionId,
              requestId,
              messageId: event.messageId,
              delta: event.delta,
            })
            break
          }
          case 'tool': {
            this.emit({
              type: 'tool',
              sessionId,
              requestId,
              messageId: event.messageId,
              call: event.call,
            })
            break
          }
          case 'done': {
            this.emit({
              type: 'done',
              sessionId,
              requestId,
              ...(event.pending === true ? { pending: true } : {}),
            })
            break
          }
          case 'error': {
            this.emit({
              type: 'error',
              sessionId,
              requestId,
              code: event.code,
              message: event.message,
            })
            break
          }
          default:
            break
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error('Agent 请求失败', { requestId, sessionId, error: message })
      this.emit({ type: 'error', sessionId, requestId, code: 'E_UNKNOWN', message })
    } finally {
      const entry = this.active.get(sessionId)
      if (entry?.requestId === requestId) this.active.delete(sessionId)
    }
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        this.logger.warn('Agent 事件监听器抛错', { error: String(error) })
      }
    }
  }
}

export type { AgentToolCall }
