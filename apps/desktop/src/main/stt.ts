/**
 * 语音输入（STT 转写，Design/betav2-spec.md §8.2、docs/06 §15）。
 *
 * 主进程用**解密后**的凭据把渲染层录制的音频（MediaRecorder → webm base64）交给
 * 用户配置的转写服务，回传识别文本；渲染层永远看不到明文密钥。两套协议（`stt.providers.<id>.type`）：
 *
 * - `openai-compat`：`POST <baseUrl>/audio/transcriptions`（multipart/form-data，回 `{text}`）；
 * - `dashscope-native`：阿里云百炼 / DashScope 原生
 *   `POST <baseUrl>/api/v1/services/aigc/multimodal-generation/generation`
 *   —— 同步接口，音频以 `data:<mime>;base64,…` 放进 `input.messages[].content[].audio`，
 *   文本在 `output.choices[0].message.content[].text`（webm/opus 直传，**无需转码**）。
 *
 * 本文件**不得 import electron**：它必须能被 vitest 直接加载（见 vitest.config.ts 的 include），
 * 出网 fetch（netFetch）等系统能力全部经 options 注入。
 */
import type { Logger, SttProviderType, SttTranscribeResult } from '@aurora/shared'
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
  /**
   * 录音 MIME 类型（如 `audio/webm;codecs=opus`）。两套协议都吃它：
   * `openai-compat` 据此选 multipart 文件扩展名，`dashscope-native` 据此拼
   * `data:<type/subtype>;base64,…`（只保留 type/subtype，`;codecs=…` 会被剥掉）。
   */
  mime: string
  /** 覆盖 provider 配置的识别语言；缺省用 `stt.providers.<id>.language`，空串 = 交给服务端自动检测 */
  language?: string
  /** 主进程内部回落用：覆盖 `stt.active`，不进入 IPC 契约。 */
  providerId?: string
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
    type: SttProviderType
    baseUrl: string
    model: string
    language: string
    apiKey: string
    audio: Buffer
    audioBase64: string
    mime: string
  }> {
    const config = settings.get().stt
    if (!config.enabled || config.active === '') {
      throw new Error('语音输入未配置：请先在设置中启用语音输入并选择识别模型')
    }
    const providerId = input.providerId?.trim() || config.active
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
      type: provider.type,
      baseUrl,
      model,
      language,
      apiKey,
      audio,
      audioBase64,
      mime: input.mime.trim() === '' ? 'audio/webm' : input.mime.trim(),
    }
  }

  return {
    async transcribe(input: SttTranscribeInput): Promise<SttTranscribeResult> {
      const resolved = await resolve(input)
      const native = resolved.type === 'dashscope-native'
      const fetchImpl = resolveFetchOf(options.resolveFetch, logger)

      const startedAt = Date.now()
      const response = native
        ? await postJson({
            fetchImpl,
            endpoint: dashscopeAsrEndpoint(resolved.baseUrl),
            apiKey: resolved.apiKey,
            body: JSON.stringify({
              model: resolved.model,
              input: {
                messages: [
                  {
                    role: 'user',
                    content: [{ audio: audioDataUri(resolved.mime, resolved.audioBase64) }],
                  },
                ],
              },
              // 空串 = 自动检测：整个 `parameters` 不下发（与 OpenAI 侧不下发 language 同义）
              ...(resolved.language === ''
                ? {}
                : { parameters: { asr_options: { language: resolved.language } } }),
            }),
            timeoutMs,
          })
        : await post({
            fetchImpl,
            endpoint: transcribeEndpoint(resolved.baseUrl),
            apiKey: resolved.apiKey,
            form: buildForm(resolved),
            timeoutMs,
          })

      if (!response.ok) {
        const detail = await readErrorDetail(response)
        const message = native
          ? describeDashscopeFailure(response.status, detail)
          : describeHttpFailure(response.status, detail)
        logger.warn('STT 转写失败', { provider: resolved.providerId, status: response.status })
        throw new Error(message)
      }

      const text = native ? await readDashscopeText(response) : await readText(response)
      logger.info('STT 转写成功', {
        provider: resolved.providerId,
        protocol: resolved.type,
        chars: text.length,
        bytes: resolved.audio.byteLength,
        latencyMs: Date.now() - startedAt,
      })
      return { text }
    },
  }
}

// ───────────────────────── 内部 ─────────────────────────

/** OpenAI 兼容侧的多部分表单：`file` + `model` + 可选的 `language`。 */
function buildForm(resolved: {
  audio: Buffer
  mime: string
  model: string
  language: string
}): FormData {
  const form = new FormData()
  form.append(
    FILE_FIELD,
    new Blob([new Uint8Array(resolved.audio)], { type: resolved.mime }),
    `recording.${extensionForMime(resolved.mime)}`,
  )
  form.append('model', resolved.model)
  if (resolved.language !== '') form.append('language', resolved.language)
  return form
}

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

/** 阿里云原生 ASR 的路径（同步接口，与 qwen-image 同一条 multimodal-generation 路由）。 */
const DASHSCOPE_ASR_PATH = '/api/v1/services/aigc/multimodal-generation/generation'

/**
 * `<baseUrl>` → 阿里云原生 ASR 端点。
 *
 * baseUrl 的**规范填法是服务根**（如 `https://dashscope.aliyuncs.com`），但三种常见写法都容忍：
 * ① 已经是完整端点 → 原样用；② 尾上挂着 `/api` / `/api/v1` / `/compatible-mode/v1`
 * （照 TTS / 生图那两栏的习惯粘过来的，尤其 MaaS 专属网关的 baseUrl 常写成 `…/api`）→ 换掉这段尾巴；
 * ③ 其余 → 拼上完整路径。**不猜 `/compatible-mode/v1` 之外的网关前缀**：
 * 原生路径就挂在其根上，换网关只要改 baseUrl。
 */
function dashscopeAsrEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (trimmed.endsWith(DASHSCOPE_ASR_PATH)) return trimmed
  for (const suffix of ['/compatible-mode/v1', '/api/v1', '/api']) {
    if (trimmed.endsWith(suffix)) {
      return `${trimmed.slice(0, trimmed.length - suffix.length)}${DASHSCOPE_ASR_PATH}`
    }
  }
  return `${trimmed}${DASHSCOPE_ASR_PATH}`
}

/**
 * 音频 → `data:` URI。
 *
 * MIME **只保留 `type/subtype`**：渲染层交上来的是 `recorder.mimeType`
 * （Chromium 实际协商值 `audio/webm;codecs=opus`），把 `;codecs=…` 带进 URI 会让
 * 服务端按未知格式解析。空 mime 兜底 `audio/webm`（与 multipart 侧同一兜底口径）。
 */
function audioDataUri(mime: string, base64: string): string {
  const type = mime.split(';')[0]?.trim().toLowerCase() ?? ''
  return `data:${type === '' ? 'audio/webm' : type};base64,${base64}`
}

/** 发一次原生 JSON POST；超时与网络错误的中文文案与 multipart 侧**逐字一致**。 */
async function postJson(input: {
  fetchImpl: typeof fetch
  endpoint: string
  apiKey: string
  body: string
  timeoutMs: number
}): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs)
  const seconds = Math.round(input.timeoutMs / 1000)

  try {
    return await input.fetchImpl(input.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.apiKey}`,
      },
      body: input.body,
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`识别超时（${seconds}s）`)
    throw new Error(`识别请求失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
  }
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

/**
 * 解析原生响应：`output.choices[0].message.content[0].text`。
 *
 * 与生图侧同款「逐层取样、不假设只有一层」的读法：`choices` 与 `content` 都是数组
 * （内容数组还可能混着非文本分片），取**第一条带字符串 `text` 的**即可；
 * 一个都没有时按失败处理，不编造空文本。
 */
async function readDashscopeText(response: Response): Promise<string> {
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new Error('语音识别返回了无法解析的内容')
  }
  const choices = (parsed as { output?: { choices?: unknown } } | null)?.output?.choices
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      const content = (choice as { message?: { content?: unknown } } | null)?.message?.content
      if (!Array.isArray(content)) continue
      for (const item of content) {
        const text = (item as { text?: unknown } | null)?.text
        if (typeof text === 'string') return text
      }
    }
  }
  throw new Error('语音识别返回格式异常（缺少 output.choices[0].message.content[0].text）')
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const body = await response.text()
    return body.slice(0, ERROR_BODY_LIMIT)
  } catch {
    return ''
  }
}

/** 按状态码给中文前缀（两套协议共用，保证同一状态码的提示词一致）。 */
function httpFailurePrefix(status: number): string {
  return status === 401 || status === 403
    ? 'API Key 无效或没有权限'
    : status === 404
      ? '接口或模型不存在（请检查 baseURL 与模型名）'
      : status === 429
        ? '请求过于频繁，已被限流'
        : status >= 500
          ? 'STT 服务端错误'
          : '语音识别失败'
}

/** 按状态码给中文前缀，并把服务端返回的 body 尾巴拼上（便于用户自查）。 */
function describeHttpFailure(status: number, detail: string): string {
  const suffix = detail.trim() === '' ? '' : `：${detail.trim()}`
  return `${httpFailurePrefix(status)}（HTTP ${status}）${suffix}`
}

/**
 * 原生接口的错误体是 `{ code, message, request_id }`（如
 * `{"code":"InvalidParameter","message":"Model not exist."}`）：
 * 优先回「code：message」—— `code` 才是用户能拿去对照阿里云文档的东西，
 * 也让「模型名写错」这类问题不用展开原始 JSON 就能看懂。解析不出时退回原始 body。
 */
function describeDashscopeFailure(status: number, detail: string): string {
  const parsed = asRecord(tryParseJson(detail))
  const code = readNonEmptyText(parsed?.['code'])
  const message = readNonEmptyText(parsed?.['message'])
  if (code !== undefined || message !== undefined) {
    const body = [code, message].filter((part) => part !== undefined && part !== '').join('：')
    return `${httpFailurePrefix(status)}（HTTP ${status}）：${body}`
  }
  return describeHttpFailure(status, detail)
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** 取非空字符串（`code` / `message` 这类字段可能缺失或为空串）。 */
function readNonEmptyText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
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
