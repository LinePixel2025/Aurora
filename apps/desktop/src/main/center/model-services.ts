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

export interface CenterModelServicesDeps {
  settings: {
    get(): Settings
    update(patch: Record<string, unknown>): Settings | undefined
  }
  logger: Logger
  fetchImpl: () => typeof fetch | undefined
  config: () => { enabled: boolean; serverUrl: string; token: string; clientId: string }
  onChanged?: (catalog: CenterOfficialModelCatalog | null) => void
}

export class CenterModelServices {
  private catalogValue: CenterOfficialModelCatalog | null = null
  private refreshPromise: Promise<CenterOfficialModelCatalog | null> | null = null

  constructor(private readonly deps: CenterModelServicesDeps) {}

  current(): CenterOfficialModelCatalog | null {
    return this.catalogValue === null ? null : structuredClone(this.catalogValue)
  }

  async refresh(): Promise<CenterOfficialModelCatalog | null> {
    if (this.refreshPromise !== null) return this.refreshPromise
    this.refreshPromise = this.doRefresh().finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }

  /** Provider 工厂 / 服务层判断某能力当前是否有可用官方目录。 */
  service(capability: CenterOfficialCapability): CenterOfficialServiceCatalog | undefined {
    const service = this.catalogValue?.services[capability]
    return service === undefined ? undefined : structuredClone(service)
  }

  private async doRefresh(): Promise<CenterOfficialModelCatalog | null> {
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
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const catalog = (await response.json()) as CenterOfficialModelCatalog
      if (!isCatalog(catalog)) throw new Error('目录响应格式异常')
      this.setCatalog(catalog)
      await this.syncProviders(catalog)
      return catalog
    } catch (error) {
      this.deps.logger.warn('刷新 Aurora Center 官方模型目录失败', { error: String(error) })
      this.setCatalog(null)
      return null
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
      const entry = image.models.find((item) => item.id === image.defaultModel) ?? image.models[0]
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
      const entry = tts.models.find((item) => item.id === tts.defaultModel) ?? tts.models[0]
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
      const entry = stt.models.find((item) => item.id === stt.defaultModel) ?? stt.models[0]
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
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { revision?: unknown }).revision === 'string' &&
    typeof (value as { services?: unknown }).services === 'object'
  )
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function normalizeImageSize(value: string | undefined): ImageGenProviderConfig['size'] {
  const allowed = ['512x512', '768x768', '1024x1024', '1024x1792', '1792x1024', 'auto'] as const
  return (allowed as readonly string[]).includes(value ?? '')
    ? (value as ImageGenProviderConfig['size'])
    : '1024x1024'
}

function normalizeTtsFormat(value: string | undefined): TtsProviderConfig['format'] {
  const allowed = ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'] as const
  return (allowed as readonly string[]).includes(value ?? '')
    ? (value as TtsProviderConfig['format'])
    : 'mp3'
}

export function resolveOfficialModelParams(
  provider: LlmProviderConfig,
): ReturnType<typeof resolveModelParams> {
  return resolveModelParams(provider)
}
