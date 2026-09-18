import { describe, expect, it } from 'vitest'
import {
  JsonRpcClient,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpTransport,
} from './jsonrpc.js'
import { McpError } from './errors.js'

/** 可编程假传输：按方法名给出响应，可制造超时与关闭。 */
class FakeTransport implements McpTransport {
  readonly kind = 'http' as const
  readonly sent: JsonRpcRequest[] = []
  readonly notifications: JsonRpcNotification[] = []
  closed = false
  handler: (request: JsonRpcRequest) => Promise<JsonRpcResponse> | JsonRpcResponse = (request) => ({
    jsonrpc: '2.0',
    id: request.id,
    result: { ok: true },
  })

  async send(request: JsonRpcRequest, options: { timeoutMs: number }): Promise<JsonRpcResponse> {
    this.sent.push(request)
    if (this.closed) throw new McpError('E_CLOSED', '已关闭')
    if (options.timeoutMs > 0) {
      // 直接拒绝以模拟超时，避免测试等待真实时间
      return await Promise.race([
        Promise.resolve(this.handler(request)),
        new Promise<JsonRpcResponse>((_resolve, reject) =>
          setTimeout(() => reject(new McpError('E_TIMEOUT', '超时')), options.timeoutMs),
        ),
      ])
    }
    return await Promise.resolve(this.handler(request))
  }

  notify(notification: JsonRpcNotification): void {
    this.notifications.push(notification)
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

describe('JsonRpcClient', () => {
  it('id 递增且返回 result', async () => {
    const transport = new FakeTransport()
    const client = new JsonRpcClient({ transport })
    const first = await client.request('initialize', { a: 1 })
    const second = await client.request('tools/list', {})
    expect(first).toEqual({ ok: true })
    expect(second).toEqual({ ok: true })
    expect(transport.sent.map((item) => item.id)).toEqual([1, 2])
    expect(transport.sent[0]?.jsonrpc).toBe('2.0')
  })

  it('服务端 error 字段转成 E_REMOTE 并带 detail', async () => {
    const transport = new FakeTransport()
    transport.handler = (request) => ({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32601, message: '未实现', data: { method: 'x' } },
    })
    const client = new JsonRpcClient({ transport })
    await expect(client.request('x')).rejects.toMatchObject({
      code: 'E_REMOTE',
      message: expect.stringContaining('未实现'),
    })
  })

  it('超时映射为 E_TIMEOUT', async () => {
    const transport = new FakeTransport()
    transport.handler = () => new Promise<JsonRpcResponse>(() => undefined)
    const client = new JsonRpcClient({ transport, timeoutMs: 5 })
    await expect(client.request('slow')).rejects.toMatchObject({ code: 'E_TIMEOUT' })
  })

  it('关闭后拒绝新请求', async () => {
    const transport = new FakeTransport()
    const client = new JsonRpcClient({ transport })
    await client.close()
    await expect(client.request('x')).rejects.toMatchObject({ code: 'E_CLOSED' })
    expect(transport.closed).toBe(true)
  })

  it('notify 走单向通道（不带 id）', () => {
    const transport = new FakeTransport()
    const client = new JsonRpcClient({ transport })
    client.notify('notifications/initialized')
    expect(transport.notifications).toEqual([
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    ])
    expect(client.kind).toBe('http')
  })

  it('handleNotification 转发回调且回调抛错不外溢', () => {
    const transport = new FakeTransport()
    const seen: string[] = []
    const client = new JsonRpcClient({
      transport,
      onNotification: (notification) => {
        seen.push(notification.method)
        if (notification.method === 'boom') throw new Error('listener')
      },
    })
    client.handleNotification({ jsonrpc: '2.0', method: 'ping' })
    expect(() => client.handleNotification({ jsonrpc: '2.0', method: 'boom' })).not.toThrow()
    expect(seen).toEqual(['ping', 'boom'])
  })
})
