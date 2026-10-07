import { describe, expect, it } from 'vitest'
import { createDefaultSettings, type LlmProviderConfig, type Settings } from '@aurora/shared'
import {
  fileAwarenessModelError,
  fileAwarenessModelOverride,
  hasExplicitFileAwarenessModel,
  resolveFileAwarenessModel,
} from './file-awareness-model.js'

function provider(model: string): LlmProviderConfig {
  return {
    type: 'openai-compat',
    baseUrl: 'https://api.example.com/v1',
    apiKeyEnc: 'enc',
    model,
    modelList: [model],
    modelParams: {},
  }
}

function settingsWith(backgroundProviderId = '', backgroundModel = ''): Settings {
  const settings = createDefaultSettings()
  settings.llm.active = 'global'
  settings.llm.providers = {
    global: provider('global-model'),
    background: provider('background-default'),
  }
  settings.fileAwareness.backgroundModel = {
    providerId: backgroundProviderId,
    model: backgroundModel,
  }
  return settings
}

describe('文件自感知后台模型解析', () => {
  it('未显式选择时跟随全局主模型', () => {
    const settings = settingsWith()
    expect(resolveFileAwarenessModel(settings)).toEqual({
      providerId: 'global',
      model: 'global-model',
      overridden: false,
    })
    expect(fileAwarenessModelOverride(settings)).toBeUndefined()
    expect(hasExplicitFileAwarenessModel(settings)).toBe(false)
  })

  it('显式选择时返回约定的 provider + model，并标记为严格覆盖', () => {
    const settings = settingsWith('background', 'background-reasoner')
    expect(resolveFileAwarenessModel(settings)).toEqual({
      providerId: 'background',
      model: 'background-reasoner',
      overridden: true,
    })
    expect(fileAwarenessModelOverride(settings)).toEqual({
      providerId: 'background',
      model: 'background-reasoner',
    })
    expect(hasExplicitFileAwarenessModel(settings)).toBe(true)
    expect(fileAwarenessModelError(settings, () => 'secret')).toBeUndefined()
  })

  it('显式模型不存在 / 模型为空 / Key 缺失时返回可操作原因', () => {
    expect(fileAwarenessModelError(settingsWith('missing', 'm'), () => 'secret')).toContain(
      '所选后台模型不存在',
    )
    expect(fileAwarenessModelError(settingsWith('background', ''), () => 'secret')).toContain(
      '尚未选择自感知后台模型',
    )
    expect(
      fileAwarenessModelError(settingsWith('background', 'background-default'), () => ''),
    ).toContain('缺少 API Key')
  })

  it('Center 官方后台模型使用 Center 目录与登录令牌校验', () => {
    const settings = settingsWith('center-llm', 'deepseek-flash')
    settings.llm.providers['center-llm'] = provider('deepseek-flash')
    settings.llm.providers['center-llm']!.apiKeyEnc = ''

    expect(
      fileAwarenessModelError(settings, () => '', {
        enabled: true,
        available: true,
        tokenSet: true,
      }),
    ).toBeUndefined()
    expect(
      fileAwarenessModelError(settings, () => '', {
        enabled: false,
        available: true,
        tokenSet: true,
      }),
    ).toContain('未启用')
    expect(
      fileAwarenessModelError(settings, () => '', {
        enabled: true,
        available: false,
        tokenSet: true,
      }),
    ).toContain('目录当前不可用')
  })
})
