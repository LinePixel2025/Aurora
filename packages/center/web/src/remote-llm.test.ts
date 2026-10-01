import { describe, expect, it } from 'vitest'
import { extractRemoteLlm } from './remote-llm.js'

/**
 * 网页端的 LLM 切片解析（v23 起取值是**模型级**的）。
 *
 * 这三处显示都吃它的输出：模型下拉的候选、思考等级、上下文占比的**分母**。
 * 分母错了会显示成另一档百分比，而「切模型后分母跟着换」正是本轮修过的一个真问题
 * （`switchLlm` 成功后要补一次 `fetchRemoteConfig`）。
 */
describe('extractRemoteLlm（config.get 的 llm 切片）', () => {
  function provider(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      model: 'gpt-4.1',
      modelList: ['gpt-4.1', 'gpt-4.1-mini'],
      modelParams: {
        'gpt-4.1': { reasoningEffort: 'high', contextWindow: 128_000, vision: true },
        'gpt-4.1-mini': { reasoningEffort: 'auto', contextWindow: 32_000, vision: false },
      },
      ...overrides,
    }
  }

  it('取的是**当前模型**那一份参数（含点模型 id 也能取到）', () => {
    const result = extractRemoteLlm({
      llm: { active: 'openai', providers: { openai: provider() } },
    })
    expect(result).toEqual({
      active: 'openai',
      providers: {
        openai: {
          model: 'gpt-4.1',
          modelList: ['gpt-4.1', 'gpt-4.1-mini'],
          contextWindow: 128_000,
          reasoningEffort: 'high',
        },
      },
    })
  })

  it('换模型后分母跟着换（同一 provider 的两份参数各归各的）', () => {
    const switched = extractRemoteLlm({
      llm: { active: 'openai', providers: { openai: provider({ model: 'gpt-4.1-mini' }) } },
    })
    expect(switched?.providers['openai']?.contextWindow).toBe(32_000)
    expect(switched?.providers['openai']?.reasoningEffort).toBe('auto')
  })

  it('键未命中 / 字段缺失 / 值非法一律按字段回落 0 与 auto（不把 undefined 漏出去）', () => {
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ model: 'ghost', modelParams: { 'gpt-4.1': {} } }, 0, 'auto'],
      [{ model: 'gpt-4.1', modelParams: {} }, 0, 'auto'],
      [{ model: 'gpt-4.1' }, 0, 'auto'],
      [{ model: 'gpt-4.1', modelParams: { 'gpt-4.1': { contextWindow: '128k' } } }, 0, 'auto'],
      [{ model: 'gpt-4.1', modelParams: { 'gpt-4.1': { reasoningEffort: 'ultra' } } }, 0, 'auto'],
      // `modelParams` 本身不是对象
      [{ model: 'gpt-4.1', modelParams: 'nope' }, 0, 'auto'],
    ]
    for (const [raw, contextWindow, reasoningEffort] of cases) {
      const result = extractRemoteLlm({ llm: { active: 'a', providers: { a: raw } } })
      expect(result?.providers['a']?.contextWindow).toBe(contextWindow)
      expect(result?.providers['a']?.reasoningEffort).toBe(reasoningEffort)
    }
  })

  it('非法输入返回 null / 空表，不抛错（脱敏配置可能缺字段）', () => {
    expect(extractRemoteLlm(null)).toBeNull()
    expect(extractRemoteLlm('nope')).toBeNull()
    expect(extractRemoteLlm({})).toBeNull()
    expect(extractRemoteLlm({ llm: null })).toBeNull()
    expect(extractRemoteLlm({ llm: {} })).toEqual({ active: '', providers: {} })
    expect(extractRemoteLlm({ llm: { active: 42, providers: [] } })).toEqual({
      active: '',
      providers: {},
    })
  })

  it('非对象 provider 与混入的非字符串候选项被逐个剔掉，不污染下一位', () => {
    const result = extractRemoteLlm({
      llm: {
        active: 'a',
        providers: { a: provider(), bad: 'nope', b: { modelList: ['x', 1, null, 'y'] } },
      },
    })
    expect(Object.keys(result?.providers ?? {})).toEqual(['a', 'b'])
    expect(result?.providers['b']?.modelList).toEqual(['x', 'y'])
    expect(result?.providers['b']?.model).toBe('')
  })
})
