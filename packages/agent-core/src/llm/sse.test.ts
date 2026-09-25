import { describe, expect, it } from 'vitest'
import { extractDelta, extractReasoningDelta, parseSseChunk, parseSseData } from './sse.js'

describe('parseSseChunk', () => {
  it('解析单条完整事件', () => {
    const { events, rest } = parseSseChunk('data: {"a":1}\n\n')
    expect(events).toEqual(['{"a":1}'])
    expect(rest).toBe('')
  })

  it('多条事件一次性解析', () => {
    const { events } = parseSseChunk('data: 1\n\ndata: 2\n\ndata: 3\n\n')
    expect(events).toEqual(['1', '2', '3'])
  })

  it('未结束的分片留在 rest，与下一片拼接后可解析', () => {
    const first = parseSseChunk('data: {"cho')
    expect(first.events).toEqual([])
    expect(first.rest).toBe('data: {"cho')

    const second = parseSseChunk(`${first.rest}ices":[]}\n\n`)
    expect(second.events).toEqual(['{"choices":[]}'])
    expect(second.rest).toBe('')
  })

  it('跨 chunk 的 UTF-8 中文与多行 data 合并', () => {
    const { events } = parseSseChunk('data: 第一行\ndata: 第二行\n\n')
    expect(events).toEqual(['第一行\n第二行'])
  })

  it('兼容 CRLF 与注释行、event/id 字段', () => {
    const { events } = parseSseChunk(': keep-alive\r\nevent: message\r\nid: 7\r\ndata: hi\r\n\r\n')
    expect(events).toEqual(['hi'])
  })

  it('data: 后无空格也能解析', () => {
    const { events } = parseSseChunk('data:{"x":1}\n\n')
    expect(events).toEqual(['{"x":1}'])
  })
})

describe('parseSseData', () => {
  it('[DONE] 视为流结束标记', () => {
    expect(parseSseData('[DONE]')).toBeNull()
    expect(parseSseData('  [DONE] "')).toBeUndefined()
  })

  it('单对象与数组都归一为数组', () => {
    expect(parseSseData('{"a":1}')).toEqual([{ a: 1 }])
    expect(parseSseData('[{"a":1},{"b":2}]')).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('非法 JSON 返回 undefined 由调用方忽略', () => {
    expect(parseSseData('not-json')).toBeUndefined()
  })
})

describe('extractDelta', () => {
  it('取出全部 choices 的增量文本', () => {
    expect(
      extractDelta({ choices: [{ delta: { content: '你' } }, { delta: { content: '好' } }] }),
    ).toBe('你好')
  })

  it('工具调用分片与空 choices 返回空串', () => {
    expect(extractDelta({ choices: [{ delta: { tool_calls: [{ index: 0 }] } }] })).toBe('')
    expect(extractDelta({ choices: [] })).toBe('')
    expect(extractDelta(null)).toBe('')
  })
})

describe('extractReasoningDelta', () => {
  it('读取 reasoning_content 字段（DeepSeek / Kimi 口径）', () => {
    expect(extractReasoningDelta({ choices: [{ delta: { reasoning_content: '让我想' } }] })).toBe(
      '让我想',
    )
  })

  it('读取 reasoning 字段（OpenRouter 口径）', () => {
    expect(extractReasoningDelta({ choices: [{ delta: { reasoning: '一下' } }] })).toBe('一下')
  })

  it('同一分片同时给两个字段时 reasoning_content 优先', () => {
    expect(
      extractReasoningDelta({
        choices: [{ delta: { reasoning_content: 'A', reasoning: 'B' } }],
      }),
    ).toBe('A')
  })

  it('跨多条 choices 拼接', () => {
    expect(
      extractReasoningDelta({
        choices: [{ delta: { reasoning: '你' } }, { delta: { reasoning: '好' } }],
      }),
    ).toBe('你好')
  })

  it('null 与缺失字段都视为没有思考链', () => {
    expect(extractReasoningDelta({ choices: [{ delta: { reasoning_content: null } }] })).toBe('')
    expect(extractReasoningDelta({ choices: [{ delta: { reasoning: null } }] })).toBe('')
    expect(extractReasoningDelta({ choices: [{ delta: { content: '正文' } }] })).toBe('')
    expect(extractReasoningDelta({ choices: [] })).toBe('')
    expect(extractReasoningDelta(null)).toBe('')
  })

  it('非字符串的 reasoning 字段不参与拼接', () => {
    expect(extractReasoningDelta({ choices: [{ delta: { reasoning: 42 } }] })).toBe('')
  })
})
