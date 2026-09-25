/**
 * 语音输入（STT 转写，Design/betav2-spec.md §8.2、docs/06 §15）。
 *
 * 主进程用**解密后**的凭据把渲染层录制的音频（MediaRecorder → webm base64）
 * 交给用户配置的 OpenAI 兼容转写服务 `POST <baseUrl>/audio/transcriptions`
 * （multipart/form-data），回传识别文本；渲染层永远看不到明文密钥。
 *
 * 本文件**不得 import electron**：它必须能被 vitest 直接加载（见 vitest.config.ts 的 include），
 * 出网 fetch（netFetch）等系统能力全部经 options 注入。
 */
import type { Logger, SttTranscribeResult } from '@aurora/shared'
import type { SettingsStoreLike } from './contracts.js'

export interface SttServiceOptions {
  settings: SettingsStoreLike
  logger: Logger
  /** 转写超时（默认 30s）；录音是短音频，与 TTS 同一量级 */
  timeoutMs?: number
  /**
   * 当前出网 fetch（docs/08 §6 系统代理）。
   * 与 `TtsSynthesizer` 同理：STT 也必须走同一条网络路径，
   * 否则 `advanced.proxy` 对它无效。
   */
  resolveFetch?: () => typeof fetch | undefined
}

export interface SttTranscribeInput {
  /** 录音内容的 base64（渲染层 MediaRecorder 产物） */
  audioBase64: string
  /** 录音 MIME 类型（如 `audio/webm;codecs=opus`），据此选 multipart 文件扩展名 */
  mime: string
  /** 覆盖 provider 配置的识别语言；缺省用 `stt.providers.<id>.language`，空串 = 交给服务端自动检测 */
  language?: string
}

export interface SttService {
  /** 录音 → 文本。失败一律**抛出**（IPC 层折成 `Result.error`），与 `TtsSynthesizer` 同一口径。 */
  transcribe(input: SttTranscribeInput): Promise<SttTranscribeResult>
}

/** 转写超时（默认 30s）。 */
const DEFAULT_TIMEOUT_MS = 30_000
/** 非 2xx 时读进 message 的 body 上限。 */
const ERROR_BODY_LIMIT = 300

/** multipart 里文件字段的字段名（OpenAI 兼容约定） */
const FILE_FIELD = 'file'

/** 创建 STT 服务；provider 解析口径与 TTS 一致（`stt.enabled && stt.active`）。 */
export function createSttService(options: SttServiceOptions): SttService {
  const { settings, logger } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  async function resolve(input: SttTranscribeInput): Promise<{
    providerId: string
    baseUrl: string
    model: string
    language: string
    apiKey: string
    audio: Buffer
    mime: string
  }> {
    const config = settings.get().stt
    if (!config.enabled || config.active === '') {
      throw new Error('语音输入未配置：请先在设置中启用语音输入并选择识别模型')
    }
    const providerId = config.active
    const provider = config.providers[providerId]
    if (provider === undefined) {
      throw new Error(`语音输入未配置：识别模型「${providerId}」不存在`)
    }

    const baseUrl = provider.baseUrl.trim()
    if (baseUrl === '') throw new Error('语音输入未配置：识别模型的 baseURL 为空')

    const model = provider.model.trim()
    if (model === '') throw new Error('语音输入未配置：请先填写识别模型名')

    const apiKey = settings.getSecret(`stt.providers.${providerId}.apiKey`)
    if (apiKey === '') throw new Error('缺少 API Key：请先填写识别模型的密钥')

    const audioBase64 = input.audioBase64.trim()
    const audio = audioBase64 === '' ? Buffer.alloc(0) : Buffer.from(audioBase64, 'base64')
    if (audio.byteLength === 0) throw new Error('没有可识别的音频内容')

    // 语言：请求覆盖值优先，其次 provider 配置；两者为空都表示交给服务端自动检测（不下发字段）
    const language = (input.language ?? provider.language).trim()

    return {
      providerId,
      baseUrl,
      model,
      language,
      apiKey,
      audio,
      mime: input.mime.trim() === '' ? 'audio/webm' : input.mime.trim(),
    }
  }

  return {
    async transcribe(input: SttTranscribeInput): Promise<SttTranscribeResult> {
      const resolved = await resolve(input)

      const form = new FormData()
      form.append(
        FILE_FIELD,
        new Blob([new Uint8Array(resolved.audio)], { type: resolved.mime }),
        `recording.${extensionForMime(resolved.mime)}`,
      )
      form.append('model', resolved.model)
      if (resolved.language !== '') form.append('language', resolved.language)

      const startedAt = Date.now()
      const response = await post({
        fetchImpl: resolveFetchOf(options.resolveFetch, logger),
        endpoint: transcribeEndpoint(resolved.baseUrl),
        apiKey: resolved.apiKey,
        form,
        timeoutMs,
      })

      if (!response.ok) {
        const detail = await readErrorDetail(response)
        const message = describeHttpFailure(response.status, detail)
        logger.warn('STT 转写失败', { provider: resolved.providerId, status: response.status })
        throw new Error(message)
      }

      const text = await readText(response)
      logger.info('STT 转写成功', {
        provider: resolved.providerId,
        chars: text.length,
        bytes: resolved.audio.byteLength,
        latencyMs: Date.now() - startedAt,
      })
      return { text }
    },
  }
}

// ───────────────────────── 内部 ─────────────────────────

/** 发一次 `POST <baseUrl>/audio/transcriptions`；超时统一折成固定中文文案。 */
async function post(input: {
  fetchImpl: typeof fetch
  endpoint: string
  apiKey: string
  form: FormData
  timeoutMs: number
}): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs)
  const seconds = Math.round(input.timeoutMs / 1000)

  try {
    // 注意：multipart **不能**手工设置 Content-Type —— boundary 由 fetch 实现生成，
    // 手工设置会丢 boundary 导致服务端解析失败。
    return await input.fetchImpl(input.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.apiKey}` },
      body: input.form,
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`识别超时（${seconds}s）`)
    throw new Error(`识别请求失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

/** `<baseUrl>` 去尾斜杠后拼 `/audio/transcriptions`；已经以它结尾时不重复拼。 */
function transcribeEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed.endsWith('/audio/transcriptions') ? trimmed : `${trimmed}/audio/transcriptions`
}

/** 录音 MIME → multipart 文件名扩展名（无法识别时按 MediaRecorder 默认的 webm 兜底）。 */
function extensionForMime(mime: string): string {
  const lower = mime.toLowerCase()
  if (lower.includes('webm')) return 'webm'
  if (lower.includes('mp3') || lower.includes('mpeg')) return 'mp3'
  if (lower.includes('wav')) return 'wav'
  if (lower.includes('ogg')) return 'ogg'
  if (lower.includes('mp4') || lower.includes('m4a') || lower.includes('aac')) return 'm4a'
  if (lower.includes('flac')) return 'flac'
  return 'webm'
}

/** 解析 `{ text }` 响应；形状不对时按失败处理（不给模型 / 渲染层编造空文本的机会）。 */
async function readText(response: Response): Promise<string> {
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new Error('语音识别返回了无法解析的内容')
  }
  const text = (parsed as { text?: unknown } | null)?.text
  if (typeof text !== 'string') throw new Error('语音识别返回格式异常（缺少 text 字段）')
  return text
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const body = await response.text()
    return body.slice(0, ERROR_BODY_LIMIT)
  } catch {
    return ''
  }
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
            ? 'STT 服务端错误'
            : '语音识别失败'
  const suffix = detail.trim() === '' ? '' : `：${detail.trim()}`
  return `${prefix}（HTTP ${status}）${suffix}`
}

/** 解析当前出网 fetch；解析失败按未提供处理（回落 `globalThis.fetch`）。 */
function resolveFetchOf(
  resolveFetch: (() => typeof fetch | undefined) | undefined,
  logger: Logger,
): typeof fetch {
  if (resolveFetch !== undefined) {
    try {
      const resolved = resolveFetch()
      if (resolved !== undefined) return resolved
    } catch (error) {
      logger.debug('取网络客户端失败，回落默认实现', { error: String(error) })
    }
  }
  return globalThis.fetch
}
