import { describe, expect, it } from 'vitest'
import { createMemoryLogger } from '@aurora/shared'
import type { Settings, TtsFormat, TtsProviderType } from '@aurora/shared'
import { TtsSynthesizer } from './tts.js'
import type { SettingsStoreLike } from './contracts.js'

const BASE_URL = 'https://api.siliconflow.cn/v1'

interface FakeSettingsOptions {
  active?: string
  maxChars?: number
  secret?: string
  provider?: Partial<{
    type: TtsProviderType
    baseUrl: string
    model: string
    voice: string
    speed: number
    format: TtsFormat
    instructions: string
    language: string
  }>
  /** true 时完全不放 provider 条目（模拟「模型不存在」） */
  omitProvider?: boolean
}

/** 只实现 `TtsSynthesizer` 需要的两个方法，避免拉起整个 SettingsStore。 */
function fakeSettings(options: FakeSettingsOptions = {}): SettingsStoreLike {
  const anyOptions = options as { overrides?: Partial<Settings> }
  const provider = {
    type: 'openai-compat' as const,
    baseUrl: BASE_URL,
    apiKeyEnc: '',
    model: 'FunAudioLLM/CosyVoice2-0.5B',
    voice: 'alex',
    speed: 1,
    format: 'mp3' as TtsFormat,
    instructions: '',
    language: 'auto',
    ...options.provider,
  }
  const active = options.active ?? 'sf'
  const settings = {
    version: 7,
    general: {
      language: 'zh-CN',
      launchAtLogin: false,
      hotkey: 'Alt+Space',
      edgeBar: {
        enabled: true,
        opacity: 0.9,
        quietHours: null,
        display: 'primary',
        position: 'right',
      },
      windowState: {},
    },
    llm: { active: '', providers: {} },
    tts: {
      enabled: true,
      active,
      autoRead: false,
      maxChars: options.maxChars ?? 2000,
      providers: options.omitProvider === true ? {} : { sf: provider },
    },
    modes: {
      current: 'classroom',
      classroom: {
        guideCompleted: true,
        watchDir: '',
        subjects: [],
        schedule: {
          provider: 'manual',
          lessons: [],
          classisland: { source: 'file', endpoint: '', timeoutMs: 3000 },
        },
        preClassReminder: true,
        classification: { autoMove: true, confidenceThreshold: 0.6, fallbackFolder: '待分类' },
      },
      work: { guideCompleted: false },
      code: { guideCompleted: false },
    },
    skills: { userDir: '', disabled: [] },
    mcp: { servers: [], lazyConnect: false },
    advanced: {
      proxy: '',
      logLevel: 'info',
      quietHours: null,
      confirmSensitiveTools: true,
      readonlyPrefixes: [],
    },
    agent: { tools: {} },
    ...anyOptions.overrides,
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

/** 记录请求并回放固定响应；同时用 `fetchCalls` 证明注入的 fetch 真的被用上。 */
function stubFetch(response: Response | (() => Promise<Response>)): {
  fetchImpl: typeof fetch
  requests: CapturedRequest[]
} {
  const requests: CapturedRequest[] = []
  const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} })
    return Promise.resolve(typeof response === 'function' ? response() : response)
  }) as typeof fetch
  return { fetchImpl, requests }
}

function audioResponse(bytes: number[], init: ResponseInit = {}): Response {
  return new Response(new Uint8Array(bytes), { status: 200, ...init })
}

function errorResponse(status: number, body: string): Response {
  return new Response(body, { status })
}

function make(
  settings: SettingsStoreLike,
  fetchImpl: typeof fetch,
  extra: { timeoutMs?: number } = {},
): TtsSynthesizer {
  return new TtsSynthesizer({
    settings,
    logger: createMemoryLogger(),
    resolveFetch: () => fetchImpl,
    ...extra,
  })
}

describe('TtsSynthesizer · synthesize', () => {
  it('请求 URL / 头 / body 正确，音频字节与 base64 一致', async () => {
    const bytes = [1, 2, 3, 4, 5]
    const { fetchImpl, requests } = stubFetch(audioResponse(bytes))
    const tts = make(
      fakeSettings({ provider: { voice: 'alex', speed: 1.25, format: 'wav' } }),
      fetchImpl,
    )

    const result = await tts.synthesize({ text: '你好，世界' })

    expect(requests).toHaveLength(1)
    const request = requests[0]!
    expect(request.url).toBe(`${BASE_URL}/audio/speech`)
    expect(request.init.method).toBe('POST')
    const headers = request.init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk-saved')
    expect(headers['Content-Type']).toBe('application/json')

    const body = JSON.parse(String(request.init.body)) as Record<string, unknown>
    expect(body['input']).toBe('你好，世界')
    expect(body['voice']).toBe('alex')
    expect(body['speed']).toBe(1.25)
    expect(body['response_format']).toBe('wav')
    expect(body['model']).toBe('FunAudioLLM/CosyVoice2-0.5B')

    expect(result.audioBase64).toBe(Buffer.from(bytes).toString('base64'))
    expect(result.bytes).toBe(bytes.length)
    expect(result.mimeType).toBe('audio/wav')
    expect(result.chars).toBe(5)
    expect(result.truncated).toBe(false)
  })

  it('baseUrl 已以 /audio/speech 结尾时不重复拼接', async () => {
    const { fetchImpl, requests } = stubFetch(audioResponse([0]))
    const tts = make(
      fakeSettings({ provider: { baseUrl: `${BASE_URL}/audio/speech/` } }),
      fetchImpl,
    )
    await tts.synthesize({ text: 'hi' })
    expect(requests[0]!.url).toBe(`${BASE_URL}/audio/speech`)
  })

  it('按 tts.maxChars 截断并标记 truncated', async () => {
    const { fetchImpl, requests } = stubFetch(audioResponse([0]))
    const tts = make(fakeSettings({ maxChars: 50 }), fetchImpl)

    const result = await tts.synthesize({ text: 'x'.repeat(120) })

    const body = JSON.parse(String(requests[0]!.init.body)) as Record<string, unknown>
    expect(String(body['input']).length).toBe(50)
    expect(result.chars).toBe(50)
    expect(result.truncated).toBe(true)
  })

  it('文本未超上限时不标记截断', async () => {
    const { fetchImpl } = stubFetch(audioResponse([0]))
    const tts = make(fakeSettings({ maxChars: 50 }), fetchImpl)
    const result = await tts.synthesize({ text: 'x'.repeat(50) })
    expect(result.truncated).toBe(false)
    expect(result.chars).toBe(50)
  })

  it('synthesize 不接受 apiKey 参数（渲染层不持有明文），始终用已保存凭据', async () => {
    const { fetchImpl, requests } = stubFetch(audioResponse([0]))
    const tts = make(fakeSettings({ secret: 'sk-saved' }), fetchImpl)
    await tts.synthesize({ text: 'hi' })
    // `TtsSynthesizeRequest` 只有 `{ text, providerId }`：这是「渲染层不持有明文密钥」的边界，
    // 明文 Key 只允许经 `test()`（设置页草稿）传入。
    const headers = requests[0]!.init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk-saved')
  })

  it('未配置 provider 时抛出中文提示', async () => {
    const { fetchImpl } = stubFetch(audioResponse([0]))
    const tts = make(fakeSettings({ active: '', omitProvider: true }), fetchImpl)
    await expect(tts.synthesize({ text: 'hi' })).rejects.toThrow('尚未配置 TTS 模型')
  })

  it('provider 不存在时抛出中文提示', async () => {
    const { fetchImpl } = stubFetch(audioResponse([0]))
    const tts = make(fakeSettings({ active: 'ghost', omitProvider: true }), fetchImpl)
    await expect(tts.synthesize({ text: 'hi' })).rejects.toThrow('TTS 模型「ghost」不存在')
  })

  it('空文本 / 纯空白抛出中文提示', async () => {
    const { fetchImpl } = stubFetch(audioResponse([0]))
    const tts = make(fakeSettings(), fetchImpl)
    await expect(tts.synthesize({ text: '' })).rejects.toThrow('没有可朗读的文本')
    await expect(tts.synthesize({ text: '   ' })).rejects.toThrow('没有可朗读的文本')
  })

  it('缺少 API Key 时抛出中文提示', async () => {
    const { fetchImpl } = stubFetch(audioResponse([0]))
    const tts = make(fakeSettings({ secret: '' }), fetchImpl)
    await expect(tts.synthesize({ text: 'hi' })).rejects.toThrow('缺少 API Key')
  })

  it('baseUrl / model / voice 各自缺失时给出对应提示', async () => {
    const { fetchImpl } = stubFetch(audioResponse([0]))
    await expect(
      make(fakeSettings({ provider: { baseUrl: '' } }), fetchImpl).synthesize({ text: 'hi' }),
    ).rejects.toThrow('请先填写 baseURL')
    await expect(
      make(fakeSettings({ provider: { model: '  ' } }), fetchImpl).synthesize({ text: 'hi' }),
    ).rejects.toThrow('请先填写模型名')
    await expect(
      make(fakeSettings({ provider: { voice: '' } }), fetchImpl).synthesize({ text: 'hi' }),
    ).rejects.toThrow('请先填写音色')
  })

  it('各输出格式映射到正确的 MIME', async () => {
    const cases: Array<[TtsFormat, string]> = [
      ['mp3', 'audio/mpeg'],
      ['opus', 'audio/ogg'],
      ['aac', 'audio/aac'],
      ['flac', 'audio/flac'],
      ['wav', 'audio/wav'],
      ['pcm', 'audio/L16'],
    ]
    for (const [format, mime] of cases) {
      const { fetchImpl } = stubFetch(audioResponse([1]))
      const tts = make(fakeSettings({ provider: { format } }), fetchImpl)
      const result = await tts.synthesize({ text: 'hi' })
      expect(result.mimeType, format).toBe(mime)
    }
  })
})

describe('TtsSynthesizer · 错误处理', () => {
  it('401 折成密钥提示并含状态码', async () => {
    const { fetchImpl } = stubFetch(errorResponse(401, 'invalid api key'))
    const tts = make(fakeSettings(), fetchImpl)
    await expect(tts.synthesize({ text: 'hi' })).rejects.toThrow(/API Key 无效.*401/)
  })

  it('404 折成路径 / 模型提示并含状态码', async () => {
    const { fetchImpl } = stubFetch(errorResponse(404, 'model not found'))
    const tts = make(fakeSettings(), fetchImpl)
    await expect(tts.synthesize({ text: 'hi' })).rejects.toThrow(/404/)
  })

  it('429 折成限流提示', async () => {
    const { fetchImpl } = stubFetch(errorResponse(429, 'too many requests'))
    const tts = make(fakeSettings(), fetchImpl)
    await expect(tts.synthesize({ text: 'hi' })).rejects.toThrow(/限流.*429/)
  })

  it('500 折成服务端错误', async () => {
    const { fetchImpl } = stubFetch(errorResponse(500, 'boom'))
    const tts = make(fakeSettings(), fetchImpl)
    await expect(tts.synthesize({ text: 'hi' })).rejects.toThrow(/服务端错误.*500/)
  })

  it('超时折成固定中文文案「合成超时（<n>s）」', async () => {
    // 真正尊重 AbortSignal 的挂起 fetch：abort 时才 reject，
    // 这样断言的是 TtsSynthesizer 的取消逻辑，而不是 stub 自己的定时器。
    const hanging = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) return
        if (signal.aborted) {
          reject(new Error('aborted'))
          return
        }
        signal.addEventListener('abort', () => reject(new Error('aborted')))
      })) as typeof fetch
    const tts = make(fakeSettings(), hanging, { timeoutMs: 20 })
    await expect(tts.synthesize({ text: 'hi' })).rejects.toThrow('合成超时（0s）')
  })

  it('网络异常折成中文前缀，不泄漏原始栈', async () => {
    const failing = (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch
    const tts = make(fakeSettings(), failing)
    await expect(tts.synthesize({ text: 'hi' })).rejects.toThrow(/合成请求失败.*ECONNREFUSED/)
  })
})

describe('TtsSynthesizer · baseUrl 规整（404 根治，docs/06 §13.2）', () => {
  /** 借 synthesize 捕获实际请求 URL：speechEndpoint 是模块内私有函数，从外部行为断言 */
  async function endpointOf(baseUrl: string): Promise<string> {
    const { fetchImpl, requests } = stubFetch(audioResponse([0]))
    const tts = make(fakeSettings({ provider: { baseUrl } }), fetchImpl)
    await tts.synthesize({ text: 'hi' })
    return requests[0]!.url
  }

  it('只填域名根时自动补 /v1（漏写 /v1 的 404 根因）', async () => {
    expect(await endpointOf('https://api.siliconflow.cn')).toBe(
      'https://api.siliconflow.cn/v1/audio/speech',
    )
  })

  it('带 /v1 与尾斜杠时正常拼接', async () => {
    expect(await endpointOf('https://api.openai.com/v1/')).toBe(
      'https://api.openai.com/v1/audio/speech',
    )
  })

  it('误把 chat 端点整段当 baseUrl 时剥掉尾巴', async () => {
    expect(await endpointOf('https://x.com/v1/chat/completions')).toBe(
      'https://x.com/v1/audio/speech',
    )
  })

  it('带路径（非域名根）尊重不动', async () => {
    expect(await endpointOf('https://x.com/api/v1')).toBe('https://x.com/api/v1/audio/speech')
  })

  it('已以 /audio/speech 结尾时不重复拼（也不补 /v1）', async () => {
    expect(await endpointOf('https://x.com/audio/speech')).toBe('https://x.com/audio/speech')
  })

  it('非法 URL 按原样拼接不抛（错误交给服务端报）', async () => {
    expect(await endpointOf('not-a-url')).toBe('not-a-url/audio/speech')
  })

  it('404 文案带实际请求的 endpoint，用户可自诊断', async () => {
    const { fetchImpl } = stubFetch(errorResponse(404, 'not found'))
    const tts = make(fakeSettings(), fetchImpl)
    await expect(tts.synthesize({ text: 'hi' })).rejects.toThrow(
      /接口不存在.*api\.siliconflow\.cn\/v1\/audio\/speech/,
    )
  })
})

describe('TtsSynthesizer · dashscope（docs/06 §13.6）', () => {
  const DASH_BASE = 'https://maas.qianwenaiapi.com/api/v1'
  const GENERATION_TAIL = '/services/aigc/multimodal-generation/generation'

  /**
   * 依次回放多个响应：dashscope 合成是两段请求（先 POST 拿 output.audio.url，
   * 再 GET 下载音频），与 `stubFetch` 的单响应回放不同；越界时重复最后一个响应。
   */
  function sequenceFetch(responses: Response[]): {
    fetchImpl: typeof fetch
    requests: CapturedRequest[]
  } {
    const requests: CapturedRequest[] = []
    const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const index = requests.length
      requests.push({ url: String(input), init: init ?? {} })
      return Promise.resolve(responses[Math.min(index, responses.length - 1)]!)
    }) as typeof fetch
    return { fetchImpl, requests }
  }

  /** dashscope 合成响应（2xx JSON，音频在 output.audio.url，24h 有效） */
  function dashJsonResponse(url: string): Response {
    return new Response(
      JSON.stringify({ output: { audio: { url, expires_at: 0 }, finish_reason: 'success' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }

  /**
   * 在 `fakeSettings` 上拦截 `mutate`：备用模型写回断言用 ——
   * 记录收到的 mutator，供用例在最小草稿上重放并断言「只改目标 provider 的 model」。
   */
  function fakeSettingsWithMutate(options: FakeSettingsOptions = {}): {
    settings: SettingsStoreLike
    mutations: Array<(draft: Settings) => void>
  } {
    const store = fakeSettings(options)
    const mutations: Array<(draft: Settings) => void> = []
    return {
      settings: {
        ...store,
        mutate: (mutator: (draft: Settings) => void) => {
          mutations.push(mutator)
          return store.get()
        },
      } as SettingsStoreLike,
      mutations,
    }
  }

  /** 借 synthesize 捕获 dashscope 实际请求的第一跳 URL：端点函数是模块内私有，从行为断言 */
  async function dashEndpointOf(baseUrl: string): Promise<string> {
    const { fetchImpl, requests } = sequenceFetch([
      dashJsonResponse('https://oss.example.com/a.mp3'),
      audioResponse([0]),
    ])
    const tts = make(fakeSettings({ provider: { type: 'dashscope', baseUrl } }), fetchImpl)
    await tts.synthesize({ text: 'hi' })
    return requests[0]!.url
  }

  it('端点规整：裸域名自动补 /api/v1 再拼生成端点', async () => {
    expect(await dashEndpointOf('https://dashscope.aliyuncs.com')).toBe(
      `https://dashscope.aliyuncs.com/api/v1${GENERATION_TAIL}`,
    )
  })

  it('端点规整：以 /api 结尾自动补 /v1（千问AI平台少写 /v1 的高频错误）', async () => {
    expect(await dashEndpointOf('https://maas.qianwenaiapi.com/api')).toBe(
      `https://maas.qianwenaiapi.com/api/v1${GENERATION_TAIL}`,
    )
  })

  it('端点规整：完整原生路径（/api/v1）尊重不动', async () => {
    expect(await dashEndpointOf(DASH_BASE)).toBe(`${DASH_BASE}${GENERATION_TAIL}`)
  })

  it('端点规整：已以完整生成端点结尾时不重复拼（也不补 /api/v1）', async () => {
    const full = `${DASH_BASE}${GENERATION_TAIL}`
    expect(await dashEndpointOf(`${full}/`)).toBe(full)
  })

  it('端点规整：粘着 /compatible-mode/v1 的 baseUrl 整段换成完整原生路径（2026-10-31 线上 404 根因）', async () => {
    expect(await dashEndpointOf('https://maas.qianwenaiapi.com/compatible-mode/v1')).toBe(
      `https://maas.qianwenaiapi.com/api/v1${GENERATION_TAIL}`,
    )
  })

  it('端点规整：少写 /v1 的 /compatible-mode 残缺粘法同样容忍（2026-11 用户配置实测形态）', async () => {
    expect(await dashEndpointOf('https://maas.qianwenaiapi.com/compatible-mode')).toBe(
      `https://maas.qianwenaiapi.com/api/v1${GENERATION_TAIL}`,
    )
  })

  it('端点规整：Center 网关 base 拼出 /api/v1 形状（与其 routeKind 接受的 rest 一致）', async () => {
    expect(await dashEndpointOf('http://127.0.0.1:8787/api/model-gateway/tts')).toBe(
      `http://127.0.0.1:8787/api/model-gateway/tts/api/v1${GENERATION_TAIL}`,
    )
  })

  it('模型列表端点：粘着 /compatible-mode/v1 的 baseUrl 换成 /api/v1 再拼 /models', async () => {
    const { fetchImpl, requests } = sequenceFetch([
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    ])
    await make(
      fakeSettings({
        provider: {
          type: 'dashscope',
          baseUrl: 'https://maas.qianwenaiapi.com/compatible-mode/v1',
        },
      }),
      fetchImpl,
    ).listModels({})
    expect(requests[0]!.url).toBe(
      'https://maas.qianwenaiapi.com/api/v1/models?page_no=1&page_size=100',
    )
  })

  it('两段请求：POST body 含 input.text / input.voice，mp3 携带 audio.format；GET 下载不带 Authorization', async () => {
    const audio = [1, 2, 3, 4]
    const signedUrl = 'https://oss.example.com/audio/signed?Expires=1&Signature=SECRET'
    const { fetchImpl, requests } = sequenceFetch([
      dashJsonResponse(signedUrl),
      new Response(new Uint8Array(audio), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' },
      }),
    ])
    const tts = make(
      fakeSettings({
        provider: {
          type: 'dashscope',
          baseUrl: DASH_BASE,
          model: 'qwen-audio-3.1-tts-flash',
          voice: 'longanlufeng',
          format: 'mp3',
        },
      }),
      fetchImpl,
    )

    const result = await tts.synthesize({ text: '你好' })

    expect(requests).toHaveLength(2)
    const post = requests[0]!
    expect(post.url).toBe(`${DASH_BASE}${GENERATION_TAIL}`)
    expect(post.init.method).toBe('POST')
    const postHeaders = post.init.headers as Record<string, string>
    expect(postHeaders['Authorization']).toBe('Bearer sk-saved')
    const body = JSON.parse(String(post.init.body)) as {
      model: string
      input: { text: string; voice: string }
      audio?: { format: string }
    }
    expect(body.model).toBe('qwen-audio-3.1-tts-flash')
    expect(body.input.text).toBe('你好')
    expect(body.input.voice).toBe('longanlufeng')
    expect(body.audio?.format).toBe('mp3')

    const download = requests[1]!
    expect(download.url).toBe(signedUrl)
    expect(download.init.method).toBe('GET')
    const downloadHeaders = (download.init.headers ?? {}) as Record<string, string>
    expect(downloadHeaders['Authorization']).toBeUndefined()

    expect(result.bytes).toBe(audio.length)
    expect(result.mimeType).toBe('audio/mpeg')
  })

  it('format=flac 时不携带 audio 字段，且 dashscope 协议永不发送 speed', async () => {
    const { fetchImpl, requests } = sequenceFetch([
      dashJsonResponse('https://oss.example.com/a.wav'),
      audioResponse([0]),
    ])
    const tts = make(fakeSettings({ provider: { type: 'dashscope', format: 'flac' } }), fetchImpl)
    await tts.synthesize({ text: 'hi' })
    const body = JSON.parse(String(requests[0]!.init.body)) as Record<string, unknown>
    expect(body['audio']).toBeUndefined()
    expect(body['speed']).toBeUndefined()
    expect(body['response_format']).toBeUndefined()
  })

  it('mimeType：content-type 非 audio/* 时按 URL 扩展名，再回落 provider.format', async () => {
    // content-type 是 application/octet-stream（非 audio/*）→ 丢弃，按 URL 扩展名 .wav 推导
    const octet = sequenceFetch([
      dashJsonResponse('https://oss.example.com/a/b.wav'),
      new Response(new Uint8Array([0]), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    ])
    const first = await make(
      fakeSettings({ provider: { type: 'dashscope', format: 'mp3' } }),
      octet.fetchImpl,
    ).synthesize({ text: 'hi' })
    expect(first.mimeType).toBe('audio/wav')

    // 无 content-type、URL 无扩展名 → 回落 provider.format 对应的 MIME
    const fallback = sequenceFetch([
      dashJsonResponse('https://oss.example.com/a/b'),
      new Response(new Uint8Array([0])),
    ])
    const second = await make(
      fakeSettings({ provider: { type: 'dashscope', format: 'flac' } }),
      fallback.fetchImpl,
    ).synthesize({ text: 'hi' })
    expect(second.mimeType).toBe('audio/flac')
  })

  it('output.audio.url 缺失时抛中文错误，附响应体尾巴便于自查', async () => {
    const { fetchImpl } = sequenceFetch([
      new Response(JSON.stringify({ output: {} }), { status: 200 }),
    ])
    const tts = make(
      fakeSettings({ provider: { type: 'dashscope', baseUrl: DASH_BASE } }),
      fetchImpl,
    )
    await expect(tts.synthesize({ text: 'hi' })).rejects.toThrow(/output\.audio\.url/)
  })

  it('2xx 但响应不是合法 JSON 时抛中文错误', async () => {
    const { fetchImpl } = sequenceFetch([new Response('not-json', { status: 200 })])
    const tts = make(
      fakeSettings({ provider: { type: 'dashscope', baseUrl: DASH_BASE } }),
      fetchImpl,
    )
    await expect(tts.synthesize({ text: 'hi' })).rejects.toThrow('不是合法 JSON')
  })

  it('POST 404：文案含实际请求的 endpoint 与下架自查提示（Model not exist 之外的 404）', async () => {
    const { fetchImpl } = sequenceFetch([errorResponse(404, 'not found')])
    const tts = make(
      fakeSettings({ provider: { type: 'dashscope', baseUrl: DASH_BASE } }),
      fetchImpl,
    )
    await expect(tts.synthesize({ text: 'hi' })).rejects.toThrow(
      /接口不存在.*maas\.qianwenaiapi\.com\/api\/v1\/services\/aigc\/multimodal-generation\/generation[\s\S]*模型已下架（响应含 Model not exist）时换用 qwen3-tts-flash/,
    )
  })

  it('POST 404 + Model not exist（模型已下架）：自动改用 qwen3-tts-flash 重试并写回设置', async () => {
    const audio = [5, 6]
    const { fetchImpl, requests } = sequenceFetch([
      errorResponse(
        404,
        '{"code":"InvalidParameter","message":"Model not exist.","request_id":"r"}',
      ),
      dashJsonResponse('https://oss.example.com/a.mp3'),
      new Response(new Uint8Array(audio), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' },
      }),
    ])
    const hooked = fakeSettingsWithMutate({
      provider: { type: 'dashscope', baseUrl: DASH_BASE, model: 'qwen-tts', voice: 'Cherry' },
    })
    const result = await make(hooked.settings, fetchImpl).synthesize({ text: '你好' })

    expect(requests).toHaveLength(3)
    const firstBody = JSON.parse(String(requests[0]!.init.body)) as {
      model: string
      input: { voice: string }
    }
    const retryBody = JSON.parse(String(requests[1]!.init.body)) as {
      model: string
      input: { voice: string }
    }
    expect(firstBody.model).toBe('qwen-tts')
    expect(retryBody.model).toBe('qwen3-tts-flash')
    // 只换模型：音色等其它字段原样保留
    expect(retryBody.input.voice).toBe('Cherry')
    expect(firstBody.input.voice).toBe('Cherry')
    expect(requests[1]!.url).toBe(requests[0]!.url)

    expect(result.bytes).toBe(audio.length)
    // 成功即写回：mutate 收到一次调用，且只改该 provider 的 model 字段
    expect(hooked.mutations).toHaveLength(1)
    const draft = {
      tts: { providers: { sf: { model: 'qwen-tts' } } },
    } as unknown as Settings
    hooked.mutations[0]!(draft)
    expect((draft.tts.providers as Record<string, { model: string }>)['sf']?.model).toBe(
      'qwen3-tts-flash',
    )
  })

  it('POST 400 + url error（WebSocket 专用族）：自动重试成功', async () => {
    const { fetchImpl, requests } = sequenceFetch([
      errorResponse(400, '{"code":"InvalidParameter","message":"url error, please check url！"}'),
      dashJsonResponse('https://oss.example.com/a.mp3'),
      audioResponse([1]),
    ])
    const result = await make(
      fakeSettings({
        provider: {
          type: 'dashscope',
          baseUrl: DASH_BASE,
          model: 'qwen-audio-3.0-tts-plus',
        },
      }),
      fetchImpl,
    ).synthesize({ text: 'hi' })
    expect(requests).toHaveLength(3)
    expect(JSON.parse(String(requests[1]!.init.body)).model).toBe('qwen3-tts-flash')
    expect(result.bytes).toBe(1)
  })

  it('模型级失效但备用模型也失败：报两段原因的中文错误', async () => {
    const { fetchImpl, requests } = sequenceFetch([
      errorResponse(
        404,
        '{"code":"InvalidParameter","message":"Model not exist.","request_id":"r"}',
      ),
      errorResponse(400, '{"code":"InvalidParameter","message":"url error"}'),
    ])
    const error = (await make(
      fakeSettings({
        provider: { type: 'dashscope', baseUrl: DASH_BASE, model: 'qwen-tts' },
      }),
      fetchImpl,
    )
      .synthesize({ text: 'hi' })
      .catch((reason: unknown) => reason)) as Error
    expect(requests).toHaveLength(2)
    expect(error.message).toContain('配置的模型「qwen-tts」不可用（HTTP 404')
    expect(error.message).toContain('备用模型 qwen3-tts-flash 也失败')
    expect(error.message).toContain('不走当前 HTTP 合成端点')
  })

  it('非模型级失败（401 / 429 / 5xx）不触发备用模型重试', async () => {
    for (const status of [401, 429, 500]) {
      const { fetchImpl, requests } = sequenceFetch([errorResponse(status, 'boom')])
      await expect(
        make(
          fakeSettings({
            provider: { type: 'dashscope', baseUrl: DASH_BASE, model: 'qwen-tts' },
          }),
          fetchImpl,
        ).synthesize({ text: 'hi' }),
      ).rejects.toThrow()
      expect(requests, `HTTP ${status}`).toHaveLength(1)
    }
  })

  it('配置模型已是备用模型时不再重试（避免同模型二次白打）', async () => {
    const { fetchImpl, requests } = sequenceFetch([
      errorResponse(400, '{"code":"InvalidParameter","message":"url error"}'),
    ])
    await expect(
      make(
        fakeSettings({
          provider: { type: 'dashscope', baseUrl: DASH_BASE, model: 'qwen3-tts-flash' },
        }),
        fetchImpl,
      ).synthesize({ text: 'hi' }),
    ).rejects.toThrow(/不走当前 HTTP 合成端点/)
    expect(requests).toHaveLength(1)
  })

  it('openai-compat 的 404 不触发模型回退（各网关模型空间不同）', async () => {
    const { fetchImpl, requests } = stubFetch(errorResponse(404, 'model not exist'))
    const tts = make(fakeSettings(), fetchImpl)
    await expect(tts.synthesize({ text: 'hi' })).rejects.toThrow(/404/)
    expect(requests).toHaveLength(1)
  })

  it('listModels() 404：文案按 dashscope 取词（下架自查提示），不串用 openai-compat 文案', async () => {
    const { fetchImpl } = sequenceFetch([errorResponse(404, 'not found')])
    const tts = make(
      fakeSettings({ provider: { type: 'dashscope', baseUrl: DASH_BASE } }),
      fetchImpl,
    )
    const result = await tts.listModels({})
    expect(result.ok).toBe(false)
    expect(result.message).toContain('模型已下架（响应含 Model not exist）时换用 qwen3-tts-flash')
    expect(result.message).not.toContain('OpenAI 兼容端点')
  })

  it('output.audio.url 存在但非法时，响应体尾巴里的签名参数值先脱敏再进错误文案', async () => {
    const { fetchImpl } = sequenceFetch([
      new Response(
        JSON.stringify({
          output: {
            audio: {
              url: 'ftp://oss.example.com/a.wav?Expires=1&Signature=TOPSECRET&OSSAccessKeyId=KEYID',
            },
          },
        }),
        { status: 200 },
      ),
    ])
    const tts = make(
      fakeSettings({ provider: { type: 'dashscope', baseUrl: DASH_BASE } }),
      fetchImpl,
    )
    const error = (await tts.synthesize({ text: 'hi' }).catch((reason: unknown) => reason)) as Error
    expect(error.message).toContain('Signature=<redacted>')
    expect(error.message).not.toContain('TOPSECRET')
    expect(error.message).not.toContain('KEYID')
  })

  it('下载非 2xx：报错只带 host，不泄漏带签名参数的完整 URL', async () => {
    const signedUrl = 'https://oss.example.com/audio/x.mp3?Expires=1&Signature=SECRET&KeyId=k'
    const { fetchImpl } = sequenceFetch([
      dashJsonResponse(signedUrl),
      errorResponse(403, 'forbidden'),
    ])
    const tts = make(
      fakeSettings({ provider: { type: 'dashscope', baseUrl: DASH_BASE } }),
      fetchImpl,
    )
    const error = (await tts.synthesize({ text: 'hi' }).catch((reason: unknown) => reason)) as Error
    expect(error.message).toContain('音频下载失败（HTTP 403）：oss.example.com')
    expect(error.message).not.toContain('Signature')
  })

  it('test()：两段成功折成 ok + 字节数，httpStatus 取 POST 状态', async () => {
    const { fetchImpl, requests } = sequenceFetch([
      dashJsonResponse('https://oss.example.com/a.mp3'),
      new Response(new Uint8Array([7, 7]), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' },
      }),
    ])
    const tts = make(
      fakeSettings({ provider: { type: 'dashscope', baseUrl: DASH_BASE } }),
      fetchImpl,
    )
    const result = await tts.test({})
    expect(result.ok).toBe(true)
    expect(result.bytes).toBe(2)
    expect(result.httpStatus).toBe(200)
    expect(requests[0]!.url).toBe(`${DASH_BASE}${GENERATION_TAIL}`)
  })

  it('listModels()：/api 规整成 /api/v1/models 且带翻页参数；顶层 models 回落解析（字符串与 {model}/{id}/{name} 对象都收）', async () => {
    const { fetchImpl, requests } = sequenceFetch([
      new Response(
        JSON.stringify({
          models: [
            'qwen-audio-3.1-tts-flash',
            { model: 'qwen-tts' },
            { id: 'cosyvoice-v2' },
            { name: 'sambert-zhichu' },
            { nope: 1 },
          ],
        }),
        { status: 200 },
      ),
    ])
    const tts = make(
      fakeSettings({
        provider: { type: 'dashscope', baseUrl: 'https://maas.qianwenaiapi.com/api' },
      }),
      fetchImpl,
    )
    const result = await tts.listModels({})
    expect(requests[0]!.url).toBe(
      'https://maas.qianwenaiapi.com/api/v1/models?page_no=1&page_size=100',
    )
    expect(result.ok).toBe(true)
    expect(result.models).toEqual([
      'qwen-audio-3.1-tts-flash',
      'qwen-tts',
      'cosyvoice-v2',
      'sambert-zhichu',
    ])
  })

  it('listModels()：DashScope 原生 output.models 按 output.total 翻页拉全', async () => {
    const { fetchImpl, requests } = sequenceFetch([
      new Response(
        JSON.stringify({
          output: {
            total: 3,
            page_no: 1,
            models: [{ model: 'qwen-tts' }, { model: 'qwen3-tts-flash' }],
          },
        }),
        { status: 200 },
      ),
      new Response(
        JSON.stringify({ output: { total: 3, page_no: 2, models: [{ model: 'cosyvoice-v2' }] } }),
        { status: 200 },
      ),
    ])
    const tts = make(
      fakeSettings({ provider: { type: 'dashscope', baseUrl: DASH_BASE } }),
      fetchImpl,
    )
    const result = await tts.listModels({})
    expect(requests).toHaveLength(2)
    expect(requests[0]!.url).toContain('page_no=1&page_size=100')
    expect(requests[1]!.url).toContain('page_no=2&page_size=100')
    expect(result.ok).toBe(true)
    expect(result.models).toEqual(['qwen-tts', 'qwen3-tts-flash', 'cosyvoice-v2'])
  })

  it('listModels()：响应仍是 OpenAI data[].id 时主路径照常解析', async () => {
    const { fetchImpl } = sequenceFetch([
      new Response(JSON.stringify({ data: [{ id: 'm1' }, { nope: 2 }] }), { status: 200 }),
    ])
    const tts = make(
      fakeSettings({ provider: { type: 'dashscope', baseUrl: DASH_BASE } }),
      fetchImpl,
    )
    const result = await tts.listModels({})
    expect(result.ok).toBe(true)
    expect(result.models).toEqual(['m1'])
  })
})

describe('TtsSynthesizer · listModels', () => {
  function modelsResponse(body: string, init: ResponseInit = {}): Response {
    return new Response(body, { status: 200, ...init })
  }

  it('GET {baseUrl}/models，带 Bearer 头，解析 data[].id', async () => {
    const { fetchImpl, requests } = stubFetch(
      modelsResponse(
        JSON.stringify({ data: [{ id: 'tts-1' }, { id: 'FunAudioLLM/CosyVoice2-0.5B' }] }),
      ),
    )
    const tts = make(fakeSettings(), fetchImpl)

    const result = await tts.listModels({})

    expect(requests[0]!.url).toBe(`${BASE_URL}/models`)
    expect(requests[0]!.init.method).toBe('GET')
    const headers = requests[0]!.init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk-saved')
    expect(result.ok).toBe(true)
    expect(result.models).toEqual(['tts-1', 'FunAudioLLM/CosyVoice2-0.5B'])
    expect(result.message).toBeUndefined()
  })

  it('草稿值优先（含剥掉误填的 chat 端点尾巴），密钥用草稿明文', async () => {
    const { fetchImpl, requests } = stubFetch(
      modelsResponse(JSON.stringify({ data: [{ id: 'm' }] })),
    )
    const tts = make(fakeSettings({ secret: 'sk-saved' }), fetchImpl)

    const result = await tts.listModels({
      providerId: 'draft',
      baseUrl: 'https://x.com/v1/chat/completions',
      apiKey: 'sk-draft',
    })

    expect(result.ok).toBe(true)
    expect(requests[0]!.url).toBe('https://x.com/v1/models')
    const headers = requests[0]!.init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk-draft')
  })

  it('baseUrl 已以 /models 结尾时不重复拼接', async () => {
    const { fetchImpl, requests } = stubFetch(modelsResponse(JSON.stringify({ data: [] })))
    const tts = make(fakeSettings({ provider: { baseUrl: `${BASE_URL}/models/` } }), fetchImpl)
    await tts.listModels({})
    expect(requests[0]!.url).toBe(`${BASE_URL}/models`)
  })

  it('data / models 皆缺时折成 ok: false + 中文提示（防御性解析不抛）', async () => {
    // 顶层 models 数组已是合法回落（DashScope 形状），这里换一个真正无形状的响应
    const { fetchImpl } = stubFetch(modelsResponse(JSON.stringify({ items: ['x'] })))
    const tts = make(fakeSettings(), fetchImpl)
    const result = await tts.listModels({})
    expect(result.ok).toBe(false)
    expect(result.models).toEqual([])
    expect(result.message).toContain('data')
  })

  it('条目缺 id / 非 id 条目被跳过，取能取到的', async () => {
    const { fetchImpl } = stubFetch(
      modelsResponse(
        JSON.stringify({ data: [{ id: 'a' }, { nope: 1 }, 'junk', { id: '' }, { id: 'b' }] }),
      ),
    )
    const tts = make(fakeSettings(), fetchImpl)
    const result = await tts.listModels({})
    expect(result.ok).toBe(true)
    expect(result.models).toEqual(['a', 'b'])
  })

  it('HTTP 401 折成 describeHttpFailure 文案，不抛', async () => {
    const { fetchImpl } = stubFetch(errorResponse(401, 'bad key'))
    const tts = make(fakeSettings(), fetchImpl)
    const result = await tts.listModels({})
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/401/)
  })

  it('网络异常折成中文提示，不抛', async () => {
    const failing = (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch
    const tts = make(fakeSettings(), failing)
    const result = await tts.listModels({})
    expect(result.ok).toBe(false)
    expect(result.message).toContain('获取模型列表请求失败')
  })

  it('未配置 provider 时折成 ok: false 的中文提示', async () => {
    const { fetchImpl } = stubFetch(audioResponse([0]))
    const tts = make(fakeSettings({ active: '', omitProvider: true }), fetchImpl)
    const result = await tts.listModels({})
    expect(result.ok).toBe(false)
    expect(result.message).toBe('尚未配置 TTS 模型')
  })
})

describe('TtsSynthesizer · test', () => {
  it('成功回 ok + 字节数 + httpStatus', async () => {
    const { fetchImpl } = stubFetch(audioResponse([1, 2, 3]))
    const tts = make(fakeSettings(), fetchImpl)
    const result = await tts.test({})
    expect(result.ok).toBe(true)
    expect(result.bytes).toBe(3)
    expect(result.httpStatus).toBe(200)
    expect(result.message).toContain('合成成功')
  })

  it('用内置样例句「你好，我是 Aurora。」', async () => {
    const { fetchImpl, requests } = stubFetch(audioResponse([0]))
    const tts = make(fakeSettings(), fetchImpl)
    await tts.test({})
    const body = JSON.parse(String(requests[0]!.init.body)) as Record<string, unknown>
    expect(body['input']).toBe('你好，我是 Aurora。')
  })

  it('失败不抛，折成 ok: false 的 message', async () => {
    const { fetchImpl } = stubFetch(errorResponse(401, 'bad key'))
    const tts = make(fakeSettings(), fetchImpl)
    const result = await tts.test({})
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/401/)
    expect(result.httpStatus).toBe(401)
  })

  it('未配置时也返回 ok: false 而不是抛异常', async () => {
    const { fetchImpl } = stubFetch(audioResponse([0]))
    const tts = make(fakeSettings({ active: '', omitProvider: true }), fetchImpl)
    const result = await tts.test({})
    expect(result.ok).toBe(false)
    expect(result.message).toBe('尚未配置 TTS 模型')
  })

  it('接受页面草稿字段（未保存的 baseUrl / key / 音色），密钥优先用草稿明文', async () => {
    const { fetchImpl, requests } = stubFetch(audioResponse([0]))
    const tts = make(fakeSettings({ secret: 'sk-saved' }), fetchImpl)

    const result = await tts.test({
      providerId: 'draft',
      baseUrl: 'https://tts.example.com/v1',
      apiKey: 'sk-draft',
      model: 'tts-1',
      voice: 'alloy',
      speed: 2,
      format: 'opus',
    })

    expect(result.ok).toBe(true)
    expect(requests[0]!.url).toBe('https://tts.example.com/v1/audio/speech')
    const headers = requests[0]!.init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk-draft')
    const body = JSON.parse(String(requests[0]!.init.body)) as Record<string, unknown>
    expect(body['voice']).toBe('alloy')
    expect(body['response_format']).toBe('opus')
    expect(body['speed']).toBe(2)
  })

  it('草稿缺 Key 时回落已保存凭据', async () => {
    const { fetchImpl, requests } = stubFetch(audioResponse([0]))
    const tts = make(fakeSettings({ secret: 'sk-saved' }), fetchImpl)
    await tts.test({ baseUrl: BASE_URL, model: 'tts-1', voice: 'alloy' })
    const headers = requests[0]!.init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk-saved')
  })
})

describe('TtsSynthesizer · 出网路径', () => {
  /**
   * 把 `globalThis.fetch` 换成一个「一旦被调用就抛错」的哨兵，
   * 用来证明请求真的走了注入的 fetch —— 只断言「注入的被调用了」拿不到这个结论：
   * 那样一个误用 `globalThis.fetch` 的实现照样能通过。
   */
  async function withGlobalFetchTrap<T>(body: (trap: { calls: number }) => Promise<T>): Promise<T> {
    const original = globalThis.fetch
    const trap = { calls: 0 }
    globalThis.fetch = (() => {
      trap.calls += 1
      throw new Error('globalThis.fetch 被调用了 —— 说明没有走注入的 fetch')
    }) as typeof fetch
    try {
      return await body(trap)
    } finally {
      globalThis.fetch = original
    }
  }

  it('使用注入的 resolveFetch（advanced.proxy 生效的前提），而不是 globalThis.fetch', async () => {
    const { fetchImpl, requests } = stubFetch(audioResponse([0]))
    let resolveCalls = 0

    await withGlobalFetchTrap(async (trap) => {
      const tts = new TtsSynthesizer({
        settings: fakeSettings(),
        logger: createMemoryLogger(),
        resolveFetch: () => {
          resolveCalls += 1
          return fetchImpl
        },
      })

      await tts.synthesize({ text: 'hi' })

      // 两半都要断言：注入的**被用上**，全局的**一次都没被碰**
      expect(resolveCalls).toBeGreaterThan(0)
      expect(requests).toHaveLength(1)
      expect(trap.calls).toBe(0)
    })
  })

  it('resolveFetch 返回 undefined 时才回落 globalThis.fetch（哨兵会被打到）', async () => {
    const { fetchImpl, requests } = stubFetch(audioResponse([1]))
    const original = globalThis.fetch
    globalThis.fetch = fetchImpl
    try {
      const tts = new TtsSynthesizer({
        settings: fakeSettings(),
        logger: createMemoryLogger(),
        resolveFetch: () => undefined,
      })
      const result = await tts.synthesize({ text: 'hi' })
      // 这条用例锁住回落的**存在**（与上一条互为对照），免得将来把回落删了没人知道
      expect(result.bytes).toBe(1)
      expect(requests).toHaveLength(1)
    } finally {
      globalThis.fetch = original
    }
  })

  it('resolveFetch 抛错时回落默认实现，不把异常冒到调用方', async () => {
    const original = globalThis.fetch
    const { fetchImpl, requests } = stubFetch(audioResponse([0]))
    globalThis.fetch = fetchImpl
    try {
      const tts = new TtsSynthesizer({
        settings: fakeSettings(),
        logger: createMemoryLogger(),
        resolveFetch: () => {
          throw new Error('网络模块未就绪')
        },
      })
      const result = await tts.synthesize({ text: 'hi' })
      expect(result.bytes).toBe(1)
      expect(requests).toHaveLength(1)
    } finally {
      globalThis.fetch = original
    }
  })
})

// ───────────────────────── v43：语气指令 / 合成语言 / 新协议 / 清洗与缓存 ─────────────────────────

/**
 * 每次请求**现造**响应（Response body 只能读一次，缓存 / 多段用例会在同一个桩上
 * 发多次请求，回放同一个对象会炸「Body has already been read」）。
 */
function freshFetch(makeResponse: () => Response): {
  fetchImpl: typeof fetch
  requests: CapturedRequest[]
} {
  const requests: CapturedRequest[] = []
  const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} })
    return Promise.resolve(makeResponse())
  }) as typeof fetch
  return { fetchImpl, requests }
}

/**
 * 循环回放多个响应（两段请求 × 多次合成用）：第 n 次请求取第 n % len 个。
 * 每次请求返回 `clone()`：Response body 只能读一次，缓存 / 多段用例会在同一个桩上
 * 发多次请求，直接回放同一个对象会炸「Body has already been read」。
 */
function sequenceFetch(responses: Response[]): {
  fetchImpl: typeof fetch
  requests: CapturedRequest[]
} {
  const requests: CapturedRequest[] = []
  const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const index = requests.length
    requests.push({ url: String(input), init: init ?? {} })
    return Promise.resolve(responses[index % responses.length]!.clone())
  }) as typeof fetch
  return { fetchImpl, requests }
}

/** DashScope 系合成响应（2xx JSON，音频在 output.audio.url）。 */
function dashJsonResponse(url: string): Response {
  return new Response(
    JSON.stringify({ output: { audio: { url, expires_at: 0 }, finish_reason: 'stop' } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

describe('TtsSynthesizer · 语气指令与合成语言（v43，docs/06 §13.1）', () => {
  it('openai-compat：instructions 非空走顶层字段；空串不发送；language 永不发送', async () => {
    const { fetchImpl, requests } = freshFetch(() => audioResponse([0]))
    const tts = make(
      fakeSettings({ provider: { instructions: '用温柔的语气朗读', language: 'zh' } }),
      fetchImpl,
    )
    await tts.synthesize({ text: '你好' })
    const body = JSON.parse(String(requests[0]!.init.body)) as Record<string, unknown>
    expect(body['instructions']).toBe('用温柔的语气朗读')
    expect(body['language']).toBeUndefined()
    expect(body['language_type']).toBeUndefined()

    const plain = make(fakeSettings(), fetchImpl)
    await plain.synthesize({ text: '你好' })
    const plainBody = JSON.parse(String(requests[1]!.init.body)) as Record<string, unknown>
    expect(plainBody['instructions']).toBeUndefined()
  })

  it('dashscope：language zh → input.language_type Chinese；instructions 走 input；auto 不发送语言', async () => {
    const { fetchImpl, requests } = sequenceFetch([
      dashJsonResponse('https://oss.example.com/a.mp3'),
      audioResponse([0]),
    ])
    const tts = make(
      fakeSettings({
        provider: { type: 'dashscope', language: 'zh', instructions: '语速稍慢，温柔一些' },
      }),
      fetchImpl,
    )
    await tts.synthesize({ text: '你好' })
    const body = JSON.parse(String(requests[0]!.init.body)) as {
      input: { language_type?: string; instructions?: string }
    }
    expect(body.input.language_type).toBe('Chinese')
    expect(body.input.instructions).toBe('语速稍慢，温柔一些')

    const auto = make(fakeSettings({ provider: { type: 'dashscope' } }), fetchImpl)
    await auto.synthesize({ text: '你好' })
    const autoBody = JSON.parse(String(requests[2]!.init.body)) as {
      input: { language_type?: string; instructions?: string }
    }
    expect(autoBody.input.language_type).toBeUndefined()
    expect(autoBody.input.instructions).toBeUndefined()
  })

  it('未知语言短码归一为 auto（不发送），不让手改配置的笔误变成请求参数', async () => {
    const { fetchImpl, requests } = sequenceFetch([
      dashJsonResponse('https://oss.example.com/a.mp3'),
      audioResponse([0]),
    ])
    const tts = make(
      fakeSettings({ provider: { type: 'dashscope', language: 'klingon' } }),
      fetchImpl,
    )
    await tts.synthesize({ text: '你好' })
    const body = JSON.parse(String(requests[0]!.init.body)) as { input: { language_type?: string } }
    expect(body.input.language_type).toBeUndefined()
  })

  it('test()：草稿 instructions / language 优先于已保存配置', async () => {
    const { fetchImpl, requests } = freshFetch(() => audioResponse([0]))
    const tts = make(fakeSettings({ provider: { instructions: '已保存的语气' } }), fetchImpl)
    await tts.test({ instructions: '草稿的语气', language: 'en' })
    const body = JSON.parse(String(requests[0]!.init.body)) as Record<string, unknown>
    expect(body['instructions']).toBe('草稿的语气')
  })
})

describe('TtsSynthesizer · dashscope-audio（v43，docs/06 §13.7）', () => {
  const DASH_BASE = 'https://maas.qianwenaiapi.com/api/v1'
  const AUDIO_TAIL = '/services/audio/tts/SpeechSynthesizer'
  const GENERATION_TAIL = '/services/aigc/multimodal-generation/generation'

  /** 借 synthesize 捕获第一跳 URL（端点函数是模块内私有，从行为断言）。 */
  async function audioEndpointOf(baseUrl: string): Promise<string> {
    const { fetchImpl, requests } = sequenceFetch([
      dashJsonResponse('https://oss.example.com/a.mp3'),
      audioResponse([0]),
    ])
    const tts = make(fakeSettings({ provider: { type: 'dashscope-audio', baseUrl } }), fetchImpl)
    await tts.synthesize({ text: 'hi' })
    return requests[0]!.url
  }

  it('端点规整：裸域名 / api/v1 / compatible-mode / Center base 各形态', async () => {
    expect(await audioEndpointOf('https://maas.qianwenaiapi.com')).toBe(
      `https://maas.qianwenaiapi.com/api/v1${AUDIO_TAIL}`,
    )
    expect(await audioEndpointOf(DASH_BASE)).toBe(`${DASH_BASE}${AUDIO_TAIL}`)
    expect(await audioEndpointOf('https://maas.qianwenaiapi.com/compatible-mode/v1')).toBe(
      `https://maas.qianwenaiapi.com/api/v1${AUDIO_TAIL}`,
    )
    expect(await audioEndpointOf('http://127.0.0.1:8787/api/model-gateway/tts')).toBe(
      `http://127.0.0.1:8787/api/model-gateway/tts/api/v1${AUDIO_TAIL}`,
    )
  })

  it('端点规整：已以新端点结尾不重复拼；粘着旧生成端点（只改类型不改地址）整段替换', async () => {
    const full = `${DASH_BASE}${AUDIO_TAIL}`
    expect(await audioEndpointOf(`${full}/`)).toBe(full)
    expect(await audioEndpointOf(`${DASH_BASE}${GENERATION_TAIL}`)).toBe(
      `${DASH_BASE}${AUDIO_TAIL}`,
    )
  })

  it('请求体：input.format / instruction（单数）/ language_hints；rate 夹取到 0.5–2 且 ≠1 才发', async () => {
    const { fetchImpl, requests } = sequenceFetch([
      dashJsonResponse('https://oss.example.com/a.mp3'),
      audioResponse([0]),
    ])
    const tts = make(
      fakeSettings({
        provider: {
          type: 'dashscope-audio',
          baseUrl: DASH_BASE,
          model: 'qwen-audio-3.1-tts-flash',
          voice: 'loongstella',
          format: 'mp3',
          speed: 3,
          instructions: '用活泼明快的语气朗读',
          language: 'zh',
        },
      }),
      fetchImpl,
    )
    await tts.synthesize({ text: '你好' })
    const post = requests[0]!
    expect(post.url).toBe(`${DASH_BASE}${AUDIO_TAIL}`)
    const body = JSON.parse(String(post.init.body)) as {
      model: string
      input: {
        text: string
        voice: string
        format?: string
        rate?: number
        instruction?: string
        instructions?: string
        language_hints?: string[]
        language_type?: string
      }
      audio?: unknown
    }
    expect(body.model).toBe('qwen-audio-3.1-tts-flash')
    expect(body.input.text).toBe('你好')
    expect(body.input.voice).toBe('loongstella')
    expect(body.input.format).toBe('mp3')
    expect(body.input.rate).toBe(2) // speed 3 夹到协议上限 2
    expect(body.input.instruction).toBe('用活泼明快的语气朗读')
    expect(body.input.instructions).toBeUndefined() // 不是 dashscope 的复数字段
    expect(body.input.language_hints).toEqual(['zh'])
    expect(body.input.language_type).toBeUndefined() // 不是 dashscope 的全称字段
    expect(body.audio).toBeUndefined() // 格式在 input 里，不在顶层 audio

    // GET 下载不带 Authorization（与 dashscope 同口径）
    const download = requests[1]!
    expect(download.init.method).toBe('GET')
    expect((download.init.headers as Record<string, string>)['Authorization']).toBeUndefined()
  })

  it('speed=1 不发 rate；aac 不发 format；auto 不发 language_hints；空指令不发 instruction', async () => {
    const { fetchImpl, requests } = sequenceFetch([
      dashJsonResponse('https://oss.example.com/a.mp3'),
      audioResponse([0]),
    ])
    const tts = make(
      fakeSettings({ provider: { type: 'dashscope-audio', format: 'aac', speed: 1 } }),
      fetchImpl,
    )
    await tts.synthesize({ text: 'hi' })
    const body = JSON.parse(String(requests[0]!.init.body)) as { input: Record<string, unknown> }
    expect(body.input['rate']).toBeUndefined()
    expect(body.input['format']).toBeUndefined()
    expect(body.input['language_hints']).toBeUndefined()
    expect(body.input['instruction']).toBeUndefined()
  })

  it('模型级失效自动回退到 qwen-audio-3.1-tts-flash 并写回设置', async () => {
    const store = fakeSettings({
      provider: { type: 'dashscope-audio', baseUrl: DASH_BASE, model: 'qwen-audio-3.0-tts-flash' },
    })
    const mutations: Array<(draft: Settings) => void> = []
    const settings: SettingsStoreLike = {
      ...store,
      mutate: (mutator: (draft: Settings) => void) => {
        mutations.push(mutator)
        return store.get()
      },
    } as SettingsStoreLike
    const { fetchImpl, requests } = sequenceFetch([
      errorResponse(404, JSON.stringify({ code: 'Model not exist', message: 'Model not exist' })),
      dashJsonResponse('https://oss.example.com/a.mp3'),
      audioResponse([7]),
    ])
    const tts = make(settings, fetchImpl)
    const result = await tts.synthesize({ text: '你好' })
    expect(result.bytes).toBe(1)
    expect(requests).toHaveLength(3)
    const retryBody = JSON.parse(String(requests[1]!.init.body)) as { model: string }
    expect(retryBody.model).toBe('qwen-audio-3.1-tts-flash')
    // 写回：只改目标 provider 的 model
    expect(mutations).toHaveLength(1)
    const draft = {
      tts: { providers: { sf: { model: 'qwen-audio-3.0-tts-flash' } } },
    } as unknown as Settings
    mutations[0]!(draft)
    expect(draft.tts.providers['sf']!.model).toBe('qwen-audio-3.1-tts-flash')
  })

  it('listModels：与 dashscope 共用原生 /models 规整与翻页', async () => {
    const { fetchImpl, requests } = sequenceFetch([
      new Response(JSON.stringify({ data: [{ id: 'qwen-audio-3.1-tts-flash' }] }), { status: 200 }),
    ])
    const result = await make(
      fakeSettings({
        provider: {
          type: 'dashscope-audio',
          baseUrl: 'https://maas.qianwenaiapi.com/compatible-mode',
        },
      }),
      fetchImpl,
    ).listModels({})
    expect(requests[0]!.url).toBe(
      'https://maas.qianwenaiapi.com/api/v1/models?page_no=1&page_size=100',
    )
    expect(result).toEqual({ ok: true, models: ['qwen-audio-3.1-tts-flash'] })
  })
})

describe('TtsSynthesizer · 清洗与缓存（v43，docs/06 §13.4 / §13.8）', () => {
  it('synthesize 入口清洗 Markdown：代码块 / 强调标记不出网', async () => {
    const { fetchImpl, requests } = freshFetch(() => audioResponse([0]))
    const tts = make(fakeSettings(), fetchImpl)
    await tts.synthesize({ text: '这是**重点**。\n```ts\nconst a = 1\n```\n完毕。' })
    const body = JSON.parse(String(requests[0]!.init.body)) as { input: string }
    expect(body.input).toBe('这是重点。 完毕。')
  })

  it('清洗后为空（纯代码块）抛出「没有可朗读的文本」', async () => {
    const tts = make(fakeSettings(), freshFetch(() => audioResponse([0])).fetchImpl)
    await expect(tts.synthesize({ text: '```ts\nconst a = 1\n```' })).rejects.toThrow(
      '没有可朗读的文本',
    )
  })

  it('缓存命中：同参数同文本第二次合成不再出网', async () => {
    const { fetchImpl, requests } = freshFetch(() => audioResponse([1, 2, 3]))
    const tts = make(fakeSettings(), fetchImpl)
    const first = await tts.synthesize({ text: '你好，世界' })
    const second = await tts.synthesize({ text: '你好，世界' })
    expect(requests).toHaveLength(1)
    expect(second.audioBase64).toBe(first.audioBase64)
    expect(second.bytes).toBe(3)
  })

  it('缓存 key 含全部合成参数：同一实例上改音色 / 语气都 miss', async () => {
    const { fetchImpl, requests } = freshFetch(() => audioResponse([0]))
    const store = fakeSettings()
    const tts = make(store, fetchImpl)
    await tts.synthesize({ text: '你好' })
    await tts.synthesize({ text: '你好' }) // 命中
    expect(requests).toHaveLength(1)
    // fakeSettings.get 返回同一引用：改音色模拟设置变更，key 必须 miss
    store.get().tts.providers['sf']!.voice = 'ben'
    await tts.synthesize({ text: '你好' })
    expect(requests).toHaveLength(2)
    store.get().tts.providers['sf']!.instructions = '温柔一些'
    await tts.synthesize({ text: '你好' })
    expect(requests).toHaveLength(3)
  })

  it('缓存逐出：超过 16 条后最旧访问的条目被逐出（再读要重新合成）', async () => {
    const { fetchImpl, requests } = freshFetch(() => audioResponse([0]))
    const tts = make(fakeSettings(), fetchImpl)
    for (let i = 0; i < 17; i += 1) await tts.synthesize({ text: `文本编号${i}` })
    expect(requests).toHaveLength(17)
    // 第 0 条已被逐出 → 重新合成；第 16 条仍在缓存 → 不出网
    await tts.synthesize({ text: '文本编号0' })
    expect(requests).toHaveLength(18)
    await tts.synthesize({ text: '文本编号16' })
    expect(requests).toHaveLength(18)
  })

  it('test() 也走清洗（样例句带 Markdown 时同样剥掉）', async () => {
    const { fetchImpl, requests } = freshFetch(() => audioResponse([0]))
    const tts = make(fakeSettings(), fetchImpl)
    const result = await tts.test({ text: '**你好**，我是 Aurora。' })
    expect(result.ok).toBe(true)
    const body = JSON.parse(String(requests[0]!.init.body)) as { input: string }
    expect(body.input).toBe('你好，我是 Aurora。')
  })
})
