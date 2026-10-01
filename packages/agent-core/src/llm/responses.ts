/**
 * OpenAI **Responses API** Provider（docs/06 §3.2，v22）。
 *
 * 与 `OpenAiCompatProvider` 的关系：**只差两件事** —— 请求体的形状（`instructions` + `input`
 * 条目数组 + 扁平 `tools`）与响应事件的形状（带 `type` 的 `response.*` 事件 + 单个
 * `call_id` 配对的工具调用）。超时 / 取消 / 退避重试 / 错误码 / `listModels` / `testConnection`
 * 全部复用 `transport.ts`，两条协议的可靠性语义因此逐字一致。
 *
 * 用户侧入口是 `llm.providers.<id>.type = 'openai-responses'`（docs/08 §1）；
 * `baseUrl` 仍按「以 /v1 结尾」填，本类只在其后拼 `/responses`。
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
import { parseSseChunk, parseSseData } from './sse.js'
import { HttpTransport, toLlmError, type TransportOptions } from './transport.js'

export interface OpenAiResponsesOptions extends TransportOptions {
  defaultModel: string
}

/** 一条流内工具调用的累积状态（`key` = 事件里的 `item_id` / 条目 id）。 */
export interface PendingCall {
  callId: string
  name: string
  args: string
  emitted: boolean
}

export class OpenAiResponsesProvider implements LlmProvider {
  readonly id: string
  private readonly defaultModel: string
  private readonly http: HttpTransport

  constructor(options: OpenAiResponsesOptions) {
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
    // 作用域与 chat-completions 侧同款：由本方法持有到**读流结束**（P1-08），
    // 语义与释放时机见 `HttpTransport.createScope` 的注释。
    const scope = this.http.createScope(signal)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const body = toResponsesBody(req, this.defaultModel)
      const response = await this.http.fetchWithPolicy(
        this.http.createRequest('POST', '/responses', body, 'text/event-stream', signal),
        scope,
      )
      reader = response.body?.getReader()
      if (!reader) throw new LlmError('E_UNKNOWN', '响应体为空，无法读取流')

      const requestSignal = scope.controller.signal
      const aborted = new Promise<never>((_resolve, reject) => {
        const onAbort = (): void => reject(toLlmError(requestSignal.reason))
        if (requestSignal.aborted) onAbort()
        else requestSignal.addEventListener('abort', onAbort, { once: true })
      })
      aborted.catch(() => undefined)

      // TextDecoder 全程复用一份：跨 chunk 截断的多字节字符（中文每字 3 字节）否则会变成 U+FFFD。
      const decoder = new TextDecoder()
      const calls = new Map<string, PendingCall>()
      let finishReason: FinishReason = 'unknown'
      let usage: TokenUsage | undefined
      let failure: LlmError | undefined
      let buffer = ''
      let finished = false

      while (!finished) {
        const { done, value } = await Promise.race([reader.read(), aborted])
        if (done) break
        scope.rearm()
        buffer += decoder.decode(value, { stream: true })
        const parsedChunk = parseSseChunk(buffer)
        buffer = parsedChunk.rest

        for (const event of parsedChunk.events) {
          const parsed = parseSseData(event)
          if (parsed === null) {
            // `data: [DONE]`（部分网关用它收尾，而不是 `response.completed`）
            finished = true
            break
          }
          if (parsed === undefined) continue

          for (const payload of parsed) {
            for (const emitted of handleResponsesEvent(payload, calls)) {
              if (emitted.kind === 'text' || emitted.kind === 'reasoning') {
                yield { type: emitted.kind, delta: emitted.delta }
                continue
              }
              if (emitted.kind === 'tool') {
                yield { type: 'tool_call', call: emitted.call }
                continue
              }
              if (emitted.kind === 'done') {
                if (emitted.usage !== undefined) usage = emitted.usage
                if (emitted.finishReason !== undefined) finishReason = emitted.finishReason
                continue
              }
              // 失败：记下来，流结束后按 `error` 事件收尾（与 chat-completions 侧一致）
              failure = emitted.error
            }
          }
        }
      }

      if (failure !== undefined) {
        yield { type: 'error', code: failure.code, message: failure.message }
        return
      }

      // 收口：没等到 `response.output_item.done` 的工具调用在这里补发（有名字才发）。
      for (const call of calls.values()) {
        if (call.emitted || call.name === '') continue
        call.emitted = true
        yield {
          type: 'tool_call',
          call: { id: call.callId, name: call.name, arguments: call.args },
        }
      }
      if (calls.size > 0 && finishReason === 'stop') finishReason = 'tool_calls'
      yield { type: 'done', finishReason, ...(usage === undefined ? {} : { usage }) }
    } catch (error) {
      const llmError = toLlmError(error)
      yield { type: 'error', code: llmError.code, message: llmError.message }
    } finally {
      await reader?.cancel().catch(() => undefined)
      scope.release()
    }
  }

  private async probeChat(): Promise<void> {
    const body = toResponsesBody(
      { model: this.defaultModel, messages: [{ role: 'user', content: 'ping' }], maxTokens: 1 },
      this.defaultModel,
    )
    const response = await this.http.fetchWithPolicy(
      this.http.createRequest('POST', '/responses', body, 'application/json'),
    )
    await response.arrayBuffer()
  }
}

// ───────────────────────── 请求体映射（纯函数，单测直接调） ─────────────────────────

/**
 * `ChatRequest` → Responses API 请求体（docs/06 §3.2）。
 *
 * 两处刻意的取舍：
 * - **首条 system 消息 → 顶层 `instructions`**，其余 system 消息（技能正文 / 附件文本）
 *   保留在 `input` 的原位：这样「易变内容靠尾部」的性质与 chat-completions 侧一致，
 *   前缀缓存不被破坏（把它们统统并进 `instructions` 会把易变内容挪到最前面）。
 * - `temperature` / `max_output_tokens` / `reasoning` / `text` 只在**真的有值**时才出现：
 *   推理模型对 `temperature` 一类字段是直接 400，与 `reasoning_effort` 的 `auto` 同款理由。
 */
export function toResponsesBody(req: ChatRequest, defaultModel: string): Record<string, unknown> {
  const { instructions, input } = toResponsesInput(req.messages)
  return {
    model: req.model || defaultModel,
    input,
    ...(instructions === undefined ? {} : { instructions }),
    stream: true,
    // 不在服务端留存会话（docs/11 的隐私口径）：Aurora 的会话历史只存在本机
    store: false,
    ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
    ...(req.reasoningEffort === undefined ? {} : { reasoning: { effort: req.reasoningEffort } }),
    ...(req.maxTokens === undefined ? {} : { max_output_tokens: req.maxTokens }),
    ...(req.jsonObject ? { text: { format: { type: 'json_object' } } } : {}),
    ...(req.tools && req.tools.length > 0
      ? {
          tools: req.tools.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            strict: false,
          })),
          tool_choice: 'auto',
        }
      : {}),
  }
}

/** `input` 条目数组 + `instructions`（首条 system 消息）。 */
export function toResponsesInput(messages: readonly ChatRequestMessage[]): {
  instructions?: string
  input: Array<Record<string, unknown>>
} {
  const input: Array<Record<string, unknown>> = []
  let instructions: string | undefined

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message === undefined) continue

    if (message.role === 'system') {
      // 首条 = 系统提示词 → `instructions`；其后的（extraContext 等）留在原位
      if (instructions === undefined && index === 0) {
        instructions = message.content
        continue
      }
      input.push({ role: 'system', content: inputContentOf(message) })
      continue
    }

    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId ?? '',
        output: message.content,
      })
      continue
    }

    if (message.role === 'assistant') {
      if (message.content !== '') {
        input.push({ role: 'assistant', content: inputContentOf(message) })
      }
      for (const call of message.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          // `call_id` 是**工具结果回填时要比对的 id**（形如 call_…），不是条目 id（fc_…）：
          // 用条目 id 配 `function_call_output` 会被服务端直接拒绝，表现为「工具跑完了
          // 但对话再也继续不下去」。
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        })
      }
      continue
    }

    input.push({ role: 'user', content: inputContentOf(message) })
  }

  return { ...(instructions === undefined ? {} : { instructions }), input }
}

/**
 * 一条消息在 `input` 里的 `content`：没有图片时用**纯字符串**（最通行、也最短的形状），
 * 有图片时才是分片数组（`input_text` + 每张图一个 `input_image`）。
 */
function inputContentOf(message: ChatRequestMessage): unknown {
  const images = message.images ?? []
  if (images.length === 0) return message.content
  const parts: Array<Record<string, unknown>> = []
  // 正文为空时只发图片分片：空 text 分片在部分网关会被当成「空消息」拒绝。
  if (message.content !== '') parts.push({ type: 'input_text', text: message.content })
  for (const image of images) {
    parts.push({
      type: 'input_image',
      // Responses 的 `input_image` 收的是 **URL 字符串**（不像 chat-completions 那样套一层对象）
      image_url: toImageDataUrl(image),
      ...(image.detail === undefined ? {} : { detail: image.detail }),
    })
  }
  return parts
}

// ───────────────────────── 事件映射（纯函数，单测直接调） ─────────────────────────

/** `handleResponsesEvent` 的产出（一个事件最多产出一条）。 */
export type ResponsesEventOutput =
  | { kind: 'text'; delta: string }
  | { kind: 'reasoning'; delta: string }
  | { kind: 'tool'; call: ToolCallRequest }
  /**
   * 收尾信息：`usage` 缺省 = 这个网关没回传用量（**不是** 0）；
   * `finishReason` 缺省 = 没说明原因（由调用方按既有值决定）。
   */
  | { kind: 'done'; usage?: TokenUsage; finishReason?: FinishReason }
  | { kind: 'error'; error: LlmError }

/**
 * 把一个 SSE 负载（Responses 的 `response.*` 事件）翻译成内部事件。
 *
 * 认的事件（其余的静默忽略 —— 这个协议的事件种类很多，且各家网关的实现子集不同，
 * 「不认识就当没发生」比「报错」稳得多）：
 * `response.output_text.delta` / `response.reasoning_summary_text.delta` /
 * `response.reasoning_text.delta` / `response.output_item.added` /
 * `response.function_call_arguments.delta` / `response.function_call_arguments.done` /
 * `response.output_item.done` / `response.completed` / `response.incomplete` /
 * `response.failed` / 顶层 `error`。
 */
export function handleResponsesEvent(
  payload: unknown,
  calls: Map<string, PendingCall>,
): ResponsesEventOutput[] {
  const record = asRecord(payload)
  if (record === undefined) return []
  const type = record['type']
  if (typeof type !== 'string') return []

  switch (type) {
    case 'response.output_text.delta': {
      const delta = record['delta']
      return typeof delta === 'string' && delta !== '' ? [{ kind: 'text', delta }] : []
    }
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta': {
      const delta = record['delta']
      return typeof delta === 'string' && delta !== '' ? [{ kind: 'reasoning', delta }] : []
    }
    case 'response.output_item.added': {
      const item = asRecord(record['item'])
      if (item === undefined || item['type'] !== 'function_call') return []
      const callId = stringOf(item['call_id']) ?? stringOf(item['id']) ?? ''
      const key = stringOf(item['id']) ?? callId
      calls.set(key, {
        callId,
        name: stringOf(item['name']) ?? '',
        args: stringOf(item['arguments']) ?? '',
        emitted: false,
      })
      return []
    }
    case 'response.function_call_arguments.delta': {
      const key = stringOf(record['item_id'])
      const delta = record['delta']
      if (key === undefined || typeof delta !== 'string') return []
      const call = calls.get(key)
      if (call !== undefined) call.args += delta
      return []
    }
    case 'response.function_call_arguments.done': {
      const key = stringOf(record['item_id'])
      const args = record['arguments']
      if (key === undefined || typeof args !== 'string') return []
      const call = calls.get(key)
      // `done` 携带的是**完整参数**：累积值在多副本 / 丢片时可能不完整，这里以它为准
      if (call !== undefined) call.args = args
      return []
    }
    case 'response.output_item.done': {
      const item = asRecord(record['item'])
      if (item === undefined || item['type'] !== 'function_call') return []
      const key = stringOf(item['id']) ?? stringOf(item['call_id']) ?? ''
      const known = calls.get(key)
      const callId = stringOf(item['call_id']) ?? known?.callId ?? stringOf(item['id']) ?? ''
      const name = stringOf(item['name']) ?? known?.name ?? ''
      const args = stringOf(item['arguments']) ?? known?.args ?? ''
      if (known !== undefined) {
        known.callId = callId
        known.name = name
        known.args = args
        if (known.emitted || name === '') return []
        known.emitted = true
      } else {
        calls.set(key, { callId, name, args, emitted: true })
      }
      if (name === '') return []
      return [{ kind: 'tool', call: { id: callId, name, arguments: args } }]
    }
    case 'response.completed': {
      const response = asRecord(record['response'])
      // 兜底：有的网关不发 `output_item.done`，工具调用只出现在收尾的 `output` 里
      const outputs = response?.['output']
      const recovered: ResponsesEventOutput[] = []
      if (Array.isArray(outputs)) {
        for (const raw of outputs) {
          const item = asRecord(raw)
          if (item === undefined || item['type'] !== 'function_call') continue
          const key = stringOf(item['id']) ?? stringOf(item['call_id']) ?? ''
          const call = calls.get(key)
          if (call !== undefined && call.emitted) continue
          const callId = stringOf(item['call_id']) ?? call?.callId ?? key
          const name = stringOf(item['name']) ?? call?.name ?? ''
          const args = stringOf(item['arguments']) ?? call?.args ?? ''
          if (key !== '') calls.set(key, { callId, name, args, emitted: true })
          if (name !== '')
            recovered.push({ kind: 'tool', call: { id: callId, name, arguments: args } })
        }
      }
      const usage = extractResponsesUsage(response?.['usage'])
      const finishReason = finishReasonOf(response)
      return [
        ...recovered,
        {
          kind: 'done',
          ...(usage === undefined ? {} : { usage }),
          ...(finishReason === undefined ? {} : { finishReason }),
        },
      ]
    }
    case 'response.incomplete': {
      const response = asRecord(record['response'])
      const usage = extractResponsesUsage(response?.['usage'])
      const finishReason = finishReasonOf(response) ?? 'length'
      return [{ kind: 'done', ...(usage === undefined ? {} : { usage }), finishReason }]
    }
    case 'response.failed': {
      const response = asRecord(record['response'])
      const error = asRecord(response?.['error'])
      const message = stringOf(error?.['message']) ?? 'Responses API 返回失败状态'
      const code = stringOf(error?.['code'])
      return [
        {
          kind: 'error',
          error: new LlmError(
            code === 'rate_limit_exceeded' ? 'E_RATE_LIMIT' : 'E_SERVER',
            code === undefined ? message : `${code}: ${message}`,
          ),
        },
      ]
    }
    case 'error': {
      const message = stringOf(record['message']) ?? 'Responses API 流中返回错误事件'
      const code = stringOf(record['code'])
      return [
        {
          kind: 'error',
          error: new LlmError(
            code === 'rate_limit_exceeded' ? 'E_RATE_LIMIT' : 'E_SERVER',
            code === undefined ? message : `${code}: ${message}`,
          ),
        },
      ]
    }
    default:
      return []
  }
}

/** `response.usage` → `TokenUsage`（缓存命中读 `input_tokens_details.cached_tokens`）。 */
export function extractResponsesUsage(raw: unknown): TokenUsage | undefined {
  const usage = asRecord(raw)
  if (usage === undefined) return undefined
  const prompt = Number(usage['input_tokens'] ?? Number.NaN)
  const completion = Number(usage['output_tokens'] ?? Number.NaN)
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return undefined
  const totalRaw = Number(usage['total_tokens'] ?? prompt + completion)
  const total = Number.isFinite(totalRaw) ? totalRaw : prompt + completion
  const details = asRecord(usage['input_tokens_details'])
  const cachedRaw = details?.['cached_tokens']
  const cached = cachedRaw === undefined ? undefined : Number(cachedRaw)
  const cachedTokens =
    cached === undefined || !Number.isFinite(cached) || cached < 0 ? undefined : cached
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    // 与 chat-completions 侧同款：缺省整条不出现（「没报」≠「报了 0」）
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
  }
}

/** `response.status` / `incomplete_details.reason` → `FinishReason`。 */
function finishReasonOf(response: Record<string, unknown> | undefined): FinishReason | undefined {
  if (response === undefined) return undefined
  const details = asRecord(response['incomplete_details'])
  const reason = stringOf(details?.['reason'])
  if (reason === 'max_output_tokens') return 'length'
  if (reason === 'content_filter') return 'content_filter'
  if (reason !== undefined) return 'unknown'
  const status = stringOf(response['status'])
  if (status === 'incomplete') return 'length'
  if (status === 'completed') return 'stop'
  return undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
