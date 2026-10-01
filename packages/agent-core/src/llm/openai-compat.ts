/**
 * OpenAI 兼容 Provider（ADR-003）：`baseURL + apiKey + model` 即可接入
 * DeepSeek / OpenAI / Ollama / vLLM 等，不绑定任何商业 SDK。
 *
 * 可靠性：单请求超时（默认 60s，在**整个流**期间保持武装、每片数据重新计时；**每次 attempt 一份
 * 独立预算**，见 `fetchWithPolicy`）、指数退避重试、AbortSignal 贯穿到读流结束（`chat()` 持有作用域，
 * `finally` 里 `reader.cancel()` + 释放）—— 详见 `createScope` 与 `chat()` 的注释（docs/06 §3）。
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
    /**
     * 超时 / 取消的作用域由**本方法**持有到流读完（P1-08）。
     *
     * `fetchOnce` 的 `finally` 在拿到响应头时就把自有作用域释放掉（`listModels` / `probeChat`
     * 需要那个时序），于是外部 abort → controller 的转发与超时计时会在**正文传输期间**双双失效：
     * 用户点「停止」后底层请求照跑（token 照扣、增量照广播），服务端停滞时
     * `reader.read()` 更是永久挂起且解不开。修法是让这份作用域活到读流结束。
     */
    const scope = this.createScope(signal)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const response = await this.openStream(this.buildBody(req, true), signal, scope)
      reader = response.body?.getReader()
      if (!reader) throw new LlmError('E_UNKNOWN', '响应体为空，无法读取流')

      /**
       * abort 感知：`reader.read()` 在服务端停滞时会长期挂起，只在循环前查一次
       * `signal.aborted` 解不开（那时已经卡在 read 上）。这里让每次读与 abort 通知赛跑。
       *
       * 同一个 promise 反复参与 race，并先挂一个吞掉拒绝的处理器：race 收场之后才触发的
       * abort 不该变成 unhandledRejection（正常读完的流后面也可能被外部取消）。
       *
       * 信号在这里取一次（`openStream` 已定局，之后不再 `arm()`）：转发监听与超时计时都作用于
       * 这同一份信号 —— 正文期间点「停止」（E_ABORTED）与服务端停滞（E_TIMEOUT）都能解开这一读。
       */
      const requestSignal = scope.controller.signal
      const aborted = new Promise<never>((_resolve, reject) => {
        const onAbort = (): void => reject(toLlmError(requestSignal.reason))
        if (requestSignal.aborted) onAbort()
        else requestSignal.addEventListener('abort', onAbort, { once: true })
      })
      aborted.catch(() => undefined)

      // TextDecoder 全程复用一份：`{ stream: true }` 的挂起字节存在实例里，
      // 每个 chunk 新建一份就会把跨 chunk 截断的多字节字符变成 U+FFFD（中文每字 3 字节，
      // 网络分片边界落在字符中间是常态，乱码还会随消息落进会话历史）—— P1-09
      const decoder = new TextDecoder()
      const toolCalls = new Map<number, ToolCallRequest>()
      let finishReason: FinishReason = 'unknown'
      let usage: TokenUsage | undefined
      let buffer = ''
      let finished = false

      while (!finished) {
        const { done, value } = await Promise.race([reader.read(), aborted])
        if (done) break
        // 超时在整个流期间保持武装，但每收到一片就重新计时：服务端停滞 60s 即超时，
        // 而正常传输的长回复不会被"总时长"掐断（那会把正常完成也取消）。
        scope.rearm()
        buffer += decoder.decode(value, { stream: true })
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
    } finally {
      // 正常读完（含 `[DONE]` 提前收尾）/ 异常 / 生成器被提前 return 三条路径都要
      // 取消底层读取并释放作用域：不取消的话连接与 response.body 会一直挂到服务端自己关闭
      await reader?.cancel().catch(() => undefined)
      scope.release()
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
  private async openStream(
    body: Record<string, unknown>,
    signal?: AbortSignal,
    scope?: RequestScope,
  ): Promise<Response> {
    try {
      return await this.postStream(body, signal, scope)
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
      return await this.postStream(withoutUsage, signal, scope)
    }
  }

  private postStream(
    body: Record<string, unknown>,
    signal?: AbortSignal,
    scope?: RequestScope,
  ): Promise<Response> {
    return this.fetchWithPolicy(
      this.createRequest('POST', '/chat/completions', body, 'text/event-stream', signal),
      scope,
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

  /**
   * 超时 + 指数退避重试。`scope` 由流式路径传进来（由 `chat()` 持有到读流结束并释放）。
   *
   * 每个 attempt 入口都 `scope.arm()`：换一份**全新**的超时预算（新 controller + 新计时器）。
   * 修复「超时后的重试全是死重试」：`AbortController` 一旦 abort 不可复位，若跨 attempt 复用
   * 同一份 controller，第 1 次超时后所有重试都拿着一个永久 aborted 的信号秒失败，
   * 且会继承上一次剩下的超时预算 —— 每次重试都该有独立的完整预算（与「每次 attempt 一次请求」同构）。
   */
  private async fetchWithPolicy(request: PreparedRequest, scope?: RequestScope): Promise<Response> {
    let attempt = 0
    for (;;) {
      scope?.arm()
      try {
        return await this.fetchOnce(request, scope)
      } catch (error) {
        const llmError = toLlmError(error)
        // 用户点了「停止」（外部 signal 已 aborted）：短路，不重试也不白睡退避。
        // `E_ABORTED` 本就不在 RETRYABLE，这里提前拦一道是为了不打出与事实相反的「请求重试」日志。
        if (request.signal?.aborted === true) throw new LlmError('E_ABORTED', '请求已取消')
        if (!RETRYABLE.has(llmError.code) || attempt >= this.maxRetries) throw llmError
        const delayMs = this.retryBaseDelayMs * 2 ** attempt
        attempt += 1
        this.onRetry?.({ attempt, code: llmError.code, delayMs })
        await sleep(delayMs)
      }
    }
  }

  /**
   * 一次请求的「超时 + 取消」作用域（P1-08）。
   *
   * 这里把两件事**拆开**：
   * - **外部 abort 转发**（`onExternalAbort`）在建立作用域时只挂一次，并活到 `release()` ——
   *   这是 P1-08 的初衷：转发监听若在响应头到达时就摘掉，正文传输期间点「停止」就再没人管这个请求了。
   * - **超时计时**是**每个 attempt 一份**：`arm()` 换一份全新的 controller 与计时器，
   *   使每次重试都有独立的完整预算（旧的跨 attempt 复用会把超时后的重试变成死重试，见 `fetchWithPolicy`）。
   *   转发监听不随 `arm()` 重挂：它闭包引用 `controller` 这个**绑定**，换了新 controller 依然命中。
   *
   * `release()` 结束它：清掉超时计时、摘掉外部 abort 转发（幂等）。
   * 非流式调用（`listModels` / `probeChat`）拿到响应头即释放（与旧行为一致）；
   * 流式调用由 `chat()` 持有到**流读完**才释放。
   *
   * `rearm()` 把超时计时重新计时：超时在**整个流期间保持武装**（不再只覆盖首字节），
   * 但每收到一片数据就重置。服务端停滞（`reader.read()` 永久挂起）到点即 abort，
   * 而正常传输的长时间回复不会被"总时长"掐断 —— 那等于把正常完成也取消掉。
   */
  private createScope(external?: AbortSignal): RequestScope {
    // `controller` 会在每次 `arm()` 时被替换（`AbortController` 一旦 abort 不可复位）
    let controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let released = false

    const abortCurrent = (error: LlmError): void => {
      if (!controller.signal.aborted) controller.abort(error)
    }
    const onTimeout = (): void => abortCurrent(new LlmError('E_TIMEOUT', '请求超时'))
    const onExternalAbort = (): void => abortCurrent(new LlmError('E_ABORTED', '请求已取消'))
    // 外部 abort 转发只挂一次：已经取消了（或本来就没给信号）就立刻反映到内部 controller，
    // 别等读流时才发现。
    if (external?.aborted === true) onExternalAbort()
    else external?.addEventListener('abort', onExternalAbort)

    /**
     * 开始一次 attempt：换成一份全新的 controller 与计时器（释放后是空操作）。
     * 若此刻外部**已经**取消，新的 controller 立刻被 abort —— 下一次 `fetchOnce` 会短路成 E_ABORTED。
     */
    const arm = (): void => {
      if (released) return
      clearTimeout(timer)
      controller = new AbortController()
      if (external?.aborted === true) onExternalAbort()
      timer = setTimeout(onTimeout, this.timeoutMs)
    }
    arm()

    return {
      get controller(): AbortController {
        return controller
      },
      arm,
      rearm: (): void => {
        if (released) return
        clearTimeout(timer)
        timer = setTimeout(onTimeout, this.timeoutMs)
      },
      release: (): void => {
        if (released) return
        released = true
        clearTimeout(timer)
        external?.removeEventListener('abort', onExternalAbort)
      },
    }
  }

  private async fetchOnce(request: PreparedRequest, scope?: RequestScope): Promise<Response> {
    if (request.signal?.aborted) throw new LlmError('E_ABORTED', '请求已取消')

    // 作用域优先用调用方给的（流式路径），没有就自建一个并在本次 finally 里释放
    const active = scope ?? this.createScope(request.signal)
    try {
      const response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined || BODYLESS_METHODS.has(request.method)
          ? {}
          : { body: JSON.stringify(request.body) }),
        signal: active.controller.signal,
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
      // 自建的作用域到此收工；调用方传进来的那份归调用方释放（流式路径要活到流读完）
      if (scope === undefined) active.release()
    }
  }
}

/** 一次请求的超时 / 取消作用域（`chat()` 与 `fetchOnce()` 的分界，见 `createScope`） */
interface RequestScope {
  /**
   * **当前 attempt** 的请求信号：外部取消（转发进来）与本次 attempt 的超时都会 abort 它。
   * 每次 `arm()` 换新（超时 abort 掉的是上一份，不会连累重试）。
   */
  readonly controller: AbortController
  /**
   * 开始一次 attempt：换一份全新的超时预算（新 controller + 新计时器）。
   * `fetchWithPolicy` 每次 attempt 入口调用；释放后是空操作。
   */
  arm(): void
  /** 重新计时（流式路径每收到一片数据调一次；释放后是空操作） */
  rearm(): void
  /** 结束本次请求：清掉超时计时与外部 abort 转发（幂等） */
  release(): void
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

/**
 * 前缀缓存命中量（docs/06 §21.4）：两种厂商形态都认 —— 优先
 * `prompt_tokens_details.cached_tokens`（OpenAI 形态），否则 `prompt_cache_hit_tokens`（DeepSeek 形态）。
 *
 * 非法值（非数字 / 负数 / 非有限值）**整条省略**而不是填 0：
 * 「回传了 0」（一个也没命中）与「没回传这个字段」（这个 provider 不报缓存）在界面上必须可区分，
 * 拿别的数字冒充会把「缓存不生效」伪装成「缓存生效但没命中」，是最难查的一类假象。
 */
function extractCachedTokens(usage: Record<string, unknown>): number | undefined {
  const details = usage['prompt_tokens_details']
  const fromDetails =
    details && typeof details === 'object'
      ? (details as Record<string, unknown>)['cached_tokens']
      : undefined
  const raw = fromDetails ?? usage['prompt_cache_hit_tokens']
  if (raw === undefined || raw === null) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return undefined
  return value
}

function extractUsage(payload: unknown): TokenUsage | undefined {
  const usage = (payload as { usage?: Record<string, unknown> } | null)?.usage
  if (!usage || typeof usage !== 'object') return undefined
  const prompt = Number(usage['prompt_tokens'] ?? 0)
  const completion = Number(usage['completion_tokens'] ?? 0)
  const total = Number(usage['total_tokens'] ?? prompt + completion)
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return undefined
  const cached = extractCachedTokens(usage)
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    // 缺省就整条不出现（不是 `cachedTokens: undefined`），与同目录 `done` 事件里
    // `...(usage === undefined ? {} : { usage })` 同款写法：可选性由「键不存在」表达。
    ...(cached === undefined ? {} : { cachedTokens: cached }),
  }
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
