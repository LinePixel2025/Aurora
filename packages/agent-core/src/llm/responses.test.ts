/**
 * Responses API provider（docs/06 §3.2，v22）的接口契约测试。
 *
 * 覆盖三件在真实网关上踩过 / 容易踩的事：
 * 1. **请求体形状** —— `instructions` 只吃首条 system 消息、工具结果是独立条目、
 *    `tools` 是扁平形状、`store: false` 恒定下发；
 * 2. **工具调用 id 必须是 `call_id`**（不是条目 id `fc_…`）—— 用错会让第二轮请求被服务端
 *    直接拒绝，表现为「工具跑完了但对话再也继续不下去」；
 * 3. **收尾语义** —— `response.completed` 的用量与 `response.failed` 的错误都要如实透传。
 */
import { describe, expect, it } from 'vitest'
import {
  OpenAiResponsesProvider,
  handleResponsesEvent,
  toResponsesBody,
  toResponsesInput,
  type PendingCall,
} from './responses.js'
import type { ChatEvent } from './types.js'
import { collect, createFetchStub, sseLine } from '../testing/fetchStub.js'

function provider(
  responses: Parameters<typeof createFetchStub>[0],
  overrides: Partial<ConstructorParameters<typeof OpenAiResponsesProvider>[0]> = {},
) {
  const stub = createFetchStub(responses)
  const instance = new OpenAiResponsesProvider({
    id: 'openai',
    baseUrl: 'https://api.openai.com/v1/',
    apiKey: 'sk-test',
    defaultModel: 'gpt-4o-mini',
    maxRetries: 0,
    fetchImpl: stub.fetch,
    ...overrides,
  })
  return { instance, stub }
}

/** 一次「文本流」的完整事件序列（真实网关的最小形态） */
function textStream(text: string, usage?: Record<string, unknown>): string[] {
  return [
    sseLine({ type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } }),
    sseLine({
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: 'msg_1', type: 'message' },
    }),
    sseLine({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta: text }),
    sseLine({ type: 'response.output_text.done', item_id: 'msg_1', output_index: 0, text }),
    sseLine({
      type: 'response.completed',
      response: { id: 'resp_1', status: 'completed', ...(usage === undefined ? {} : { usage }) },
    }),
  ]
}

describe('toResponsesInput', () => {
  it('首条 system 消息进 instructions，其余 system 消息留在原位', () => {
    const { instructions, input } = toResponsesInput([
      { role: 'system', content: '系统提示词' },
      { role: 'user', content: '提问' },
      // extraContext（技能正文 / 附件文本）：必须留在用户消息**之后**，前缀缓存才不被破坏
      { role: 'system', content: '附加上下文' },
    ])
    expect(instructions).toBe('系统提示词')
    expect(input).toEqual([
      { role: 'user', content: '提问' },
      { role: 'system', content: '附加上下文' },
    ])
  })

  it('无图片时 content 是纯字符串，有图片时是 input_text + input_image 分片', () => {
    const { input } = toResponsesInput([
      {
        role: 'user',
        content: '看看这张图',
        images: [{ mimeType: 'image/png', dataBase64: 'AAA', name: 'a.png' }],
      },
    ])
    expect(input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: '看看这张图' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
        ],
      },
    ])
  })

  it('正文为空的图片消息只发图片分片（不发空 text 分片）', () => {
    const { input } = toResponsesInput([
      { role: 'user', content: '', images: [{ mimeType: 'image/jpeg', dataBase64: 'BBB' }] },
    ])
    expect(input).toEqual([
      { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/jpeg;base64,BBB' }] },
    ])
  })

  it('工具调用与结果是独立条目，call_id 与 assistant 消息分列', () => {
    const { input } = toResponsesInput([
      { role: 'user', content: '跑一下' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_abc', name: 'run_command', arguments: '{"command":"dir"}' }],
      },
      { role: 'tool', content: '退出码 0', toolCallId: 'call_abc' },
    ])
    expect(input).toEqual([
      { role: 'user', content: '跑一下' },
      {
        type: 'function_call',
        call_id: 'call_abc',
        name: 'run_command',
        arguments: '{"command":"dir"}',
      },
      { type: 'function_call_output', call_id: 'call_abc', output: '退出码 0' },
    ])
  })

  it('assistant 正文为空且没有工具调用时不产生空条目', () => {
    const { input } = toResponsesInput([{ role: 'assistant', content: '' }])
    expect(input).toEqual([])
  })
})

describe('toResponsesBody', () => {
  const base = { model: 'gpt-4o-mini', messages: [{ role: 'system', content: 'sys' }] }

  it('恒定下发 stream 与 store: false（不在服务端留存会话）', () => {
    const body = toResponsesBody({ ...base }, 'fallback')
    expect(body['stream']).toBe(true)
    expect(body['store']).toBe(false)
    expect(body['model']).toBe('gpt-4o-mini')
    expect(body['instructions']).toBe('sys')
  })

  it('可选参数缺省时**完全不出现**（推理模型收到 temperature 会直接 400）', () => {
    const body = toResponsesBody({ ...base }, 'fallback')
    expect('temperature' in body).toBe(false)
    expect('max_output_tokens' in body).toBe(false)
    expect('reasoning' in body).toBe(false)
    expect('text' in body).toBe(false)
    expect('tools' in body).toBe(false)
  })

  it('思考等级 / 温度 / 工具按设置下发，工具是扁平形状', () => {
    const body = toResponsesBody(
      {
        ...base,
        temperature: 0.3,
        maxTokens: 512,
        reasoningEffort: 'high',
        jsonObject: true,
        tools: [
          {
            name: 'read_file',
            description: '读文件',
            parameters: { type: 'object', properties: {} },
          },
        ],
      },
      'fallback',
    )
    expect(body['temperature']).toBe(0.3)
    expect(body['max_output_tokens']).toBe(512)
    expect(body['reasoning']).toEqual({ effort: 'high' })
    expect(body['text']).toEqual({ format: { type: 'json_object' } })
    expect(body['tools']).toEqual([
      {
        type: 'function',
        name: 'read_file',
        description: '读文件',
        parameters: { type: 'object', properties: {} },
        strict: false,
      },
    ])
    expect(body['tool_choice']).toBe('auto')
  })

  it('model 为空串时回落到默认模型', () => {
    expect(toResponsesBody({ ...base, model: '' }, 'gpt-4o-mini')['model']).toBe('gpt-4o-mini')
  })
})

describe('OpenAiResponsesProvider.chat', () => {
  it('打到 /responses，流式文本、用量与收尾原因都透传', async () => {
    const { instance, stub } = provider([
      {
        sseChunks: textStream('你好', {
          input_tokens: 12,
          output_tokens: 3,
          total_tokens: 15,
          input_tokens_details: { cached_tokens: 8 },
        }),
      },
    ])
    const events = await collect(
      instance.chat({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
    )
    expect(stub.calls[0]?.url).toBe('https://api.openai.com/v1/responses')
    expect(stub.calls[0]?.headers['authorization']).toBe('Bearer sk-test')
    const text = events
      .filter((event): event is Extract<ChatEvent, { type: 'text' }> => event.type === 'text')
      .map((event) => event.delta)
      .join('')
    expect(text).toBe('你好')
    const done = events.at(-1)
    expect(done).toMatchObject({ type: 'done', finishReason: 'stop' })
    expect(done?.type === 'done' ? done.usage : undefined).toEqual({
      promptTokens: 12,
      completionTokens: 3,
      totalTokens: 15,
      cachedTokens: 8,
    })
  })

  it('思考增量（reasoning summary / reasoning text）映射为 reasoning 事件', async () => {
    const { instance } = provider([
      {
        sseChunks: [
          sseLine({ type: 'response.reasoning_summary_text.delta', delta: '先想' }),
          sseLine({ type: 'response.reasoning_text.delta', delta: '再想' }),
          ...textStream('答案'),
        ],
      },
    ])
    const events = await collect(
      instance.chat({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
    )
    expect(
      events
        .filter((event) => event.type === 'reasoning')
        .map((event) => (event.type === 'reasoning' ? event.delta : ''))
        .join(''),
    ).toBe('先想再想')
  })

  it('工具调用用 call_id 收口，并把工具结果按协议回填', async () => {
    const { instance, stub } = provider([
      {
        sseChunks: [
          sseLine({
            type: 'response.output_item.added',
            output_index: 0,
            // 注意：条目 id 是 fc_1，配对用的 call_id 是 call_1 —— 二者不同才是真实形态
            item: {
              id: 'fc_1',
              type: 'function_call',
              call_id: 'call_1',
              name: 'read_file',
              arguments: '',
            },
          }),
          sseLine({
            type: 'response.function_call_arguments.delta',
            item_id: 'fc_1',
            delta: '{"path":',
          }),
          sseLine({
            type: 'response.function_call_arguments.delta',
            item_id: 'fc_1',
            delta: '"a.txt"}',
          }),
          sseLine({
            type: 'response.function_call_arguments.done',
            item_id: 'fc_1',
            arguments: '{"path":"a.txt"}',
          }),
          sseLine({
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              id: 'fc_1',
              type: 'function_call',
              call_id: 'call_1',
              name: 'read_file',
              arguments: '{"path":"a.txt"}',
            },
          }),
          sseLine({
            type: 'response.completed',
            response: {
              status: 'completed',
              usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
            },
          }),
        ],
      },
      { sseChunks: textStream('读完了') },
    ])
    const first = await collect(
      instance.chat({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: '读 a.txt' }] }),
    )
    const call = first.find((event) => event.type === 'tool_call')
    expect(call).toMatchObject({
      type: 'tool_call',
      call: { id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
    })
    // 工具调用存在时收尾原因应为 tool_calls（服务端常只给 stop，这里按事实纠正）
    expect(first.at(-1)).toMatchObject({ type: 'done', finishReason: 'tool_calls' })

    // 第二轮：把工具结果回填，断言请求体里的 function_call_output 用的是 call_id
    await collect(
      instance.chat({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'user', content: '读 a.txt' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' }],
          },
          { role: 'tool', content: '文件内容', toolCallId: 'call_1' },
        ],
      }),
    )
    const secondBody = stub.calls[1]?.body as { input: Array<Record<string, unknown>> }
    expect(secondBody.input).toContainEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: '文件内容',
    })
  })

  it('网关不发 output_item.done 时，从 response.completed 的 output 里补发工具调用', async () => {
    const { instance } = provider([
      {
        sseChunks: [
          sseLine({
            type: 'response.completed',
            response: {
              status: 'completed',
              output: [
                {
                  type: 'function_call',
                  id: 'fc_9',
                  call_id: 'call_9',
                  name: 'glob',
                  arguments: '{"pattern":"*.ts"}',
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          }),
        ],
      },
    ])
    const events = await collect(
      instance.chat({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
    )
    expect(events.find((event) => event.type === 'tool_call')).toMatchObject({
      call: { id: 'call_9', name: 'glob', arguments: '{"pattern":"*.ts"}' },
    })
  })

  it('response.incomplete（max_output_tokens）收尾为 length', async () => {
    const { instance } = provider([
      {
        sseChunks: [
          sseLine({ type: 'response.output_text.delta', delta: '半截' }),
          sseLine({
            type: 'response.incomplete',
            response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
          }),
        ],
      },
    ])
    const events = await collect(
      instance.chat({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
    )
    expect(events.at(-1)).toMatchObject({ type: 'done', finishReason: 'length' })
    // 网关没回 usage 时**不编造 0**：`done` 事件里就不该有 usage 字段
    const done = events.at(-1)
    expect(done?.type === 'done' && 'usage' in done).toBe(false)
  })

  it('response.failed 映射为 error 事件（不静默当成空回复）', async () => {
    const { instance } = provider([
      {
        sseChunks: [
          sseLine({
            type: 'response.failed',
            response: { status: 'failed', error: { code: 'server_error', message: '上游炸了' } },
          }),
        ],
      },
    ])
    const events = await collect(
      instance.chat({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
    )
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      code: 'E_SERVER',
      message: 'server_error: 上游炸了',
    })
  })

  it('HTTP 错误按状态码映射（401 → E_AUTH），不重试', async () => {
    const { instance } = provider([{ status: 401, text: 'bad key' }])
    const events = await collect(
      instance.chat({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
    )
    expect(events).toEqual([{ type: 'error', code: 'E_AUTH', message: 'HTTP 401 bad key' }])
  })

  it('取消信号中止流（E_ABORTED）', async () => {
    const controller = new AbortController()
    const { instance } = provider([{ sseChunks: textStream('永远读不完') }])
    controller.abort()
    const events = await collect(
      instance.chat(
        { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
        controller.signal,
      ),
    )
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'E_ABORTED' })
  })
})

describe('handleResponsesEvent 的边界', () => {
  const calls = (): Map<string, PendingCall> => new Map<string, PendingCall>()

  it('不认识的事件静默忽略（各家网关实现子集不同）', () => {
    expect(handleResponsesEvent({ type: 'response.in_progress' }, calls())).toEqual([])
    expect(handleResponsesEvent({ type: 'response.something.new' }, calls())).toEqual([])
    expect(handleResponsesEvent('not an object', calls())).toEqual([])
    expect(handleResponsesEvent({ no: 'type' }, calls())).toEqual([])
  })

  it('空 delta 不产生事件（避免把空串推给渲染层）', () => {
    expect(
      handleResponsesEvent({ type: 'response.output_text.delta', delta: '' }, calls()),
    ).toEqual([])
  })

  it('output_item.added 只认 function_call 条目', () => {
    const map = calls()
    expect(
      handleResponsesEvent(
        { type: 'response.output_item.added', item: { id: 'msg_1', type: 'message' } },
        map,
      ),
    ).toEqual([])
    expect(map.size).toBe(0)
    handleResponsesEvent(
      {
        type: 'response.output_item.added',
        item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'glob' },
      },
      map,
    )
    expect(map.get('fc_1')).toMatchObject({ callId: 'call_1', name: 'glob' })
  })

  it('缺少 usage 的 completed 只给收尾原因，不伪造用量', () => {
    const out = handleResponsesEvent(
      { type: 'response.completed', response: { status: 'completed' } },
      calls(),
    )
    expect(out).toEqual([{ kind: 'done', finishReason: 'stop' }])
  })
})
