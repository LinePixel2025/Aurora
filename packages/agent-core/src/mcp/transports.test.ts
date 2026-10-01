import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import type { JsonRpcRequest } from './jsonrpc.js'
import { HttpTransport } from './transports.js'

/**
 * 通用桩服务端：捕获请求头与请求体，把响应行为交给调用方（可保持流打开）。
 * `close()` 会强制销毁仍在连接的 socket —— 保持开流的场景下 `server.close()` 自己不会返回。
 */
async function startStubServer(
  handler: (context: { body: unknown; headers: IncomingHttpHeaders; res: ServerResponse }) => void,
): Promise<{ url: string; seen: IncomingHttpHeaders[]; close: () => Promise<void> }> {
  const seen: IncomingHttpHeaders[] = []
  const sockets = new Set<Socket>()
  const server: Server = createServer((req, res) => {
    seen.push(req.headers)
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      let body: unknown
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        body = undefined
      }
      handler({ body, headers: req.headers, res })
    })
  })
  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * P2-04：Streamable HTTP 规范允许服务端在写出响应后**继续持有 SSE 流**
 * （长工具期间推通知 / 心跳）。旧的 `await response.text()` 会一直挂到流关闭，
 * 先撞上请求超时 —— 响应其实早已到达，于是超过 30s 的工具必然报超时。
 * 增量解析必须在匹配响应到达的那一刻返回，并取消读取释放连接。
 */
describe('HttpTransport SSE 增量解析', () => {
  it('服务端返回响应后保持流打开 → 请求在超时窗口内正常返回（不等流关闭）', async () => {
    const server = await startStubServer(({ body, res }) => {
      const id = (body as { id: number }).id
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } })}\n\n`,
      )
      // 刻意不 res.end()：模拟"响应已到、流仍开着等心跳"
    })
    const transport = new HttpTransport({ url: server.url })
    try {
      const started = Date.now()
      const response = await transport.send(
        { jsonrpc: '2.0', id: 7, method: 'tools/call' },
        {
          timeoutMs: 30_000,
        },
      )
      expect(response).toMatchObject({ id: 7, result: { ok: true } })
      expect(Date.now() - started).toBeLessThan(3_000)
    } finally {
      await transport.close()
      await server.close()
    }
  })

  it('通知事件 + 跨 chunk 拆分的匹配响应：增量拼接后命中，仍然不等流关闭', async () => {
    const server = await startStubServer(({ body, res }) => {
      const id = (body as { id: number }).id
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      // 前一条事件是服务端通知（无 id）→ 必须跳过
      res.write(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\n`,
      )
      const payload = JSON.stringify({ jsonrpc: '2.0', id, result: { chunked: true } })
      const half = Math.ceil(payload.length / 2)
      res.write(`event: message\ndata: ${payload.slice(0, half)}`)
      // 分两段写出：事件跨 chunk 边界，解析必须等拼全才命中
      setTimeout(() => {
        res.write(`${payload.slice(half)}\n\n`)
        // 依旧不 end
      }, 20)
    })
    const transport = new HttpTransport({ url: server.url })
    try {
      const response = await transport.send(
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        {
          timeoutMs: 30_000,
        },
      )
      expect(response).toMatchObject({ id: 1, result: { chunked: true } })
    } finally {
      await transport.close()
      await server.close()
    }
  })
})

/**
 * P2-05：服务端在 initialize 响应头下发 `Mcp-Session-Id`（Streamable HTTP 规范行为），
 * 客户端此后每个请求（send / notify）都必须回传，否则 tools/list / tools/call 被 400/404 拒绝。
 */
describe('HttpTransport Mcp-Session-Id', () => {
  it('initialize 下发后，后续 send 与 notify 的请求头都携带它', async () => {
    const server = await startStubServer(({ body, res }) => {
      const { id, method } = body as { id: number; method: string }
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (method === 'initialize') headers['mcp-session-id'] = 'sess-abc'
      res.writeHead(200, headers)
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: {} }))
    })
    const transport = new HttpTransport({ url: server.url })
    try {
      await transport.send(
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
        {
          timeoutMs: 5_000,
        },
      )
      await transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { timeoutMs: 5_000 })
      transport.notify({ jsonrpc: '2.0', method: 'notifications/initialized' })
      await delay(50)

      // initialize 之前没有会话 id 可带
      expect(server.seen[0]?.['mcp-session-id']).toBeUndefined()
      // 捕获后：请求与通知都回传
      expect(server.seen[1]?.['mcp-session-id']).toBe('sess-abc')
      expect(server.seen[2]?.['mcp-session-id']).toBe('sess-abc')
    } finally {
      await transport.close()
      await server.close()
    }
  })
})

/**
 * HttpTransport 自定义请求头（docs/06 §7）：
 * 默认头兜底、用户头覆盖默认头（`{ ...defaults, ...userHeaders }`）。
 * 头值只出现在本测试的断言里——实现与日志绝不落头值。
 */
describe('HttpTransport headers', () => {
  /** 真实 HTTP 服务端：逐请求捕获请求头，回一条合法 JSON-RPC 响应（跟随既有测试模式） */
  async function startCaptureServer(): Promise<{
    url: string
    seen: IncomingHttpHeaders[]
    close: () => Promise<void>
  }> {
    const seen: IncomingHttpHeaders[] = []
    const server: Server = createServer((req, res) => {
      seen.push(req.headers)
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: number }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    return {
      url: `http://127.0.0.1:${port}/mcp`,
      seen,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }
  }

  const request: JsonRpcRequest = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }

  it('未配置 headers 时默认头兜底', async () => {
    const server = await startCaptureServer()
    const transport = new HttpTransport({ url: server.url })
    try {
      await transport.send(request, { timeoutMs: 5_000 })
      expect(server.seen[0]?.['content-type']).toBe('application/json')
      expect(server.seen[0]?.accept).toBe('application/json, text/event-stream')
      expect(server.seen[0]?.authorization).toBeUndefined()
    } finally {
      await transport.close()
      await server.close()
    }
  })

  it('用户头覆盖默认头，notify 同样合并', async () => {
    const server = await startCaptureServer()
    const transport = new HttpTransport({
      url: server.url,
      headers: {
        accept: 'application/json',
        authorization: 'Bearer test-token',
        'x-custom': 'custom-value',
      },
    })
    try {
      await transport.send(request, { timeoutMs: 5_000 })
      transport.notify({ jsonrpc: '2.0', method: 'notifications/initialized' })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(server.seen.length).toBe(2)
      for (const headers of server.seen) {
        // 默认头兜底
        expect(headers['content-type']).toBe('application/json')
        // 用户显式配置优先
        expect(headers.accept).toBe('application/json')
        expect(headers.authorization).toBe('Bearer test-token')
        expect(headers['x-custom']).toBe('custom-value')
      }
    } finally {
      await transport.close()
      await server.close()
    }
  })
})
