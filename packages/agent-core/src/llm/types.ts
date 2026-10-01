/** LLM 提供者抽象（docs/06 §3、ADR-003）。 */
import type { ReasoningEffort, TokenUsage } from '@aurora/shared'

/**
 * token 用量的**唯一**定义在 `@aurora/shared`（它要经 IPC 到渲染层，IPC 契约不得依赖内核包）。
 * 这里只重导出，让内核内部的 import 路径保持在本模块内。
 */
export type { TokenUsage }

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

/**
 * 一张**可下发的图片**（多模态输入，docs/06 §3.1）。
 *
 * 刻意是「已经解析好的内容」而不是路径：内核不碰文件系统（`agent-core` 保持纯逻辑、
 * 可在 Node 里单测），路径 → base64 的读取由主进程经 `AgentHostDeps.loadImages` 注入
 * （与 `confirmTool` / `summarize` 同款的端口套路）。
 */
export interface LlmImageInput {
  /** MIME（`image/png` / `image/jpeg` …），决定 data URL 前缀 */
  mimeType: string
  /** **裸 base64**（不含 `data:` 前缀）：前缀在拼 data URL 时统一加，避免两处各拼一半 */
  dataBase64: string
  /** 文件名，只用于降级文案与日志 */
  name?: string
  /**
   * 视觉精细度（OpenAI 语义的 `detail`）。
   *
   * **当前不下发**：多数 OpenAI 兼容网关不认这个字段，发过去会被 400。
   * 留在类型里是因为两套协议的映射共用同一份形状，将来要暴露给用户时不必再改类型。
   */
  detail?: 'auto' | 'low' | 'high'
}

/** 把 `LlmImageInput` 拼成 `data:` URL（两套协议的请求映射共用这一份实现）。 */
export function toImageDataUrl(image: LlmImageInput): string {
  return `data:${image.mimeType};base64,${image.dataBase64}`
}

/**
 * 历史消息里的图片**路径** → 可下发的图片内容（多模态输入，docs/06 §3.1）。
 *
 * 必须是**同步**的：真正读盘发生在装配层（`AgentHost` 用注入的 `loadImages` 一次性
 * 读好、放进 Map），历史映射（`history.ts` / `agentLoop.ts`）只做查表。
 * 未注入 / 查不到 → 返回空数组 = 这条消息按纯文本下发，**不是**错误。
 */
export type LlmImageResolver = (paths: readonly string[]) => readonly LlmImageInput[]

export interface ChatRequestMessage {
  role: ChatRole
  content: string
  /**
   * 图片分片（多模态输入，docs/06 §3.1）：非空时请求体的 `content` 由字符串变成
   * content parts 数组（正文 + 每张图一段）。只应出现在 `role: 'user'` 的消息上。
   */
  images?: LlmImageInput[]
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
