import { describe, expect, it } from 'vitest'
import { llmSwitchRejection, withModelParams } from './llm-params.js'
import type { LlmProviderConfig } from '@aurora/shared'

function provider(overrides: Partial<LlmProviderConfig> = {}): LlmProviderConfig {
  return {
    type: 'openai-compat',
    baseUrl: 'https://api.example.com',
    apiKeyEnc: 'CIPHER-KEY',
    model: 'deepseek-chat',
    modelList: ['deepseek-chat'],
    modelParams: {},
    ...overrides,
  }
}

describe('withModelParams（v23 模型级参数的写入口径）', () => {
  it('目标模型还没有条目时，写出来的是三项齐全的表（不是只写被改的那一项）', () => {
    const next = withModelParams(provider(), { reasoningEffort: 'high' })
    // 关键护栏：`reasoningEffort` 是三个子字段里唯一没有 `.default()` 的，
    // 只写它会让自己在下次启动被 Schema 判为损坏；另两项也要落下来。
    expect(next.modelParams['deepseek-chat']).toEqual({
      reasoningEffort: 'high',
      contextWindow: 0,
      vision: false,
    })
  })

  it('已有条目时整体替换该键的对象：其余字段沿用原值，不被默认值抹掉', () => {
    const next = withModelParams(
      provider({
        modelParams: {
          'deepseek-chat': { reasoningEffort: 'auto', contextWindow: 128_000, vision: true },
        },
      }),
      { reasoningEffort: 'low' },
    )
    expect(next.modelParams['deepseek-chat']).toEqual({
      reasoningEffort: 'low',
      contextWindow: 128_000,
      vision: true,
    })
  })

  it('只影响当前生效模型：其它模型的条目一个都不动', () => {
    const base = provider({
      model: 'b',
      modelParams: {
        a: { reasoningEffort: 'high', contextWindow: 200_000, vision: true },
        b: { reasoningEffort: 'auto', contextWindow: 0, vision: false },
      },
    })
    const next = withModelParams(base, { vision: true })
    // 入参**不被就地改写**（`provider` 是 `settings.mutate` 的 draft 活对象）：
    // 只断言返回值的用例抓不到「原地合并」这类实现（嵌套对象同样要保干净）。
    expect(base.modelParams['b']).toEqual({
      reasoningEffort: 'auto',
      contextWindow: 0,
      vision: false,
    })
    expect(next.modelParams['a']).toEqual({
      reasoningEffort: 'high',
      contextWindow: 200_000,
      vision: true,
    })
    expect(next.modelParams['b']).toEqual({
      reasoningEffort: 'auto',
      contextWindow: 0,
      vision: true,
    })
  })

  it('`model` 为空串时原样返回（没有当前生效模型可写）', () => {
    const base = provider({ model: '', modelParams: {} })
    expect(withModelParams(base, { reasoningEffort: 'high' })).toBe(base)
  })

  it('不改动入参（返回副本），其余字段原样保留', () => {
    const base = provider()
    const next = withModelParams(base, { contextWindow: 32_000 })
    expect(base.modelParams).toEqual({})
    expect(next.baseUrl).toBe(base.baseUrl)
    expect(next.apiKeyEnc).toBe(base.apiKeyEnc)
    expect(next.modelList).toEqual(['deepseek-chat'])
  })

  it('写出来的表三项键齐全（`reasoningEffort` 没有默认值的那道坎）', () => {
    const next = withModelParams(provider(), { vision: true })
    const entry = next.modelParams['deepseek-chat']
    expect(entry).toBeDefined()
    expect(Object.keys(entry ?? {}).sort()).toEqual(['contextWindow', 'reasoningEffort', 'vision'])
  })
})

describe('llmSwitchRejection（远程 llm.switch 的四条前置守卫）', () => {
  const providers = {
    deepseek: { model: 'deepseek-chat' },
    empty: { model: '' },
  }

  it('放行：改模型、改等级、以及「同时改模型+等级」（后者先前被误拦）', () => {
    expect(llmSwitchRejection(providers, 'deepseek', { providerId: 'deepseek' })).toBeUndefined()
    expect(
      llmSwitchRejection(providers, 'deepseek', { model: 'deepseek-reasoner' }),
    ).toBeUndefined()
    expect(llmSwitchRejection(providers, 'deepseek', { reasoningEffort: 'high' })).toBeUndefined()
    // 只切 provider（不改任何字段）
    expect(llmSwitchRejection(providers, 'deepseek', {})).toBeUndefined()
  })

  it('① providerId 不存在 → 拒（绝不新建条目）', () => {
    expect(llmSwitchRejection(providers, 'deepseek', { providerId: 'ghost' })).toContain(
      'provider 不存在',
    )
  })

  it('② 没有任何可用的激活 provider 时改字段 → 拒', () => {
    expect(llmSwitchRejection(providers, 'ghost', { model: 'x' })).toContain(
      '没有可用的激活 provider',
    )
    expect(llmSwitchRejection(providers, 'ghost', { reasoningEffort: 'high' })).toContain(
      '没有可用的激活 provider',
    )
    // 只是切到不存在的 provider：① 先拦（文案不同，顺序是有意的）
    expect(llmSwitchRejection(providers, 'deepseek', { providerId: 'ghost' })).toContain(
      'provider 不存在',
    )
  })

  it('③ 显式把 model 设成空串 → 拒（含只有空白的串）', () => {
    expect(llmSwitchRejection(providers, 'deepseek', { model: '' })).toContain('model 不能为空')
    expect(llmSwitchRejection(providers, 'deepseek', { model: '   ' })).toContain('model 不能为空')
  })

  it('④ 只改等级、而该 provider 还没有生效模型 → 拒（等级是模型级的，没有可归属的键）', () => {
    expect(llmSwitchRejection(providers, 'deepseek', { providerId: 'empty' })).toBeUndefined()
    expect(llmSwitchRejection(providers, 'deepseek', { reasoningEffort: 'high' })).toBeUndefined()
    // 切到 empty 并只改等级 → 拒
    expect(
      llmSwitchRejection(providers, 'deepseek', {
        providerId: 'empty',
        reasoningEffort: 'high',
      }),
    ).toContain('尚未设置模型')
    // 切到 empty 并**同时**给新模型 → 放行（handler 先落模型，等级写在新模型名下）
    expect(
      llmSwitchRejection(providers, 'deepseek', {
        providerId: 'empty',
        model: 'qwen2.5:7b',
        reasoningEffort: 'high',
      }),
    ).toBeUndefined()
  })
})
