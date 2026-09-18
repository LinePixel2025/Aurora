import { createServer, type Server } from 'node:http'
import { describe, expect, it } from 'vitest'
import { OpenAiCompatProvider, normalizeBaseUrl, statusToCode } from './openai-compat.js'
import { isLlmError } from './types.js'
import { collect, createFetchStub, sseLine } from '../testing/fetchStub.js'

/** 启动测试用本地 HTTP 服务并等它真正开始监听 */
function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
}

function provider(
  responses: Parameters<typeof createFetchStub>[0],
  overrides: Partial<ConstructorParameters<typeof OpenAiCompatProvider>[0]> = {},
) {
  const stub = createFetchStub(responses)
  const instance = new OpenAiCompatProvider({
    id: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1/',
    apiKey: 'sk-test',
    defaultModel: 'deepseek-chat',
    maxRetries: 0,
    fetchImpl: stub.fetch,
    ...overrides,
  })
  return { instance, stub }
}

describe('normalizeBaseUrl / statusToCode', () => {
  it('去掉尾部斜杠与空白', () => {
    expect(normalizeBaseUrl(' https://api.deepseek.com/v1/ ')).toBe('https://api.deepseek.com/v1')
  })

  it('HTTP 状态码映射为稳定错误码', () => {
    expect(statusToCode(401)).toBe('E_AUTH')
    expect(statusToCode(403)).toBe('E_AUTH')
    expect(statusToCode(404)).toBe('E_NOT_FOUND')
    expect(statusToCode(429)).toBe('E_RATE_LIMIT')
    expect(statusToCode(400)).toBe('E_BAD_REQUEST')
    expect(statusToCode(503)).toBe('E_SERVER')
  })
})

describe('OpenAiCompatProvider.chat', () => {
  it('流式文本按分片推送并以 done 结束', async () => {
    const { instance, stub } = provider([
      {
        sseChunks: [
          sseLine({ choices: [{ delta: { content: '你' } }] }),
          sseLine({ choices: [{ delta: { content: '好' } }] }),
          sseLine({
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }),
          'data: [DONE]\n\n',
        ],
      },
    ])

    const events = await collect(
      instance.chat({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] }),
    )
    expect(
      events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta),
    ).toEqual(['你', '好'])
    const done = events.at(-1)
    expect(done).toMatchObject({ type: 'done', finishReason: 'stop' })
    expect(events.some((e) => e.type === 'error')).toBe(false)

    expect(stub.calls[0]?.url).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(stub.calls[0]?.headers['authorization']).toBe('Bearer sk-test')
    expect(stub.calls[0]?.headers['accept']).toBe('text/event-stream')
    const body = stub.calls[0]?.body as Record<string, unknown>
    expect(body['stream']).toBe(true)
    expect(body['model']).toBe('deepseek-chat')
  })

  it('跨 chunk 分片的 JSON 仍能正确解析', async () => {
    const payload = sseLine({ choices: [{ delta: { content: '分片文本' } }] })
    const cut = Math.floor(payload.length / 2)
    const { instance } = provider([
      { sseChunks: [payload.slice(0, cut), payload.slice(cut), 'data: [DONE]\n\n'] },
    ])
    const events = await collect(instance.chat({ model: 'm', messages: [] }))
    expect(events.filter((e) => e.type === 'text')).toHaveLength(1)
    expect((events[0] as { delta: string }).delta).toBe('分片文本')
  })

  it('聚合分片的 tool_calls', async () => {
    const { instance } = provider([
      {
        sseChunks: [
          sseLine({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_1', function: { name: 'use_skill', arguments: '{"na' } },
                  ],
                },
              },
            ],
          }),
          sseLine({
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: 'me":"x"}' } }] } },
            ],
          }),
          sseLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
          'data: [DONE]\n\n',
        ],
      },
    ])
    const events = await collect(instance.chat({ model: 'm', messages: [] }))
    const toolCall = events.find((e) => e.type === 'tool_call')
    expect(toolCall).toMatchObject({
      type: 'tool_call',
      call: { id: 'call_1', name: 'use_skill', arguments: '{"name":"x"}' },
    })
  })

  it('请求体包含 tools / temperature / json 模式', async () => {
    const { instance, stub } = provider([{ sseChunks: ['data: [DONE]\n\n'] }])
    await collect(
      instance.chat({
        model: 'm',
        messages: [
          { role: 'system', content: '人设' },
          { role: 'user', content: 'hi' },
        ],
        temperature: 0.2,
        maxTokens: 128,
        jsonObject: true,
        tools: [{ name: 't', description: 'd', parameters: { type: 'object', properties: {} } }],
      }),
    )
    const body = stub.calls[0]?.body as Record<string, unknown>
    expect(body['temperature']).toBe(0.2)
    expect(body['max_tokens']).toBe(128)
    expect(body['response_format']).toEqual({ type: 'json_object' })
    expect(body['tools']).toEqual([
      {
        type: 'function',
        function: { name: 't', description: 'd', parameters: { type: 'object', properties: {} } },
      },
    ])
  })

  it('HTTP 错误转为 error 事件（不抛给调用方）', async () => {
    const { instance } = provider([{ status: 401, text: 'invalid api key' }])
    const events = await collect(instance.chat({ model: 'm', messages: [] }))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error', code: 'E_AUTH' })
    expect((events[0] as { message: string }).message).toContain('401')
  })

  it('取消信号产生 E_ABORTED', async () => {
    const controller = new AbortController()
    controller.abort()
    const { instance } = provider([{ sseChunks: ['data: [DONE]\n\n'] }])
    const events = await collect(instance.chat({ model: 'm', messages: [] }, controller.signal))
    expect(events.some((e) => e.type === 'text')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'E_ABORTED' })
  })

  it('5xx 可重试，重试后成功', async () => {
    const { instance, stub } = provider(
      [
        { status: 503, text: 'busy' },
        { sseChunks: [sseLine({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'] },
      ],
      { maxRetries: 2, retryBaseDelayMs: 1 },
    )
    const events = await collect(instance.chat({ model: 'm', messages: [] }))
    expect(stub.calls).toHaveLength(2)
    expect(events.some((e) => e.type === 'text')).toBe(true)
  })

  it('4xx（非限流）不重试', async () => {
    const { instance, stub } = provider([{ status: 400, text: 'bad' }], { maxRetries: 3 })
    const events = await collect(instance.chat({ model: 'm', messages: [] }))
    expect(stub.calls).toHaveLength(1)
    expect(events[0]).toMatchObject({ code: 'E_BAD_REQUEST' })
  })
})

describe('OpenAiCompatProvider.listModels / testConnection', () => {
  it('GET /models 并归一化返回', async () => {
    const { instance, stub } = provider([
      {
        json: {
          data: [
            { id: 'deepseek-chat', owned_by: 'deepseek' },
            { id: 'deepseek-reasoner' },
            { bad: true },
          ],
        },
      },
    ])
    const models = await instance.listModels()
    expect(models).toEqual([
      { id: 'deepseek-chat', ownedBy: 'deepseek' },
      { id: 'deepseek-reasoner' },
    ])
    expect(stub.calls[0]?.method).toBe('GET')
    expect(stub.calls[0]?.url).toBe('https://api.deepseek.com/v1/models')
  })

  it('GET /models 不携带请求体', async () => {
    const { instance, stub } = provider([{ json: { data: [{ id: 'deepseek-chat' }] } }])
    await instance.listModels()
    // 给 GET 挂 body 会被 undici 直接拒绝（Request with GET/HEAD method cannot have body.）
    expect(stub.calls[0]?.body).toBeUndefined()
  })

  it('真实 fetch（undici）下 GET /models 可用：回归「GET 带 body」崩溃', async () => {
    const received: Array<{ method: string; url: string; bytes: number }> = []
    const server = createServer((req, res) => {
      received.push({ method: req.method ?? '', url: req.url ?? '', bytes: 0 })
      req.on('data', (chunk: Buffer) => {
        const last = received[received.length - 1]
        if (last) last.bytes += chunk.length
      })
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'local-model' }] }))
      })
    })
    await listen(server)
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('无法获取测试服务端口')
      // 注意：不注入 fetchImpl，走真实 undici —— 这正是单测替身覆盖不到的地方
      const instance = new OpenAiCompatProvider({
        id: 'local',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: 'sk-test',
        defaultModel: 'local-model',
        maxRetries: 0,
      })
      const models = await instance.listModels()
      expect(models).toEqual([{ id: 'local-model' }])
      expect(received[0]?.method).toBe('GET')
      expect(received[0]?.url).toBe('/v1/models')
      expect(received[0]?.bytes).toBe(0)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('测试连接成功返回延迟与模型数', async () => {
    const { instance } = provider([{ json: { data: [{ id: 'deepseek-chat' }] } }])
    const result = await instance.testConnection()
    expect(result.ok).toBe(true)
    expect(result.message).toContain('连接成功')
    expect(result.models).toEqual(['deepseek-chat'])
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('认证失败返回可读原因', async () => {
    const { instance } = provider([{ status: 401, text: 'invalid api key' }])
    const result = await instance.testConnection()
    expect(result.ok).toBe(false)
    expect(result.httpStatus).toBe(401)
    expect(result.message).toContain('认证失败')
  })

  it('/models 404 时退化为最小 chat 探测', async () => {
    const { instance, stub } = provider([
      { status: 404, text: 'not found' },
      { json: { choices: [{ message: { content: 'pong' } }] } },
    ])
    const result = await instance.testConnection()
    expect(result.ok).toBe(true)
    expect(result.message).toContain('未提供模型列表接口')
    expect(stub.calls).toHaveLength(2)
  })

  it('网络异常返回 E_NETWORK 描述', async () => {
    const { instance } = provider([{ throwError: new Error('getaddrinfo ENOTFOUND') }], {
      maxRetries: 0,
    })
    const result = await instance.testConnection()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('网络异常')
  })
})

describe('构造函数防御', () => {
  it('fetchImpl 非函数时抛出 LlmError', () => {
    expect(
      () =>
        new OpenAiCompatProvider({
          id: 'x',
          baseUrl: 'http://localhost',
          apiKey: '',
          defaultModel: 'm',
          fetchImpl: 'not-a-function' as unknown as typeof fetch,
        }),
    ).toThrowError(/不提供 fetch/)
  })

  it('未显式注入时使用全局 fetch', () => {
    const instance = new OpenAiCompatProvider({
      id: 'x',
      baseUrl: 'http://localhost:1/v1',
      apiKey: '',
      defaultModel: 'm',
    })
    expect(instance.id).toBe('x')
  })

  it('isLlmError 可跨模块副本判定', () => {
    expect(isLlmError({ name: 'LlmError', code: 'E_AUTH' })).toBe(true)
    expect(isLlmError(new Error('x'))).toBe(false)
    expect(isLlmError(null)).toBe(false)
  })
})
