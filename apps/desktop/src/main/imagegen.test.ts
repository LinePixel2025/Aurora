import { describe, expect, it } from 'vitest'
import { createMemoryLogger } from '@aurora/shared'
import { createImageGenService } from './imagegen.js'
import type { ImageGenSettingsStoreLike } from './imagegen.js'

const BASE_URL = 'https://api.example.com/v1'
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

interface FakeOptions {
  enabled?: boolean
  active?: string
  secret?: string
  provider?: Partial<{ baseUrl: string; model: string; size: string }>
  omitProvider?: boolean
}

function fakeSettings(options: FakeOptions = {}): ImageGenSettingsStoreLike {
  const provider = {
    type: 'openai-compat' as const,
    baseUrl: BASE_URL,
    apiKeyEnc: '',
    model: 'image-1',
    size: '1024x1024',
    ...options.provider,
  }
  const active = options.active ?? 'ig'
  const settings = {
    imagegen: {
      enabled: options.enabled ?? true,
      active,
      providers: options.omitProvider === true ? {} : { [active]: provider },
    },
  }
  return {
    get: () => settings,
    getSecret: () => options.secret ?? 'sk-saved',
  }
}

interface CapturedRequest {
  url: string
  init: RequestInit
}

function stubFetch(response: Response): { fetchImpl: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = []
  const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} })
    return Promise.resolve(response)
  }) as typeof fetch
  return { fetchImpl, requests }
}

function memoryFs(initial: Map<string, Uint8Array> = new Map()) {
  return {
    files: initial,
    async mkdir(path: string) {
      initial.set(`dir:${path}`, new Uint8Array(0))
      return undefined
    },
    async writeFile(path: string, data: Uint8Array) {
      initial.set(path, data)
    },
    async readFile(path: string) {
      const bytes = initial.get(path)
      if (bytes === undefined) throw new Error(`ENOENT: ${path}`)
      return bytes
    },
  }
}

function make(
  settings: ImageGenSettingsStoreLike,
  fetchImpl: typeof fetch,
  generatedDir: string,
  fs: ReturnType<typeof memoryFs>,
) {
  return createImageGenService({
    settings,
    logger: createMemoryLogger(),
    generatedDir,
    resolveFetch: () => fetchImpl,
    fs,
  })
}

describe('createImageGenService · generate', () => {
  it('b64_json 成功路径：JSON body 正确、图片落盘并回传 filePath + dataUrl', async () => {
    const b64 = PNG_BYTES.toString('base64')
    const { fetchImpl, requests } = stubFetch(
      new Response(JSON.stringify({ data: [{ b64_json: b64 }] })),
    )
    const dir = 'C:\\tmp\\generated'
    const fs = memoryFs()
    const service = make(fakeSettings(), fetchImpl, dir, fs)

    const result = await service.generate({ prompt: '一只机械猫' })

    expect(requests).toHaveLength(1)
    const request = requests[0]!
    expect(request.url).toBe(`${BASE_URL}/images/generations`)
    expect(request.init.method).toBe('POST')
    const headers = request.init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk-saved')
    expect(headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(String(request.init.body)) as Record<string, unknown>
    expect(body['model']).toBe('image-1')
    expect(body['prompt']).toBe('一只机械猫')
    expect(body['size']).toBe('1024x1024')
    expect(body['n']).toBe(1)
    expect(body['response_format']).toBe('b64_json')

    expect(result.filePath.startsWith(`${dir}\\`)).toBe(true)
    expect(result.filePath.endsWith('.png')).toBe(true)
    expect(result.dataUrl).toBe(`data:image/png;base64,${b64}`)
    expect(Buffer.from(fs.files.get(result.filePath)!).equals(PNG_BYTES)).toBe(true)
  })

  it('请求级 size 覆盖 provider 配置', async () => {
    const { fetchImpl, requests } = stubFetch(
      new Response(JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString('base64') }] })),
    )
    const service = make(fakeSettings(), fetchImpl, 'C:\\tmp\\generated', memoryFs())
    await service.generate({ prompt: 'cat', size: '512x512' })
    const body = JSON.parse(String(requests[0]!.init.body)) as Record<string, unknown>
    expect(body['size']).toBe('512x512')
  })

  it('服务只回 url 时用注入的 fetch 下载并落盘', async () => {
    const requests: CapturedRequest[] = []
    const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push({ url: String(input), init: init ?? {} })
      const url = String(input)
      if (url.endsWith('/images/generations')) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: [{ url: `${BASE_URL}/img/1.png` }] })),
        )
      }
      return Promise.resolve(new Response(new Uint8Array(PNG_BYTES)))
    }) as typeof fetch
    const fs = memoryFs()
    const service = make(fakeSettings(), fetchImpl, 'C:\\tmp\\generated', fs)

    const result = await service.generate({ prompt: 'cat' })

    expect(requests).toHaveLength(2)
    expect(requests[1]!.url).toBe(`${BASE_URL}/img/1.png`)
    expect(Buffer.from(fs.files.get(result.filePath)!).equals(PNG_BYTES)).toBe(true)
  })

  it('未配置（开关关闭 / active 为空 / 缺 Key）与空 prompt 抛中文提示且不出网', async () => {
    const { fetchImpl, requests } = stubFetch(new Response('{}'))
    const base = { prompt: 'cat' }
    await expect(
      make(fakeSettings({ enabled: false }), fetchImpl, 'C:\\tmp\\g', memoryFs()).generate(base),
    ).rejects.toThrow('图像生成未配置')
    await expect(
      make(
        fakeSettings({ active: '', omitProvider: true }),
        fetchImpl,
        'C:\\tmp\\g',
        memoryFs(),
      ).generate(base),
    ).rejects.toThrow('图像生成未配置')
    await expect(
      make(fakeSettings({ secret: '' }), fetchImpl, 'C:\\tmp\\g', memoryFs()).generate(base),
    ).rejects.toThrow('缺少 API Key')
    await expect(
      make(fakeSettings(), fetchImpl, 'C:\\tmp\\g', memoryFs()).generate({ prompt: '   ' }),
    ).rejects.toThrow('没有可生成的图片描述')
    expect(requests).toHaveLength(0)
  })

  it('非 2xx 折成带状态码的中文错误', async () => {
    const { fetchImpl } = stubFetch(new Response('bad key', { status: 401 }))
    const service = make(fakeSettings(), fetchImpl, 'C:\\tmp\\g', memoryFs())
    await expect(service.generate({ prompt: 'cat' })).rejects.toThrow(/API Key 无效.*401/)
  })
})

describe('createImageGenService · read', () => {
  it('只允许读取 generated 目录内的文件，越界路径（.. 逃逸 / 其它目录）一律拒绝', async () => {
    const dir = 'C:\\tmp\\generated'
    const fs = memoryFs()
    const service = make(fakeSettings(), stubFetch(new Response('{}')).fetchImpl, dir, fs)

    // 目录内但文件不存在 → 通过路径校验后按读盘失败处理（错误信息与越界路径可区分）
    await expect(service.read({ filePath: 'C:\\tmp\\generated\\ok.png' })).rejects.toThrow(
      '读取生成图片失败',
    )
    await expect(service.read({ filePath: 'C:\\tmp\\generated\\..\\secret.png' })).rejects.toThrow(
      '路径不合法',
    )
    await expect(service.read({ filePath: 'D:\\elsewhere\\pic.png' })).rejects.toThrow('路径不合法')
    await expect(service.read({ filePath: '' })).rejects.toThrow('缺少文件路径')
  })

  it('目录内的文件读回 data:image/png;base64 URL', async () => {
    const dir = 'C:\\tmp\\generated'
    const fs = memoryFs()
    const filePath = `${dir}\\1700000000000-abc123.png`
    fs.files.set(filePath, PNG_BYTES)
    const service = make(fakeSettings(), stubFetch(new Response('{}')).fetchImpl, dir, fs)

    const result = await service.read({ filePath })
    expect(result.dataUrl).toBe(`data:image/png;base64,${PNG_BYTES.toString('base64')}`)
  })

  it('目录内的同名目录路径（relative 为空串）也拒绝', async () => {
    const dir = 'C:\\tmp\\generated'
    const service = make(fakeSettings(), stubFetch(new Response('{}')).fetchImpl, dir, memoryFs())
    await expect(service.read({ filePath: dir })).rejects.toThrow('路径不合法')
  })
})
