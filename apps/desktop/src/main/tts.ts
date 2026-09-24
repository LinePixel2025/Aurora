/**
 * 语音合成（TTS 朗读，docs/06 §13）。
 *
 * 主进程用**解密后**的凭据调 TTS 服务的 `POST <baseUrl>/audio/speech`，
 * 把音频以 base64 回传渲染层；渲染层永远看不到明文密钥。
 *
 * 本文件**不得 import electron**：它必须能被 vitest 直接加载（见 vitest.config.ts 的 include）。
 */
import type { Logger, TtsFormat, TtsSynthesizeResult, TtsTestResult } from '@aurora/shared'
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
    const response = await this.post(resolved, input, this.timeoutMs)

    if (!response.ok) {
      const detail = await this.readErrorDetail(response)
      const message = describeHttpFailure(response.status, detail)
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

      const response = await this.post(resolved, input, TEST_TIMEOUT_MS)
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
          message: describeHttpFailure(response.status, detail),
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

  /** 发一次 `POST <baseUrl>/audio/speech`；超时统一折成固定中文文案。 */
  private async post(
    resolved: ReturnType<TtsSynthesizer['resolve']>,
    input: string,
    timeoutMs: number,
  ): Promise<Response> {
    const { provider, apiKey } = resolved
    const endpoint = speechEndpoint(provider.baseUrl)
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

/** `<baseUrl>` 去尾斜杠后拼 `/audio/speech`；已经以它结尾时不重复拼。 */
function speechEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed.endsWith('/audio/speech') ? trimmed : `${trimmed}/audio/speech`
}

/** 按状态码给中文前缀，并把服务端返回的 body 尾巴拼上（便于用户自查）。 */
function describeHttpFailure(status: number, detail: string): string {
  const prefix =
    status === 401 || status === 403
      ? 'API Key 无效或没有权限'
      : status === 404
        ? '接口或模型不存在（请检查 baseURL 与模型名）'
        : status === 429
          ? '请求过于频繁，已被限流'
          : status >= 500
            ? 'TTS 服务端错误'
            : '语音合成失败'
  const suffix = detail.trim() === '' ? '' : `：${detail.trim()}`
  return `${prefix}（HTTP ${status}）${suffix}`
}
