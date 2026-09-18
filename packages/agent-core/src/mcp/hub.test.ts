import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createMemoryLogger, type McpServerConfig } from '@aurora/shared'
import { McpClientHub, mcpToolName, toServerDefinitions } from './hub.js'
import { ToolRegistry } from '../tools/registry.js'

const FAKE_SERVER = fileURLToPath(new URL('./testing/fakeMcpServer.mjs', import.meta.url))

function stdioDefinition(name = 'fake', env: Record<string, string> = {}) {
  return {
    name,
    transport: 'stdio' as const,
    enabled: true,
    command: process.execPath,
    args: [FAKE_SERVER],
    env,
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
