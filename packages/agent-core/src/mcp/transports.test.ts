import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { describe, expect, it } from 'vitest'
import type { JsonRpcRequest } from './jsonrpc.js'
import { HttpTransport } from './transports.js'

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
