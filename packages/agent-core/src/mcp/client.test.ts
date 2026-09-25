import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createMemoryLogger } from '@aurora/shared'
import { McpClient } from './client.js'
import type { JsonRpcRequest, JsonRpcResponse, McpTransport } from './jsonrpc.js'
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

/** 内存分页假传输：tools/list 按请求次数依次返回 pages；页数用尽后重复返回最后一页 */
class PagedFakeTransport implements McpTransport {
  readonly kind = 'stdio' as const
  readonly toolListParams: unknown[] = []

  constructor(private readonly pages: Array<{ tools: unknown[]; nextCursor?: string }>) {}

  async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (request.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: { protocolVersion: '2024-11-05', serverInfo: { name: 'paged', version: '1' } },
      }
    }
    if (request.method === 'tools/list') {
      const page = this.pages[Math.min(this.toolListParams.length, this.pages.length - 1)]
      this.toolListParams.push(request.params)
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          tools: page?.tools ?? [],
          ...(page?.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        },
      }
    }
    return { jsonrpc: '2.0', id: request.id, result: {} }
  }

  notify(): void {}

  async close(): Promise<void> {}
}

describe('tools/list 分页（nextCursor，docs/06 §7）', () => {
  it('跟随 nextCursor 翻页并合并各页工具（首页无 cursor，翻页带 cursor）', async () => {
    const transport = new PagedFakeTransport([
      {
        tools: [{ name: 'a', description: 'a', inputSchema: { type: 'object' } }],
        nextCursor: 'page-2',
      },
      { tools: [{ name: 'b', description: 'b', inputSchema: { type: 'object' } }] },
    ])
    const client = new McpClient({ server: 'paged', transport })
    try {
      await client.connect()
      expect(client.listTools().map((tool) => tool.name)).toEqual(['a', 'b'])
      expect(transport.toolListParams[0]).toEqual({})
      expect(transport.toolListParams[1]).toEqual({ cursor: 'page-2' })
    } finally {
      await client.close()
    }
  })

  it('单页（无 nextCursor）只请求一次，行为不变', async () => {
    const transport = new PagedFakeTransport([
      { tools: [{ name: 'only', description: 'only', inputSchema: { type: 'object' } }] },
    ])
    const client = new McpClient({ server: 'single', transport })
    try {
      await client.connect()
      expect(client.listTools().map((tool) => tool.name)).toEqual(['only'])
      expect(transport.toolListParams).toHaveLength(1)
    } finally {
      await client.close()
    }
  })

  it('分页超过 20 页上限即停止并记 warn', async () => {
    // 单页 + 恒定 nextCursor：永远"还有下一页"
    const transport = new PagedFakeTransport([
      {
        tools: [{ name: 't', description: 't', inputSchema: { type: 'object' } }],
        nextCursor: 'more',
      },
    ])
    const logger = createMemoryLogger()
    const client = new McpClient({ server: 'paged', transport, logger })
    try {
      await client.connect()
      expect(client.listTools()).toHaveLength(20)
      expect(transport.toolListParams).toHaveLength(20)
      expect(logger.entries.some((line) => line.includes('分页超过上限'))).toBe(true)
    } finally {
      await client.close()
    }
  })
})
