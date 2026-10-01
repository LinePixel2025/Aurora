import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createMemoryLogger, type McpServerConfig } from '@aurora/shared'
import { McpClientHub, mcpToolName, toServerDefinitions, type TransportHooks } from './hub.js'
import { McpError } from './errors.js'
import type { JsonRpcRequest, JsonRpcResponse, McpTransport } from './jsonrpc.js'
import { ToolRegistry } from '../tools/registry.js'

const FAKE_SERVER = fileURLToPath(new URL('./testing/fakeMcpServer.mjs', import.meta.url))

function stdioDefinition(
  name = 'fake',
  env: Record<string, string> = {},
  headers?: Record<string, string>,
) {
  return {
    name,
    transport: 'stdio' as const,
    enabled: true,
    command: process.execPath,
    args: [FAKE_SERVER],
    env,
    ...(headers === undefined ? {} : { headers }),
  }
}

function setup() {
  const tools = new ToolRegistry()
  const logger = createMemoryLogger()
  const statusLog: Array<Array<{ name: string; state: string }>> = []
  const hub = new McpClientHub({
    tools,
    logger,
    timeoutMs: 5_000,
    onStatusChanged: (statuses) =>
      statusLog.push(statuses.map((item) => ({ name: item.name, state: item.state }))),
  })
  return { hub, tools, logger, statusLog }
}

describe('McpClientHub', () => {
  it('连接后把工具注册为 mcp.<server>.<tool>（标记 confirm）', async () => {
    const { hub, tools } = setup()
    await hub.reconfigure([stdioDefinition()], { connect: true })

    expect(hub.statuses()).toEqual([
      {
        name: 'fake',
        transport: 'stdio',
        enabled: true,
        state: 'ready',
        toolCount: 1,
      },
    ])
    const tool = tools.get('mcp.fake.echo')
    expect(tool).toBeDefined()
    expect(tool?.sensitivity).toBe('confirm')

    const result = await tool?.execute({ text: 'hi' }, { sessionId: 's' })
    expect(result?.content).toContain('fake:echo:hi')
    await hub.close()
  })

  it('单个服务器失败只影响自己（不抛出）', async () => {
    const { hub, tools, logger } = setup()
    await hub.reconfigure(
      [
        { name: 'bad', transport: 'stdio', enabled: true, command: 'no-such-binary-aurora.exe' },
        stdioDefinition('good'),
      ],
      { connect: true },
    )

    const statuses = hub.statuses()
    expect(statuses.find((item) => item.name === 'bad')?.state).toBe('error')
    expect(statuses.find((item) => item.name === 'bad')?.lastError).toBeTruthy()
    expect(statuses.find((item) => item.name === 'good')?.state).toBe('ready')
    expect(tools.get('mcp.good.echo')).toBeDefined()
    expect(logger.entries.some((line) => line.includes('MCP 服务器不可用'))).toBe(true)
    await hub.close()
  })

  it('缺少 command / url 时直接置 error', async () => {
    const { hub } = setup()
    await hub.reconfigure([{ name: 'empty', transport: 'stdio', enabled: true }], { connect: true })
    expect(hub.statuses()[0]?.state).toBe('error')
    expect(hub.statuses()[0]?.lastError).toContain('command')
    await hub.close()
  })

  it('停用的服务器不连接、也不注册工具', async () => {
    const { hub, tools } = setup()
    await hub.reconfigure([{ ...stdioDefinition(), enabled: false }], { connect: true })
    expect(hub.statuses()[0]?.state).toBe('idle')
    expect(tools.list()).toHaveLength(0)
    await hub.close()
  })

  it('lazyConnect：配置后不连接，首次调用工具时才连接', async () => {
    const { hub, tools } = setup()
    await hub.reconfigure([stdioDefinition()], { lazyConnect: true, connect: true })
    expect(hub.isLazy).toBe(true)
    expect(hub.statuses()[0]?.state).toBe('idle')
    expect(tools.list()).toHaveLength(0)

    await hub.connectAll()
    expect(hub.statuses()[0]?.state).toBe('ready')
    await hub.close()
  })

  it('reconfigure 移除已删除的服务器并清理其工具', async () => {
    const { hub, tools } = setup()
    await hub.reconfigure([stdioDefinition('a'), stdioDefinition('b')], { connect: true })
    expect(tools.get('mcp.a.echo')).toBeDefined()

    await hub.reconfigure([stdioDefinition('b')], { connect: true })
    expect(tools.get('mcp.a.echo')).toBeUndefined()
    expect(tools.get('mcp.b.echo')).toBeDefined()
    expect(hub.statuses().map((item) => item.name)).toEqual(['b'])
    await hub.close()
  })

  it('reconfigure 对相同配置幂等（不重复建连）', async () => {
    const { hub } = setup()
    await hub.reconfigure([stdioDefinition()], { connect: true })
    const before = hub.statuses()
    await hub.reconfigure([stdioDefinition()], { connect: true })
    expect(hub.statuses()).toEqual(before)
    await hub.close()
  })

  it('参数变化会触发重建连接', async () => {
    const { hub, tools } = setup()
    await hub.reconfigure([stdioDefinition('fake', { MCP_FAKE_TOOLS: '["echo"]' })], {
      connect: true,
    })
    expect(toolNames(tools)).toEqual(['mcp.fake.echo'])
    await hub.reconfigure([stdioDefinition('fake', { MCP_FAKE_TOOLS: '["alpha","beta"]' })], {
      connect: true,
    })
    expect(toolNames(tools)).toEqual(['mcp.fake.alpha', 'mcp.fake.beta'])
    await hub.close()
  })

  it('headers 变化触发重建连接；仅 key 顺序不同视为相同（稳定序列化）', async () => {
    const { hub, statusLog } = setup()
    const connectingCount = (): number =>
      statusLog.filter((states) => states.some((item) => item.state === 'connecting')).length

    await hub.reconfigure([stdioDefinition('fake', {}, { a: '1', b: '2' })], { connect: true })
    expect(hub.statuses()[0]?.state).toBe('ready')
    expect(connectingCount()).toBe(1)

    // key 顺序不同、内容相同 → 配置 diff 判定未变化，不重连
    await hub.reconfigure([stdioDefinition('fake', {}, { b: '2', a: '1' })], { connect: true })
    expect(connectingCount()).toBe(1)
    expect(hub.statuses()[0]?.state).toBe('ready')

    // 内容变化 → 触发重建连接
    await hub.reconfigure([stdioDefinition('fake', {}, { a: '9' })], { connect: true })
    expect(connectingCount()).toBe(2)
    expect(hub.statuses()[0]?.state).toBe('ready')
    await hub.close()
  })

  it('http 定义的 headers 透传到 HttpTransport 请求头（值不落日志）', async () => {
    const seen: IncomingHttpHeaders[] = []
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        seen.push(req.headers)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          id: number
          method: string
        }
        const result =
          body.method === 'initialize'
            ? { protocolVersion: '2024-11-05', serverInfo: { name: 'hub-http', version: '1' } }
            : body.method === 'tools/list'
              ? { tools: [] }
              : {}
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0

    const { hub, logger } = setup()
    try {
      await hub.reconfigure(
        [
          {
            name: 'remote',
            transport: 'http',
            url: `http://127.0.0.1:${port}/mcp`,
            enabled: true,
            headers: { authorization: 'Bearer hub-secret', 'x-trace': 'aurora' },
          },
        ],
        { connect: true },
      )
      expect(hub.statuses()[0]?.state).toBe('ready')
      expect(seen.length).toBeGreaterThanOrEqual(1)
      expect(seen[0]?.authorization).toBe('Bearer hub-secret')
      expect(seen[0]?.['x-trace']).toBe('aurora')
      expect(seen[0]?.accept).toBe('application/json, text/event-stream')
      // 凭据口径：日志只允许出现 key 名，绝不落头值
      expect(logger.entries.join('\n')).not.toContain('hub-secret')
      expect(logger.entries.join('\n')).toContain('headerKeys')
    } finally {
      await hub.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('close 清理状态与工具', async () => {
    const { hub, tools } = setup()
    await hub.reconfigure([stdioDefinition()], { connect: true })
    await hub.close()
    expect(hub.statuses()).toEqual([])
    expect(tools.list()).toHaveLength(0)
  })

  it('findToolServer 解析工具命名空间', () => {
    const { hub } = setup()
    expect(hub.findToolServer('mcp.fake.echo')).toBe('fake')
    expect(hub.findToolServer('use_skill')).toBeUndefined()
    expect(hub.findToolServer('mcp.fake')).toBeUndefined()
  })

  it('MCP 工具覆盖同名 Skill 工具（MCP 优先）', async () => {
    const { hub, tools } = setup()
    tools.register({
      name: 'mcp.fake.echo',
      description: '同名内置工具',
      parameters: { type: 'object' },
      execute: async () => ({ content: 'builtin' }),
    })
    await hub.reconfigure([stdioDefinition()], { connect: true })
    const result = await tools.get('mcp.fake.echo')?.execute({ text: 'x' }, { sessionId: 's' })
    expect(result?.content).toContain('fake:echo:x')
    expect(tools.conflicts.some((item) => item.message.includes('MCP 工具覆盖'))).toBe(true)
    await hub.close()
  })

  /**
   * P2-06：MCP 工具覆盖同名内置工具后，断开 / 移除都必须把内置实现**恢复**回来，
   * 而不是让模型拿到「工具不存在」直到下一次 sync()。
   */
  it('MCP 覆盖同名内置工具后 close() → 被覆盖的旧定义恢复且可调用', async () => {
    const { hub, tools } = setup()
    const builtin = {
      name: 'mcp.fake.echo',
      description: '内置实现',
      parameters: { type: 'object' },
      execute: async () => ({ content: 'builtin' }),
    }
    tools.register(builtin)

    await hub.reconfigure([stdioDefinition()], { connect: true })
    // 连接期间 MCP 实现生效
    const duringConnection = await tools
      .get('mcp.fake.echo')
      ?.execute({ text: 'x' }, { sessionId: 's' })
    expect(duringConnection?.content).toContain('fake:echo:x')

    await hub.close()
    const restored = tools.get('mcp.fake.echo')
    expect(restored).toBe(builtin)
    expect((await restored?.execute({}, { sessionId: 's' }))?.content).toBe('builtin')
  })

  it('reconfigure 移除服务器（teardown 路径）同样恢复被覆盖的旧定义', async () => {
    const { hub, tools } = setup()
    const builtin = {
      name: 'mcp.fake.echo',
      description: '内置实现',
      parameters: { type: 'object' },
      execute: async () => ({ content: 'builtin' }),
    }
    tools.register(builtin)

    await hub.reconfigure([stdioDefinition()], { connect: true })
    expect(tools.get('mcp.fake.echo')).not.toBe(builtin)

    await hub.reconfigure([], { connect: true })
    expect(tools.get('mcp.fake.echo')).toBe(builtin)
    await hub.close()
  })
})

describe('mcpToolName / toServerDefinitions', () => {
  it('服务器名中的点被归一，避免破坏命名空间', () => {
    expect(mcpToolName('my.server', 'read')).toBe('mcp.my_server.read')
  })

  it('把设置配置 + 解密函数转换为 hub 输入', () => {
    const servers: McpServerConfig[] = [
      {
        name: 'fs',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'server'],
        envEnc: { TOKEN: 'cipher' },
        enabled: true,
      },
      { name: 'remote', transport: 'http', url: 'https://x/mcp', envEnc: {}, enabled: false },
    ]
    const definitions = toServerDefinitions(servers, (server) => ({
      TOKEN: `plain-${server.name}`,
    }))
    expect(definitions[0]).toMatchObject({
      name: 'fs',
      command: 'npx',
      args: ['-y', 'server'],
      env: { TOKEN: 'plain-fs' },
      enabled: true,
    })
    expect(definitions[1]).toMatchObject({ name: 'remote', url: 'https://x/mcp', enabled: false })
  })
})

function toolNames(tools: ToolRegistry): string[] {
  return tools
    .list()
    .map((tool) => tool.name)
    .sort()
}

/** 可编程假传输：应答协议三件套；`failConnect` 时建连失败；`crash()` 模拟子进程意外退出 */
class FakeMcpTransport implements McpTransport {
  readonly kind = 'stdio' as const
  private hooks: TransportHooks | undefined

  constructor(private readonly failConnect: boolean) {}

  setHooks(hooks: TransportHooks | undefined): void {
    this.hooks = hooks
  }

  async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (this.failConnect) throw new McpError('E_CLOSED', '假传输连接失败')
    if (request.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'fake-mcp', version: '1' },
        },
      }
    }
    if (request.method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          tools: [
            {
              name: 'echo',
              description: '假工具 echo',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        },
      }
    }
    return { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'ok' }] } }
  }

  notify(): void {}

  async close(): Promise<void> {}

  crash(): void {
    this.hooks?.onExit?.({ code: 1, signal: null })
  }
}

describe('McpClientHub stdio 意外断开自动重连（docs/06 §7）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** 与 setup() 同款，但注入可编程传输工厂：`state.failConnect` 控制后续建连是否失败 */
  function factorySetup() {
    const tools = new ToolRegistry()
    const logger = createMemoryLogger()
    const transports: FakeMcpTransport[] = []
    const state = { failConnect: false }
    const statusLog: Array<Array<{ name: string; state: string }>> = []
    const hub = new McpClientHub({
      tools,
      logger,
      onStatusChanged: (statuses) =>
        statusLog.push(statuses.map((item) => ({ name: item.name, state: item.state }))),
      createTransport: (_definition, hooks) => {
        const transport = new FakeMcpTransport(state.failConnect)
        transport.setHooks(hooks)
        transports.push(transport)
        return transport
      },
    })
    return { hub, tools, logger, transports, state, statusLog }
  }

  // command 仅为占位：传输由工厂注入，defaultTransport 不会被调用
  const bareDefinition = {
    name: 'fake',
    transport: 'stdio' as const,
    enabled: true,
    command: 'unused-by-factory',
  }

  it('意外退出 → 工具移除并进入 connecting，第 1 次重试成功 → ready 且工具重新注册', async () => {
    const { hub, tools, logger, transports } = factorySetup()
    await hub.reconfigure([bareDefinition], { connect: true })
    expect(hub.statuses()[0]?.state).toBe('ready')
    expect(tools.get('mcp.fake.echo')).toBeDefined()

    transports[0]?.crash()
    expect(hub.statuses()[0]?.state).toBe('connecting')
    expect(tools.get('mcp.fake.echo')).toBeUndefined()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(hub.statuses()[0]).toMatchObject({ state: 'ready', toolCount: 1 })
    expect(tools.get('mcp.fake.echo')).toBeDefined()
    expect(transports).toHaveLength(2)
    expect(logger.entries.some((line) => line.includes('将自动重连'))).toBe(true)
    expect(logger.entries.some((line) => line.includes('自动重连成功'))).toBe(true)
    await hub.close()
  })

  it('退避间隔按 1s/2s/4s/8s/16s 指数递增（warn 记录第几次与下次间隔）', async () => {
    const { hub, transports, state, logger } = factorySetup()
    await hub.reconfigure([bareDefinition], { connect: true })
    state.failConnect = true
    transports[0]?.crash()

    // 每次只推进到下一次退避到期，验证间隔序列
    for (const delay of [1_000, 2_000, 4_000, 8_000]) {
      await vi.advanceTimersByTimeAsync(delay)
      expect(hub.statuses()[0]?.state).toBe('connecting')
    }
    await vi.advanceTimersByTimeAsync(16_000)

    expect(logger.entries.filter((line) => line.includes('将自动重连'))).toHaveLength(5)
    expect(logger.entries.some((line) => line.includes('"nextRetryMs":16000'))).toBe(true)
    expect(transports).toHaveLength(6)
    await hub.close()
  })

  it('5 次重连全部失败 → error（lastError 注明自动重连失败）并停止重试', async () => {
    const { hub, logger, transports, state } = factorySetup()
    await hub.reconfigure([bareDefinition], { connect: true })
    state.failConnect = true
    transports[0]?.crash()

    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.advanceTimersByTimeAsync(4_000)
    await vi.advanceTimersByTimeAsync(8_000)
    await vi.advanceTimersByTimeAsync(16_000)

    expect(hub.statuses()[0]?.state).toBe('error')
    expect(hub.statuses()[0]?.lastError).toContain('连接中断，自动重连失败')
    expect(transports).toHaveLength(6) // 初始 1 次 + 重试 5 次
    expect(logger.entries.some((line) => line.includes('已停止重试'))).toBe(true)

    // 耗尽后不再重试：推进很长时间也没有新的建连尝试
    await vi.advanceTimersByTimeAsync(120_000)
    expect(transports).toHaveLength(6)
    expect(hub.statuses()[0]?.state).toBe('error')
    await hub.close()
  })

  it('close() 取消挂起中的重连定时器（不留悬挂回调）', async () => {
    const { hub, transports } = factorySetup()
    await hub.reconfigure([bareDefinition], { connect: true })
    transports[0]?.crash()
    expect(hub.statuses()[0]?.state).toBe('connecting')
    await hub.close()
    expect(hub.statuses()).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(transports).toHaveLength(1) // 没有新的建连尝试
  })

  it('reconfigure 替换服务器时取消挂起中的重连', async () => {
    const { hub, transports } = factorySetup()
    await hub.reconfigure([bareDefinition], { connect: true })
    transports[0]?.crash()
    // 换一份不同配置 → 旧 entry 被 teardown（取消重连定时器）后按新配置重建
    await hub.reconfigure([{ ...bareDefinition, command: 'changed' }], { connect: true })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(transports).toHaveLength(2) // 初始 + 替换后新建；被取消的重连不会执行
    expect(hub.statuses()[0]?.state).toBe('ready')
    await hub.close()
  })

  it('重复的退出事件只安排一次重连（不叠加定时器）', async () => {
    const { hub, transports } = factorySetup()
    await hub.reconfigure([bareDefinition], { connect: true })
    transports[0]?.crash()
    transports[0]?.crash() // 迟到的重复退出事件
    await vi.advanceTimersByTimeAsync(1_000)
    expect(transports).toHaveLength(2)
    expect(hub.statuses()[0]?.state).toBe('ready')
    await hub.close()
  })

  it('耗尽后 reconfigure 仍可再建连（重试计数归零，退避从头开始）', async () => {
    const { hub, transports, state } = factorySetup()
    await hub.reconfigure([bareDefinition], { connect: true })
    state.failConnect = true
    transports[0]?.crash()
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
      await vi.advanceTimersByTimeAsync(delay)
    }
    expect(hub.statuses()[0]?.state).toBe('error')

    state.failConnect = false
    await hub.reconfigure([bareDefinition], { connect: true })
    expect(hub.statuses()[0]?.state).toBe('ready')

    // 再次意外退出：计数已归零，1s 后第 1 次重试即成功
    transports[transports.length - 1]?.crash()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(hub.statuses()[0]?.state).toBe('ready')
    expect(transports).toHaveLength(8) // 初始 + 5 次失败 + reconfigure 成功 + 1 次重试成功
    await hub.close()
  })

  /** P2-06：意外断开走的是 handleTransportExit 的清理路径，同样要恢复被覆盖的旧定义 */
  it('意外退出 → 被 MCP 覆盖的旧定义立即恢复（不等重连、不等 sync）', async () => {
    const { hub, tools, transports } = factorySetup()
    const builtin = {
      name: 'mcp.fake.echo',
      description: '内置实现',
      parameters: { type: 'object' },
      execute: async () => ({ content: 'builtin' }),
    }
    tools.register(builtin)
    await hub.reconfigure([bareDefinition], { connect: true })
    expect(tools.get('mcp.fake.echo')).not.toBe(builtin)

    transports[0]?.crash()
    expect(hub.statuses()[0]?.state).toBe('connecting')
    expect(tools.get('mcp.fake.echo')).toBe(builtin)

    // 重连成功后再由 MCP 覆盖回来（覆盖仍是正常语义）
    await vi.advanceTimersByTimeAsync(1_000)
    expect(hub.statuses()[0]?.state).toBe('ready')
    expect(tools.get('mcp.fake.echo')).not.toBe(builtin)
    await hub.close()
  })
})
