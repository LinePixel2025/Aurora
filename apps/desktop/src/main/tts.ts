/**
 * 语音合成（TTS 朗读，docs/06 §13）。
 *
 * 主进程用**解密后**的凭据调 TTS 服务合成音频，把音频以 base64 回传渲染层；
 * 渲染层永远看不到明文密钥。按 `provider.type` 分流三套请求协议：
 * - `openai-compat`：`POST <baseUrl>/audio/speech`（docs/06 §13.2），响应体即音频字节；
 * - `dashscope`：DashScope 原生非实时合成（docs/06 §13.6），先 POST 拿 `output.audio.url`，
 *   再 GET 下载音频字节；
 * - `dashscope-audio`：Qwen-Audio-TTS 非实时 HTTP（docs/06 §13.7），端点不同、
 *   响应形状与 dashscope 相同，共用同一条「取 URL → 二次下载」尾段。
 *
 * v43 起：入口先 `cleanTtsText` 清洗（§13.4，幂等，渲染层分块前已洗过一次）；
 * `synthesize` 成功结果进内存 LRU 缓存（§13.8），重读同一条即时出声。
 *
 * 本文件**不得 import electron**：它必须能被 vitest 直接加载（见 vitest.config.ts 的 include）。
 */
import { cleanTtsText, TTS_LANGUAGES } from '@aurora/shared'
import type {
  Logger,
  TtsFormat,
  TtsListModelsResult,
  TtsProviderType,
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
  /** 页面草稿的接口类型；缺省回落已保存配置，再缺省按 openai-compat（docs/06 §13.6） */
  type?: TtsProviderType
  /** 页面草稿的语气指令（v43）；缺省回落已保存配置，空串 = 不发送 */
  instructions?: string
  /** 页面草稿的合成语言短码（v43）；缺省回落已保存配置，auto = 不发送 */
  language?: string
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
  /** 页面草稿的接口类型；缺省回落已保存配置，再缺省按 openai-compat（docs/06 §13.6） */
  type?: TtsProviderType
}

/** 设置页「试听 / 连接测试」的缺省样例句。 */
const DEFAULT_TEST_TEXT = '你好，我是 Aurora。'
/** 合成超时（真实 TTS 服务首字节较慢，30s 是留足余量的经验值）。 */
const DEFAULT_TIMEOUT_MS = 30_000
/** 试听超时（设置页不该让用户等太久）。 */
const TEST_TIMEOUT_MS = 15_000
/** dashscope 原生 /models 的每页条数（qianwenai 实测接受 100）。 */
const DASHSCOPE_MODEL_PAGE_SIZE = 100
/** dashscope 原生 /models 的翻页上限（6 页 × 100 条，足够盖住 qianwenai 实测 518 个模型）。 */
const DASHSCOPE_MODEL_MAX_PAGES = 6
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

/** 解析后的 provider 字段 + 明文凭据（凭据只在主进程即将发请求的那一刻解密存在）。 */
interface ResolvedProvider {
  provider: {
    id: string
    type: TtsProviderType
    baseUrl: string
    model: string
    voice: string
    speed: number
    format: TtsFormat
    /** 语气指令（v43）：空串 = 不发送 */
    instructions: string
    /** 合成语言短码（v43）：auto = 不发送 */
    language: string
  }
  apiKey: string
}

/** 一次合成主干的结果：成功带音频与 MIME，失败折成中文 message（HTTP 失败另带状态码）。 */
type SynthesisOutcome =
  | { ok: true; buffer: Buffer; mimeType: string; httpStatus: number }
  | { ok: false; message: string; httpStatus?: number }

/** 404 时按接口类型给的自查提示（各类型的 404 根因不同，docs/06 §13.2 / §13.6 / §13.7）。 */
const NOT_FOUND_HINTS: Record<TtsProviderType, string> = {
  'openai-compat': '请检查 baseURL 是否以 /v1 结尾、模型名是否正确；部分网关不支持 OpenAI 兼容端点',
  dashscope:
    '请检查 baseURL 主机名与网络可达性；模型已下架（响应含 Model not exist）时换用 qwen3-tts-flash',
  'dashscope-audio':
    '请检查 baseURL 主机名与网络可达性；模型已下架（响应含 Model not exist）时换用 qwen-audio-3.1-tts-flash',
}

/**
 * 合成语言短码 → DashScope `language_type` 全称（docs/06 §13.1，v43）。
 * `auto` 不在表内 = 整个字段不发送（服务端 Auto，v43 之前的行为）。
 * `dashscope-audio` 不走这张表：它直接下发 `language_hints: [短码]`。
 */
const DASHSCOPE_LANGUAGE_TYPE: Record<string, string> = {
  zh: 'Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  ru: 'Russian',
}

/**
 * 模型级失效自动回退的备用模型（docs/06 §13.6 / §13.7）：按协议类型各取一个
 * 当前可用的模型。openai-compat 不在表内 = 不回退（各网关模型空间不同，静默换模型没有依据）。
 *
 * dashscope 取 `qwen3-tts-flash`（2026-11 实测）：网关与官方 DashScope 都只对
 * `qwen3-tts-flash` 开放 multimodal-generation HTTP 端点——旧 `qwen-tts` /
 * `qwen-tts-latest` / `qwen3-tts-plus` 已下架（`Model not exist`）。
 * dashscope-audio 取 `qwen-audio-3.1-tts-flash`：Qwen-Audio-TTS 系列的低延迟档，
 * 走 SpeechSynthesizer HTTP 端点（该系列自 2026 起提供非实时 HTTP，不再是 WebSocket 专用）。
 */
const FALLBACK_BY_TYPE: Partial<Record<TtsProviderType, string>> = {
  dashscope: 'qwen3-tts-flash',
  'dashscope-audio': 'qwen-audio-3.1-tts-flash',
}

/** 合成缓存上限（docs/06 §13.8）：条数与总字节双闸，超限按最近访问逐出。 */
const CACHE_MAX_ENTRIES = 16
const CACHE_MAX_BYTES = 32 * 1024 * 1024

/** 缓存条目：合成结果 + 逐出用的体量与最近访问时间。 */
interface CacheEntry {
  result: TtsSynthesizeResult
  bytes: number
  lastAccess: number
}

export class TtsSynthesizer {
  private readonly settings: SettingsStoreLike
  private readonly logger: Logger
  private readonly timeoutMs: number
  private readonly resolveFetch: (() => typeof fetch | undefined) | undefined
  /**
   * 合成结果 LRU 缓存（docs/06 §13.8，v43）：key 含全部解析后参数 + 清洗后文本，
   * 改任何合成参数自然 miss，无需监听配置变化。只缓存成功、不落盘。
   */
  private readonly cache = new Map<string, CacheEntry>()
  private cacheBytes = 0

  constructor(options: TtsSynthesizerOptions) {
    this.settings = options.settings
    this.logger = options.logger
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.resolveFetch = options.resolveFetch
  }

  /**
   * 合成语音。失败一律**抛出**（IPC 层折成 `Result.error`），
   * 因为渲染层需要区分「没配置」与「合成失败」。
   *
   * v43：入口先清洗（幂等，渲染层分块前已洗过一次；Center 中转的全量文本在这里洗），
   * 成功结果进 LRU 缓存 —— 重读同一条消息即时出声。
   */
  async synthesize(request: TtsSynthesizeRequest): Promise<TtsSynthesizeResult> {
    const resolved = this.resolve(request)
    const { provider } = resolved

    const text = cleanTtsText(request.text)
    if (text === '') throw new Error('没有可朗读的文本')

    const maxChars = this.settings.get().tts.maxChars
    const truncated = text.length > maxChars
    const input = truncated ? text.slice(0, maxChars) : text

    const startedAt = Date.now()
    const cacheKey = synthesisCacheKey(resolved, input)
    const cached = this.cache.get(cacheKey)
    if (cached !== undefined) {
      cached.lastAccess = Date.now()
      this.logger.info('TTS 合成成功', {
        provider: provider.id,
        bytes: cached.bytes,
        chars: input.length,
        latencyMs: Date.now() - startedAt,
        cacheHit: true,
      })
      return { ...cached.result, latencyMs: Date.now() - startedAt }
    }

    const outcome = await this.runSynthesis(resolved, input, this.timeoutMs, '合成')
    if (!outcome.ok) throw new Error(outcome.message)

    const latencyMs = Date.now() - startedAt
    this.logger.info('TTS 合成成功', {
      provider: provider.id,
      bytes: outcome.buffer.byteLength,
      chars: input.length,
      latencyMs,
      cacheHit: false,
    })

    const result: TtsSynthesizeResult = {
      audioBase64: outcome.buffer.toString('base64'),
      mimeType: outcome.mimeType,
      bytes: outcome.buffer.byteLength,
      latencyMs,
      chars: input.length,
      truncated,
    }
    this.cacheStore(cacheKey, result)
    return result
  }

  /**
   * 连接测试 / 试听。与 `synthesize` 同一套解析逻辑，但**不抛**：
   * 把错误折成 `{ ok: false, latencyMs, message }` 供设置页直接展示。
   */
  async test(request: TtsTestRequest): Promise<TtsTestResult> {
    const startedAt = Date.now()
    try {
      const resolved = this.resolve(request)
      const text = cleanTtsText(request.text ?? DEFAULT_TEST_TEXT)
      if (text === '') return { ok: false, latencyMs: 0, message: '没有可朗读的文本' }

      const maxChars = this.settings.get().tts.maxChars
      const input = text.length > maxChars ? text.slice(0, maxChars) : text

      const outcome = await this.runSynthesis(resolved, input, TEST_TIMEOUT_MS, '连接测试')
      const latencyMs = Date.now() - startedAt
      if (!outcome.ok) {
        return { ok: false, latencyMs, message: outcome.message, httpStatus: outcome.httpStatus }
      }

      this.logger.info('TTS 连接测试成功', {
        provider: resolved.provider.id,
        bytes: outcome.buffer.byteLength,
        latencyMs,
      })
      return {
        ok: true,
        latencyMs,
        message: `合成成功（${outcome.buffer.byteLength} 字节）`,
        bytes: outcome.buffer.byteLength,
        httpStatus: outcome.httpStatus,
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
   * 拉取模型列表（设置页「获取模型列表」，`GET {baseUrl}/models`，docs/06 §13.2 / §13.6）。
   * 与 `test` 同款「不抛」口径：配置缺失、网络错误、HTTP 失败、响应畸形
   * 一律折成 `{ ok: false, models: [], message }` 供设置页直接 toast。
   * dashscope 的原生 /models 是**分页**的（`output.total`，qianwenai 实测 500+ 模型且
   * TTS 系列排在后段），按 `page_no` / `page_size` 翻页拉全（页数封顶防失控）。
   */
  async listModels(request: TtsListModelsRequest): Promise<TtsListModelsResult> {
    try {
      const resolved = this.resolveListInputs(request)
      const endpoint = modelsEndpoint(resolved.baseUrl, resolved.type)
      const pages = resolved.type === 'openai-compat' ? 1 : DASHSCOPE_MODEL_MAX_PAGES
      const seen = new Set<string>()
      const collected: string[] = []
      let expectedTotal = Number.POSITIVE_INFINITY

      for (let page = 1; page <= pages; page += 1) {
        const url =
          resolved.type === 'openai-compat'
            ? endpoint
            : `${endpoint}?page_no=${page}&page_size=${DASHSCOPE_MODEL_PAGE_SIZE}`
        const response = await this.getUrl(
          url,
          { Authorization: `Bearer ${resolved.apiKey}` },
          TEST_TIMEOUT_MS,
          '获取模型列表',
        )

        if (!response.ok) {
          const detail = await this.readErrorDetail(response)
          this.logger.warn('TTS 拉取模型列表失败', {
            provider: resolved.providerId,
            status: response.status,
          })
          return {
            ok: false,
            models: [],
            message: describeHttpFailure(response.status, detail, url, resolved.type),
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
        const before = collected.length
        for (const id of parsed.models) {
          if (!seen.has(id)) {
            seen.add(id)
            collected.push(id)
          }
        }
        const total = dashscopeModelsTotal(body)
        if (total !== null) expectedTotal = total
        // 拿满 total / 本页没有新 id（空页，或网关不吃翻页参数原样回放）/ 响应没有
        // output.total（非分页形状，无从知道还有没有下一页）即停；
        // openai-compat 单页请求天然只转一圈
        if (total === null || collected.length === before || collected.length >= expectedTotal) {
          break
        }
      }

      this.logger.info('TTS 拉取模型列表成功', {
        provider: resolved.providerId,
        count: collected.length,
      })
      return { ok: true, models: collected }
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
  private resolve(request: TtsTestRequest): ResolvedProvider {
    const settings = this.settings.get()
    const providerId = request.providerId ?? settings.tts.active
    if (providerId === '') throw new Error('尚未配置 TTS 模型')

    const saved = settings.tts.providers[providerId]
    const draftFieldsPresent =
      request.baseUrl !== undefined ||
      request.model !== undefined ||
      request.voice !== undefined ||
      request.speed !== undefined ||
      request.format !== undefined ||
      request.type !== undefined
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
    // 接口类型：草稿优先 → 已保存配置 → openai-compat（历史配置天然回落，无需迁移）
    const type: TtsProviderType = request.type ?? saved?.type ?? 'openai-compat'
    // 语气指令 / 合成语言（v43）：同款「草稿优先 → 已保存 → 默认」；
    // 未知语言短码按 auto 处理（不发送），不让手改配置的笔误变成请求参数
    const instructions = (request.instructions ?? saved?.instructions ?? '').trim()
    const rawLanguage = (request.language ?? saved?.language ?? 'auto').trim()
    const language = (TTS_LANGUAGES as readonly string[]).includes(rawLanguage) ? rawLanguage : 'auto'

    const apiKey =
      request.apiKey !== undefined && request.apiKey !== ''
        ? request.apiKey
        : saved === undefined
          ? ''
          : this.settings.getSecret(`tts.providers.${providerId}.apiKey`)

    if (apiKey === '') throw new Error('缺少 API Key：请填写密钥')

    return {
      provider: { id: providerId, type, baseUrl, model, voice, speed, format, instructions, language },
      apiKey,
    }
  }

  /**
   * `listModels` 专用的轻量解析：与 `resolve` 同一套「草稿优先 → 回落已保存配置」思路，
   * 但只要 baseUrl + apiKey，不要求 model / voice。
   */
  private resolveListInputs(request: TtsListModelsRequest): {
    providerId: string
    type: TtsProviderType
    baseUrl: string
    apiKey: string
  } {
    const settings = this.settings.get()
    const providerId = request.providerId ?? settings.tts.active
    if (providerId === '') throw new Error('尚未配置 TTS 模型')

    const saved = settings.tts.providers[providerId]
    if (saved === undefined && request.baseUrl === undefined && request.type === undefined) {
      throw new Error(`TTS 模型「${providerId}」不存在`)
    }

    const baseUrl = (request.baseUrl ?? saved?.baseUrl ?? '').trim()
    if (baseUrl === '') throw new Error('请先填写 baseURL')

    const type: TtsProviderType = request.type ?? saved?.type ?? 'openai-compat'

    const apiKey =
      request.apiKey !== undefined && request.apiKey !== ''
        ? request.apiKey
        : saved === undefined
          ? ''
          : this.settings.getSecret(`tts.providers.${providerId}.apiKey`)

    if (apiKey === '') throw new Error('缺少 API Key：请填写密钥')

    return { providerId, type, baseUrl, apiKey }
  }

  /**
   * 合成主干（`synthesize` / `test` 共用，docs/06 §13.2 / §13.6 / §13.7）：按
   * `provider.type` 分流请求协议。HTTP 失败与 DashScope 系的解析 / 下载失败一律折成
   * `{ ok: false, message }`（不抛 —— 抛不抛由调用方决定）；超时 / 网络异常仍由
   * `post` / `getUrl` 抛出。`scene` 只用于日志文案（「合成」/「连接测试」）。
   */
  private async runSynthesis(
    resolved: ResolvedProvider,
    input: string,
    timeoutMs: number,
    scene: '合成' | '连接测试',
  ): Promise<SynthesisOutcome> {
    const { provider } = resolved
    if (provider.type === 'dashscope' || provider.type === 'dashscope-audio') {
      return this.runDashscopeFamilySynthesis(resolved, input, timeoutMs, scene)
    }

    // openai-compat：成功响应体就是音频二进制（docs/06 §13.2）
    const endpoint = speechEndpoint(provider.baseUrl)
    const response = await this.post(
      resolved,
      endpoint,
      openaiSpeechBody(provider, input),
      timeoutMs,
    )
    if (!response.ok) {
      const detail = await this.readErrorDetail(response)
      this.logger.warn(`TTS ${scene}失败`, { provider: provider.id, status: response.status })
      return {
        ok: false,
        message: describeHttpFailure(response.status, detail, endpoint),
        httpStatus: response.status,
      }
    }
    const buffer = Buffer.from(new Uint8Array(await response.arrayBuffer()))
    return {
      ok: true,
      buffer,
      mimeType: MIME_BY_FORMAT[provider.format],
      httpStatus: response.status,
    }
  }

  /**
   * DashScope 系合成主干（`dashscope` 与 `dashscope-audio` 共用，docs/06 §13.6 / §13.7）：
   * 两类型只有**端点与请求体**不同，「模型级失效回退」与「2xx 取 URL + 二次下载」完全同构。
   * 先按配置模型发一次 POST；遇**模型级失效**（404 `Model not exist` = 模型已下架 /
   * 400 `url error` = 模型不在 HTTP 端点族）时自动改用该类型的备用模型重试一次——
   * 只换模型，音色等其它配置不动；重试成功把设置里的模型字段一并写回（设置页可见），
   * 重试也失败则把两段原因都报出来。
   */
  private async runDashscopeFamilySynthesis(
    resolved: ResolvedProvider,
    input: string,
    timeoutMs: number,
    scene: '合成' | '连接测试',
  ): Promise<SynthesisOutcome> {
    const { provider } = resolved
    const isAudio = provider.type === 'dashscope-audio'
    const endpoint = isAudio
      ? dashscopeAudioEndpoint(provider.baseUrl)
      : dashscopeEndpoint(provider.baseUrl)
    const bodyFor = (model: string): string =>
      isAudio
        ? dashscopeAudioSpeechBody({ ...provider, model }, input)
        : dashscopeSpeechBody({ ...provider, model }, input)
    const fallbackModel = FALLBACK_BY_TYPE[provider.type]
    const postOnce = (model: string): Promise<Response> =>
      this.post(
        { ...resolved, provider: { ...provider, model } },
        endpoint,
        bodyFor(model),
        timeoutMs,
      )

    let response = await postOnce(provider.model)
    if (!response.ok) {
      const detail = await this.readErrorDetail(response)
      if (
        isDashscopeModelLevelFailure(response.status, detail) &&
        fallbackModel !== undefined &&
        provider.model !== fallbackModel
      ) {
        this.logger.warn(`TTS ${scene}：配置的模型不可用，改用备用模型重试`, {
          provider: provider.id,
          model: provider.model,
          fallback: fallbackModel,
          status: response.status,
        })
        const retry = await postOnce(fallbackModel)
        if (retry.ok) {
          this.persistFallbackModel(provider.id, provider.model, fallbackModel)
          response = retry
        } else {
          const retryDetail = await this.readErrorDetail(retry)
          this.logger.warn(`TTS ${scene}失败`, {
            provider: provider.id,
            status: retry.status,
            fallbackUsed: true,
          })
          return {
            ok: false,
            message:
              `配置的模型「${provider.model}」不可用（HTTP ${response.status}：${detail.trim()}），` +
              `备用模型 ${fallbackModel} 也失败：` +
              describeHttpFailure(retry.status, retryDetail, endpoint, provider.type),
            httpStatus: retry.status,
          }
        }
      } else {
        this.logger.warn(`TTS ${scene}失败`, { provider: provider.id, status: response.status })
        return {
          ok: false,
          message: describeHttpFailure(response.status, detail, endpoint, provider.type),
          httpStatus: response.status,
        }
      }
    }

    return this.downloadDashscopeAudio(response, resolved, timeoutMs, scene)
  }

  /**
   * DashScope 系共用的响应尾段（docs/06 §13.6 / §13.7）：2xx 响应体是 JSON，
   * 音频在 `output.audio.url`（24h 有效的签名地址），需要二次 GET 下载。
   */
  private async downloadDashscopeAudio(
    response: Response,
    resolved: ResolvedProvider,
    timeoutMs: number,
    scene: '合成' | '连接测试',
  ): Promise<SynthesisOutcome> {
    const { provider } = resolved
    const raw = await response.text()
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      return {
        ok: false,
        message: `合成响应不是合法 JSON（无法取出音频地址）：${sanitizeSignedQuery(tailOf(raw))}`,
      }
    }
    const audioUrl = extractDashscopeAudioUrl(body)
    if (audioUrl === null) {
      return {
        ok: false,
        message: `合成响应缺少音频地址（output.audio.url）：${sanitizeSignedQuery(tailOf(raw))}`,
      }
    }

    // 二次下载：OSS 签名 URL 带鉴权头可能被拒，**不带 Authorization**；独立一份超时预算。
    // 签名参数不进日志与错误文案 —— 失败只报 host。
    const download = await this.getUrl(audioUrl, {}, timeoutMs, '音频下载')
    if (!download.ok) {
      const host = new URL(audioUrl).host
      this.logger.warn(`TTS ${scene}失败`, {
        provider: provider.id,
        status: download.status,
        host,
      })
      return { ok: false, message: `音频下载失败（HTTP ${download.status}）：${host}` }
    }
    const buffer = Buffer.from(new Uint8Array(await download.arrayBuffer()))
    return {
      ok: true,
      buffer,
      mimeType: pickAudioMime(download.headers.get('content-type'), audioUrl, provider.format),
      httpStatus: response.status,
    }
  }

  /**
   * 备用模型重试成功后把该 provider 的 `model` 字段写回设置（docs/06 §13.6 / §13.7）：
   * 设置页能看到实际生效的模型，下次合成不再多付一次失效请求。
   * 写回目标不存在（草稿 providerId）时 mutate 自然 no-op；失败只记日志不阻断本次合成。
   */
  private persistFallbackModel(providerId: string, from: string, to: string): void {
    try {
      this.settings.mutate((draft) => {
        const provider = draft.tts.providers[providerId]
        if (provider !== undefined && provider.model === from) provider.model = to
      })
      this.logger.info('TTS 模型已失效，设置已改用备用模型', { provider: providerId, from, to })
    } catch (error) {
      this.logger.warn('TTS 备用模型写回设置失败（不影响本次合成）', {
        provider: providerId,
        error: String(error),
      })
    }
  }

  // ───────────────────────── 合成缓存（docs/06 §13.8） ─────────────────────────

  /** 存一条成功结果；超条数 / 超字节按最近访问逐出（Map 迭代序 = 插入序，逐出最旧访问）。 */
  private cacheStore(key: string, result: TtsSynthesizeResult): void {
    // 单条超过总预算的不进缓存（避免一条就把缓存清空）
    if (result.bytes > CACHE_MAX_BYTES) return
    const existing = this.cache.get(key)
    if (existing !== undefined) {
      this.cacheBytes -= existing.bytes
      this.cache.delete(key)
    }
    this.cache.set(key, { result, bytes: result.bytes, lastAccess: Date.now() })
    this.cacheBytes += result.bytes
    while (this.cache.size > CACHE_MAX_ENTRIES || this.cacheBytes > CACHE_MAX_BYTES) {
      let oldestKey: string | null = null
      let oldestAccess = Number.POSITIVE_INFINITY
      for (const [candidateKey, entry] of this.cache) {
        if (entry.lastAccess < oldestAccess) {
          oldestAccess = entry.lastAccess
          oldestKey = candidateKey
        }
      }
      if (oldestKey === null) break
      const evicted = this.cache.get(oldestKey)
      this.cache.delete(oldestKey)
      if (evicted !== undefined) this.cacheBytes -= evicted.bytes
    }
  }

  /**
   * 发一次 `POST <endpoint>`；body 由调用方按协议构造（§13.2 / §13.6），
   * 超时统一折成固定中文文案。
   */
  private async post(
    resolved: ResolvedProvider,
    endpoint: string,
    body: string,
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
        body,
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

  /**
   * 发一次 `GET <url>`；超时 / 网络异常折成 `<label>超时（<n>s）` / `<label>请求失败：…` 的中文文案。
   * headers 由调用方给：模型列表带鉴权头，dashscope 的音频下载**不带**（签名 URL 见 §13.6）。
   */
  private async getUrl(
    url: string,
    headers: Record<string, string>,
    timeoutMs: number,
    label: string,
  ): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const seconds = Math.round(timeoutMs / 1000)

    try {
      const fetchImpl = this.netFetch()
      return await fetchImpl(url, { method: 'GET', headers, signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`${label}超时（${seconds}s）`)
      throw new Error(`${label}请求失败：${error instanceof Error ? error.message : String(error)}`)
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

/** 去尾斜杠 → 剥误填的已知端点尾巴（长尾在前）。openai-compat 与 dashscope 的 baseUrl 规整共用这一步。 */
function stripKnownEndpointTails(baseUrl: string): string {
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
  return trimmed
}

/**
 * baseUrl 规整（docs/06 §13.2）：去尾斜杠 → 剥误填的已知端点尾巴 → 域名根自动补 `/v1`。
 * 带路径（`/api/v1`、`/compatible-mode/v1` 等）尊重不动；URL 非法则原样返回，
 * 把错误交给服务端报出来（不在这里抛）。
 */
function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = stripKnownEndpointTails(baseUrl)
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

/**
 * DashScope 原生非实时合成端点的完整路径（**含 `/api/v1` 前缀**，与 stt.ts 的
 * `DASHSCOPE_ASR_PATH` 同一形状——原生路由只挂在服务根的 `/api/v1` 下）。
 */
const DASHSCOPE_GENERATION_PATH = '/api/v1/services/aigc/multimodal-generation/generation'
/** 生成端点不含 `/api/v1` 的尾巴（识别「已经拼好端点」的 baseUrl 用）。 */
const DASHSCOPE_GENERATION_TAIL = '/services/aigc/multimodal-generation/generation'

/**
 * `<baseUrl>` → DashScope 原生合成端点（docs/06 §13.6）。
 *
 * 与 stt.ts 的 `dashscopeAsrEndpoint` 同一套容错：baseUrl 的**规范填法是服务根**
 * （如 `https://dashscope.aliyuncs.com`），但这些都容忍：
 * ① 已以生成端点结尾（含或不含 `/api/v1` 前缀）→ 原样用；② 尾上粘着 `/compatible-mode/v1` /
 * `/compatible-mode` / `/api/v1` / `/api`（从 LLM / 生图那几栏照抄的习惯粘法，长短两截都见过）
 * → **整段换成完整原生路径**——原生路由不在 compatible-mode 下，挂错了就是 404
 * （2026-10-31 线上 404 的直接根因）；
 * ③ 其余 → 直接拼完整路径：裸域名自然得到 `<根>/api/v1/...`，Center 网关 base
 * （`…/api/model-gateway/tts`）得到 `…/tts/api/v1/services/...`，与 Center `routeKind`
 * 接受的 rest 形状一致（dashscope 型 Center TTS 因此可用）。
 * URL 非法按原样拼接，错误交给服务端报（不在这里抛）。
 */
function dashscopeEndpoint(baseUrl: string): string {
  let trimmed = baseUrl.replace(/\/+$/, '')
  if (trimmed.endsWith(DASHSCOPE_GENERATION_TAIL)) return trimmed
  // 尾上粘着 Qwen-Audio-TTS 端点（只改类型不改地址）：先剥掉再按常规规整
  if (trimmed.endsWith(DASHSCOPE_AUDIO_TTS_TAIL)) {
    trimmed = trimmed.slice(0, trimmed.length - DASHSCOPE_AUDIO_TTS_TAIL.length).replace(/\/+$/, '')
  }
  for (const suffix of ['/compatible-mode/v1', '/compatible-mode', '/api/v1', '/api']) {
    if (trimmed.endsWith(suffix)) {
      return `${trimmed.slice(0, trimmed.length - suffix.length)}${DASHSCOPE_GENERATION_PATH}`
    }
  }
  return `${trimmed}${DASHSCOPE_GENERATION_PATH}`
}

/**
 * Qwen-Audio-TTS 非实时合成端点的完整路径（docs/06 §13.7，含 `/api/v1` 前缀）。
 * 与 multimodal-generation 是**两个不同的端点族**：qwen-audio-3.x-tts 系列只认这个。
 */
const DASHSCOPE_AUDIO_TTS_PATH = '/api/v1/services/audio/tts/SpeechSynthesizer'
/** 合成端点不含 `/api/v1` 的尾巴（识别「已经拼好端点」的 baseUrl 用）。 */
const DASHSCOPE_AUDIO_TTS_TAIL = '/services/audio/tts/SpeechSynthesizer'

/**
 * `<baseUrl>` → Qwen-Audio-TTS 合成端点（docs/06 §13.7）。容错与 `dashscopeEndpoint()`
 * 同一套：已以新端点结尾原样用；粘着 multimodal-generation 尾巴（只改类型不改地址）
 * 先剥掉再规整；`/compatible-mode/v1` / `/compatible-mode` / `/api/v1` / `/api` 尾巴
 * 整段换成完整路径；其余直接拼（Center 网关 base 得到 `…/tts/api/v1/services/audio/tts/SpeechSynthesizer`）。
 */
function dashscopeAudioEndpoint(baseUrl: string): string {
  let trimmed = baseUrl.replace(/\/+$/, '')
  if (trimmed.endsWith(DASHSCOPE_AUDIO_TTS_TAIL)) return trimmed
  if (trimmed.endsWith(DASHSCOPE_GENERATION_TAIL)) {
    trimmed = trimmed.slice(0, trimmed.length - DASHSCOPE_GENERATION_TAIL.length).replace(/\/+$/, '')
  }
  for (const suffix of ['/compatible-mode/v1', '/compatible-mode', '/api/v1', '/api']) {
    if (trimmed.endsWith(suffix)) {
      return `${trimmed.slice(0, trimmed.length - suffix.length)}${DASHSCOPE_AUDIO_TTS_PATH}`
    }
  }
  return `${trimmed}${DASHSCOPE_AUDIO_TTS_PATH}`
}

/**
 * DashScope 原生根地址规整（`modelsEndpoint` 用；合成端点已改走 `dashscopeEndpoint`
 * 的整段替换算法，不走这里）：先走与 `normalizeBaseUrl` 同一套剥尾 / 去尾斜杠，再：
 * - `pathname` 为空或 `/`（只填域名根）→ 自动补 `/api/v1`；
 * - 尾上粘着 `/compatible-mode/v1` / `/compatible-mode` 或 `/api` → 整段换成 `/api/v1`
 *   （原生路由不挂在 compatible-mode 下，`/api` 少写 `/v1` 也是该类网关的高频 404 来源）；
 * - 其余路径（`/api/v1` 等）尊重不动；URL 非法按原样返回，错误交给服务端报（不在这里抛）。
 */
function normalizeDashscopeBaseUrl(baseUrl: string): string {
  const trimmed = stripKnownEndpointTails(baseUrl)
  try {
    const url = new URL(trimmed)
    if (url.pathname === '' || url.pathname === '/') return `${trimmed}/api/v1`
    for (const suffix of ['/compatible-mode/v1', '/compatible-mode', '/api']) {
      if (url.pathname.endsWith(suffix)) {
        return `${trimmed.slice(0, trimmed.length - suffix.length)}/api/v1`
      }
    }
  } catch {
    return trimmed
  }
  return trimmed
}

/** `<baseUrl>` 规整后拼 `/models`；DashScope 系用原生根规整（docs/06 §13.6 / §13.7）。已以它结尾时不重复拼（也不补 /v1）。 */
function modelsEndpoint(baseUrl: string, type: TtsProviderType): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (trimmed.endsWith('/models')) return trimmed
  const normalized =
    type === 'openai-compat' ? normalizeBaseUrl(trimmed) : normalizeDashscopeBaseUrl(trimmed)
  return `${normalized}/models`
}

/**
 * openai-compat 合成请求体（docs/06 §13.2）：文本 / 音色 / 语速 / 格式都平铺在顶层。
 * `instructions`（v43）仅非空时携带 —— gpt-4o-mini-tts 支持；tts-1 不支持，
 * 填了会被服务端拒绝（错误按 §13.5 降级提示，不静默剥离）。该协议没有语言参数。
 */
function openaiSpeechBody(provider: ResolvedProvider['provider'], input: string): string {
  const body: {
    model: string
    input: string
    voice: string
    speed: number
    response_format: TtsFormat
    instructions?: string
  } = {
    model: provider.model,
    input,
    voice: provider.voice,
    speed: provider.speed,
    response_format: provider.format,
  }
  if (provider.instructions !== '') body.instructions = provider.instructions
  return JSON.stringify(body)
}

/**
 * dashscope 合成请求体（docs/06 §13.6）：文本与音色包在 `input` 里；
 * `audio.format` 仅在格式是 DashScope 实际支持的 wav / mp3 / opus 时携带（aac / flac / pcm
 * 按服务端默认下发，不发 audio 字段）；该协议没有 speed 参数，**永不发送**。
 * `input.language_type`（v43）仅 language 非 auto 且能映射成全称时携带；
 * `input.instructions`（v43）仅非空携带（百炼 qwen3-tts-instruct-flash 支持）。
 */
function dashscopeSpeechBody(provider: ResolvedProvider['provider'], input: string): string {
  const body: {
    model: string
    input: { text: string; voice: string; language_type?: string; instructions?: string }
    audio?: { format: 'wav' | 'mp3' | 'opus' }
  } = {
    model: provider.model,
    input: { text: input, voice: provider.voice },
  }
  const languageType = DASHSCOPE_LANGUAGE_TYPE[provider.language]
  if (languageType !== undefined) body.input.language_type = languageType
  if (provider.instructions !== '') body.input.instructions = provider.instructions
  if (provider.format === 'wav' || provider.format === 'mp3' || provider.format === 'opus') {
    body.audio = { format: provider.format }
  }
  return JSON.stringify(body)
}

/**
 * dashscope-audio 合成请求体（docs/06 §13.7，Qwen-Audio-TTS）：与 dashscope 的差异 ——
 * 格式在 `input.format`（mp3 / wav / opus / pcm 四者条件携带，aac / flac 按服务端默认）；
 * 语速走 `input.rate`（协议限 0.5–2.0，夹取后仅 ≠1 携带）；语气指令字段名是
 * **`instruction`（单数）**；语言走 `input.language_hints: [短码]`（auto 不发）。
 */
function dashscopeAudioSpeechBody(provider: ResolvedProvider['provider'], input: string): string {
  const body: {
    model: string
    input: {
      text: string
      voice: string
      format?: 'mp3' | 'wav' | 'opus' | 'pcm'
      rate?: number
      instruction?: string
      language_hints?: string[]
    }
  } = {
    model: provider.model,
    input: { text: input, voice: provider.voice },
  }
  if (
    provider.format === 'mp3' ||
    provider.format === 'wav' ||
    provider.format === 'opus' ||
    provider.format === 'pcm'
  ) {
    body.input.format = provider.format
  }
  const rate = Math.min(2, Math.max(0.5, provider.speed))
  if (rate !== 1) body.input.rate = rate
  if (provider.instructions !== '') body.input.instruction = provider.instructions
  if (provider.language !== 'auto') body.input.language_hints = [provider.language]
  return JSON.stringify(body)
}

/**
 * 合成缓存 key（docs/06 §13.8）：全部解析后参数 + 清洗后文本。
 * 含 providerId 只为日志可读；参数全在 key 里，改配置自然 miss。
 */
function synthesisCacheKey(resolved: ResolvedProvider, input: string): string {
  const { provider } = resolved
  return JSON.stringify([
    provider.id,
    provider.type,
    provider.baseUrl,
    provider.model,
    provider.voice,
    provider.speed,
    provider.format,
    provider.instructions,
    provider.language,
    input,
  ])
}

/** 错误文案里附的响应体尾巴（尾部 300 字符，够定位又不刷屏）。 */
function tailOf(text: string): string {
  return text.slice(-ERROR_BODY_LIMIT).trim()
}

/**
 * 抹掉文本里签名 URL 的鉴权参数值（Signature / OSSAccessKeyId / Expires 等）。
 * `output.audio.url` 本身含签名 —— 它一旦随响应体尾巴进错误文案，必须先脱敏
 * （docs/06 §13.6：签名参数不进日志与错误文案）。
 */
function sanitizeSignedQuery(text: string): string {
  return text.replace(
    /([?&](?:Signature|OSSAccessKeyId|Expires|SecurityToken|X-Amz-[A-Za-z-]+))=[^&"\\]*/g,
    '$1=<redacted>',
  )
}

/**
 * 从 DashScope 合成响应取音频地址：`output.audio.url` 必须是 http(s) 字符串（24h 有效的签名地址）；
 * 缺失 / 非法（含非 http(s) 协议）返回 null，由调用方折成中文错误（附响应体尾巴便于自查）。
 */
function extractDashscopeAudioUrl(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const output = (body as { output?: unknown }).output
  if (typeof output !== 'object' || output === null) return null
  const audio = (output as { audio?: unknown }).audio
  if (typeof audio !== 'object' || audio === null) return null
  const url = (audio as { url?: unknown }).url
  if (typeof url !== 'string' || url === '') return null
  try {
    const protocol = new URL(url).protocol
    if (protocol !== 'https:' && protocol !== 'http:') return null
  } catch {
    return null
  }
  return url
}

/** 从 URL 扩展名猜 MIME（认不出返回 null，交给上层回落 `provider.format`）。 */
function mimeFromUrlExtension(url: string): string | null {
  try {
    const match = /\.([a-z0-9]+)$/i.exec(new URL(url).pathname)
    if (match === null) return null
    const format = match[1]!.toLowerCase() as TtsFormat
    return MIME_BY_FORMAT[format] ?? null
  } catch {
    return null
  }
}

/**
 * dashscope 二次下载后的 MIME 推导（docs/06 §13.6）：
 * 优先下载响应的 `content-type`（`audio/*` 才采用，丢弃 charset 等参数），
 * 其次按 URL 扩展名，最后回落 `provider.format` 对应的 MIME。
 */
function pickAudioMime(contentType: string | null, url: string, fallback: TtsFormat): string {
  const header = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (header.startsWith('audio/')) return header
  const fromExtension = mimeFromUrlExtension(url)
  if (fromExtension !== null) return fromExtension
  return MIME_BY_FORMAT[fallback]
}

/**
 * dashscope 的「模型级失效」判定（docs/06 §13.6）：404 + `Model not exist`（模型已下架）
 * 或 400 + `url error`（模型不在 HTTP 端点族，如 WebSocket 实时专用模型）。
 * 只有这两类换当前可用模型重试才有意义；鉴权 / 限流 / 网络类失败重试也不会好。
 */
function isDashscopeModelLevelFailure(status: number, detail: string): boolean {
  return (
    (status === 404 && /model not exist/i.test(detail)) ||
    (status === 400 && /url error/i.test(detail))
  )
}

/** 按状态码给中文前缀，并把服务端返回的 body 尾巴拼上（便于用户自查）。404 提示按 provider type 取词。 */
function describeHttpFailure(
  status: number,
  detail: string,
  endpoint?: string,
  type: TtsProviderType = 'openai-compat',
): string {
  const prefix =
    status === 401 || status === 403
      ? 'API Key 无效或没有权限'
      : status === 404
        ? endpoint === undefined
          ? '接口或模型不存在（请检查 baseURL 与模型名）'
          : `接口不存在：实际请求了 ${endpoint}。${NOT_FOUND_HINTS[type]}`
        : status === 429
          ? '请求过于频繁，已被限流'
          : status >= 500
            ? 'TTS 服务端错误'
            : type !== 'openai-compat' && /url error/i.test(detail)
              ? // DashScope 式网关对「模型不在这个端点族」回 400 + url error：
                // qwen3-tts 走 multimodal-generation，qwen-audio-3.x-tts 走 SpeechSynthesizer，
                // 挂错端点族就是这个错（CosyVoice / Sambert 旧系列仍是 WebSocket 实时专用）
                '该模型不走当前 HTTP 合成端点：qwen3-tts 系列请用 DashScope 原生类型，qwen-audio-3.x-tts 系列请改用 Qwen-Audio-TTS 接口类型，或检查 baseURL'
              : '语音合成失败'
  const suffix = detail.trim() === '' ? '' : `：${detail.trim()}`
  return `${prefix}（HTTP ${status}）${suffix}`
}

/**
 * 防御性解析模型列表响应（docs/06 §13.2 / §13.6）：
 * - OpenAI 格式：`data[].id`（主路径，行为不变：只收对象里的 id 字符串，其余条目跳过）；
 * - DashScope 原生：`output.models[]`（qianwenai 实测条目形如 `{model, name, ...}`，
 *   `model` 是规范 id、`name` 是展示名）；
 * - 回落：顶层 `models` 数组，字符串元素与 `{model}` / `{id}` / `{name}` 对象都接受。
 * 畸形响应（非对象 / 三者皆缺）不抛，折成失败 + 中文提示。
 */
function parseModelList(
  body: unknown,
): { ok: true; models: string[] } | { ok: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: '模型列表响应不是 JSON 对象' }
  }
  const data = (body as { data?: unknown }).data
  if (Array.isArray(data)) {
    const models: string[] = []
    for (const item of data) {
      if (typeof item === 'object' && item !== null) {
        const id = (item as { id?: unknown }).id
        if (typeof id === 'string' && id !== '') models.push(id)
      }
    }
    return { ok: true, models }
  }
  const outputModels = (body as { output?: { models?: unknown } }).output?.models
  if (Array.isArray(outputModels)) return { ok: true, models: collectModelIds(outputModels) }
  const models = (body as { models?: unknown }).models
  if (Array.isArray(models)) return { ok: true, models: collectModelIds(models) }
  return { ok: false, message: '模型列表响应缺少 data / models 数组（非 OpenAI 兼容格式）' }
}

/** 从 models 数组收模型 id：字符串原样收；对象元素依次认 `model`（DashScope 规范 id）/ `id` / `name`。 */
function collectModelIds(items: unknown[]): string[] {
  const collected: string[] = []
  for (const item of items) {
    if (typeof item === 'string' && item !== '') {
      collected.push(item)
    } else if (typeof item === 'object' && item !== null) {
      const record = item as { model?: unknown; id?: unknown; name?: unknown }
      for (const key of ['model', 'id', 'name'] as const) {
        const value = record[key]
        if (typeof value === 'string' && value !== '') {
          collected.push(value)
          break
        }
      }
    }
  }
  return collected
}

/** DashScope 原生 /models 的 `output.total`（翻页停止条件用）；缺失或非法返回 null。 */
function dashscopeModelsTotal(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null
  const total = (body as { output?: { total?: unknown } }).output?.total
  return typeof total === 'number' && Number.isFinite(total) ? total : null
}
