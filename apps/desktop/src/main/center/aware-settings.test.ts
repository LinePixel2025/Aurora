import { describe, expect, it } from 'vitest'
import { createDefaultSettings } from '@aurora/shared'
import type {
  CenterOfficialCapability,
  CenterOfficialServiceCatalog,
  Logger,
  Settings,
} from '@aurora/shared'
import type { SettingsStoreLike } from '../contracts.js'
import { createCenterAwareSettingsStore } from './aware-settings.js'

const catalogs: Partial<Record<CenterOfficialCapability, CenterOfficialServiceCatalog>> = {
  imagegen: {
    type: 'openai-compat',
    defaultModel: 'img-default',
    models: [
      { id: 'img-default', size: '1024x1024' },
      { id: 'img-alt', size: '512x512' },
    ],
  },
  tts: {
    type: 'openai-compat',
    defaultModel: 'tts-default',
    models: [
      { id: 'tts-default', voice: 'alloy', speed: 1, format: 'mp3' },
      { id: 'tts-alt', voice: 'nova', speed: 1.5, format: 'wav' },
    ],
  },
  stt: {
    type: 'openai-compat',
    defaultModel: 'stt-default',
    models: [
      { id: 'stt-default', language: 'zh' },
      { id: 'stt-alt', language: 'en' },
    ],
  },
  llm: {
    type: 'openai-compat',
    defaultModel: 'llm-default',
    models: [{ id: 'llm-default' }],
  },
}

function baseStoreOf(settings: Settings): SettingsStoreLike {
  const unsupported = (): never => {
    throw new Error('测试桩未实现该 SettingsStoreLike 方法')
  }
  return {
    // 真 store 的 get() 返回 deepClone 副本，这里同口径（断言"不改原对象"才有意义）
    get: () => structuredClone(settings),
    getSecret: () => 'sk-test',
    setSecret: unsupported,
    clearSecret: unsupported,
    mutate: unsupported,
    update: unsupported,
    isCryptoAvailable: () => true,
    needsOnboarding: () => false,
    exportRedacted: () => structuredClone(settings),
    flush: async () => undefined,
    onChange: () => () => undefined,
  }
}

function settingsWithOfficial(): Settings {
  const settings = createDefaultSettings()
  settings.center.enabled = true
  settings.center.officialModels.imagegen = { enabled: true, model: 'img-alt' }
  settings.center.officialModels.tts = { enabled: true, model: 'tts-alt' }
  settings.center.officialModels.stt = { enabled: true, model: 'stt-alt' }
  settings.center.officialModels.llm = { enabled: true, model: '' }
  settings.imagegen.providers['center-imagegen'] = {
    type: 'openai-compat',
    baseUrl: 'https://center/api/model-gateway/imagegen',
    apiKeyEnc: '',
    model: 'img-default',
    size: '1024x1024',
  }
  settings.tts.providers['center-tts'] = {
    type: 'openai-compat',
    baseUrl: 'https://center/api/model-gateway/tts',
    apiKeyEnc: '',
    model: 'tts-default',
    voice: 'alloy',
    speed: 1,
    format: 'mp3',
  }
  settings.stt.providers['center-stt'] = {
    type: 'openai-compat',
    baseUrl: 'https://center/api/model-gateway/stt',
    apiKeyEnc: '',
    model: 'stt-default',
    language: 'zh',
  }
  settings.llm.providers['center-llm'] = {
    type: 'openai-compat',
    baseUrl: 'https://center/api/model-gateway/llm',
    apiKeyEnc: '',
    model: 'llm-default',
    modelList: ['llm-default'],
    modelParams: { 'llm-default': { reasoningEffort: 'auto', contextWindow: 0, vision: false } },
  }
  return settings
}

function makeAware(settings: Settings) {
  const warns: unknown[][] = []
  const fallbacks: CenterOfficialCapability[] = []
  const store = createCenterAwareSettingsStore(baseStoreOf(settings), {
    serviceOf: (capability) => catalogs[capability],
    noticeFallback: (capability) => fallbacks.push(capability),
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (message: string, meta?: unknown) => warns.push([message, meta]),
      error: () => undefined,
    } as unknown as Logger,
  })
  return { store, warns, fallbacks }
}

describe('createCenterAwareSettingsStore 官方选模读时覆写', () => {
  it('所选官方模型与参数覆写进返回副本（imagegen/tts/stt）', () => {
    const { store } = makeAware(settingsWithOfficial())
    const next = store.get()
    const image = next.imagegen.providers['center-imagegen']
    expect(image?.model).toBe('img-alt')
    expect(image?.size).toBe('512x512')
    const tts = next.tts.providers['center-tts']
    expect(tts).toMatchObject({ model: 'tts-alt', voice: 'nova', speed: 1.5, format: 'wav' })
    const stt = next.stt.providers['center-stt']
    expect(stt).toMatchObject({ model: 'stt-alt', language: 'en' })
    expect(next.imagegen.enabled).toBe(true)
    expect(next.llm.active).toBe('center-llm')
  })

  it('不落盘：底仓对象保持镜像默认模型', () => {
    const settings = settingsWithOfficial()
    const { store } = makeAware(settings)
    void store.get()
    expect(settings.imagegen.providers['center-imagegen']?.model).toBe('img-default')
    expect(settings.tts.providers['center-tts']?.model).toBe('tts-default')
  })

  it('未选择（空串）时镜像原样返回', () => {
    const settings = settingsWithOfficial()
    settings.center.officialModels.tts.model = ''
    const { store } = makeAware(settings)
    expect(store.get().tts.providers['center-tts']?.model).toBe('tts-default')
  })

  it('所选模型被目录下线：回落 defaultModel，且 warn 去重只记一次', () => {
    const settings = settingsWithOfficial()
    settings.center.officialModels.tts.model = 'tts-removed'
    const { store, warns } = makeAware(settings)
    expect(store.get().tts.providers['center-tts']?.model).toBe('tts-default')
    void store.get()
    expect(warns.filter((entry) => String(entry[0]).includes('不再开放所选模型'))).toHaveLength(1)
  })

  it('目录缺席：不覆写并按能力提示回落', () => {
    const settings = settingsWithOfficial()
    const { store, fallbacks } = makeAware(settings)
    const withoutImage = createCenterAwareSettingsStore(baseStoreOf(settings), {
      serviceOf: (capability) => (capability === 'imagegen' ? undefined : catalogs[capability]),
      noticeFallback: (capability) => fallbacks.push(capability),
    })
    void store.get()
    void withoutImage.get()
    expect(withoutImage.get().imagegen.enabled).toBe(false)
    expect(fallbacks).toContain('imagegen')
  })

  it('开关未启用：完全不触碰 provider', () => {
    const settings = settingsWithOfficial()
    settings.center.officialModels.tts.enabled = false
    const { store } = makeAware(settings)
    const next = store.get()
    expect(next.tts.providers['center-tts']?.model).toBe('tts-default')
    expect(next.tts.providers['center-tts']?.voice).toBe('alloy')
  })

  it('官方凭据路径仍映射到 center.token', () => {
    const { store } = makeAware(settingsWithOfficial())
    expect(store.getSecret('tts.providers.center-tts.apiKey')).toBe('sk-test')
  })
})
