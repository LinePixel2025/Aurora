/**
 * OpenAI 兼容 Provider（ADR-003）：`baseURL + apiKey + model` 即可接入
 * DeepSeek / OpenAI / Ollama / vLLM 等，不绑定任何商业 SDK。
 * 多模态（图片输入）见 docs/06 §3.1；另一套协议（Responses API）见 `responses.ts` 与 §3.2。
 *
 * 可靠性（单请求超时默认 60s 且**在整个流期间保持武装**、指数退避重试、AbortSignal 贯穿到读流结束、
 * 错误码映射）在 `transport.ts` —— 与 Responses Provider **共用同一份实现**，两条协议在这些行为上
 * 逐字一致；本文件只管**请求体怎么拼、事件怎么解**（`buildBody` / `toOpenAiMessage` / `chat()`）。
 */
import {
  LlmError,
  toImageDataUrl,
  type ChatEvent,
  type ChatRequest,
  type ChatRequestMessage,
  type FinishReason,
  type LlmProvider,
  type ModelInfo,
  type TestConnectionResult,
  type TokenUsage,
  type ToolCallRequest,
} from './types.js'
import { extractDelta, extractReasoningDelta, parseSseChunk, parseSseData } from './sse.js'
import {
  HttpTransport,
  looksLikeRejectedField,
  toLlmError,
  type RequestScope,
  type TransportOptions,
} from './transport.js'

// 传输层的工具函数在这里**再导出一次**：它们是本模块的历史公开面
// （单测与主进程从 `@aurora/agent-core` 根导入 `normalizeBaseUrl` / `describeError`），
// 搬家不该让调用方跟着改导入路径。
export { describeError, normalizeBaseUrl, statusToCode, toLlmError } from './transport.js'
export type { PreparedRequest, RequestScope, RetryInfo } from './transport.js'

export interface OpenAiCompatOptions extends TransportOptions {
  defaultModel: string
}

export class OpenAiCompatProvider implements LlmProvider {
  readonly id: string
  private readonly defaultModel: string
  private readonly http: HttpTransport

  constructor(options: OpenAiCompatOptions) {
    this.id = options.id
    this.defaultModel = options.defaultModel
    this.http = new HttpTransport(options)
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.http.listModels()
  }

  async testConnection(): Promise<TestConnectionResult> {
    return this.http.testConnection(() => this.probeChat())
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
    const scope = this.http.createScope(signal)
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
   *
   * **Responses API 没有这一步**（用量随 `response.completed` 事件回传，不存在这个可选字段），
   * 因此这条降级留在本 provider，不下沉到传输层。
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
      this.http.notifyRetry({
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
    return this.http.fetchWithPolicy(
      this.http.createRequest('POST', '/chat/completions', body, 'text/event-stream', signal),
      scope,
    )
  }

  private async probeChat(): Promise<void> {
    const body = this.buildBody(
      { model: this.defaultModel, messages: [{ role: 'user', content: 'ping' }], maxTokens: 1 },
      false,
    )
    const response = await this.http.fetchWithPolicy(
      this.http.createRequest('POST', '/chat/completions', body, 'application/json'),
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
}

// ───────────────────────── 消息 / 分片映射（纯函数，单测直接调） ─────────────────────────

/**
 * 一条消息的 `content`：没有图片时就是原样的字符串（**旧形状逐字不变**，老网关因此完全不受
 * 影响），有图片时变成 content parts 数组（docs/06 §3.1）。
 */
export function toOpenAiContent(message: ChatRequestMessage): unknown {
  const images = message.images ?? []
  if (images.length === 0) return message.content
  const parts: Array<Record<string, unknown>> = []
  // 正文为空时**不发空 text 分片**：部分服务把「只有一个空 text 的消息」当空消息，直接 400。
  if (message.content !== '') parts.push({ type: 'text', text: message.content })
  for (const image of images) {
    parts.push({
      type: 'image_url',
      image_url: {
        url: toImageDataUrl(image),
        ...(image.detail === undefined ? {} : { detail: image.detail }),
      },
    })
  }
  return parts
}

function toOpenAiMessage(message: ChatRequestMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: message.role, content: toOpenAiContent(message) }
  if (message.toolCalls && message.toolCalls.length > 0) {
    out['tool_calls'] = message.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }))
    if (message.content === '' && (message.images ?? []).length === 0) delete out['content']
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
