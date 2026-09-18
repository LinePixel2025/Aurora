/**
 * 测试用假 MCP 服务器（真实子进程，Content-Length 分帧）。
 *
 * 通过 `node fakeMcpServer.js` 启动；环境变量可控制行为：
 * - `MCP_FAKE_TOOLS`：可选工具名列表（JSON），默认 `["echo"]`
 * - `MCP_FAKE_INIT_FAIL=1`：`initialize` 返回 JSON-RPC 错误
 * - `MCP_FAKE_GARBAGE=1`：启动时向 stdout 打印非协议垃圾（验证容错）
 */
const tools = JSON.parse(process.env.MCP_FAKE_TOOLS ?? '["echo"]')
let buffer = ''

if (process.env.MCP_FAKE_GARBAGE === '1') {
  process.stdout.write('this is not protocol data\n')
}

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  for (;;) {
    const boundary = buffer.indexOf('\r\n\r\n')
    if (boundary < 0) break
    const header = buffer.slice(0, boundary)
    const match = /content-length:\s*(\d+)/i.exec(header)
    if (!match) {
      buffer = buffer.slice(boundary + 4)
      continue
    }
    const length = Number(match[1])
    const start = boundary + 4
    if (buffer.length - start < length) break
    const body = buffer.slice(start, start + length)
    buffer = buffer.slice(start + length)
    handle(JSON.parse(body))
  }
})

function send(payload) {
  const json = JSON.stringify(payload)
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`)
}

function handle(message) {
  if (message.method === 'notifications/initialized') return
  if (message.method === 'initialize') {
    if (process.env.MCP_FAKE_INIT_FAIL === '1') {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: '初始化被拒绝' } })
      return
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'fake-mcp', version: '1.0.0' },
        capabilities: { tools: {} },
      },
    })
    return
  }
  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: tools.map((name) => ({
          name,
          description: `假工具 ${name}`,
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: [],
          },
        })),
      },
    })
    return
  }
  if (message.method === 'tools/call') {
    const name = message.params?.name
    const text = message.params?.arguments?.text ?? ''
    if (name === 'boom') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { isError: true, content: [{ type: 'text', text: '工具内部失败' }] },
      })
      return
    }
    if (name === 'explode') {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: '服务端炸了' } })
      return
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [
          { type: 'text', text: `fake:${name}:${text}` },
          { type: 'image', data: 'xxx' },
        ],
      },
    })
    return
  }
  if (message.id !== undefined) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `未知方法 ${message.method}` },
    })
  }
}
