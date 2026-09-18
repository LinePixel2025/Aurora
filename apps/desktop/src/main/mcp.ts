/**
 * MCP 装配层（docs/06 §7）。
 *
 * 主进程负责：把设置里的 MCP 服务器配置与**解密后的**环境变量交给
 * `McpClientHub`，并把状态变化推给设置页。协议细节全在 agent-core。
 */
import { McpClientHub, toServerDefinitions, type ToolRegistry } from '@aurora/agent-core'
import type { McpServerConfig, McpServerStatus, Logger, Settings } from '@aurora/shared'
import type { SettingsStoreLike } from './contracts.js'

export interface McpControllerOptions {
  settings: SettingsStoreLike
  tools: ToolRegistry
  logger: Logger
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
    )
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
}

/** 只关心会影响连接的字段，避免无关设置变更触发重连。 */
function signatureOf(settings: Settings): string {
  return JSON.stringify({
    lazyConnect: settings.mcp.lazyConnect,
    servers: settings.mcp.servers.map((server) => ({
      name: server.name,
      transport: server.transport,
      command: server.command,
      args: server.args,
      url: server.url,
      enabled: server.enabled,
      envKeys: Object.keys(server.envEnc).sort(),
    })),
  })
}
