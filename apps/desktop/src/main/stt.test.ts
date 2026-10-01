import { describe, expect, it } from 'vitest'
import { createMemoryLogger } from '@aurora/shared'
import type { Settings } from '@aurora/shared'
import { createSttService } from './stt.js'
import type { SettingsStoreLike } from './contracts.js'

const BASE_URL = 'https://api.example.com/v1'

interface FakeSttOptions {
  enabled?: boolean
  active?: string
  secret?: string
  provider?: Partial<{
    type: 'openai-compat' | 'dashscope-native'
    baseUrl: string
    model: string
    language: string
  }>
  /** true 时完全不放 provider 条目（模拟「指向不存在的模型」） */
  omitProvider?: boolean
}

/** 只实现 `createSttService` 需要的两个方法，避免拉起整个 SettingsStore。 */
function fakeSettings(options: FakeSttOptions = {}): SettingsStoreLike {
  const provider = {
    type: 'openai-compat' as const,
    baseUrl: BASE_URL,
    apiKeyEnc: '',
    model: 'whisper-1',
    language: 'zh',
    ...options.provider,
  }
  const active = options.active ?? 'st'
  const settings = {
    stt: {
      enabled: options.enabled ?? true,
      active,
      providers: options.omitProvider === true ? {} : { [active]: provider },
    },
  } as unknown as Settings

  return {
    get: () => settings,
    mutate: () => settings,
    update: () => settings,
    getSecret: () => options.secret ?? 'sk-saved',
    setSecret: () => true,
    clearSecret: () => undefined,
    isCryptoAvailable: () => true,
    needsOnboarding: () => false,
    exportRedacted: () => settings,
    flush: () => Promise.resolve(),
    onChange: () => () => undefined,
  }
}

interface CapturedRequest {
  url: string
  init: RequestInit
}

/** 记录请求并回放固定响应；同时证明注入的 fetch 真的被用上。 */
function stubFetch(response: Response): { fetchImpl: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = []
  const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} })
    return Promise.resolve(response)
  }) as typeof fetch
  return { fetchImpl, requests }
}

function make(settings: SettingsStoreLike, fetchImpl: typeof fetch) {
  return createSttService({
    settings,
    logger: createMemoryLogger(),
    resolveFetch: () => fetchImpl,
  })
}

function audioBase64(content: string): string {
  return Buffer.from(content, 'utf8').toString('base64')
}

describe('createSttService · transcribe', () => {
  it('multipart 字段（file/model/language）与鉴权头正确，且不手工设置 Content-Type', async () => {
    const { fetchImpl, requests } = stubFetch(new Response(JSON.stringify({ text: '你好' })))
    const stt = make(fakeSettings(), fetchImpl)

    const result = await stt.transcribe({
      audioBase64: audioBase64('fake-webm'),
      mime: 'audio/webm;codecs=opus',
    })

    expect(result.text).toBe('你好')
    expect(requests).toHaveLength(1)
    const request = requests[0]!
    expect(request.url).toBe(`${BASE_URL}/audio/transcriptions`)
    expect(request.init.method).toBe('POST')
    const headers = request.init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk-saved')
    // boundary 必须由 fetch 实现生成：手工设置 Content-Type 会丢 boundary（服务端解析失败）
    expect(headers['Content-Type']).toBeUndefined()

    const form = request.init.body as FormData
    expect(form.get('model')).toBe('whisper-1')
    expect(form.get('language')).toBe('zh')
    const file = form.get('file')
    expect(file).toBeInstanceOf(Blob)
    expect((file as unknown as File).name).toBe('recording.webm')
    expect(Buffer.from(await (file as Blob).arrayBuffer()).toString('utf8')).toBe('fake-webm')
  })

  it('请求级 language 覆盖 provider 配置；provider 语言为空且无覆盖时不下发 language', async () => {
    const { fetchImpl, requests } = stubFetch(new Response(JSON.stringify({ text: 'hi' })))
    const stt = make(fakeSettings(), fetchImpl)
    await stt.transcribe({ audioBase64: audioBase64('a'), mime: 'audio/webm', language: 'en' })
    expect((requests[0]!.init.body as FormData).get('language')).toBe('en')

    const { fetchImpl: fetch2, requests: requests2 } = stubFetch(
      new Response(JSON.stringify({ text: 'hi' })),
    )
    const auto = make(fakeSettings({ provider: { language: '' } }), fetch2)
    await auto.transcribe({ audioBase64: audioBase64('a'), mime: 'audio/webm' })
    expect((requests2[0]!.init.body as FormData).get('language')).toBeNull()
  })

  it('baseUrl 已以 /audio/transcriptions 结尾时不重复拼接', async () => {
    const { fetchImpl, requests } = stubFetch(new Response(JSON.stringify({ text: 'x' })))
    const stt = make(
      fakeSettings({ provider: { baseUrl: `${BASE_URL}/audio/transcriptions/` } }),
      fetchImpl,
    )
    await stt.transcribe({ audioBase64: audioBase64('a'), mime: 'audio/webm' })
    expect(requests[0]!.url).toBe(`${BASE_URL}/audio/transcriptions`)
  })

  it('mp3 的 MIME 映射到 .mp3 扩展名', async () => {
    const { fetchImpl, requests } = stubFetch(new Response(JSON.stringify({ text: 'x' })))
    const stt = make(fakeSettings(), fetchImpl)
    await stt.transcribe({ audioBase64: audioBase64('a'), mime: 'audio/mpeg' })
    const form = requests[0]!.init.body as FormData
    expect((form.get('file') as unknown as File).name).toBe('recording.mp3')
  })
})

describe('createSttService · 未配置与错误路径', () => {
  it('总开关关闭 / active 为空 / provider 不存在 / 缺 Key 时给出中文提示，且不出网', async () => {
    const { fetchImpl, requests } = stubFetch(new Response(JSON.stringify({ text: 'x' })))
    const audio = { audioBase64: audioBase64('a'), mime: 'audio/webm' }

    await expect(
      make(fakeSettings({ enabled: false }), fetchImpl).transcribe(audio),
    ).rejects.toThrow('语音输入未配置')
    await expect(
      make(fakeSettings({ active: '', omitProvider: true }), fetchImpl).transcribe(audio),
    ).rejects.toThrow('语音输入未配置')
    await expect(
      make(fakeSettings({ active: 'ghost', omitProvider: true }), fetchImpl).transcribe(audio),
    ).rejects.toThrow('语音输入未配置')
    await expect(make(fakeSettings({ secret: '' }), fetchImpl).transcribe(audio)).rejects.toThrow(
      '缺少 API Key',
    )
    // 未配置路径一律不触网
    expect(requests).toHaveLength(0)
  })

  it('空音频 / 空 base64 抛出中文提示', async () => {
    const { fetchImpl } = stubFetch(new Response(JSON.stringify({ text: 'x' })))
    const stt = make(fakeSettings(), fetchImpl)
    await expect(stt.transcribe({ audioBase64: '', mime: 'audio/webm' })).rejects.toThrow(
      '没有可识别的音频内容',
    )
    await expect(stt.transcribe({ audioBase64: '   ', mime: 'audio/webm' })).rejects.toThrow(
      '没有可识别的音频内容',
    )
  })

  it('非 2xx 折成带状态码的中文错误', async () => {
    const { fetchImpl } = stubFetch(new Response('invalid api key', { status: 401 }))
    const stt = make(fakeSettings(), fetchImpl)
    await expect(
      stt.transcribe({ audioBase64: audioBase64('a'), mime: 'audio/webm' }),
    ).rejects.toThrow(/API Key 无效.*401/)
  })

  it('响应缺少 text 字段时按失败处理', async () => {
    const { fetchImpl } = stubFetch(new Response(JSON.stringify({ nope: 1 })))
    const stt = make(fakeSettings(), fetchImpl)
    await expect(
      stt.transcribe({ audioBase64: audioBase64('a'), mime: 'audio/webm' }),
    ).rejects.toThrow('语音识别返回格式异常')
  })

  it('网络异常折成中文前缀', async () => {
    const failing = (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch
    const stt = make(fakeSettings(), failing)
    await expect(
      stt.transcribe({ audioBase64: audioBase64('a'), mime: 'audio/webm' }),
    ).rejects.toThrow(/识别请求失败.*ECONNREFUSED/)
  })
})

/** 阿里云原生协议的响应体（与线上实测形状一致：output.choices[0].message.content[0].text）。 */
function nativeResponse(text: string, extraContentBefore: unknown[] = []): Response {
  return new Response(
    JSON.stringify({
      output: {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              annotations: [{ emotion: 'neutral', language: 'zh', type: 'audio_info' }],
              content: [...extraContentBefore, { text }],
              role: 'assistant',
            },
          },
        ],
      },
      usage: { seconds: 4 },
    }),
  )
}

function nativeSettings(
  provider: Partial<{
    baseUrl: string
    model: string
    language: string
  }> = {},
): SettingsStoreLike {
  return fakeSettings({
    provider: { type: 'dashscope-native', model: 'qwen3-asr-flash', ...provider },
  })
}

describe('createSttService · dashscope-native（阿里云原生 ASR）', () => {
  it('走原生端点，body 是 input.messages 里的 data URI，语言进 asr_options', async () => {
    const { fetchImpl, requests } = stubFetch(nativeResponse('你好'))
    const stt = make(nativeSettings({ baseUrl: 'https://dashscope.aliyuncs.com' }), fetchImpl)

    const result = await stt.transcribe({
      audioBase64: audioBase64('fake-webm'),
      // 渲染层交上来的是 recorder.mimeType，带 codecs —— 数据 URI 必须把它剥掉
      mime: 'audio/webm;codecs=opus',
    })

    expect(result.text).toBe('你好')
    expect(requests).toHaveLength(1)
    const request = requests[0]!
    expect(request.url).toBe(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    )
    expect(request.init.method).toBe('POST')
    const headers = request.init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk-saved')
    // 原生接口是 JSON（与 multipart 侧相反：这里**必须**显式设 Content-Type）
    expect(headers['Content-Type']).toBe('application/json')

    const body = JSON.parse(String(request.init.body)) as Record<string, unknown>
    expect(body['model']).toBe('qwen3-asr-flash')
    expect(body['parameters']).toEqual({ asr_options: { language: 'zh' } })
    const messages = (body['input'] as { messages: { role: string; content: unknown[] }[] })
      .messages
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe('user')
    expect(messages[0]!.content).toEqual([
      { audio: `data:audio/webm;base64,${audioBase64('fake-webm')}` },
    ])
  })

  it('baseUrl 的四种常见写法都落到同一个原生端点', async () => {
    const cases: [string, string][] = [
      ['https://dashscope.aliyuncs.com', 'https://dashscope.aliyuncs.com'],
      ['https://dashscope.aliyuncs.com/', 'https://dashscope.aliyuncs.com'],
      // MaaS 专属网关习惯写成 …/api（TTS 那栏就是这个形状）
      ['https://maas.example.com/api', 'https://maas.example.com'],
      ['https://maas.example.com/api/v1', 'https://maas.example.com'],
      ['https://maas.example.com/compatible-mode/v1', 'https://maas.example.com'],
      // 已经贴了完整端点：不重复拼接
      [
        'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
        'https://dashscope.aliyuncs.com',
      ],
    ]

    for (const [baseUrl, expectedRoot] of cases) {
      const { fetchImpl, requests } = stubFetch(nativeResponse('x'))
      const stt = make(nativeSettings({ baseUrl }), fetchImpl)
      await stt.transcribe({ audioBase64: audioBase64('a'), mime: 'audio/webm' })
      expect(requests[0]!.url).toBe(
        `${expectedRoot}/api/v1/services/aigc/multimodal-generation/generation`,
      )
    }
  })

  it('语言为空时整个 parameters 不下发（交服务端自动检测）', async () => {
    const { fetchImpl, requests } = stubFetch(nativeResponse('hi'))
    const stt = make(nativeSettings({ language: '' }), fetchImpl)
    await stt.transcribe({ audioBase64: audioBase64('a'), mime: 'audio/webm' })

    const body = JSON.parse(String(requests[0]!.init.body)) as Record<string, unknown>
    expect(body['parameters']).toBeUndefined()
  })

  it('请求级 language 覆盖 provider 配置', async () => {
    const { fetchImpl, requests } = stubFetch(nativeResponse('hi'))
    const stt = make(nativeSettings(), fetchImpl)
    await stt.transcribe({ audioBase64: audioBase64('a'), mime: 'audio/webm', language: 'en' })

    const body = JSON.parse(String(requests[0]!.init.body)) as Record<string, unknown>
    expect(body['parameters']).toEqual({ asr_options: { language: 'en' } })
  })

  it('内容数组里非文本分片在前时，取第一条带 text 的', async () => {
    const { fetchImpl } = stubFetch(nativeResponse('真文本', [{ image: 'x' }, { foo: 1 }]))
    const stt = make(nativeSettings(), fetchImpl)
    const result = await stt.transcribe({ audioBase64: audioBase64('a'), mime: 'audio/webm' })
    expect(result.text).toBe('真文本')
  })

  it('mime 为空时数据 URI 兜底 audio/webm', async () => {
    const { fetchImpl, requests } = stubFetch(nativeResponse('x'))
    const stt = make(nativeSettings(), fetchImpl)
    await stt.transcribe({ audioBase64: audioBase64('a'), mime: '  ' })

    const body = JSON.parse(String(requests[0]!.init.body)) as {
      input: { messages: { content: { audio: string }[] }[] }
    }
    expect(body.input.messages[0]!.content[0]!.audio.startsWith('data:audio/webm;base64,')).toBe(
      true,
    )
  })

  it('原生错误体折成「code：message」并保留状态码前缀', async () => {
    const modelMissing = new Response(
      JSON.stringify({
        code: 'InvalidParameter',
        message: 'Model not exist.',
        request_id: 'abc',
      }),
      { status: 404 },
    )
    const { fetchImpl } = stubFetch(modelMissing)
    const stt = make(nativeSettings(), fetchImpl)
    await expect(
      stt.transcribe({ audioBase64: audioBase64('a'), mime: 'audio/webm' }),
    ).rejects.toThrow(/接口或模型不存在.*404.*InvalidParameter：Model not exist\./)
  })

  it('原生错误体不是 JSON 时回落到原始 body', async () => {
    const { fetchImpl } = stubFetch(new Response('gateway exploded', { status: 502 }))
    const stt = make(nativeSettings(), fetchImpl)
    await expect(
      stt.transcribe({ audioBase64: audioBase64('a'), mime: 'audio/webm' }),
    ).rejects.toThrow(/STT 服务端错误.*502.*gateway exploded/)
  })

  it('原生响应缺少 output.choices[0].message.content[0].text 时按失败处理', async () => {
    const { fetchImpl } = stubFetch(new Response(JSON.stringify({ output: { choices: [] } })))
    const stt = make(nativeSettings(), fetchImpl)
    await expect(
      stt.transcribe({ audioBase64: audioBase64('a'), mime: 'audio/webm' }),
    ).rejects.toThrow('语音识别返回格式异常')
  })

  it('原生协议同样受总开关 / 缺 Key / 空音频守卫约束，且不触网', async () => {
    const { fetchImpl, requests } = stubFetch(nativeResponse('x'))
    const audio = { audioBase64: audioBase64('a'), mime: 'audio/webm' }

    await expect(
      make(
        fakeSettings({ provider: { type: 'dashscope-native' }, enabled: false }),
        fetchImpl,
      ).transcribe(audio),
    ).rejects.toThrow('语音输入未配置')
    await expect(
      make(
        fakeSettings({ provider: { type: 'dashscope-native' }, secret: '' }),
        fetchImpl,
      ).transcribe(audio),
    ).rejects.toThrow('缺少 API Key')
    await expect(
      make(nativeSettings(), fetchImpl).transcribe({ audioBase64: '', mime: 'audio/webm' }),
    ).rejects.toThrow('没有可识别的音频内容')
    expect(requests).toHaveLength(0)
  })
})
