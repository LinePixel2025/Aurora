/**
 * Provider 按接口协议分派（docs/06 §3.2，v22）的单测。
 *
 * 为什么值得单独测：分派错了的症状是「设置页测通了、对话却 404」——
 * 两处装配（会话用 / 测试连接用）必须拿到**同一个**类，这条断言就是那道闸。
 */
import { describe, expect, it } from 'vitest'
import { OpenAiCompatProvider, OpenAiResponsesProvider } from '@aurora/agent-core'
import { createLlmProvider } from './llm-provider.js'

const base = {
  id: 'p',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-x',
  defaultModel: 'm',
}

describe('createLlmProvider', () => {
  it('openai-compat → OpenAiCompatProvider', () => {
    expect(createLlmProvider('openai-compat', base)).toBeInstanceOf(OpenAiCompatProvider)
  })

  it('openai-responses → OpenAiResponsesProvider', () => {
    expect(createLlmProvider('openai-responses', base)).toBeInstanceOf(OpenAiResponsesProvider)
  })

  it('缺省 / 未知取值按 openai-compat 处理（与 Schema 默认值、迁移口径一致）', () => {
    expect(createLlmProvider(undefined, base)).toBeInstanceOf(OpenAiCompatProvider)
    // 手改过的配置文件可能带一个不存在的取值：不抛错，退回旧协议
    expect(createLlmProvider('something-else' as never, base)).toBeInstanceOf(OpenAiCompatProvider)
  })

  it('两个实现都提供 listModels / testConnection（装配层的窄化不是空承诺）', () => {
    for (const type of ['openai-compat', 'openai-responses'] as const) {
      const built = createLlmProvider(type, base)
      expect(typeof built.listModels).toBe('function')
      expect(typeof built.testConnection).toBe('function')
      expect(built.id).toBe('p')
    }
  })
})
