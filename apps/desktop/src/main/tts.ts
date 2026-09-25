/**
 * 语音合成（TTS 朗读，docs/06 §13）。
 *
 * 主进程用**解密后**的凭据调 TTS 服务的 `POST <baseUrl>/audio/speech`，
 * 把音频以 base64 回传渲染层；渲染层永远看不到明文密钥。
 *
 * 本文件**不得 import electron**：它必须能被 vitest 直接加载（见 vitest.config.ts 的 include）。
 */
import type {
  Logger,
  TtsFormat,
  TtsListModelsResult,
  TtsSynthesizeResult,
  TtsTestResult,
} from '@aurora/shared'
import type { SettingsStoreLike } from './contracts.js'

export interface TtsSynthesizerOptions {
  settings: SettingsStoreLike
  logger: Logger
  /** 合成超时（默认 30s）；`test` 用更短的 15s */
  timeoutMs?: number
  /**
   * 当前出网 fetch（docs/08 §6 系统代理）。
   * 与 `llm-tester.ts` 同理：TTS 也必须走同一条网络路径，
   * 否则 `advanced.proxy` 对它无效（表现为「设置了代理仍然连不上」）。
   */
  resolveFetch?: () => typeof fetch | undefined
}

export interface TtsSynthesizeRequest {
  text: string
  providerId?: string
}

export interface TtsTestRequest {
  providerId?: string
  baseUrl?: string
  apiKey?: string
  model?: string
  voice?: string
  speed?: number
  format?: TtsFormat
  text?: string
}

/**
 * 「获取模型列表」（设置页编辑卡按钮）的请求：草稿值优先，缺省回落已保存配置。
 * 只需要 baseUrl + apiKey，不要求 model / voice（拉列表时它们还没填很正常）。
 */
export interface TtsListModelsRequest {
  providerId?: string
  baseUrl?: string
  apiKey?: string
}

/** 设置页「试听 / 连接测试」的缺省样例句。 */
const DEFAULT_TEST_TEXT = '你好，我是 Aurora。'
/** 合成超时（真实 TTS 服务首字节较慢，30s 是留足余量的经验值）。 */
const DEFAULT_TIMEOUT_MS = 30_000
/** 试听超时（设置页不该让用户等太久）。 */
const TEST_TIMEOUT_MS = 15_000
/** 非 2xx 时读进 message 的 body 上限。 */
const ERROR_BODY_LIMIT = 300

/** 输出格式 → 播放用 MIME。 */
const MIME_BY_FORMAT: Record<TtsFormat, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/L16',
}

export class TtsSynthesizer {
  private readonly settings: SettingsStoreLike
  private readonly logger: Logger
  private readonly timeoutMs: number
  private readonly resolveFetch: (() => typeof fetch | undefined) | undefined

  constructor(options: TtsSynthesizerOptions) {
    this.settings = options.settings
    this.logger = options.logger
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.resolveFetch = options.resolveFetch
  }

  /**
   * 合成语音。失败一律**抛出**（IPC 层折成 `Result.error`），
   * 因为渲染层需要区分「没配置」与「合成失败」。
   */
  async synthesize(request: TtsSynthesizeRequest): Promise<TtsSynthesizeResult> {
    const resolved = this.resolve(request)
    const { provider } = resolved

    const text = request.text.trim()
    if (text === '') throw new Error('没有可朗读的文本')

    const maxChars = this.settings.get().tts.maxChars
    const truncated = text.length > maxChars
    const input = truncated ? text.slice(0, maxChars) : text

    const startedAt = Date.now()
    const endpoint = speechEndpoint(resolved.provider.baseUrl)
    const response = await this.post(resolved, endpoint, input, this.timeoutMs)

    if (!response.ok) {
      const detail = await this.readErrorDetail(response)
      const message = describeHttpFailure(response.status, detail, endpoint)
      this.logger.warn('TTS 合成失败', { provider: provider.id, status: response.status })
      throw new Error(message)
    }

    const buffer = Buffer.from(new Uint8Array(await response.arrayBuffer()))
    const latencyMs = Date.now() - startedAt
    this.logger.info('TTS 合成成功', {
      provider: provider.id,
      bytes: buffer.byteLength,
      chars: input.length,
      latencyMs,
    })

    return {
      audioBase64: buffer.toString('base64'),
      mimeType: MIME_BY_FORMAT[provider.format],
      bytes: buffer.byteLength,
      latencyMs,
      chars: input.length,
      truncated,
    }
  }

  /**
   * 连接测试 / 试听。与 `synthesize` 同一套解析逻辑，但**不抛**：
   * 把错误折成 `{ ok: false, latencyMs, message }` 供设置页直接展示。
   */
  async test(request: TtsTestRequest): Promise<TtsTestResult> {
    const startedAt = Date.now()
    try {
      const resolved = this.resolve(request)
      const text = (request.text ?? DEFAULT_TEST_TEXT).trim()
      if (text === '') return { ok: false, latencyMs: 0, message: '没有可朗读的文本' }

      const maxChars = this.settings.get().tts.maxChars
      const input = text.length > maxChars ? text.slice(0, maxChars) : text

      const endpoint = speechEndpoint(resolved.provider.baseUrl)
      const response = await this.post(resolved, endpoint, input, TEST_TIMEOUT_MS)
      const latencyMs = Date.now() - startedAt

      if (!response.ok) {
        const detail = await this.readErrorDetail(response)
        this.logger.warn('TTS 连接测试失败', {
          provider: resolved.provider.id,
          status: response.status,
        })
        return {
          ok: false,
          latencyMs,
          message: describeHttpFailure(response.status, detail, endpoint),
          httpStatus: response.status,
        }
      }

      const buffer = Buffer.from(new Uint8Array(await response.arrayBuffer()))
      this.logger.info('TTS 连接测试成功', {
        provider: resolved.provider.id,
        bytes: buffer.byteLength,
        latencyMs,
      })
      return {
        ok: true,
        latencyMs,
        message: `合成成功（${buffer.byteLength} 字节）`,
        bytes: buffer.byteLength,
        httpStatus: response.status,
      }
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * 拉取模型列表（设置页「获取模型列表」，`GET {baseUrl}/models`，docs/06 §13.2）。
   * 与 `test` 同款「不抛」口径：配置缺失、网络错误、HTTP 失败、响应畸形
   * 一律折成 `{ ok: false, models: [], message }` 供设置页直接 toast。
   */
  async listModels(request: TtsListModelsRequest): Promise<TtsListModelsResult> {
    try {
      const resolved = this.resolveListInputs(request)
      const endpoint = modelsEndpoint(resolved.baseUrl)
      const response = await this.get(endpoint, resolved.apiKey, TEST_TIMEOUT_MS)

      if (!response.ok) {
        const detail = await this.readErrorDetail(response)
        this.logger.warn('TTS 拉取模型列表失败', {
          provider: resolved.providerId,
          status: response.status,
        })
        return {
          ok: false,
          models: [],
          message: describeHttpFailure(response.status, detail, endpoint),
        }
      }

      let body: unknown
      try {
        body = await response.json()
      } catch {
        return { ok: false, models: [], message: '模型列表响应不是合法 JSON' }
      }
      const parsed = parseModelList(body)
      if (!parsed.ok) {
        this.logger.warn('TTS 模型列表响应格式异常', { provider: resolved.providerId })
        return { ok: false, models: [], message: parsed.message }
      }
      this.logger.info('TTS 拉取模型列表成功', {
        provider: resolved.providerId,
        count: parsed.models.length,
      })
      return { ok: true, models: parsed.models }
    } catch (error) {
      return {
        ok: false,
        models: [],
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  // ───────────────────────── 内部 ─────────────────────────

  /**
   * 解析生效配置：优先渲染层传来的草稿值（用户正在编辑、尚未保存），
   * 否则回落已保存配置；凭据优先用**参数里的明文**，再回落 `getSecret` 解密值。
   */
  private resolve(request: TtsTestRequest): {
    provider: {
      id: string
      baseUrl: string
      model: string
      voice: string
      speed: number
      format: TtsFormat
    }
    apiKey: string
  } {
    const settings = this.settings.get()
    const providerId = request.providerId ?? settings.tts.active
    if (providerId === '') throw new Error('尚未配置 TTS 模型')

    const saved = settings.tts.providers[providerId]
    const draftFieldsPresent =
      request.baseUrl !== undefined ||
      request.model !== undefined ||
      request.voice !== undefined ||
      request.speed !== undefined ||
      request.format !== undefined
    if (saved === undefined && !draftFieldsPresent) {
      throw new Error(`TTS 模型「${providerId}」不存在`)
    }

    const baseUrl = (request.baseUrl ?? saved?.baseUrl ?? '').trim()
    if (baseUrl === '') throw new Error('请先填写 baseURL')

    const model = (request.model ?? saved?.model ?? '').trim()
    if (model === '') throw new Error('请先填写模型名')

    const voice = (request.voice ?? saved?.voice ?? '').trim()
    if (voice === '') throw new Error('请先填写音色')

    const speed = request.speed ?? saved?.speed ?? 1
    const format = request.format ?? saved?.format ?? 'mp3'

    const apiKey =
      request.apiKey !== undefined && request.apiKey !== ''
        ? request.apiKey
        : saved === undefined
          ? ''
          : this.settings.getSecret(`tts.providers.${providerId}.apiKey`)

    if (apiKey === '') throw new Error('缺少 API Key：请填写密钥')

    return {
      provider: { id: providerId, baseUrl, model, voice, speed, format },
      apiKey,
    }
  }

  /**
   * `listModels` 专用的轻量解析：与 `resolve` 同一套「草稿优先 → 回落已保存配置」思路，
   * 但只要 baseUrl + apiKey，不要求 model / voice。
   */
  private resolveListInputs(request: TtsListModelsRequest): {
    providerId: string
    baseUrl: string
    apiKey: string
  } {
    const settings = this.settings.get()
    const providerId = request.providerId ?? settings.tts.active
    if (providerId === '') throw new Error('尚未配置 TTS 模型')

    const saved = settings.tts.providers[providerId]
    if (saved === undefined && request.baseUrl === undefined) {
      throw new Error(`TTS 模型「${providerId}」不存在`)
    }

    const baseUrl = (request.baseUrl ?? saved?.baseUrl ?? '').trim()
    if (baseUrl === '') throw new Error('请先填写 baseURL')

    const apiKey =
      request.apiKey !== undefined && request.apiKey !== ''
        ? request.apiKey
        : saved === undefined
          ? ''
          : this.settings.getSecret(`tts.providers.${providerId}.apiKey`)

    if (apiKey === '') throw new Error('缺少 API Key：请填写密钥')

    return { providerId, baseUrl, apiKey }
  }

  /** 发一次 `POST <endpoint>`；超时统一折成固定中文文案。 */
  private async post(
    resolved: ReturnType<TtsSynthesizer['resolve']>,
    endpoint: string,
    input: string,
    timeoutMs: number,
  ): Promise<Response> {
    const { provider, apiKey } = resolved
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const seconds = Math.round(timeoutMs / 1000)

    try {
      const fetchImpl = this.netFetch()
      return await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: provider.model,
          input,
          voice: provider.voice,
          speed: provider.speed,
          response_format: provider.format,
        }),
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`合成超时（${seconds}s）`)
      this.logger.warn('TTS 请求失败', { provider: provider.id, error: String(error) })
      throw new Error(`合成请求失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  /** 发一次 `GET <endpoint>`（拉模型列表）；超时 / 网络异常折成固定中文文案，模式与 post 同款。 */
  private async get(endpoint: string, apiKey: string, timeoutMs: number): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const seconds = Math.round(timeoutMs / 1000)

    try {
      const fetchImpl = this.netFetch()
      return await fetchImpl(endpoint, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`获取模型列表超时（${seconds}s）`)
      throw new Error(
        `获取模型列表请求失败：${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      clearTimeout(timer)
    }
  }

  private async readErrorDetail(response: Response): Promise<string> {
    try {
      const body = await response.text()
      return body.slice(0, ERROR_BODY_LIMIT)
    } catch {
      return ''
    }
  }

  /** 解析当前出网 fetch；解析失败按未提供处理（回落 `globalThis.fetch`）。 */
  private netFetch(): typeof fetch {
    if (this.resolveFetch !== undefined) {
      try {
        const resolved = this.resolveFetch()
        if (resolved !== undefined) return resolved
      } catch (error) {
        this.logger.debug('取网络客户端失败，回落默认实现', { error: String(error) })
      }
    }
    return globalThis.fetch
  }
}

/**
 * 误填成 baseUrl 的已知端点尾巴（长尾在前，避免 `/chat/completions` 只被剥掉一半的 `/completions`）。
 * `/audio/speech` 也在列：拉模型列表等场景要把误粘的合成端点剥掉。
 */
const KNOWN_ENDPOINT_TAILS = [
  '/audio/transcriptions',
  '/chat/completions',
  '/audio/speech',
  '/completions',
  '/models',
] as const

/**
 * baseUrl 规整（docs/06 §13.2）：去尾斜杠 → 剥误填的已知端点尾巴 → 域名根自动补 `/v1`。
 * 带路径（`/api/v1`、`/compatible-mode/v1` 等）尊重不动；URL 非法则原样返回，
 * 把错误交给服务端报出来（不在这里抛）。
 */
function normalizeBaseUrl(baseUrl: string): string {
  let trimmed = baseUrl.replace(/\/+$/, '')
  let changed = true
  while (changed) {
    changed = false
    for (const tail of KNOWN_ENDPOINT_TAILS) {
      if (trimmed.length > tail.length && trimmed.endsWith(tail)) {
        trimmed = trimmed.slice(0, -tail.length).replace(/\/+$/, '')
        changed = true
        break
      }
    }
  }
  try {
    const url = new URL(trimmed)
    // 只填了域名根（如 https://api.siliconflow.cn）：自动补 /v1（漏写 /v1 是 404 的最大来源）
    if (url.pathname === '' || url.pathname === '/') return `${trimmed}/v1`
  } catch {
    return trimmed
  }
  return trimmed
}

/** `<baseUrl>` 规整后拼 `/audio/speech`；已经以它结尾时不重复拼（也不补 /v1）。 */
function speechEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (trimmed.endsWith('/audio/speech')) return trimmed
  return `${normalizeBaseUrl(trimmed)}/audio/speech`
}

/** `<baseUrl>` 规整后拼 `/models`；已经以它结尾时不重复拼（也不补 /v1）。 */
function modelsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (trimmed.endsWith('/models')) return trimmed
  return `${normalizeBaseUrl(trimmed)}/models`
}

/** 按状态码给中文前缀，并把服务端返回的 body 尾巴拼上（便于用户自查）。 */
function describeHttpFailure(status: number, detail: string, endpoint?: string): string {
  const prefix =
    status === 401 || status === 403
      ? 'API Key 无效或没有权限'
      : status === 404
        ? endpoint === undefined
          ? '接口或模型不存在（请检查 baseURL 与模型名）'
          : `接口不存在：实际请求了 ${endpoint}。请检查 baseURL 是否以 /v1 结尾、模型名是否正确；部分网关不支持 OpenAI 兼容端点`
        : status === 429
          ? '请求过于频繁，已被限流'
          : status >= 500
            ? 'TTS 服务端错误'
            : '语音合成失败'
  const suffix = detail.trim() === '' ? '' : `：${detail.trim()}`
  return `${prefix}（HTTP ${status}）${suffix}`
}

/**
 * 防御性解析 OpenAI `GET /models` 响应的 `data[].id`：
 * 畸形响应（非对象 / 缺 data 数组）不抛，折成失败 + 中文提示；
 * 数组里个别缺 id / 非 id 条目直接跳过（取能取到的）。
 */
function parseModelList(
  body: unknown,
): { ok: true; models: string[] } | { ok: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: '模型列表响应不是 JSON 对象' }
  }
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) {
    return { ok: false, message: '模型列表响应缺少 data 数组（非 OpenAI 兼容格式）' }
  }
  const models: string[] = []
  for (const item of data) {
    if (typeof item === 'object' && item !== null) {
      const id = (item as { id?: unknown }).id
      if (typeof id === 'string' && id !== '') models.push(id)
    }
  }
  return { ok: true, models }
}
