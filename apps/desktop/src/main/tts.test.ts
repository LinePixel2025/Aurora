import { describe, expect, it } from 'vitest'
import { createMemoryLogger } from '@aurora/shared'
import type { Settings, TtsFormat } from '@aurora/shared'
import { TtsSynthesizer } from './tts.js'
import type { SettingsStoreLike } from './contracts.js'

const BASE_URL = 'https://api.siliconflow.cn/v1'

interface FakeSettingsOptions {
  active?: string
  maxChars?: number
  secret?: string
  provider?: Partial<{
    baseUrl: string
    model: string
    voice: string
    speed: number
    format: TtsFormat
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
    ...options.provider,
  }
  const active = options.active ?? 'sf'
  const settings = {
    version: 7,
    general: {
      language: 'zh-CN',
      launchAtLogin: false,
      hotkey: 'Alt+Space',
      edgeBar: { enabled: true, opacity: 0.9, quietHours: null },
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

  it('data 非数组折成 ok: false + 中文提示（防御性解析不抛）', async () => {
    const { fetchImpl } = stubFetch(modelsResponse(JSON.stringify({ models: ['x'] })))
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
