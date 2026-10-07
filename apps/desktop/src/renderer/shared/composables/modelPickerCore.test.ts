import { describe, expect, it } from 'vitest'
import {
  CENTER_OFFICIAL_PROVIDER_IDS,
  createDefaultSettings,
  type LlmProviderConfig,
  type Settings,
} from '@aurora/shared/browser'
import { buildModelPickerState } from './modelPickerCore.js'

function provider(model: string, modelList: string[] = [model]): LlmProviderConfig {
  return {
    type: 'openai-compat',
    baseUrl: 'https://example.test/v1',
    apiKeyEnc: '',
    model,
    modelList,
    modelParams: {},
  }
}

function settingsWith(): Settings {
  const settings = createDefaultSettings()
  settings.llm.providers = {
    alpha: provider('alpha-a', ['alpha-a', 'shared']),
    beta: provider('beta-b', ['beta-b', 'shared']),
  }
  settings.llm.active = 'alpha'
  return settings
}

function enableCenter(settings: Settings): void {
  settings.center.officialModels.llm = { enabled: true, model: 'center-b' }
  settings.llm.providers[CENTER_OFFICIAL_PROVIDER_IDS.llm] = provider('center-a', [
    'center-a',
    'center-b',
  ])
}

describe('模型来源选择器解析', () => {
  it('没有会话覆盖时优先展示 Center 官方默认模型，但标记为未覆盖', () => {
    const settings = settingsWith()
    enableCenter(settings)

    expect(buildModelPickerState(settings)).toMatchObject({
      sourceId: 'center',
      choice: { providerId: 'center-llm', model: 'center-b' },
      overridden: false,
      centerReadOnly: true,
    })
  })

  it('Center 未启用时只展示全部用户 Provider，并保留同名模型', () => {
    const settings = settingsWith()
    const state = buildModelPickerState(settings)

    expect(state.sourceId).toBe('local')
    expect(state.sources.map((source) => source.id)).toEqual(['local'])
    expect(state.sources[0]?.options.map((item) => item.label)).toEqual([
      'alpha · alpha-a',
      'alpha · shared',
      'beta · beta-b',
      'beta · shared',
    ])
    expect(state.choice).toEqual({ providerId: 'alpha', model: 'alpha-a' })
  })

  it('Center 目录不可用时隐藏官方来源并回落本机选择', () => {
    const settings = settingsWith()
    enableCenter(settings)
    const state = buildModelPickerState(settings, null, false)

    expect(state.sources.map((source) => source.id)).toEqual(['local'])
    expect(state.sourceId).toBe('local')
    expect(state.choice).toEqual({ providerId: 'alpha', model: 'alpha-a' })
  })

  it('会话覆盖优先于 Center 和本机全局，并识别真正的 Provider + model', () => {
    const settings = settingsWith()
    enableCenter(settings)

    const local = buildModelPickerState(settings, { providerId: 'beta', model: 'shared' })
    expect(local.sourceId).toBe('local')
    expect(local.choice).toEqual({ providerId: 'beta', model: 'shared' })
    expect(local.overridden).toBe(true)
    expect(local.centerReadOnly).toBe(false)

    const center = buildModelPickerState(settings, {
      providerId: CENTER_OFFICIAL_PROVIDER_IDS.llm,
      model: 'center-a',
    })
    expect(center.sourceId).toBe('center')
    expect(center.choice).toEqual({ providerId: 'center-llm', model: 'center-a' })
    expect(center.overridden).toBe(true)
    expect(center.centerReadOnly).toBe(true)
  })

  it('失效覆盖与不可用 Center 来源都回落到当前可用选择', () => {
    const settings = settingsWith()
    const state = buildModelPickerState(settings, {
      providerId: CENTER_OFFICIAL_PROVIDER_IDS.llm,
      model: 'center-a',
    })

    expect(state.sourceId).toBe('local')
    expect(state.choice).toEqual({ providerId: 'alpha', model: 'alpha-a' })
    expect(state.overridden).toBe(false)
  })

  it('当前模型不在候选列表时如实补成一项', () => {
    const settings = settingsWith()
    const state = buildModelPickerState(settings, { providerId: 'beta', model: 'legacy-model' })

    expect(state.sources[0]?.options.at(-1)).toMatchObject({
      providerId: 'beta',
      model: 'legacy-model',
      label: 'legacy-model（不在列表中）',
    })
  })
})
