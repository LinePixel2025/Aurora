/**
 * 客户端官方模型目录同步（docs/12 §12.2 / docs/08 §8）。
 *
 * Center 连接建立后拉取目录，把四类保留 Provider 的只读镜像写进普通 provider 表，
 * 供现有 Provider 解析链、会话覆盖与 Center Web 复用；真实上游凭据仍只存在 Center。
 */
import type {
  CenterOfficialCapability,
  CenterOfficialModelCatalog,
  CenterOfficialServiceCatalog,
  LlmProviderConfig,
  Logger,
  Settings,
} from '@aurora/shared'
import {
  CENTER_OFFICIAL_PROVIDER_IDS,
  resolveModelParams,
  type ImageGenProviderConfig,
  type SttProviderConfig,
  type TtsProviderConfig,
} from '@aurora/shared'
import { httpBaseUrlOf } from './client-login.js'
import {
  normalizeImageSize,
  normalizeTtsFormat,
  resolveOfficialModelEntry,
} from './official-selection.js'

export interface CenterCatalogCache {
  /** 上次成功同步的目录快照（按服务器地址隔离）；缺失 / 损坏返回 null。 */
  read(serverUrl: string): unknown
  write(serverUrl: string, catalog: CenterOfficialModelCatalog): void
}

export interface CenterModelServicesDeps {
  settings: {
    get(): Settings
    update(patch: Record<string, unknown>): Settings | undefined
  }
  logger: Logger
  fetchImpl: () => typeof fetch | undefined
  config: () => { enabled: boolean; serverUrl: string; token: string; clientId: string }
  /**
   * 目录落盘快照。目录原本只在内存里，首个请求（启动自动化 / 刚登录后的第一条消息）
   * 常常早于拉取完成，于是「目录还没到」被当成「官方模型不可用」并弹回落提示。
   */
  cache?: CenterCatalogCache
  onChanged?: (catalog: CenterOfficialModelCatalog | null) => void
}

export class CenterModelServices {
  private catalogValue: CenterOfficialModelCatalog | null = null
  private refreshPromise: Promise<CenterOfficialModelCatalog | null> | null = null
  private lastAttemptAt = 0

  constructor(private readonly deps: CenterModelServicesDeps) {
    const config = this.deps.config()
    if (config.enabled && config.serverUrl.trim() !== '' && config.token !== '') {
      const cached = this.deps.cache?.read(config.serverUrl)
      if (isCatalog(cached)) this.catalogValue = cached
    }
  }

  current(): CenterOfficialModelCatalog | null {
    return this.catalogValue === null ? null : structuredClone(this.catalogValue)
  }

  /** 目录是否已就绪（含本机缓存）。false = 尚未加载，**不等于**官方模型不可用。 */
  loaded(): boolean {
    return this.catalogValue !== null
  }

  async refresh(): Promise<CenterOfficialModelCatalog | null> {
    if (this.refreshPromise !== null) return this.refreshPromise
    this.refreshPromise = this.doRefresh().finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }

  /**
   * 目录缺失时的后台补拉（构造 provider 时调用）：与上次尝试间隔不足 `maxAgeMs` 就跳过，
   * 避免每个请求都打一次目录接口。
   */
  refreshIfStale(maxAgeMs = 30_000): void {
    if (this.refreshPromise !== null) return
    if (Date.now() - this.lastAttemptAt < maxAgeMs) return
    void this.refresh()
  }

  /** Provider 工厂 / 服务层判断某能力当前是否有可用官方目录。 */
  service(capability: CenterOfficialCapability): CenterOfficialServiceCatalog | undefined {
    const service = this.catalogValue?.services[capability]
    return service === undefined ? undefined : structuredClone(service)
  }

  private async doRefresh(): Promise<CenterOfficialModelCatalog | null> {
    this.lastAttemptAt = Date.now()
    const config = this.deps.config()
    if (!config.enabled || config.serverUrl.trim() === '' || config.token === '') {
      this.setCatalog(null)
      return null
    }
    const base = httpBaseUrlOf(config.serverUrl)
    if (base === undefined) {
      this.setCatalog(null)
      return null
    }
    const fetchImpl = this.deps.fetchImpl() ?? globalThis.fetch
    try {
      const response = await fetchImpl(
        `${base.replace(/\/+$/, '')}/api/client/model-services/catalog`,
        {
          headers: { Authorization: `Bearer ${config.token}` },
          signal: AbortSignal.timeout(15_000),
        },
      )
      // 凭据失效时旧目录不能再当作有效来源，否则「未登录 / 令牌过期」会表现成官方模型全挂。
      if (response.status === 401 || response.status === 403) this.setCatalog(null)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const catalog = (await response.json()) as CenterOfficialModelCatalog
      if (!isCatalog(catalog)) throw new Error('目录响应格式异常')
      this.setCatalog(catalog)
      this.deps.cache?.write(config.serverUrl, catalog)
      await this.syncProviders(catalog)
      return catalog
    } catch (error) {
      this.deps.logger.warn('刷新 Aurora Center 官方模型目录失败', { error: String(error) })
      // 网络抖动 / 5xx 时保留上一份目录：静默切回本机模型会让用户以为官方模型坏了，
      // 真正的失败应由「仍指向官方」的请求本身如实报出。
      return this.current()
    }
  }

  private setCatalog(catalog: CenterOfficialModelCatalog | null): void {
    this.catalogValue = catalog
    this.deps.onChanged?.(this.current())
  }

  private async syncProviders(catalog: CenterOfficialModelCatalog): Promise<void> {
    const settings = this.deps.settings.get()
    const base = httpBaseUrlOf(this.deps.config().serverUrl)?.replace(/\/+$/, '') ?? ''
    if (base === '') return

    const llmProviders = { ...settings.llm.providers }
    const ttsProviders = { ...settings.tts.providers }
    const sttProviders = { ...settings.stt.providers }
    const imageProviders = { ...settings.imagegen.providers }

    const llm = catalog.services.llm
    if (llm !== undefined) {
      const model = llm.defaultModel || llm.models[0]?.id || ''
      const models = llm.models.map((entry) => entry.id)
      const modelParams = Object.fromEntries(
        llm.models.map((entry) => [
          entry.id,
          {
            reasoningEffort: entry.reasoningEffort ?? 'auto',
            contextWindow: entry.contextWindow ?? 0,
            vision: entry.vision === true,
          },
        ]),
      )
      llmProviders[CENTER_OFFICIAL_PROVIDER_IDS.llm] = {
        type: llm.type === 'openai-responses' ? 'openai-responses' : 'openai-compat',
        baseUrl: `${base}/api/model-gateway/llm`,
        apiKeyEnc: '',
        model,
        modelList: models,
        modelParams,
      } satisfies LlmProviderConfig
    }

    const image = catalog.services.imagegen
    if (image !== undefined) {
      const entry = resolveOfficialModelEntry(image, '')?.entry
      imageProviders[CENTER_OFFICIAL_PROVIDER_IDS.imagegen] = {
        type: 'openai-compat',
        baseUrl: `${base}/api/model-gateway/imagegen`,
        apiKeyEnc: '',
        model: entry?.id ?? '',
        size: normalizeImageSize(entry?.size),
      } satisfies ImageGenProviderConfig
    }

    const tts = catalog.services.tts
    if (tts !== undefined) {
      const entry = resolveOfficialModelEntry(tts, '')?.entry
      ttsProviders[CENTER_OFFICIAL_PROVIDER_IDS.tts] = {
        type: tts.type === 'dashscope' ? 'dashscope' : 'openai-compat',
        baseUrl: `${base}/api/model-gateway/tts`,
        apiKeyEnc: '',
        model: entry?.id ?? '',
        voice: entry?.voice ?? '',
        speed: entry?.speed ?? 1,
        format: normalizeTtsFormat(entry?.format),
      } satisfies TtsProviderConfig
    }

    const stt = catalog.services.stt
    if (stt !== undefined) {
      const entry = resolveOfficialModelEntry(stt, '')?.entry
      sttProviders[CENTER_OFFICIAL_PROVIDER_IDS.stt] = {
        type: stt.type === 'dashscope-native' ? 'dashscope-native' : 'openai-compat',
        baseUrl: `${base}/api/model-gateway/stt`,
        apiKeyEnc: '',
        model: entry?.id ?? '',
        language: entry?.language ?? 'zh',
      } satisfies SttProviderConfig
    }

    if (
      sameJson(settings.llm.providers, llmProviders) &&
      sameJson(settings.tts.providers, ttsProviders) &&
      sameJson(settings.stt.providers, sttProviders) &&
      sameJson(settings.imagegen.providers, imageProviders)
    ) {
      return
    }
    await this.deps.settings.update({
      llm: { ...settings.llm, providers: llmProviders },
      tts: { ...settings.tts, providers: ttsProviders },
      stt: { ...settings.stt, providers: sttProviders },
      imagegen: { ...settings.imagegen, providers: imageProviders },
    })
  }
}

function isCatalog(value: unknown): value is CenterOfficialModelCatalog {
  if (typeof value !== 'object' || value === null) return false
  const catalog = value as { revision?: unknown; services?: unknown }
  if (typeof catalog.revision !== 'string') return false
  if (typeof catalog.services !== 'object' || catalog.services === null) return false
  const services = catalog.services as Record<string, unknown>
  for (const capability of ['llm', 'imagegen', 'tts', 'stt']) {
    const entry = services[capability]
    if (entry === undefined) continue
    if (typeof entry !== 'object' || entry === null) return false
    const service = entry as { type?: unknown; models?: unknown; defaultModel?: unknown }
    if (typeof service.type !== 'string' || !Array.isArray(service.models)) return false
    if (service.defaultModel !== undefined && typeof service.defaultModel !== 'string') return false
    if (
      !service.models.every(
        (model) =>
          typeof model === 'object' &&
          model !== null &&
          typeof (model as { id?: unknown }).id === 'string',
      )
    ) {
      return false
    }
  }
  return true
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function resolveOfficialModelParams(
  provider: LlmProviderConfig,
): ReturnType<typeof resolveModelParams> {
  return resolveModelParams(provider)
}
