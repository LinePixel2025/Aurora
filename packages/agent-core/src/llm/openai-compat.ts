/**
 * OpenAI 兼容 Provider（ADR-003）：`baseURL + apiKey + model` 即可接入
 * DeepSeek / OpenAI / Ollama / vLLM 等，不绑定任何商业 SDK。
 *
 * 可靠性：单请求超时（默认 60s）、指数退避重试、AbortSignal 贯穿（docs/06 §3）。
 */
import {
  LlmError,
  isLlmError,
  type ChatEvent,
  type ChatRequest,
  type ChatRequestMessage,
  type FinishReason,
  type LlmErrorCode,
  type LlmProvider,
  type ModelInfo,
  type TestConnectionResult,
  type TokenUsage,
  type ToolCallRequest,
} from './types.js'
import { extractDelta, extractReasoningDelta, parseSseChunk, parseSseData } from './sse.js'

export interface OpenAiCompatOptions {
  id: string
  baseUrl: string
  apiKey: string
  defaultModel: string
  /** 单请求超时，默认 60_000ms */
  timeoutMs?: number
  /** 失败重试次数（不含首次），默认 2 */
  maxRetries?: number
  /** 重试基础退避，默认 500ms（指数） */
  retryBaseDelayMs?: number
  /** 注入 fetch 便于单测 */
  fetchImpl?: typeof fetch
  onRetry?: (info: {
    attempt: number
    code: LlmErrorCode
    delayMs: number
    /** 非退避重试时的原因说明（如「去掉 stream_options 降级」）；退避重试不带该字段 */
    reason?: string
  }) => void
}

const RETRYABLE: ReadonlySet<LlmErrorCode> = new Set<LlmErrorCode>([
  'E_RATE_LIMIT',
  'E_TIMEOUT',
  'E_NETWORK',
  'E_SERVER',
])

/**
 * GET / HEAD 语义上不允许携带请求体：带了会被 undici 直接拒绝
 * （`Request with GET/HEAD method cannot have body.`），而且该错误会被归类成可重试的
 * E_NETWORK，白等一轮指数退避。这里统一兜底，调用方误传 body 也不会发出去。
 */
const BODYLESS_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD'])

export class OpenAiCompatProvider implements LlmProvider {
  readonly id: string
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly defaultModel: string
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly retryBaseDelayMs: number
  private readonly fetchImpl: typeof fetch
  private readonly onRetry: OpenAiCompatOptions['onRetry']

  constructor(options: OpenAiCompatOptions) {
    this.id = options.id
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    this.apiKey = options.apiKey
    this.defaultModel = options.defaultModel
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.maxRetries = Math.max(0, options.maxRetries ?? 2)
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.onRetry = options.onRetry
    if (typeof this.fetchImpl !== 'function') {
      throw new LlmError('E_UNKNOWN', '当前运行环境不提供 fetch，无法访问 LLM 服务')
    }
  }
  async listModels(): Promise<ModelInfo[]> {
    const response = await this.fetchWithPolicy(
      this.createRequest('GET', '/models', undefined, 'application/json'),
    )
    const payload = (await response.json()) as {
      data?: Array<{ id?: unknown; owned_by?: unknown }>
    }
    if (!Array.isArray(payload.data)) return []
    return payload.data
      .filter((item): item is { id: string; owned_by?: unknown } => typeof item.id === 'string')
      .map((item) => ({
        id: item.id,
        ...(typeof item.owned_by === 'string' ? { ownedBy: item.owned_by } : {}),
      }))
  }

  async testConnection(): Promise<TestConnectionResult> {
    const started = Date.now()
    try {
      const models = await this.listModels()
      return {
        ok: true,
        latencyMs: Date.now() - started,
        message:
          models.length > 0
            ? `连接成功，可用模型 ${models.length} 个`
            : '连接成功（未返回模型列表）',
        models: models.map((m) => m.id),
      }
    } catch (error) {
      const first = toLlmError(error)
      // 部分服务不实现 /models，退化为一次最小 chat 请求
      if (first.httpStatus === 404 || first.httpStatus === 405) {
        try {
          await this.probeChat()
          return {
            ok: true,
            latencyMs: Date.now() - started,
            message: '连接成功（服务未提供模型列表接口）',
          }
        } catch (probeError) {
          const second = toLlmError(probeError)
          return this.failure(second, started)
        }
      }
      return this.failure(first, started)
    }
  }

  async *chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    try {
      const response = await this.openStream(this.buildBody(req, true), signal)
      const reader = response.body?.getReader()
      if (!reader) throw new LlmError('E_UNKNOWN', '响应体为空，无法读取流')

      const toolCalls = new Map<number, ToolCallRequest>()
      let finishReason: FinishReason = 'unknown'
      let usage: TokenUsage | undefined
      let buffer = ''
      let finished = false

      while (!finished) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += new TextDecoder().decode(value, { stream: true })
        const parsedChunk = parseSseChunk(buffer)
        buffer = parsedChunk.rest

        for (const event of parsedChunk.events) {
          const parsed = parseSseData(event)
          if (parsed === null) {
            finished = true
            break
          }
          if (parsed === undefined) continue

          for (const payload of parsed) {
            const text = extractDelta(payload)
            if (text !== '') yield { type: 'text', delta: text }

            // 思考链增量与文本增量并列转发（分片通常只含其一，二者都按原样透传）
            const reasoning = extractReasoningDelta(payload)
            if (reasoning !== '') yield { type: 'reasoning', delta: reasoning }

            for (const call of extractToolCallDeltas(payload)) {
              const existing = toolCalls.get(call.index) ?? { id: '', name: '', arguments: '' }
              toolCalls.set(call.index, {
                id: call.id ?? existing.id,
                name: existing.name + (call.name ?? ''),
                arguments: existing.arguments + (call.argumentsDelta ?? ''),
              })
            }

            const reason = extractFinishReason(payload)
            if (reason) finishReason = reason
            const parsedUsage = extractUsage(payload)
            if (parsedUsage) usage = parsedUsage
          }
        }
      }

      for (const call of [...toolCalls.values()]) {
        if (call.name !== '') yield { type: 'tool_call', call }
      }
      yield { type: 'done', finishReason, ...(usage === undefined ? {} : { usage }) }
    } catch (error) {
      const llmError = toLlmError(error)
      yield { type: 'error', code: llmError.code, message: llmError.message }
    }
  }

  // ───────────────────────── 内部 ─────────────────────────

  /**
   * 建立流式响应：先带 `stream_options.include_usage`（拿真实的 prompt / completion tokens，
   * 对话窗输入框底部的「上下文详解」靠它），若服务端**明确拒绝这个字段**
   * （400 且报文提到 `stream_options` / `include_usage`），去掉它重试一次。
   *
   * 为什么要降级：不少 OpenAI 兼容网关只认最基础的字段，带上未知字段直接 400 ——
   * 「整个对话打不开」比「拿不到 token 用量」严重得多，所以这里必须能退回去。
   * 只对**点名了这两个字段**的 400 重试：其它 400（模型名错、参数越界）重试也是白试。
   */
  private async openStream(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    try {
      return await this.postStream(body, signal)
    } catch (error) {
      const llmError = toLlmError(error)
      if (llmError.code !== 'E_BAD_REQUEST' || !looksLikeRejectedField(llmError.message)) {
        throw llmError
      }
      const withoutUsage = { ...body }
      delete withoutUsage['stream_options']
      // 这是**降级**不是重试：报文里没有延迟、也不是同一个请求。用 `reason` 把它与
      // `fetchWithPolicy` 的退避重试区分开，否则排查时只看到「LLM 请求重试 delayMs:0」。
      this.onRetry?.({
        attempt: 1,
        code: llmError.code,
        delayMs: 0,
        reason: '服务端拒绝 stream_options，已去掉该字段重试（本次不带 token 用量）',
      })
      return await this.postStream(withoutUsage, signal)
    }
  }

  private postStream(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    return this.fetchWithPolicy(
      this.createRequest('POST', '/chat/completions', body, 'text/event-stream', signal),
    )
  }

  private failure(error: LlmError, started: number): TestConnectionResult {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      message: describeError(error),
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    }
  }

  private async probeChat(): Promise<void> {
    const body = this.buildBody(
      { model: this.defaultModel, messages: [{ role: 'user', content: 'ping' }], maxTokens: 1 },
      false,
    )
    const response = await this.fetchWithPolicy(
      this.createRequest('POST', '/chat/completions', body, 'application/json'),
    )
    await response.arrayBuffer()
  }

  private buildBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
    return {
      model: req.model || this.defaultModel,
      messages: req.messages.map(toOpenAiMessage),
      stream,
      // 流式下 OpenAI 规范只在**最后一片**带 usage，且必须先显式索取；
      // 服务端不认这个字段时由 `openStream` 去掉它重试（否则整个对话都用不了）
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
      // 思考等级：`undefined` 时**完全不写**该字段（不认这个参数的厂商会直接 400）
      ...(req.reasoningEffort === undefined ? {} : { reasoning_effort: req.reasoningEffort }),
      ...(req.maxTokens === undefined ? {} : { max_tokens: req.maxTokens }),
      ...(req.jsonObject ? { response_format: { type: 'json_object' } } : {}),
      ...(req.tools && req.tools.length > 0
        ? {
            tools: req.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
          }
        : {}),
    }
  }

  private createRequest(
    method: 'GET' | 'POST',
    path: string,
    body: Record<string, unknown> | undefined,
    accept: string,
    signal?: AbortSignal,
  ): PreparedRequest {
    const headers: Record<string, string> = { accept }
    if (this.apiKey !== '') headers['authorization'] = `Bearer ${this.apiKey}`
    if (method === 'POST') headers['content-type'] = 'application/json'
    return {
      url: `${this.baseUrl}${path}`,
      method,
      headers,
      body,
      ...(signal === undefined ? {} : { signal }),
    }
  }

  /** 超时 + 指数退避重试。 */
  private async fetchWithPolicy(request: PreparedRequest): Promise<Response> {
    let attempt = 0
    for (;;) {
      try {
        return await this.fetchOnce(request)
      } catch (error) {
        const llmError = toLlmError(error)
        if (!RETRYABLE.has(llmError.code) || attempt >= this.maxRetries) throw llmError
        const delayMs = this.retryBaseDelayMs * 2 ** attempt
        attempt += 1
        this.onRetry?.({ attempt, code: llmError.code, delayMs })
        await sleep(delayMs)
      }
    }
  }

  private async fetchOnce(request: PreparedRequest): Promise<Response> {
    if (request.signal?.aborted) throw new LlmError('E_ABORTED', '请求已取消')

    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new LlmError('E_TIMEOUT', '请求超时')),
      this.timeoutMs,
    )
    const external = request.signal
    const onExternalAbort = (): void => controller.abort(new LlmError('E_ABORTED', '请求已取消'))
    external?.addEventListener('abort', onExternalAbort)

    try {
      const response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined || BODYLESS_METHODS.has(request.method)
          ? {}
          : { body: JSON.stringify(request.body) }),
        signal: controller.signal,
      })
      if (!response.ok) {
        const body = await safeText(response)
        throw new LlmError(
          statusToCode(response.status),
          describeHttpError(response.status, body),
          response.status,
        )
      }
      return response
    } catch (error) {
      throw toLlmError(error)
    } finally {
      clearTimeout(timer)
      external?.removeEventListener('abort', onExternalAbort)
    }
  }
}

/** 内部请求描述（不直接用 `Request`，便于注入 fetch 与单测断言请求体） */
interface PreparedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: Record<string, unknown>
  signal?: AbortSignal
}

// ───────────────────────── 工具函数 ─────────────────────────

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

function toOpenAiMessage(message: ChatRequestMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: message.role, content: message.content }
  if (message.toolCalls && message.toolCalls.length > 0) {
    out['tool_calls'] = message.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }))
    if (message.content === '') delete out['content']
  }
  if (message.toolCallId !== undefined) out['tool_call_id'] = message.toolCallId
  if (message.name !== undefined) out['name'] = message.name
  return out
}

function extractToolCallDeltas(
  payload: unknown,
): Array<{ index: number; id?: string; name?: string; argumentsDelta?: string }> {
  const choices = (payload as { choices?: unknown[] } | null)?.choices
  if (!Array.isArray(choices)) return []
  const out: Array<{ index: number; id?: string; name?: string; argumentsDelta?: string }> = []
  for (const choice of choices) {
    const calls = (choice as { delta?: { tool_calls?: unknown[] } }).delta?.tool_calls
    if (!Array.isArray(calls)) continue
    for (const raw of calls) {
      const call = raw as {
        index?: unknown
        id?: unknown
        function?: { name?: unknown; arguments?: unknown }
      }
      out.push({
        index: typeof call.index === 'number' ? call.index : 0,
        ...(typeof call.id === 'string' ? { id: call.id } : {}),
        ...(typeof call.function?.name === 'string' ? { name: call.function.name } : {}),
        ...(typeof call.function?.arguments === 'string'
          ? { argumentsDelta: call.function.arguments }
          : {}),
      })
    }
  }
  return out
}

function extractFinishReason(payload: unknown): FinishReason | undefined {
  const choices = (payload as { choices?: unknown[] } | null)?.choices
  if (!Array.isArray(choices)) return undefined
  const raw = (choices[0] as { finish_reason?: unknown } | undefined)?.finish_reason
  if (typeof raw !== 'string') return undefined
  const known: FinishReason[] = ['stop', 'length', 'tool_calls', 'content_filter']
  return known.includes(raw as FinishReason) ? (raw as FinishReason) : 'unknown'
}

function extractUsage(payload: unknown): TokenUsage | undefined {
  const usage = (payload as { usage?: Record<string, unknown> } | null)?.usage
  if (!usage || typeof usage !== 'object') return undefined
  const prompt = Number(usage['prompt_tokens'] ?? 0)
  const completion = Number(usage['completion_tokens'] ?? 0)
  const total = Number(usage['total_tokens'] ?? prompt + completion)
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return undefined
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total }
}

export function statusToCode(status: number): LlmErrorCode {
  if (status === 401 || status === 403) return 'E_AUTH'
  if (status === 404) return 'E_NOT_FOUND'
  if (status === 429) return 'E_RATE_LIMIT'
  if (status >= 500) return 'E_SERVER'
  if (status >= 400) return 'E_BAD_REQUEST'
  return 'E_UNKNOWN'
}

export function toLlmError(error: unknown): LlmError {
  if (isLlmError(error)) return error
  if (error instanceof Error) {
    if (error.name === 'AbortError') return new LlmError('E_ABORTED', '请求已取消')
    if (error.name === 'TimeoutError') return new LlmError('E_TIMEOUT', '请求超时')
    return new LlmError('E_NETWORK', error.message)
  }
  return new LlmError('E_UNKNOWN', String(error))
}

export function describeError(error: LlmError): string
export function describeError(code: LlmErrorCode, message: string): string
export function describeError(errorOrCode: LlmError | LlmErrorCode, message = ''): string {
  const code = typeof errorOrCode === 'string' ? errorOrCode : errorOrCode.code
  const detail = typeof errorOrCode === 'string' ? message : errorOrCode.message
  switch (code) {
    case 'E_AUTH':
      return '认证失败：请检查 API Key 是否正确、是否有该模型权限'
    case 'E_NOT_FOUND':
      return '接口地址不存在：请检查 baseURL（多数服务需要以 /v1 结尾）'
    case 'E_RATE_LIMIT':
      return '触发限流：请稍后重试'
    case 'E_TIMEOUT':
      return '连接超时：请检查网络、代理或服务可用性'
    case 'E_NETWORK':
      return `网络异常：${detail}`
    case 'E_BAD_REQUEST':
      return `请求被拒绝：${detail}`
    case 'E_SERVER':
      return `服务端错误：${detail}`
    case 'E_ABORTED':
      return '请求已取消'
    default:
      return detail
  }
}

/**
 * 「服务端拒绝了一个未知字段」的报文判定（`stream_options` 降级的触发条件）。
 *
 * 先认点名（`stream_options` / `include_usage`），再兜一层**不点名**的常见措辞：
 * 不少网关只说 `Unknown parameter` / `Extra inputs are not permitted`，逐字匹配就退不回去，
 * 用户看到的是「整个对话 400 打不开」—— 而这一层降级存在的唯一理由就是避免那个结果。
 * 代价是可能白重试一次（若报文恰好回显了请求体），可接受：重试只发生在 `E_BAD_REQUEST` 上，
 * 它不参与 `fetchWithPolicy` 的退避重试，最多多发一次请求。
 */
function looksLikeRejectedField(message: string): boolean {
  if (/stream_options|include_usage/i.test(message)) return true
  return /unknown|unexpected|unrecognized|not permitted|unsupported|extra fields|extra inputs|invalid[_ ]?parameter/i.test(
    message,
  )
}

function describeHttpError(status: number, body: string): string {
  const trimmed = body.trim().slice(0, 300)
  return trimmed === '' ? `HTTP ${status}` : `HTTP ${status} ${trimmed}`
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
