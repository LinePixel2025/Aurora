/** LLM 提供者抽象（docs/06 §3、ADR-003）。 */

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
  maxTokens?: number
  /** 要求模型以 JSON 对象作答（结构化输出，docs/05 §3.2） */
  jsonObject?: boolean
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'unknown'

export type ChatEvent =
  | { type: 'text'; delta: string }
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
