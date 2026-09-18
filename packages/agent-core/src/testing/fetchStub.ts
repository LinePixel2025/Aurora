/** 测试用 fetch 替身：按调用次数依次返回预置响应，并记录请求内容。 */

export interface StubCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

export interface StubResponse {
  status?: number
  /** JSON 响应体（与 body 互斥） */
  json?: unknown
  /** 文本响应体 */
  text?: string
  /** SSE 分片，按顺序推送 */
  sseChunks?: string[]
  /** 返回前抛出的错误（模拟网络失败） */
  throwError?: Error
}

export interface FetchStub {
  fetch: typeof fetch
  calls: StubCall[]
}

export function createFetchStub(responses: StubResponse[]): FetchStub {
  const calls: StubCall[] = []
  let index = 0

  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers: Record<string, string> = {}
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => {
        headers[key.toLowerCase()] = value
      })
    }
    const rawBody = init?.body
    calls.push({
      url,
      method,
      headers,
      body: typeof rawBody === 'string' ? JSON.parse(rawBody) : undefined,
    })

    const preset = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (!preset) throw new Error('setup: no stub response')
    if (preset.throwError) throw preset.throwError

    const status = preset.status ?? 200
    if (preset.sseChunks) {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of preset.sseChunks ?? []) controller.enqueue(encoder.encode(chunk))
          controller.close()
        },
      })
      return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } })
    }
    if (preset.json !== undefined) {
      return new Response(JSON.stringify(preset.json), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(preset.text ?? '', { status })
  }

  return { fetch: stub as unknown as typeof fetch, calls }
}

/** 把 ChatEvent 流收集成数组 */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of iterable) out.push(item)
  return out
}

export function sseLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}
