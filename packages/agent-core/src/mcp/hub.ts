/**
 * McpClientHub —— 多 MCP 连接管理与工具注册（docs/06 §7）。
 *
 * 职责：
 * - 按配置 diff（幂等）维护连接；`lazyConnect` 决定启动即连还是首次使用才连；
 * - 把每个服务器的工具注册为 `mcp.<server>.<tool>`（MCP 优先于同名 Skill）；
 * - 任何失败都降级为状态灯 + 日志，绝不抛出到 Agent 主流程。
 */
import type { McpServerConfig, McpServerStatus, Logger } from '@aurora/shared'
import { createNoopLogger } from '@aurora/shared'
import type { ToolDefinition, ToolRegistry } from '../tools/registry.js'
import { McpClient } from './client.js'
import { McpError, toMcpError } from './errors.js'
import type { McpTransport } from './jsonrpc.js'
import { HttpTransport, StdioTransport } from './transports.js'

export interface McpServerDefinition {
  name: string
  transport: 'stdio' | 'http'
  enabled: boolean
  command?: string
  args?: string[]
  url?: string
  /** 解密后的环境变量（stdio 专用） */
  env?: Record<string, string>
}

export interface McpClientHubOptions {
  tools: ToolRegistry
  logger?: Logger
  /** 默认请求超时，默认 30s */
  timeoutMs?: number
  /**
   * HTTP 传输使用的 fetch（docs/08 §6 系统代理）。
   *
   * 用**函数**而非实例：代理是运行时可改的，装配层会按设置重建 fetch，
   * 而 hub 只在构造时拿到一个引用。返回 `undefined` 时回落 `globalThis.fetch`。
   */
  resolveFetch?: () => typeof fetch | undefined
  /** 注入传输实现（单测用假传输） */
  createTransport?(definition: McpServerDefinition): McpTransport
  onStatusChanged?(statuses: McpServerStatus[]): void
}

interface ServerEntry {
  definition: McpServerDefinition
  client: McpClient | undefined
  state: McpServerStatus['state']
  toolCount: number
  lastError: string | undefined
  /** 连接中 / 已连接过（用于懒连接判定与并发去重） */
  connecting: Promise<void> | undefined
  /** 该服务器已注册的工具名（断开时按名单移除） */
  registered: string[]
}

export const MCP_TOOL_PREFIX = 'mcp'

/** `mcp.<server>.<tool>`：服务器名中的 `.` 会破坏命名空间，统一为 `_` */
export function mcpToolName(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}.${server.replace(/\./g, '_')}.${tool}`
}

export class McpClientHub {
  private readonly tools: ToolRegistry
  private readonly logger: Logger
  private readonly timeoutMs: number
  private readonly createTransport: (definition: McpServerDefinition) => McpTransport
  private readonly onStatusChanged: ((statuses: McpServerStatus[]) => void) | undefined
  private readonly resolveFetch: (() => typeof fetch | undefined) | undefined
  private readonly entries = new Map<string, ServerEntry>()
  private lazyConnect = false
  private closed = false

  constructor(options: McpClientHubOptions) {
    this.tools = options.tools
    this.logger = options.logger ?? createNoopLogger()
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.resolveFetch = options.resolveFetch
    this.createTransport =
      options.createTransport ??
      ((definition) => defaultTransport(definition, this.fetchFor(definition)))
    this.onStatusChanged = options.onStatusChanged
  }

  /** HTTP 传输取当前 fetch；resolveFetch 抛错时按未提供处理（不能拖垮建连）。 */
  private fetchFor(definition: McpServerDefinition): typeof fetch | undefined {
    if (this.resolveFetch === undefined) return undefined
    try {
      return this.resolveFetch()
    } catch (error) {
      this.logger.warn('取网络客户端失败，MCP HTTP 传输回落默认实现', {
        server: definition.name,
        error: String(error),
      })
      return undefined
    }
  }

  get isLazy(): boolean {
    return this.lazyConnect
  }

  /**
   * 应用配置（启动时与设置变更时都调用）。
   * `connect` = true 时对 enabled 的服务器立即建连（受 `lazyConnect` 影响）。
   */
  async reconfigure(
    definitions: readonly McpServerDefinition[],
    options: { lazyConnect?: boolean; connect?: boolean } = {},
  ): Promise<void> {
    if (options.lazyConnect !== undefined) this.lazyConnect = options.lazyConnect

    const next = new Map<string, McpServerDefinition>()
    for (const definition of definitions) {
      if (definition.name.trim() === '') continue
      next.set(definition.name, definition)
    }

    // 1. 移除不再存在的服务器
    for (const [name, entry] of [...this.entries]) {
      const updated = next.get(name)
      if (updated === undefined || !sameDefinition(entry.definition, updated)) {
        await this.teardown(entry)
        this.entries.delete(name)
        this.logger.info('已移除 MCP 连接', { server: name })
      }
    }

    // 2. 新增 / 更新
    for (const [name, definition] of next) {
      if (this.entries.has(name)) continue
      this.entries.set(name, {
        definition,
        client: undefined,
        state: 'idle',
        toolCount: 0,
        lastError: undefined,
        connecting: undefined,
        registered: [],
      })
    }

    if (options.connect !== false && !this.lazyConnect) {
      await this.connectAll()
    }
    this.emit()
  }

  /** 立即连接全部 enabled 服务器（互相独立，单个失败不影响其它）。 */
  async connectAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => this.ensureConnected(entry)))
    this.emit()
  }

  statuses(): McpServerStatus[] {
    return [...this.entries.values()].map((entry) => ({
      name: entry.definition.name,
      transport: entry.definition.transport,
      enabled: entry.definition.enabled,
      state: entry.state,
      toolCount: entry.toolCount,
      ...(entry.lastError === undefined ? {} : { lastError: entry.lastError }),
    }))
  }

  findToolServer(toolName: string): string | undefined {
    const parts = toolName.split('.')
    if (parts.length < 3 || parts[0] !== MCP_TOOL_PREFIX) return undefined
    return parts[1]
  }

  async close(): Promise<void> {
    this.closed = true
    for (const entry of this.entries.values()) {
      await this.teardown(entry)
    }
    this.entries.clear()
    this.emit()
  }

  // ───────────────────────── 内部 ─────────────────────────

  /**
   * 确保连接可用；懒连接模式下由工具执行时触发。
   * 并发调用共享同一个连接 Promise（避免重复建连）。
   */
  private ensureConnected(entry: ServerEntry): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (!entry.definition.enabled) return Promise.resolve()
    if (entry.client?.isConnected === true) return Promise.resolve()
    if (entry.connecting !== undefined) return entry.connecting
    return this.connect(entry)
  }

  private async connect(entry: ServerEntry): Promise<void> {
    const definition = entry.definition
    entry.state = 'connecting'
    this.emit()

    const task = (async () => {
      let transport: McpTransport
      try {
        transport = this.createTransport(definition)
      } catch (error) {
        this.markError(entry, toMcpError(error, 'E_SPAWN'))
        return
      }

      const client = new McpClient({
        server: definition.name,
        transport,
        timeoutMs: this.timeoutMs,
        onNotification: (notification) => {
          if (notification.method === 'notifications/tools/list_changed') {
            void client
              .refreshTools()
              .then(() => this.registerTools(entry, client))
              .catch((error: unknown) =>
                this.logger.warn('MCP 工具清单刷新失败', {
                  server: definition.name,
                  error: String(error),
                }),
              )
          }
        },
      })

      try {
        await client.connect()
      } catch (error) {
        await client.close()
        this.markError(entry, toMcpError(error, 'E_PROTOCOL'))
        return
      }

      entry.client = client
      entry.state = 'ready'
      entry.lastError = undefined
      this.registerTools(entry, client)
      this.logger.info('MCP 服务器已连接', {
        server: definition.name,
        transport: definition.transport,
        tools: client.toolCount,
      })
      this.emit()
    })()

    entry.connecting = task
    try {
      await task
    } finally {
      entry.connecting = undefined
    }
  }

  private registerTools(entry: ServerEntry, client: McpClient): void {
    // 先清掉上一轮注册的工具（清单可能变小），避免残留失效工具
    for (const name of entry.registered) this.tools.unregister(name)
    entry.registered = []

    const server = entry.definition.name
    for (const tool of client.listTools()) {
      const name = mcpToolName(server, tool.name)
      const definition: ToolDefinition = {
        name,
        description:
          tool.description === '' ? `MCP 工具 ${tool.name}（${server}）` : tool.description,
        parameters: tool.parameters,
        // 敏感确认交互归 P5（docs/06 §5）；此处仅标记 + 日志留痕
        sensitivity: 'confirm',
        execute: async (input, ctx) => {
          await this.ensureConnected(entry)
          const active = entry.client
          if (active === undefined || !active.isConnected) {
            const reason = entry.lastError ?? '未连接'
            return {
              content: `MCP 服务器「${server}」不可用：${reason}`,
              isError: true,
              summary: reason,
            }
          }
          const result = await active.callTool(tool.name, input)
          this.logger.debug('MCP 工具调用完成', {
            server,
            tool: tool.name,
            session: ctx.sessionId,
            sensitivity: 'confirm',
          })
          return result
        },
      }
      this.tools.register(definition, 'mcp')
      entry.registered.push(name)
    }
    entry.toolCount = entry.registered.length
  }

  private markError(entry: ServerEntry, error: McpError): void {
    entry.state = 'error'
    entry.lastError = error.message
    entry.client = undefined
    entry.toolCount = 0
    for (const name of entry.registered) this.tools.unregister(name)
    entry.registered = []
    this.logger.warn('MCP 服务器不可用，已降级', {
      server: entry.definition.name,
      code: error.code,
      error: error.message,
    })
    this.emit()
  }

  private async teardown(entry: ServerEntry): Promise<void> {
    for (const name of entry.registered) this.tools.unregister(name)
    entry.registered = []
    entry.toolCount = 0
    const client = entry.client
    entry.client = undefined
    if (client) await client.close().catch(() => undefined)
  }

  private emit(): void {
    this.onStatusChanged?.(this.statuses())
  }
}

function defaultTransport(definition: McpServerDefinition, fetchImpl?: typeof fetch): McpTransport {
  if (definition.transport === 'http') {
    if ((definition.url ?? '') === '') {
      throw new McpError('E_PROTOCOL', 'HTTP 传输缺少 url')
    }
    return new HttpTransport({
      url: definition.url ?? '',
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    })
  }
  if ((definition.command ?? '') === '') {
    throw new McpError('E_SPAWN', 'stdio 传输缺少 command')
  }
  return new StdioTransport({
    command: definition.command ?? '',
    ...(definition.args === undefined ? {} : { args: definition.args }),
    ...(definition.env === undefined ? {} : { env: definition.env }),
  })
}

function sameDefinition(a: McpServerDefinition, b: McpServerDefinition): boolean {
  return (
    a.transport === b.transport &&
    a.enabled === b.enabled &&
    (a.command ?? '') === (b.command ?? '') &&
    (a.url ?? '') === (b.url ?? '') &&
    JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? []) &&
    JSON.stringify(a.env ?? {}) === JSON.stringify(b.env ?? {})
  )
}

/** 把设置里的 MCP 服务器配置 + 凭据解密函数转换为 hub 输入。 */
export function toServerDefinitions(
  servers: readonly McpServerConfig[],
  decryptEnv: (server: McpServerConfig) => Record<string, string>,
): McpServerDefinition[] {
  return servers.map((server) => ({
    name: server.name,
    transport: server.transport,
    enabled: server.enabled,
    ...(server.command === undefined ? {} : { command: server.command }),
    ...(server.args === undefined ? {} : { args: server.args }),
    ...(server.url === undefined ? {} : { url: server.url }),
    env: decryptEnv(server),
  }))
}
