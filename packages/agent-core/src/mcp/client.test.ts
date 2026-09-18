import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { McpClient } from './client.js'
import { HttpTransport, StdioTransport } from './transports.js'

const FAKE_SERVER = fileURLToPath(new URL('./testing/fakeMcpServer.mjs', import.meta.url))

function stdioClient(env: Record<string, string> = {}): McpClient {
  return new McpClient({
    server: 'fake',
    transport: new StdioTransport({ command: process.execPath, args: [FAKE_SERVER], env }),
  })
}

describe('StdioTransport + McpClient', () => {
  it('initialize → tools/list → tools/call 全链路', async () => {
    const client = stdioClient()
    try {
      await client.connect()
      expect(client.isConnected).toBe(true)
      expect(client.info).toEqual({ name: 'fake-mcp', version: '1.0.0' })
      expect(client.negotiatedProtocolVersion).toBe('2024-11-05')
      expect(client.listTools().map((tool) => tool.name)).toEqual(['echo'])
      expect(client.listTools()[0]?.parameters.properties).toEqual({ text: { type: 'string' } })

      const result = await client.callTool('echo', { text: 'hi' })
      expect(result.content).toBe('fake:echo:hi\n[image 内容]')
      expect(result.summary).toContain('fake:echo:hi')
      expect(result.isError).toBeUndefined()
    } finally {
      await client.close()
    }
  })

  it('工具返回 isError 时透传失败', async () => {
    const client = stdioClient({ MCP_FAKE_TOOLS: '["boom"]' })
    try {
      await client.connect()
      const result = await client.callTool('boom', {})
      expect(result.isError).toBe(true)
      expect(result.content).toBe('工具内部失败')
    } finally {
      await client.close()
    }
  })

  it('服务端 JSON-RPC 错误 → E_REMOTE', async () => {
    const client = stdioClient({ MCP_FAKE_TOOLS: '["explode"]' })
    try {
      await client.connect()
      await expect(client.callTool('explode', {})).rejects.toMatchObject({ code: 'E_REMOTE' })
    } finally {
      await client.close()
    }
  })

  it('initialize 被拒绝 → E_REMOTE，且不标记为已连接', async () => {
    const client = stdioClient({ MCP_FAKE_INIT_FAIL: '1' })
    await expect(client.connect()).rejects.toMatchObject({ code: 'E_REMOTE' })
    expect(client.isConnected).toBe(false)
    await client.close()
  })

  it('stdout 混入非协议垃圾不影响协议解析', async () => {
    const client = stdioClient({ MCP_FAKE_GARBAGE: '1' })
    try {
      await client.connect()
      expect(client.listTools()).toHaveLength(1)
    } finally {
      await client.close()
    }
  })

  it('命令不存在 → E_SPAWN（由子进程 error 事件触发）', async () => {
    const client = new McpClient({
      server: 'bad',
      transport: new StdioTransport({
        command: 'C:\\definitely-not-a-real-binary-aurora.exe',
        args: [],
      }),
    })
    await expect(client.connect()).rejects.toMatchObject({ code: 'E_SPAWN' })
    await client.close()
  })

  it('超时 → E_TIMEOUT', async () => {
    // 用一个不会回应的子进程：sleep 型命令（node -e 只等待）
    const client = new McpClient({
      server: 'sleepy',
      transport: new StdioTransport({
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 60000)'],
      }),
      timeoutMs: 30,
    })
    await expect(client.connect()).rejects.toMatchObject({ code: 'E_TIMEOUT' })
    await client.close()
  })
})

describe('HttpTransport + McpClient', () => {
  async function startServer(
    responder: (body: unknown) => { contentType: string; payload: string },
  ): Promise<{ url: string; close: () => Promise<void>; seen: unknown[] }> {
    const seen: unknown[] = []
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        seen.push(body)
        const { contentType, payload } = responder(body)
        res.writeHead(200, { 'content-type': contentType })
        res.end(payload)
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

  it('JSON 响应', async () => {
    const server = await startServer((body) => {
      const request = body as { id: number; method: string }
      if (request.method === 'initialize') {
        return {
          contentType: 'application/json',
          payload: JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              protocolVersion: '2024-11-05',
              serverInfo: { name: 'http-fake', version: '1' },
            },
          }),
        }
      }
      if (request.method === 'tools/list') {
        return {
          contentType: 'application/json',
          payload: JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object' } }],
            },
          }),
        }
      }
      return {
        contentType: 'application/json',
        payload: JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: { content: [{ type: 'text', text: 'pong' }] },
        }),
      }
    })

    const client = new McpClient({
      server: 'http',
      transport: new HttpTransport({ url: server.url }),
    })
    try {
      await client.connect()
      expect(client.listTools().map((tool) => tool.name)).toEqual(['ping'])
      const result = await client.callTool('ping', {})
      expect(result.content).toBe('pong')
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('SSE 响应（streamable-http）', async () => {
    const server = await startServer((body) => {
      const request = body as { id: number; method: string }
      const result =
        request.method === 'initialize'
          ? { protocolVersion: '2024-11-05', serverInfo: { name: 'sse-fake', version: '1' } }
          : request.method === 'tools/list'
            ? { tools: [] }
            : { content: [{ type: 'text', text: 'sse-ok' }] }
      const frame = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n\n`
      return { contentType: 'text/event-stream', payload: frame }
    })

    const client = new McpClient({
      server: 'sse',
      transport: new HttpTransport({ url: server.url }),
    })
    try {
      await client.connect()
      expect(client.info?.name).toBe('sse-fake')
      expect(client.listTools()).toEqual([])
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('HTTP 500 → E_HTTP', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"error":"boom"}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0

    const client = new McpClient({
      server: 'bad',
      transport: new HttpTransport({ url: `http://127.0.0.1:${port}/mcp` }),
    })
    await expect(client.connect()).rejects.toMatchObject({ code: 'E_HTTP' })
    await client.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('连接失败 → E_HTTP（不可达端口）', async () => {
    const client = new McpClient({
      server: 'down',
      transport: new HttpTransport({ url: 'http://127.0.0.1:1/mcp' }),
    })
    await expect(client.connect()).rejects.toMatchObject({ code: 'E_HTTP' })
    await client.close()
  })
})
