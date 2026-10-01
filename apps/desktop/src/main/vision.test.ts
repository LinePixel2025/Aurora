/**
 * 图片输入开关判据的单测（docs/06 §3.1 / §25）。
 *
 * 这一个布尔被两处消费 —— 附件降级（`ipc.ts`）与图像工具注册（`tools/index.ts`）——
 * 因此它的**降级方向**必须钉死：任何读不出来的情形一律按「关」处理，
 * 绝不因为配置异常就把图片发出去、或把看不懂图的工具摆给模型。
 */
import { describe, expect, it } from 'vitest'
import { createDefaultSettings, type Settings } from '@aurora/shared'
import { visionEnabled } from './vision.js'

function settingsWith(options: { active?: string; vision?: boolean; model?: string }): Settings {
  const settings = createDefaultSettings()
  const active = options.active ?? 'p1'
  settings.llm.active = active
  settings.llm.providers['p1'] = {
    type: 'openai-compat',
    baseUrl: 'https://api.example.com/v1',
    apiKeyEnc: '',
    model: options.model ?? 'gpt-x',
    modelList: ['gpt-x'],
    modelParams: {
      'gpt-x': {
        reasoningEffort: 'auto',
        contextWindow: 0,
        vision: options.vision === true,
      },
    },
  }
  return settings
}

describe('visionEnabled', () => {
  it('模型级 vision 为真才是开（v23 起按模型绑定）', () => {
    expect(visionEnabled(settingsWith({ vision: true }))).toBe(true)
    expect(visionEnabled(settingsWith({ vision: false }))).toBe(false)
  })

  it('出厂默认（没配 provider / active 为空）按关处理', () => {
    expect(visionEnabled(createDefaultSettings())).toBe(false)
  })

  it('active 指向不存在的 provider：按关处理（不抛错）', () => {
    const settings = settingsWith({ vision: true })
    settings.llm.active = '已删除的条目'
    expect(visionEnabled(settings)).toBe(false)
  })

  it('当前模型在 modelParams 里没有条目：按默认关处理', () => {
    const settings = settingsWith({ vision: true, model: 'gpt-new' })
    expect(visionEnabled(settings)).toBe(false)
  })
})
