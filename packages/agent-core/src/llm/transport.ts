/**
 * LLM 传输层（docs/06 §3）：超时 / 取消 / 指数退避重试 / 错误码 / 模型列表 / 连接测试。
 *
 * 从 `openai-compat.ts` 抽出来的唯一理由是 **Responses API（§3.2）需要逐字相同的行为**：
 * 两条协议只在「请求体怎么拼」「响应事件怎么解」上不同，可靠性语义必须一致 ——
 * 否则会出现「换成 Responses 之后停止按钮失效 / 超时不重试」这类只在一种协议下复现的问题。
 *
 * 纯 Node：不依赖 Electron / DOM，`fetch` 由调用方注入（主进程注入走代理的 `netFetch`）。
 */
import {
  LlmError,
  isLlmError,
  type LlmErrorCode,
  type ModelInfo,
  type TestConnectionResult,
} from './types.js'

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

/** 内部请求描述（不直接用 `Request`，便于注入 fetch 与单测断言请求体） */
export interface PreparedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: Record<string, unknown>
  signal?: AbortSignal
}

/** 一次请求的超时 / 取消作用域（`chat()` 与 `fetchOnce()` 的分界，见 `createScope`） */
export interface RequestScope {
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

export interface RetryInfo {
  attempt: number
  code: LlmErrorCode
  delayMs: number
  /** 非退避重试时的原因说明（如「去掉 stream_options 降级」）；退避重试不带该字段 */
  reason?: string
}

export interface TransportOptions {
  id: string
  baseUrl: string
  apiKey: string
  /** 单请求超时，默认 60_000ms */
  timeoutMs?: number
  /** 失败重试次数（不含首次），默认 2 */
  maxRetries?: number
  /** 重试基础退避，默认 500ms（指数） */
  retryBaseDelayMs?: number
  /** 注入 fetch 便于单测（主进程注入 `netFetch` 以走代理） */
  fetchImpl?: typeof fetch
  onRetry?: (info: RetryInfo) => void
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
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
 * 「服务端拒绝了一个未知字段」的报文判定（chat-completions 的 `stream_options` 降级的触发条件）。
 *
 * 先认点名（`stream_options` / `include_usage`），再兜一层**不点名**的常见措辞：
 * 不少网关只说 `Unknown parameter` / `Extra inputs are not permitted`，逐字匹配就退不回去，
 * 用户看到的是「整个对话 400 打不开」—— 而这一层降级存在的唯一理由就是避免那个结果。
 * 代价是可能白重试一次（若报文恰好回显了请求体），可接受：重试只发生在 `E_BAD_REQUEST` 上，
 * 它不参与 `fetchWithPolicy` 的退避重试，最多多发一次请求。
 */
export function looksLikeRejectedField(message: string): boolean {
  if (/stream_options|include_usage/i.test(message)) return true
  return /unknown|unexpected|unrecognized|not permitted|unsupported|extra fields|extra inputs|invalid[_ ]?parameter/i.test(
    message,
  )
}

export function describeHttpError(status: number, body: string): string {
  const trimmed = body.trim().slice(0, 300)
  return trimmed === '' ? `HTTP ${status}` : `HTTP ${status} ${trimmed}`
}

export async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 两个 provider 共用的 HTTP 传输：**只关心「可靠地拿到（或流式拿到）响应」**，
 * 请求体怎么拼、响应怎么解都归各自的 provider。
 */
export class HttpTransport {
  readonly id: string
  readonly baseUrl: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly retryBaseDelayMs: number
  private readonly fetchImpl: typeof fetch
  private readonly onRetry: TransportOptions['onRetry']

  constructor(options: TransportOptions) {
    this.id = options.id
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    this.apiKey = options.apiKey
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.maxRetries = Math.max(0, options.maxRetries ?? 2)
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.onRetry = options.onRetry
    if (typeof this.fetchImpl !== 'function') {
      throw new LlmError('E_UNKNOWN', '当前运行环境不提供 fetch，无法访问 LLM 服务')
    }
  }

  /** 非退避重试（协议降级）时的告知入口，与 `fetchWithPolicy` 的退避重试共用一个回调。 */
  notifyRetry(info: RetryInfo): void {
    this.onRetry?.(info)
  }

  /** `GET {baseUrl}/models`（两个协议通用）。 */
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

  /**
   * 连接测试：先 `GET /models`，服务端不实现（404 / 405）时退化为一次最小请求
   * （`probe` 由各 provider 提供：chat-completions 发一条 `ping`，Responses 同理）。
   */
  async testConnection(probe: () => Promise<void>): Promise<TestConnectionResult> {
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
      // 部分服务不实现 /models，退化为一次最小请求
      if (first.httpStatus === 404 || first.httpStatus === 405) {
        try {
          await probe()
          return {
            ok: true,
            latencyMs: Date.now() - started,
            message: '连接成功（服务未提供模型列表接口）',
          }
        } catch (probeError) {
          return this.failure(toLlmError(probeError), started)
        }
      }
      return this.failure(first, started)
    }
  }

  failure(error: LlmError, started: number): TestConnectionResult {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      message: describeError(error),
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    }
  }

  createRequest(
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
  async fetchWithPolicy(request: PreparedRequest, scope?: RequestScope): Promise<Response> {
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
  createScope(external?: AbortSignal): RequestScope {
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

  async fetchOnce(request: PreparedRequest, scope?: RequestScope): Promise<Response> {
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
