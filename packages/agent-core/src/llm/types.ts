/** LLM 提供者抽象（docs/06 §3、ADR-003）。 */
import type { ReasoningEffort } from '@aurora/shared'

/**
 * 真正允许下发给模型的思考等级（v5）。
 *
 * `auto` 表示「不下发思考等级字段」，由装配层（主进程 `createProviderFactory`）
 * 映射成 `undefined`；内核**永远**收不到 `'auto'`。
 */
export type ReasoningEffortLevel = Exclude<ReasoningEffort, 'auto'>

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCallRequest {
  id: string
  name: string
  /** JSON 字符串（原样回填给模型） */
  arguments: string
}

export interface ChatRequestMessage {
  role: ChatRole
  content: string
  /** assistant 消息发起工具调用时使用 */
  toolCalls?: ToolCallRequest[]
  /** role = tool 时的调用 id */
  toolCallId?: string
  name?: string
}

export interface LlmToolParameterSchema {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

export interface LlmToolDefinition {
  name: string
  description: string
  parameters: LlmToolParameterSchema
}

export interface ChatRequest {
  model: string
  messages: ChatRequestMessage[]
  tools?: LlmToolDefinition[]
  temperature?: number
  /**
   * 思考等级（v5）。`undefined` = 请求体里不带思考等级字段
   * （用户选 `auto`，兼容性最好）；`auto` 不会出现在这里，见 `ReasoningEffortLevel`。
   */
  reasoningEffort?: ReasoningEffortLevel
  maxTokens?: number
  /** 要求模型以 JSON 对象作答（结构化输出，docs/05 §3.2） */
  jsonObject?: boolean
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'unknown'

export type ChatEvent =
  | { type: 'text'; delta: string }
  /** 思考链增量（`reasoning_content` / `reasoning` 字段，Design/betav2-spec.md §6） */
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call'; call: ToolCallRequest }
  | { type: 'done'; finishReason: FinishReason; usage?: TokenUsage }
  | { type: 'error'; code: LlmErrorCode; message: string }

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface ModelInfo {
  id: string
  ownedBy?: string
}

export interface TestConnectionResult {
  ok: boolean
  latencyMs: number
  message: string
  models?: string[]
  httpStatus?: number
}

export type LlmErrorCode =
  | 'E_AUTH'
  | 'E_RATE_LIMIT'
  | 'E_TIMEOUT'
  | 'E_NETWORK'
  | 'E_NOT_FOUND'
  | 'E_BAD_REQUEST'
  | 'E_SERVER'
  | 'E_ABORTED'
  | 'E_UNKNOWN'

export class LlmError extends Error {
  readonly code: LlmErrorCode
  readonly httpStatus: number | undefined

  constructor(code: LlmErrorCode, message: string, httpStatus?: number) {
    super(message)
    this.name = 'LlmError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

/** 跨模块实例的安全判定（不依赖 instanceof，避免多份模块副本导致误判）。 */
export function isLlmError(value: unknown): value is LlmError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { name?: unknown }).name === 'LlmError' &&
    typeof (value as { code?: unknown }).code === 'string'
  )
}

export interface LlmProvider {
  readonly id: string
  /** 流式对话；通过 `signal` 支持取消（docs/06 §3）。 */
  chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent>
  listModels?(): Promise<ModelInfo[]>
  testConnection(): Promise<TestConnectionResult>
}
