/**
 * McpClientHub —— 多 MCP 连接管理与工具注册（docs/06 §7）。
 *
 * 职责：
 * - 按配置 diff（幂等）维护连接；`lazyConnect` 决定启动即连还是首次使用才连；
 * - 把每个服务器的工具注册为 `mcp.<server>.<tool>`（MCP 优先于同名 Skill）；
 * - 任何失败都降级为状态灯 + 日志，绝不抛出到 Agent 主流程；
 * - stdio 意外断开自动重连（指数退避，docs/06 §7）；`close()` / `reconfigure()` 主动移除的不重连。
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
  /**
   * 解密后的自定义 HTTP 请求头（http 专用，docs/06 §7；用户头覆盖默认头）。
   * 凭据路径：日志与错误信息只允许出现 key 名（`Object.keys(headers)`），绝不落值。
   */
  headers?: Record<string, string>
}

/**
 * 传输层生命周期回调：hub 借此感知 stdio 子进程退出，驱动「意外断开自动重连」（docs/06 §7）。
 * 注意：主动 `close()` 触发的退出事件也会到达这里，是否重连由 hub 按连接身份判定。
 */
export interface TransportHooks {
  onExit?(info: { code: number | null; signal: string | null }): void
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
  /** 注入传输实现（单测用假传输）；`hooks.onExit` 用于 stdio 意外退出自动重连 */
  createTransport?(definition: McpServerDefinition, hooks?: TransportHooks): McpTransport
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
  /** 挂起中的自动重连定时器（close / reconfigure 时必须取消） */
  reconnectTimer: NodeJS.Timeout | undefined
  /** 已执行的自动重连次数（任一次建连成功后归零） */
  reconnectAttempt: number
}

export const MCP_TOOL_PREFIX = 'mcp'

/** stdio 意外断开的自动重连参数（docs/06 §7）：1s 起步指数退避、封顶 60s、最多 5 次 */
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 60_000
const RECONNECT_MAX_ATTEMPTS = 5

/** `mcp.<server>.<tool>`：服务器名中的 `.` 会破坏命名空间，统一为 `_` */
export function mcpToolName(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}.${server.replace(/\./g, '_')}.${tool}`
}

export class McpClientHub {
  private readonly tools: ToolRegistry
  private readonly logger: Logger
  private readonly timeoutMs: number
  private readonly createTransport: (
    definition: McpServerDefinition,
    hooks?: TransportHooks,
  ) => McpTransport
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
      ((definition, hooks) => defaultTransport(definition, this.fetchFor(definition), hooks))
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
        reconnectTimer: undefined,
        reconnectAttempt: 0,
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
      // 退出回调先于 client 创建注册：用 holder 持有引用，供退出事件做连接身份判定
      const holder: { client: McpClient | undefined } = { client: undefined }
      let transport: McpTransport
      try {
        transport = this.createTransport(definition, {
          onExit: (info) => {
            if (holder.client !== undefined) this.handleTransportExit(entry, holder.client, info)
          },
        })
      } catch (error) {
        this.markError(entry, toMcpError(error, 'E_SPAWN'))
        return
      }

      const client = new McpClient({
        server: definition.name,
        transport,
        timeoutMs: this.timeoutMs,
        logger: this.logger,
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
      holder.client = client

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
      entry.reconnectAttempt = 0
      this.registerTools(entry, client)
      // headers 是凭据路径：日志只允许出现 key 名，绝不落值
      this.logger.info('MCP 服务器已连接', {
        server: definition.name,
        transport: definition.transport,
        tools: client.toolCount,
        headerKeys: Object.keys(definition.headers ?? {}),
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
    this.unregisterEntryTools(entry)

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

  /**
   * 移除该服务器当前注册的全部工具，并清空登记名单。
   *
   * **必须走 `ToolRegistry.unregister`**（P2-06）：同名工具若在 MCP 注册**之前**就已存在
   * （用户配置过同名的内置 / Skill 工具），注销 MCP 实现时注册表会把被覆盖的旧定义恢复回来 ——
   * 断开 / 出错 / 重连清理都不该让内置工具"消失到下一次 `sync()`"。
   * 本 hub 的四个清理点（registerTools 重建 / markError / 意外退出 / teardown）全部走这里。
   */
  private unregisterEntryTools(entry: ServerEntry): void {
    for (const name of entry.registered) this.tools.unregister(name)
    entry.registered = []
  }

  private markError(entry: ServerEntry, error: McpError): void {
    entry.state = 'error'
    entry.lastError = error.message
    entry.client = undefined
    entry.toolCount = 0
    this.unregisterEntryTools(entry)
    this.logger.warn('MCP 服务器不可用，已降级', {
      server: entry.definition.name,
      code: error.code,
      error: error.message,
    })
    this.emit()
  }

  // ───────────────────── 意外断开自动重连（docs/06 §7） ─────────────────────

  /**
   * 传输层退出回调（stdio 子进程退出）：
   * 仅当退出的连接**仍挂在本 hub 下**（未被 `close()` / `reconfigure` 移除或替换）时
   * 视为「意外断开」——清理其工具后进入自动重连；主动关闭路径迟到的退出事件按身份判定忽略。
   */
  private handleTransportExit(
    entry: ServerEntry,
    client: McpClient,
    info: { code: number | null; signal: string | null },
  ): void {
    if (this.closed) return
    if (this.entries.get(entry.definition.name) !== entry) return
    if (entry.client !== client) return
    // 死连接与其工具先清理（在途请求已由传输层以 E_CLOSED 拒绝）
    entry.client = undefined
    entry.toolCount = 0
    this.unregisterEntryTools(entry)
    entry.lastError = `连接意外断开（code=${info.code ?? 'null'}，signal=${info.signal ?? 'null'}）`
    this.scheduleReconnect(entry)
  }

  /** 进入自动重连：指数退避 1s 起步、封顶 60s，最多 `RECONNECT_MAX_ATTEMPTS` 次。 */
  private scheduleReconnect(entry: ServerEntry): void {
    if (this.closed) return
    if (entry.reconnectTimer !== undefined) return // 已在重连排队中，不叠加定时器
    if (!entry.definition.enabled) {
      // 防御：停用的服务器没有重连意义（正常路径 reconfigure 会先 teardown）
      entry.state = 'idle'
      this.emit()
      return
    }
    const attempt = entry.reconnectAttempt + 1
    if (attempt > RECONNECT_MAX_ATTEMPTS) {
      entry.state = 'error'
      entry.lastError = `连接中断，自动重连失败（已重试 ${RECONNECT_MAX_ATTEMPTS} 次）`
      this.logger.warn('MCP 自动重连失败，已停止重试（下次 reconfigure 或使用工具时可再建连）', {
        server: entry.definition.name,
        attempts: RECONNECT_MAX_ATTEMPTS,
      })
      this.emit()
      return
    }
    const delayMs = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS)
    entry.state = 'connecting'
    this.logger.warn('MCP 连接意外断开，将自动重连', {
      server: entry.definition.name,
      attempt,
      nextRetryMs: delayMs,
    })
    this.emit()
    const timer = setTimeout(() => {
      entry.reconnectTimer = undefined
      entry.reconnectAttempt = attempt
      void this.attemptReconnect(entry)
    }, delayMs)
    timer.unref?.()
    entry.reconnectTimer = timer
  }

  /** 执行一次重连尝试（复用「建连 → tools/list → 注册」路径）；失败则安排下一次。 */
  private async attemptReconnect(entry: ServerEntry): Promise<void> {
    if (this.closed) return
    if (this.entries.get(entry.definition.name) !== entry) return
    try {
      await this.ensureConnected(entry)
    } catch {
      // connect 内部已降级为状态灯（不会抛出）；此处兜底，避免重连循环中断
    }
    if (entry.state === 'ready') {
      this.logger.info('MCP 自动重连成功', {
        server: entry.definition.name,
        attempt: entry.reconnectAttempt,
      })
      return
    }
    this.scheduleReconnect(entry)
  }

  private async teardown(entry: ServerEntry): Promise<void> {
    // 主动移除 / 关闭的连接：取消挂起中的重连定时器，不留悬挂回调
    if (entry.reconnectTimer !== undefined) {
      clearTimeout(entry.reconnectTimer)
      entry.reconnectTimer = undefined
    }
    this.unregisterEntryTools(entry)
    entry.toolCount = 0
    const client = entry.client
    entry.client = undefined
    if (client) await client.close().catch(() => undefined)
  }

  private emit(): void {
    this.onStatusChanged?.(this.statuses())
  }
}

function defaultTransport(
  definition: McpServerDefinition,
  fetchImpl?: typeof fetch,
  hooks?: TransportHooks,
): McpTransport {
  if (definition.transport === 'http') {
    if ((definition.url ?? '') === '') {
      throw new McpError('E_PROTOCOL', 'HTTP 传输缺少 url')
    }
    return new HttpTransport({
      url: definition.url ?? '',
      ...(definition.headers === undefined ? {} : { headers: definition.headers }),
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
    // 意外退出信号：hub 侧判定为「非主动关闭」时触发自动重连（docs/06 §7）
    ...(hooks?.onExit === undefined ? {} : { onExit: hooks.onExit }),
  })
}

/** header 集合的稳定序列化：按 key 排序后比较，key 顺序不同不算配置变化 */
function stableHeaders(headers: Record<string, string> | undefined): string {
  return JSON.stringify(
    Object.entries(headers ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )
}

function sameDefinition(a: McpServerDefinition, b: McpServerDefinition): boolean {
  return (
    a.transport === b.transport &&
    a.enabled === b.enabled &&
    (a.command ?? '') === (b.command ?? '') &&
    (a.url ?? '') === (b.url ?? '') &&
    JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? []) &&
    JSON.stringify(a.env ?? {}) === JSON.stringify(b.env ?? {}) &&
    stableHeaders(a.headers) === stableHeaders(b.headers)
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
