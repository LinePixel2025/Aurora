import { createServer, type Server } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  OpenAiCompatProvider,
  normalizeBaseUrl,
  statusToCode,
  toOpenAiContent,
} from './openai-compat.js'
import { isLlmError, type TokenUsage } from './types.js'
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

/**
 * 取一轮流式响应里 `done` 事件携带的 usage。
 *
 * `extractUsage` 是模块私有函数（**不为测试放宽导出面**），所以走真实链路间接断言：
 * 桩服务在最后一片里塞进 usage，解析结果只能从 `done` 事件读出来。
 */
async function usageFromStream(usage: Record<string, unknown>): Promise<TokenUsage | undefined> {
  const { instance } = provider([
    {
      sseChunks: [
        sseLine({ choices: [{ delta: { content: '好' } }] }),
        sseLine({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }),
        'data: [DONE]\n\n',
      ],
    },
  ])
  const events = await collect(
    instance.chat({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] }),
  )
  const last = events.at(-1)
  if (last?.type !== 'done') throw new Error('setup: 未收到 done 事件')
  return last.usage
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

  it('流式请求带上 stream_options.include_usage（否则拿不到 usage 事件）', async () => {
    const { instance, stub } = provider([
      { sseChunks: [sseLine({ choices: [{ delta: { content: '好' } }] }), 'data: [DONE]\n\n'] },
    ])
    await collect(
      instance.chat({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] }),
    )
    const body = stub.calls[0]?.body as Record<string, unknown>
    expect(body['stream_options']).toEqual({ include_usage: true })
  })

  it('服务端点名拒绝 stream_options 时去掉它重试一次（不认这个字段的网关也能用）', async () => {
    const { instance, stub } = provider([
      {
        status: 400,
        text: '{"error":{"message":"Unrecognized request argument supplied: stream_options"}}',
      },
      { sseChunks: [sseLine({ choices: [{ delta: { content: '好' } }] }), 'data: [DONE]\n\n'] },
    ])
    const events = await collect(
      instance.chat({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] }),
    )
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(events.filter((event) => event.type === 'text')).toHaveLength(1)
    expect(stub.calls).toHaveLength(2)
    // 第一次带字段（被拒），第二次必须已经摘掉
    expect((stub.calls[0]?.body as Record<string, unknown>)['stream_options']).toEqual({
      include_usage: true,
    })
    expect('stream_options' in (stub.calls[1]?.body as Record<string, unknown>)).toBe(false)
  })

  it('不点名、只说「未知参数」的 400 也要降级（网关措辞五花八门）', async () => {
    const { instance, stub } = provider([
      { status: 400, text: '{"error":{"message":"Extra inputs are not permitted"}}' },
      { sseChunks: [sseLine({ choices: [{ delta: { content: '好' } }] }), 'data: [DONE]'] },
    ])
    const events = await collect(
      instance.chat({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] }),
    )
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(stub.calls).toHaveLength(2)
    expect('stream_options' in (stub.calls[1]?.body as Record<string, unknown>)).toBe(false)
  })

  it('降级用「降级」语义回报 onRetry（reason 有值，不是无延迟的退避重试）', async () => {
    const retries: Array<{ attempt: number; reason?: string }> = []
    const { instance } = provider(
      [
        { status: 400, text: '{"error":{"message":"unknown parameter: stream_options"}}' },
        { sseChunks: [sseLine({ choices: [{ delta: { content: '好' } }] }), 'data: [DONE]'] },
      ],
      {
        onRetry: (info) =>
          retries.push({
            attempt: info.attempt,
            ...(info.reason === undefined ? {} : { reason: info.reason }),
          }),
      },
    )
    await collect(
      instance.chat({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] }),
    )
    expect(retries).toHaveLength(1)
    expect(retries[0]?.reason).toContain('stream_options')
  })

  it('其它 400（报文未提 stream_options）不重试，如实报错', async () => {
    const { instance, stub } = provider([
      { status: 400, text: '{"error":{"message":"model not found"}}' },
    ])
    const events = await collect(
      instance.chat({ model: 'nope', messages: [{ role: 'user', content: 'hi' }] }),
    )
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'E_BAD_REQUEST' })
    expect(stub.calls).toHaveLength(1)
  })

  it('usage 从最后一片透传到 done 事件（prompt/completion/total）', async () => {
    const { instance } = provider([
      {
        sseChunks: [
          sseLine({ choices: [{ delta: { content: '好' } }] }),
          sseLine({
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 },
          }),
          'data: [DONE]\n\n',
        ],
      },
    ])
    const events = await collect(
      instance.chat({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] }),
    )
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      usage: { promptTokens: 120, completionTokens: 8, totalTokens: 128 },
    })
  })

  /*
   * 前缀缓存命中量的解析（docs/06 §21.4）。五条断言覆盖：两种厂商字段名、都缺 → 缺省、
   * 优先级、非法值 → 缺省。「0 与没回传可区分」是这里的核心口径，所以第三条同时断言
   * 整个 usage 的键集合（证明是「整条省略」而不是 `cachedTokens: undefined`）。
   */
  it('缓存命中：prompt_tokens_details.cached_tokens 解析为 cachedTokens（OpenAI 形态）', async () => {
    const usage = await usageFromStream({
      prompt_tokens: 1024,
      completion_tokens: 8,
      total_tokens: 1032,
      prompt_tokens_details: { cached_tokens: 512 },
    })
    expect(usage?.cachedTokens).toBe(512)
  })

  it('缓存命中：只回传 prompt_cache_hit_tokens 也认（DeepSeek 形态）', async () => {
    const usage = await usageFromStream({
      prompt_tokens: 1024,
      completion_tokens: 8,
      total_tokens: 1032,
      prompt_cache_hit_tokens: 300,
    })
    expect(usage?.cachedTokens).toBe(300)
  })

  it('缓存命中：两个字段都缺 → cachedTokens 缺省，不是 0', async () => {
    const usage = await usageFromStream({
      prompt_tokens: 128,
      completion_tokens: 8,
      total_tokens: 136,
    })
    expect(usage?.cachedTokens).toBeUndefined()
    // 整条省略：`toEqual` 连键集合一起比，`cachedTokens: undefined` 这种写法过不了这一条
    expect(usage).toEqual({ promptTokens: 128, completionTokens: 8, totalTokens: 136 })
  })

  it('缓存命中：两个字段同时存在 → 以 prompt_tokens_details.cached_tokens 为准', async () => {
    const usage = await usageFromStream({
      prompt_tokens: 1024,
      completion_tokens: 8,
      total_tokens: 1032,
      prompt_tokens_details: { cached_tokens: 512 },
      prompt_cache_hit_tokens: 300,
    })
    expect(usage?.cachedTokens).toBe(512)
  })

  it('缓存命中：cached_tokens 非数字或为负数 → 整条省略（不拿别的数字冒充）', async () => {
    const notANumber = await usageFromStream({
      prompt_tokens: 128,
      completion_tokens: 8,
      total_tokens: 136,
      prompt_tokens_details: { cached_tokens: 'abc' },
    })
    expect(notANumber?.cachedTokens).toBeUndefined()

    const negative = await usageFromStream({
      prompt_tokens: 128,
      completion_tokens: 8,
      total_tokens: 136,
      prompt_tokens_details: { cached_tokens: -5 },
    })
    expect(negative?.cachedTokens).toBeUndefined()
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

  it('思考链增量按 reasoning_content / reasoning 字段转发为 reasoning 事件', async () => {
    const { instance } = provider([
      {
        sseChunks: [
          sseLine({ choices: [{ delta: { reasoning_content: '先想' } }] }),
          sseLine({ choices: [{ delta: { reasoning: '一下' } }] }),
          sseLine({ choices: [{ delta: { reasoning_content: null, reasoning: null } }] }),
          sseLine({ choices: [{ delta: { content: '答案是 4' } }] }),
          sseLine({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
          'data: [DONE]\n\n',
        ],
      },
    ])
    const events = await collect(
      instance.chat({ model: 'm', messages: [{ role: 'user', content: '2+2' }] }),
    )
    expect(
      events.filter((e) => e.type === 'reasoning').map((e) => (e as { delta: string }).delta),
    ).toEqual(['先想', '一下'])
    expect(
      events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta),
    ).toEqual(['答案是 4'])
    expect(events.at(-1)).toMatchObject({ type: 'done', finishReason: 'stop' })
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

  it('请求体带上思考等级 reasoning_effort', async () => {
    const { instance, stub } = provider([{ sseChunks: ['data: [DONE]\n\n'] }])
    await collect(
      instance.chat({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        reasoningEffort: 'high',
      }),
    )
    const body = stub.calls[0]?.body as Record<string, unknown>
    expect(body['reasoning_effort']).toBe('high')
  })

  it('未指定思考等级时请求体完全不出现 reasoning_effort（auto 不下发）', async () => {
    const { instance, stub } = provider([{ sseChunks: ['data: [DONE]\n\n'] }])
    await collect(instance.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }))
    const body = stub.calls[0]?.body as Record<string, unknown>
    expect('reasoning_effort' in body).toBe(false)
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

/**
 * 按**原始字节**分片的 SSE fetch 替身。
 *
 * `createFetchStub` 的 `sseChunks` 是字符串数组（每片各自 `TextEncoder.encode`），
 * 造不出本组要的两种现场：① 多字节字符被切成两半；② 响应流保持打开（模拟服务端停滞）。
 */
function rawStreamFetch(
  chunks: Uint8Array[],
  options: { keepOpen?: boolean; gapMs?: number } = {},
): { fetchImpl: typeof fetch; cancelCount: () => number } {
  let cancels = 0
  const fetchImpl = (async (): Promise<Response> => {
    const gapMs = options.gapMs ?? 0
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk, index) => {
          const push = (): void => {
            controller.enqueue(chunk)
            if (index === chunks.length - 1 && options.keepOpen !== true) controller.close()
          }
          if (gapMs === 0) push()
          else setTimeout(push, index * gapMs)
        })
      },
      cancel() {
        cancels += 1
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  return { fetchImpl, cancelCount: () => cancels }
}

/**
 * 按「计划」逐次响应的 fetch 替身，**每份计划都感知 signal**（复刻真实 fetch：到点前 signal 被
 * abort 就以 abort reason 拒绝；调用时 signal 已 abort 则立刻拒绝）。`hang: true` = 永不响应，
 * 只能被 abort 收场。
 *
 * `createFetchStub` 的响应是「同步立即返回」，造不出本组要的现场：第 1 次尝试**超时**
 * （响应头 / 数据都不到），以及第 1 次在预算将尽时才失败、重试只剩一点点残留预算 ——
 * 这两条正是「跨重试复用同一个 RequestScope」会踩到的路径。
 */
function plannedFetch(
  plan: Array<{ delayMs: number; hang?: boolean; status?: number; text?: string; sse?: string[] }>,
): { fetchImpl: typeof fetch; callCount: () => number } {
  let calls = 0
  const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal ?? null
    const step = plan[Math.min(calls, plan.length - 1)]
    calls += 1
    if (step === undefined) return Promise.reject(new Error('setup: 桩 fetch 未配置响应'))

    return new Promise<Response>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        reject(signal?.reason)
      }
      if (signal?.aborted === true) {
        onAbort()
        return
      }
      if (step.hang !== true) {
        timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve(plannedResponse(step))
        }, step.delayMs)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }) as unknown as typeof fetch
  return { fetchImpl, callCount: () => calls }
}

function plannedResponse(step: { status?: number; text?: string; sse?: string[] }): Response {
  const status = step.status ?? 200
  if (step.sse === undefined) return new Response(step.text ?? '', { status })
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of step.sse ?? []) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } })
}

/**
 * 给「应当很快结束」的断言加一道超时护栏：实现若挂住，失败消息是明确的
 * 「超过 Nms 仍未结束」，而不是拖到 vitest 自己的超时。
 */
function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    task,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`超过 ${ms}ms 仍未结束`)), ms)
      timer.unref?.()
    }),
  ])
}

describe('OpenAiCompatProvider.chat · 流式可靠性与取消（P1-08 / P1-09）', () => {
  const request = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }] }

  function rawProvider(
    chunks: Uint8Array[],
    options: { keepOpen?: boolean; gapMs?: number; timeoutMs?: number } = {},
  ) {
    const raw = rawStreamFetch(chunks, options)
    const instance = new OpenAiCompatProvider({
      id: 'local',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'sk-test',
      defaultModel: 'm',
      maxRetries: 0,
      fetchImpl: raw.fetchImpl,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    })
    return { instance, raw }
  }

  it('多字节字符跨 chunk 不产生 U+FFFD（decoder 全程复用）', async () => {
    const payload = sseLine({ choices: [{ delta: { content: '中' } }] })
    const encoded = new TextEncoder().encode(`${payload}data: [DONE]\n\n`)
    // 切点落在「中」的 3 字节序列中间：每片新建一份 TextDecoder 时，这一刀必然切出替换符
    const cut = new TextEncoder().encode(payload.slice(0, payload.indexOf('中'))).length + 1
    const { instance } = rawProvider([encoded.slice(0, cut), encoded.slice(cut)])

    const events = await collect(instance.chat(request))
    const deltas = events
      .filter((event) => event.type === 'text')
      .map((event) => (event as { delta: string }).delta)
    expect(deltas).toEqual(['中'])
    expect(deltas.join('')).not.toContain('\uFFFD')
  })

  it('流中途 abort：生成器及时结束、上报 E_ABORTED 并取消底层 reader', async () => {
    const { instance, raw } = rawProvider(
      [new TextEncoder().encode(sseLine({ choices: [{ delta: { content: '前半' } }] }))],
      { keepOpen: true },
    )
    const controller = new AbortController()
    const iterator = instance.chat(request, controller.signal)[Symbol.asyncIterator]()

    const first = await iterator.next()
    expect(first.value).toMatchObject({ type: 'text', delta: '前半' })
    expect(raw.cancelCount()).toBe(0)

    // 这一读会挂在「服务端不关闭的流」上：此前只有 abort 到不了这里，读会永久挂起
    const pending = iterator.next()
    controller.abort()
    const settled = await withTimeout(pending, 1000)
    expect(settled).toMatchObject({ value: { type: 'error', code: 'E_ABORTED' }, done: false })

    expect((await iterator.next()).done).toBe(true)
    expect(raw.cancelCount()).toBe(1)
  })

  it('服务端停滞时超时仍在流期间生效（不再只覆盖首字节）', async () => {
    const { instance, raw } = rawProvider(
      [new TextEncoder().encode(sseLine({ choices: [{ delta: { content: 'ok' } }] }))],
      { keepOpen: true, timeoutMs: 30 },
    )

    const events = await withTimeout(collect(instance.chat(request)), 1000)
    expect(events.filter((event) => event.type === 'text')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'E_TIMEOUT' })
    expect(raw.cancelCount()).toBe(1)
  })

  it('正常传输的长回复不会被「总时长」掐断（超时按片重新计时）', async () => {
    const chunks = Array.from({ length: 6 }, (_item, index) =>
      new TextEncoder().encode(sseLine({ choices: [{ delta: { content: `第${index}片` } }] })),
    )
    // 总时长约 240ms > 超时 150ms，但每片间隔 40ms ≪ 150ms：
    // 只有"给整个流设一个总时长上限"的实现才会在这里被误取消
    const { instance } = rawProvider([...chunks, new TextEncoder().encode('data: [DONE]\n\n')], {
      gapMs: 40,
      timeoutMs: 150,
    })

    const events = await withTimeout(collect(instance.chat(request)), 3000)
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(events.filter((event) => event.type === 'text')).toHaveLength(6)
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })
})

/**
 * 「超时后的重试全是死重试」的回归（P1）：`chat()` 建一份 scope 并跨 attempt 复用，
 * 而 `AbortController` 一旦 abort 不可复位 —— 第 1 次超时后每个重试都拿着永久 aborted 的
 * 信号秒失败，且共享同一个计时器（重试只剩上一次的残留预算）。修法是超时**每个 attempt 一份**。
 */
describe('OpenAiCompatProvider.chat · 每次 attempt 独立超时预算', () => {
  const request = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }] }

  function plannedProvider(
    plan: Parameters<typeof plannedFetch>[0],
    overrides: Partial<ConstructorParameters<typeof OpenAiCompatProvider>[0]> = {},
  ) {
    const stub = plannedFetch(plan)
    const instance = new OpenAiCompatProvider({
      id: 'local',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'sk-test',
      defaultModel: 'm',
      maxRetries: 2,
      retryBaseDelayMs: 1,
      fetchImpl: stub.fetchImpl,
      ...overrides,
    })
    return { instance, stub }
  }

  it('首次 attempt 超时失败后，重试拿到全新预算并成功（重试不是死重试）', async () => {
    const { instance, stub } = plannedProvider(
      [
        // 第 1 次：响应永不到达（服务端停滞），只能在超时时被 abort 收场
        { delayMs: 0, hang: true },
        {
          delayMs: 0,
          sse: [sseLine({ choices: [{ delta: { content: '重试成功' } }] }), 'data: [DONE]\n\n'],
        },
      ],
      { timeoutMs: 40 },
    )

    const events = await withTimeout(collect(instance.chat(request)), 2000)
    // 修复前：重试复用已 abort 的 controller → 两次重试均秒失败，这里只会拿到 error
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(
      events
        .filter((event) => event.type === 'text')
        .map((event) => (event as { delta: string }).delta),
    ).toEqual(['重试成功'])
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    expect(stub.callCount()).toBe(2)
  })

  it('重试不吃上一次 attempt 剩下的预算（每次 attempt 各有完整超时）', async () => {
    // 第 1 次在 60ms（预算 100ms 将尽）才以 503 失败 → 共享计时器时重试只剩约 40ms；
    // 第 2 次的响应要 60ms 才到：> 残留、< 完整预算。只有「每次 attempt 重新武装」才救得回来。
    const { instance, stub } = plannedProvider(
      [
        { delayMs: 60, status: 503, text: 'busy' },
        {
          delayMs: 60,
          sse: [sseLine({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'],
        },
      ],
      { timeoutMs: 100 },
    )

    const events = await withTimeout(collect(instance.chat(request)), 2000)
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(events.filter((event) => event.type === 'text')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    expect(stub.callCount()).toBe(2)
  })

  it('外部取消不重试：maxRetries > 0 也立刻 E_ABORTED（不睡退避、不重发请求）', async () => {
    const { instance, stub } = provider([{ sseChunks: ['data: [DONE]\n\n'] }], {
      maxRetries: 3,
      retryBaseDelayMs: 500,
    })
    const controller = new AbortController()
    controller.abort()
    const started = Date.now()

    const events = await withTimeout(collect(instance.chat(request, controller.signal)), 1000)
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'E_ABORTED' })
    // E_ABORTED 不在 RETRYABLE：一次请求都不该发出去
    expect(stub.calls).toHaveLength(0)
    // 若真去重试，退避至少 500ms 起步 —— 这比「立刻返回」的下限宽得多
    expect(Date.now() - started).toBeLessThan(400)
  })
})

/**
 * 多模态输入（docs/06 §3.1，v22）：图片分片的形状与「没图片时形状一个字不变」。
 *
 * 后一条是这次改动最要紧的回归面 —— 内容分片只应该在**真的有图片**时出现：
 * 老网关（只认 `content: string`）收到的请求必须与 v22 之前逐字一致。
 */
describe('OpenAiCompatProvider 的图片分片（docs/06 §3.1）', () => {
  const image = { mimeType: 'image/png', dataBase64: 'AAAA', name: 'a.png' }

  it('没有图片时 content 仍是字符串（旧形状逐字不变）', () => {
    expect(toOpenAiContent({ role: 'user', content: '你好' })).toBe('你好')
    expect(toOpenAiContent({ role: 'user', content: '你好', images: [] })).toBe('你好')
  })

  it('有图片时 content 变成 text + image_url 分片（data URL 前缀在内核拼）', () => {
    expect(toOpenAiContent({ role: 'user', content: '看看', images: [image] })).toEqual([
      { type: 'text', text: '看看' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ])
  })

  it('正文为空时只发图片分片（空 text 分片会被部分服务当空消息拒掉）', () => {
    expect(toOpenAiContent({ role: 'user', content: '', images: [image] })).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ])
  })

  it('多张图按顺序排列', () => {
    const parts = toOpenAiContent({
      role: 'user',
      content: '两张',
      images: [image, { mimeType: 'image/jpeg', dataBase64: 'BBBB' }],
    }) as Array<Record<string, unknown>>
    expect(parts).toHaveLength(3)
    expect(parts[2]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,BBBB' },
    })
  })

  it('请求体里透传：图片消息的 content 是数组，紧随其后的助手消息不受影响', async () => {
    const { instance, stub } = provider([{ sseChunks: ['data: [DONE]\n\n'] }])
    await collect(
      instance.chat({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: '这张图里是什么', images: [image] }],
      }),
    )
    const body = stub.calls[0]?.body as { messages: Array<Record<string, unknown>> }
    expect(body.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '这张图里是什么' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    })
  })
})
