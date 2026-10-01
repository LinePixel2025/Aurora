/**
 * MCP 装配层（docs/06 §7）。
 *
 * 主进程负责：把设置里的 MCP 服务器配置与**解密后的**环境变量 / HTTP 自定义请求头交给
 * `McpClientHub`，并把状态变化推给设置页。协议细节全在 agent-core。
 */
import { McpClientHub, toServerDefinitions, type ToolRegistry } from '@aurora/agent-core'
import type { McpServerConfig, McpServerStatus, Logger, Settings } from '@aurora/shared'
import type { SettingsStoreLike } from './contracts.js'

export interface McpControllerOptions {
  settings: SettingsStoreLike
  tools: ToolRegistry
  logger: Logger
  /**
   * 当前出网 fetch（docs/08 §6 系统代理）。
   * 用函数：用户在设置页改代理后无需重启即可对**新建连接**生效。
   */
  resolveFetch?: () => typeof fetch | undefined
  onStatusChanged?: (statuses: McpServerStatus[]) => void
}

export class McpController {
  readonly hub: McpClientHub
  private readonly settings: SettingsStoreLike
  private readonly logger: Logger
  private detach: (() => void) | undefined
  private appliedSignature = ''

  constructor(options: McpControllerOptions) {
    this.settings = options.settings
    this.logger = options.logger
    this.hub = new McpClientHub({
      tools: options.tools,
      logger: options.logger,
      ...(options.resolveFetch === undefined ? {} : { resolveFetch: options.resolveFetch }),
      ...(options.onStatusChanged === undefined
        ? {}
        : { onStatusChanged: options.onStatusChanged }),
    })
  }

  /** 启动时调用一次：按当前配置建连（或按 lazyConnect 延后）。 */
  async start(): Promise<void> {
    await this.apply({ connect: true })
    this.detach = this.settings.onChange(() => {
      void this.apply({ connect: true })
    })
  }

  /** 把当前设置应用到 hub；配置未变化时直接跳过。 */
  async apply(options: { connect?: boolean } = {}): Promise<void> {
    const settings = this.settings.get()
    const signature = signatureOf(settings)
    if (signature === this.appliedSignature) return
    this.appliedSignature = signature

    const definitions = toServerDefinitions(settings.mcp.servers, (server) =>
      this.decryptEnv(server),
    ).map((definition, index) => {
      // headers 与 env 同款只在主进程解密（内核 `toServerDefinitions` 不碰凭据）：
      // 逐个挂上解密结果，由 hub 透传给 HttpTransport（docs/06 §7）。
      const server = settings.mcp.servers[index]
      return server === undefined
        ? definition
        : { ...definition, headers: this.decryptHeaders(server) }
    })
    try {
      await this.hub.reconfigure(definitions, {
        lazyConnect: settings.mcp.lazyConnect,
        ...(options.connect === undefined ? {} : { connect: options.connect }),
      })
    } catch (error) {
      // reconfigure 内部已逐个降级；这里兜底避免影响主流程
      this.logger.error('MCP 配置应用失败', { error: String(error) })
    }
  }

  statuses(): McpServerStatus[] {
    return this.hub.statuses()
  }

  async close(): Promise<void> {
    this.detach?.()
    this.detach = undefined
    await this.hub.close()
  }

  private decryptEnv(server: McpServerConfig): Record<string, string> {
    const env: Record<string, string> = {}
    for (const name of Object.keys(server.envEnc)) {
      const value = this.settings.getSecret(`mcp.servers.${server.name}.env.${name}`)
      if (value !== '') env[name] = value
    }
    return env
  }

  /** 解密 HTTP 自定义请求头（docs/06 §7）：与 `decryptEnv` 同构，键名进日志、值绝不落日志。 */
  private decryptHeaders(server: McpServerConfig): Record<string, string> {
    const headers: Record<string, string> = {}
    for (const name of Object.keys(server.headersEnc)) {
      const value = this.settings.getSecret(`mcp.servers.${server.name}.headers.${name}`)
      if (value !== '') headers[name] = value
    }
    return headers
  }
}

/** 只关心会影响连接的字段，避免无关设置变更触发重连。 */
export function signatureOf(settings: Pick<Settings, 'mcp'>): string {
  return JSON.stringify({
    lazyConnect: settings.mcp.lazyConnect,
    servers: settings.mcp.servers.map((server) => ({
      name: server.name,
      transport: server.transport,
      command: server.command,
      args: server.args,
      url: server.url,
      enabled: server.enabled,
      // 键名与**值**一起进签名（P1-05）：只轮换某个 env / header 的值（键名集合不变、
      // 密文变了）时签名同样变化，从而走到 `hub.reconfigure`，由 hub 自身的
      // `sameDefinition`（按值比较）判定 teardown + 重连。旧实现只取 `Object.keys()`，
      // 于是轮换泄漏的 token 对运行中的连接永远不生效。
      //
      // ⚠️ 这里序列化的是 safeStorage **密文**：签名**只用于与上次比较**（`appliedSignature`），
      // 绝不写日志、不进 IPC；明文只在 `decryptEnv` / `decryptHeaders` 里解密后就地交给 hub。
      envEnc: stableEntries(server.envEnc),
      headersEnc: stableEntries(server.headersEnc),
    })),
  })
}

/**
 * 按键排序成稳定序列：对象字面量的键序不可靠（同一份内容的不同键序不应产生新签名），
 * 而值参与比较（P1-05 的落点）。返回「键 → 值」二元组数组，`JSON.stringify` 结果确定。
 */
function stableEntries(record: Record<string, string>): Array<[string, string]> {
  return Object.keys(record)
    .sort()
    .map((key): [string, string] => [key, record[key] ?? ''])
}
