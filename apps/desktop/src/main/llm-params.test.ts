import { describe, expect, it } from 'vitest'
import { withModelParams } from './llm-params.js'
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
