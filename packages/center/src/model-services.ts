/**
 * Aurora Center 官方模型目录与上游密钥（docs/12 §12）。
 *
 * 一个能力只配一个上游，但可开放多个模型。管理端永远拿不到明文 Key；客户端只拿清洗后的
 * 目录。实际网关转发时再在内存里解密。
 */
import { createHash } from 'node:crypto'
import type { Logger } from '@aurora/shared'
import {
  CENTER_OFFICIAL_CAPABILITIES,
  CENTER_OFFICIAL_PROVIDER_IDS,
  LlmProviderTypes,
  SttProviderTypes,
  TTS_PROVIDER_TYPES,
  type CenterOfficialCapability,
  type CenterOfficialModelCatalog,
  type CenterOfficialModelEntry,
  type CenterOfficialServiceCatalog,
  type CenterOfficialServiceConfig,
  type CenterOfficialServicesConfig,
} from '@aurora/shared'
import { JsonStore } from './store.js'
import type { SecretBox } from './secrets.js'

interface StoredService {
  enabled: boolean
  type: string
  baseUrl: string
  apiKeyEnc: string
  defaultModel: string
  models: CenterOfficialModelEntry[]
}

interface StoredModelServices {
  version: 1
  services: Record<CenterOfficialCapability, StoredService>
}

export interface ModelServicesStoreOptions {
  dataDir: string
  secrets: SecretBox
  logger?: Logger
}

export interface ResolvedOfficialService {
  capability: CenterOfficialCapability
  providerId: (typeof CENTER_OFFICIAL_PROVIDER_IDS)[CenterOfficialCapability]
  type: string
  baseUrl: string
  apiKey: string
  defaultModel: string
  models: CenterOfficialModelEntry[]
}

const ALLOWED_TYPES: Record<CenterOfficialCapability, readonly string[]> = {
  llm: LlmProviderTypes,
  imagegen: ['openai-compat'],
  tts: TTS_PROVIDER_TYPES,
  stt: SttProviderTypes,
}

export class ModelServicesStore {
  private readonly store: JsonStore<StoredModelServices>
  private readonly secrets: SecretBox
  private data: StoredModelServices = fallback()

  constructor(options: ModelServicesStoreOptions) {
    this.secrets = options.secrets
    this.store = new JsonStore<StoredModelServices>(
      `${options.dataDir}/model-services.json`,
      fallback,
      options.logger,
    )
  }

  async init(): Promise<void> {
    const loaded = await this.store.load()
    this.data = normalizeFile(loaded)
  }

  /** 管理端配置；只返回 apiKeySet，不返回密文。 */
  adminConfig(): CenterOfficialServicesConfig {
    const out = {} as CenterOfficialServicesConfig
    for (const capability of CENTER_OFFICIAL_CAPABILITIES) {
      const service = this.serviceOf(capability)
      let error: string | undefined
      if (service.apiKeyEnc !== '') {
        try {
          this.secrets.decrypt(service.apiKeyEnc)
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause)
        }
      }
      out[capability] = {
        enabled: service.enabled,
        type: service.type,
        baseUrl: service.baseUrl,
        apiKeySet: service.apiKeyEnc !== '' && this.secrets.available,
        defaultModel: service.defaultModel,
        models: service.models.map((model) => ({ ...model })),
        ...(error === undefined ? {} : { error }),
      }
    }
    return out
  }

  /** 客户端目录：只含启用且可用、且至少有一个开放模型的能力。 */
  catalog(): CenterOfficialModelCatalog {
    const services: Partial<Record<CenterOfficialCapability, CenterOfficialServiceCatalog>> = {}
    for (const capability of CENTER_OFFICIAL_CAPABILITIES) {
      const resolved = this.resolve(capability)
      if (resolved === undefined) continue
      const models = resolved.models
        .filter((model) => model.enabled)
        .map(({ enabled: _enabled, ...model }) => ({ ...model }))
      if (models.length === 0) continue
      services[capability] = {
        type: resolved.type,
        defaultModel: resolved.defaultModel,
        models,
      }
    }
    const revision = createHash('sha256').update(JSON.stringify(services)).digest('hex')
    return { revision, services }
  }

  /**
   * 更新一类能力。`apiKey` 为空串表示保留旧 Key，`null` 表示清空；非法配置整条拒绝。
   */
  async updateService(
    capability: CenterOfficialCapability,
    raw: unknown,
  ): Promise<CenterOfficialServiceConfig> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('配置不是对象')
    }
    const input = raw as Record<string, unknown>
    const type = stringOf(input['type']).trim()
    if (!ALLOWED_TYPES[capability].includes(type)) {
      throw new Error(`不支持的协议：${type === '' ? '（空）' : type}`)
    }
    const baseUrl = stringOf(input['baseUrl']).trim()
    if (input['enabled'] === true && baseUrl === '')
      throw new Error('启用官方能力前必须填写 baseURL')
    const models = normalizeModels(capability, input['models'])
    if (input['enabled'] === true && models.filter((model) => model.enabled).length === 0) {
      throw new Error('启用官方能力前至少开放一个模型')
    }
    const requestedDefault = stringOf(input['defaultModel']).trim()
    const firstEnabled = models.find((model) => model.enabled)?.id ?? ''
    const defaultModel =
      requestedDefault !== '' &&
      models.some((model) => model.id === requestedDefault && model.enabled)
        ? requestedDefault
        : firstEnabled

    const previous = this.serviceOf(capability)
    let apiKeyEnc = previous.apiKeyEnc
    if (input['apiKey'] === null) {
      apiKeyEnc = ''
    } else if (typeof input['apiKey'] === 'string' && input['apiKey'].trim() !== '') {
      if (!this.secrets.available) throw new Error('AURORA_CENTER_SECRET 未配置，无法保存 API Key')
      apiKeyEnc = this.secrets.encrypt(input['apiKey'].trim())
    }
    if (input['enabled'] === true && apiKeyEnc === '') {
      throw new Error('启用官方能力前必须保存 API Key')
    }

    this.data.services[capability] = {
      enabled: input['enabled'] === true,
      type,
      baseUrl,
      apiKeyEnc,
      defaultModel,
      models,
    }
    await this.store.save(this.data)
    return this.adminConfig()[capability]
  }

  /** 解析可供网关使用的上游配置；未启用 / 未配 Key / 解密失败返回 undefined。 */
  resolve(capability: CenterOfficialCapability): ResolvedOfficialService | undefined {
    const service = this.serviceOf(capability)
    if (!service.enabled || service.baseUrl === '' || service.apiKeyEnc === '') return undefined
    let apiKey = ''
    try {
      apiKey = this.secrets.decrypt(service.apiKeyEnc).trim()
    } catch {
      return undefined
    }
    if (apiKey === '') return undefined
    return {
      capability,
      providerId: CENTER_OFFICIAL_PROVIDER_IDS[capability],
      type: service.type,
      baseUrl: service.baseUrl,
      apiKey,
      defaultModel: service.defaultModel,
      models: service.models.map((model) => ({ ...model })),
    }
  }

  /** 校验请求模型是否开放。 */
  allowedModel(capability: CenterOfficialCapability, model: string): boolean {
    const resolved = this.resolve(capability)
    if (resolved === undefined) return false
    const id = model.trim()
    return id !== '' && resolved.models.some((entry) => entry.id === id && entry.enabled)
  }

  /** 管理端“拉取模型”：直接向上游 GET /models；不替模型填能力参数。 */
  async fetchModels(capability: CenterOfficialCapability, raw: unknown): Promise<string[]> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('配置不是对象')
    }
    const input = raw as Record<string, unknown>
    const type = stringOf(input['type']).trim()
    if (!ALLOWED_TYPES[capability].includes(type)) throw new Error('协议不受支持')
    const baseUrl = stringOf(input['baseUrl']).trim().replace(/\/+$/, '')
    if (baseUrl === '') throw new Error('请先填写 baseURL')
    const explicit = stringOf(input['apiKey']).trim()
    const apiKey =
      explicit !== ''
        ? explicit
        : (this.resolve(capability)?.apiKey ??
          (() => {
            try {
              return this.serviceOf(capability).apiKeyEnc === ''
                ? ''
                : this.secrets.decrypt(this.serviceOf(capability).apiKeyEnc)
            } catch {
              return ''
            }
          })())
    if (apiKey === '') throw new Error('请先保存 API Key')

    const response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    })
    const text = await response.text().catch(() => '')
    if (!response.ok) throw new Error(`上游返回 HTTP ${response.status}: ${text.slice(0, 200)}`)
    const body = JSON.parse(text) as unknown
    return parseModelIds(body)
  }

  private serviceOf(capability: CenterOfficialCapability): StoredService {
    return this.data.services[capability] as StoredService
  }
}

function fallback(): StoredModelServices {
  const services = {} as Record<CenterOfficialCapability, StoredService>
  for (const capability of CENTER_OFFICIAL_CAPABILITIES) {
    services[capability] = {
      enabled: false,
      type: ALLOWED_TYPES[capability][0] as string,
      baseUrl: '',
      apiKeyEnc: '',
      defaultModel: '',
      models: [],
    }
  }
  return { version: 1, services }
}

function normalizeFile(raw: StoredModelServices): StoredModelServices {
  const base = fallback()
  if (typeof raw !== 'object' || raw === null) return base
  for (const capability of CENTER_OFFICIAL_CAPABILITIES) {
    const service = (raw as { services?: Record<string, unknown> }).services?.[capability]
    if (typeof service !== 'object' || service === null) continue
    const value = service as Record<string, unknown>
    base.services[capability] = {
      enabled: value['enabled'] === true,
      type: ALLOWED_TYPES[capability].includes(stringOf(value['type']))
        ? stringOf(value['type'])
        : (ALLOWED_TYPES[capability][0] as string),
      baseUrl: stringOf(value['baseUrl']).trim(),
      apiKeyEnc: stringOf(value['apiKeyEnc']),
      defaultModel: stringOf(value['defaultModel']).trim(),
      models: normalizeModels(capability, value['models']),
    }
  }
  return base
}

function normalizeModels(
  capability: CenterOfficialCapability,
  raw: unknown,
): CenterOfficialModelEntry[] {
  if (!Array.isArray(raw)) return []
  const out: CenterOfficialModelEntry[] = []
  const seen = new Set<string>()
  for (const item of raw.slice(0, 200)) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const value = item as Record<string, unknown>
    const id = stringOf(value['id']).trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const entry: CenterOfficialModelEntry = {
      id,
      enabled: value['enabled'] !== false,
    }
    const label = stringOf(value['label']).trim()
    if (label !== '') entry.label = label
    if (capability === 'llm') {
      const effort = stringOf(value['reasoningEffort'])
      if (effort === 'auto' || effort === 'low' || effort === 'medium' || effort === 'high') {
        entry.reasoningEffort = effort
      }
      const contextWindow = Number(value['contextWindow'] ?? 0)
      entry.contextWindow =
        Number.isFinite(contextWindow) && contextWindow >= 0
          ? Math.min(2_000_000, Math.round(contextWindow))
          : 0
      entry.vision = value['vision'] === true
    } else if (capability === 'imagegen') {
      entry.size = stringOf(value['size']).trim() || 'auto'
    } else if (capability === 'tts') {
      entry.voice = stringOf(value['voice']).trim()
      const speed = Number(value['speed'] ?? 1)
      entry.speed = Number.isFinite(speed) ? Math.max(0.25, Math.min(4, speed)) : 1
      entry.format = stringOf(value['format']).trim() || 'mp3'
    } else {
      entry.language = stringOf(value['language']).trim()
    }
    out.push(entry)
  }
  return out
}

function parseModelIds(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return []
  const record = body as Record<string, unknown>
  const arrays = [
    record['data'],
    record['models'],
    (record['output'] as { models?: unknown })?.models,
  ]
  for (const value of arrays) {
    if (!Array.isArray(value)) continue
    const ids: string[] = []
    for (const item of value) {
      if (typeof item === 'string' && item.trim() !== '') {
        ids.push(item.trim())
        continue
      }
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      const id = record['id'] ?? record['model'] ?? record['name']
      if (typeof id === 'string' && id.trim() !== '') ids.push(id.trim())
    }
    if (ids.length > 0) return [...new Set(ids)]
  }
  return []
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
