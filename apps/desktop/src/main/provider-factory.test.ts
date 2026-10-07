/**
 * provider 工厂的会话级模型覆盖（docs/06 §3，本轮）。
 *
 * 覆盖链只有一级（会话覆盖 > 全局 `llm.active`），但**回落**有四条分支必须逐条钉住：
 * 未覆盖 / provider 已删 / model 空 / Key 取不到 —— 任何一条走错都会让用户以为
 * 「这个会话绑了模型」，实际却静默跑了另一个（或干脆报 E_NO_MODEL）。
 */
import { describe, expect, it } from 'vitest'
import { createDefaultSettings, createMemoryLogger } from '@aurora/shared'
import type { LlmProviderConfig, Settings } from '@aurora/shared'
import { createProviderFactory } from './agent-host.js'
import type { SettingsStoreLike } from './contracts.js'

function provider(model: string, models: string[] = []): LlmProviderConfig {
  return {
    type: 'openai-compat',
    baseUrl: 'https://api.example.com/v1',
    apiKeyEnc: 'enc',
    model,
    modelList: models,
    modelParams: {},
  }
}

/** 两个 provider：p-global（全局档）与 p-session（会话覆盖用），各带一个模型。 */
function settingsWith(overrides: Partial<Settings['llm']> = {}): Settings {
  const base = createDefaultSettings()
  return {
    ...base,
    llm: {
      ...base.llm,
      active: 'p-global',
      providers: {
        'p-global': provider('m-global', ['m-global', 'm-other']),
        'p-session': provider('m-session', ['m-session']),
        ...overrides.providers,
      },
      ...overrides,
    },
  }
}

/** 极简 SettingsStoreLike：只有本文件用到的两个方法有实现（其余抛错，避免误用）。 */
function storeOf(settings: Settings, secrets: Record<string, string> = {}): SettingsStoreLike {
  const unsupported = (): never => {
    throw new Error('测试桩未实现该 SettingsStoreLike 方法')
  }
  return {
    get: () => settings,
    getSecret: (path) => secrets[path] ?? 'sk-test',
    mutate: unsupported,
    update: unsupported,
    setSecret: unsupported,
    clearSecret: unsupported,
    isCryptoAvailable: () => true,
    needsOnboarding: () => false,
    exportRedacted: () => settings,
    flush: async () => undefined,
    onChange: () => () => undefined,
  }
}

function build(settings: Settings, sessionModel?: { providerId: string; model: string }) {
  return createProviderFactory(storeOf(settings), createMemoryLogger(), undefined, {
    sessionModelOf: () => sessionModel,
  })
}

function buildStrict(
  settings: Settings,
  sessionModel: { providerId: string; model: string },
  secrets: Record<string, string> = {},
) {
  return createProviderFactory(storeOf(settings, secrets), createMemoryLogger(), undefined, {
    sessionModelOf: () => sessionModel,
    strictSessionModelOf: () => true,
  })
}

describe('createProviderFactory · 全局档（未传 sessionId）', () => {
  it('用 llm.active 的 provider 与其 model 构造', () => {
    const factory = build(settingsWith())
    const config = factory.create()
    expect(config?.provider.id).toBe('p-global')
    expect(config?.model).toBe('m-global')
  })
})

describe('createProviderFactory · 会话级模型覆盖（docs/06 §3）', () => {
  it('命中覆盖时用覆盖的 (providerId, model) 构造，且该模型的参数随之取', () => {
    const settings = settingsWith()
    // 覆盖模型名下的思考等级：断言参数取的是「覆盖模型」而不是全局模型那一条
    settings.llm.providers['p-session']!.modelParams = {
      'm-session': { reasoningEffort: 'high', contextWindow: 0, vision: false },
    }
    settings.llm.providers['p-global']!.modelParams = {
      'm-global': { reasoningEffort: 'low', contextWindow: 0, vision: false },
    }

    const config = build(settings, { providerId: 'p-session', model: 'm-session' }).create({
      sessionId: 'center-abc',
    })
    expect(config?.provider.id).toBe('p-session')
    expect(config?.model).toBe('m-session')
    expect(config?.reasoningEffort).toBe('high')
  })

  it('覆盖 provider 已被删除 → 静默回落全局档', () => {
    const config = build(settingsWith(), { providerId: 'p-gone', model: 'm-session' }).create({
      sessionId: 'center-abc',
    })
    expect(config?.provider.id).toBe('p-global')
    expect(config?.model).toBe('m-global')
  })

  it('覆盖 model 为空 / 全空白 → 回落全局档（不构造出空模型）', () => {
    for (const model of ['', '   ']) {
      const config = build(settingsWith(), { providerId: 'p-session', model }).create({
        sessionId: 'center-abc',
      })
      expect(config?.provider.id).toBe('p-global')
      expect(config?.model).toBe('m-global')
    }
  })

  it('覆盖命中但该 provider 取不到 Key → 回落全局档（不把会话拖成 E_NO_MODEL）', () => {
    const settings = settingsWith()
    const factory = createProviderFactory(
      storeOf(settings, { 'llm.providers.p-session.apiKey': '' }),
      createMemoryLogger(),
      undefined,
      { sessionModelOf: () => ({ providerId: 'p-session', model: 'm-session' }) },
    )
    const config = factory.create({ sessionId: 'center-abc' })
    expect(config?.provider.id).toBe('p-global')
  })

  it('未注入 sessionModelOf（老装配器）时行为与从前逐字一致', () => {
    const factory = createProviderFactory(storeOf(settingsWith()), createMemoryLogger())
    expect(factory.create({ sessionId: 'center-abc' })?.model).toBe('m-global')
  })

  it('未覆盖（sessionModelOf 返回 undefined）→ 全局档', () => {
    const config = build(settingsWith()).create({ sessionId: 'center-abc' })
    expect(config?.model).toBe('m-global')
  })

  it('严格专用模型命中时正常构造，思考等级取所选模型', () => {
    const settings = settingsWith()
    settings.llm.providers['p-session']!.modelParams = {
      'm-session': { reasoningEffort: 'high', contextWindow: 0, vision: false },
    }
    const config = buildStrict(settings, {
      providerId: 'p-session',
      model: 'm-session',
    }).create({ sessionId: 'awareness-note' })
    expect(config?.provider.id).toBe('p-session')
    expect(config?.model).toBe('m-session')
    expect(config?.reasoningEffort).toBe('high')
  })

  it('严格专用模型 provider 失效 / 模型为空 / Key 缺失时返回 undefined，不回落全局', () => {
    expect(
      buildStrict(settingsWith(), { providerId: 'p-gone', model: 'm-session' }).create({
        sessionId: 'awareness-note',
      }),
    ).toBeUndefined()
    expect(
      buildStrict(settingsWith(), { providerId: 'p-session', model: '' }).create({
        sessionId: 'awareness-note',
      }),
    ).toBeUndefined()
    expect(
      buildStrict(
        settingsWith(),
        { providerId: 'p-session', model: 'm-session' },
        { 'llm.providers.p-session.apiKey': '' },
      ).create({ sessionId: 'awareness-note' }),
    ).toBeUndefined()
  })
})

describe('createProviderFactory · Aurora Center 官方模型', () => {
  it('开启官方选择时构造保留 Provider，并可被会话覆盖', () => {
    const settings = settingsWith()
    settings.center.officialModels.llm = { enabled: true, model: 'm-center' }
    settings.llm.providers['center-llm'] = provider('m-center', ['m-center'])
    const factory = createProviderFactory(storeOf(settings), createMemoryLogger(), undefined, {
      centerOfficial: {
        token: () => 'ac-token',
        service: (capability) =>
          capability === 'llm'
            ? {
                type: 'openai-compat',
                defaultModel: 'm-center',
                models: [{ id: 'm-center', contextWindow: 128000, vision: true }],
              }
            : undefined,
        selection: () => settings.center.officialModels.llm,
      },
    })

    const config = factory.create()
    expect(config?.provider.id).toBe('center-llm')
    expect(config?.model).toBe('m-center')
    expect(config?.vision).toBe(true)
  })

  it('Center 目录不可用时回调回落，并使用本机默认 Provider', () => {
    const settings = settingsWith()
    settings.center.officialModels.llm = { enabled: true, model: 'm-center' }
    settings.llm.providers['center-llm'] = provider('m-center', ['m-center'])
    const fallbacks: Array<{ requestedProviderId: string; fallbackProviderId: string }> = []
    const factory = createProviderFactory(storeOf(settings), createMemoryLogger(), undefined, {
      centerOfficial: {
        token: () => 'ac-token',
        service: () => undefined,
        selection: () => settings.center.officialModels.llm,
        onFallback: (input) => fallbacks.push(input),
      },
    })

    const config = factory.create({ allowFallback: true })
    expect(config?.provider.id).toBe('p-global')
    expect(fallbacks).toEqual([
      { requestedProviderId: 'center-llm', fallbackProviderId: 'p-global' },
    ])
  })
})
