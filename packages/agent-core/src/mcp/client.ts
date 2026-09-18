/**
 * MCP 客户端（docs/06 §7）：把一次 MCP 连接封装成"工具清单 + 工具调用"。
 *
 * v1 协议子集：`initialize` → `notifications/initialized` → `tools/list` → `tools/call`。
 * 失败一律以 `McpError` 抛出，由 `McpClientHub` 降级为状态灯 + 日志。
 */
import type { LlmToolParameterSchema } from '../llm/types.js'
import type { ToolResult } from '../tools/registry.js'
import { McpError, toMcpError } from './errors.js'
import { JsonRpcClient, type JsonRpcNotification, type McpTransport } from './jsonrpc.js'

/** 本实现声明的协议版本；实际以服务端回显为准（docs/06 §7） */
export const MCP_PROTOCOL_VERSION = '2024-11-05'

export const MCP_CLIENT_INFO = { name: 'aurora', version: '0.3.0' } as const

export interface McpToolInfo {
  name: string
  description: string
  parameters: LlmToolParameterSchema
}

export interface McpClientOptions {
  /** 服务器名（用于工具命名 `mcp.<server>.<tool>`） */
  server: string
  transport: McpTransport
  timeoutMs?: number
  onNotification?(notification: JsonRpcNotification): void
}

interface RawTool {
  name?: unknown
  description?: unknown
  inputSchema?: unknown
}

export class McpClient {
  readonly server: string
  private readonly rpc: JsonRpcClient
  private tools: McpToolInfo[] = []
  private serverInfo: { name: string; version: string } | undefined
  private protocolVersion = MCP_PROTOCOL_VERSION
  private connected = false
  private closing = false

  constructor(options: McpClientOptions) {
    this.server = options.server
    this.rpc = new JsonRpcClient({
      transport: options.transport,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.onNotification === undefined ? {} : { onNotification: options.onNotification }),
    })
  }

  get isConnected(): boolean {
    return this.connected
  }

  get toolCount(): number {
    return this.tools.length
  }

  get info(): { name: string; version: string } | undefined {
    return this.serverInfo
  }

  get negotiatedProtocolVersion(): string {
    return this.protocolVersion
  }

  /** 建立连接并拉取工具清单。重复调用是幂等的。 */
  async connect(): Promise<void> {
    if (this.connected) return

    const result = (await this.rpc.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { ...MCP_CLIENT_INFO },
    })) as {
      protocolVersion?: unknown
      serverInfo?: { name?: unknown; version?: unknown }
    }

    if (typeof result?.protocolVersion === 'string' && result.protocolVersion !== '') {
      this.protocolVersion = result.protocolVersion
    }
    const name = result?.serverInfo?.name
    const version = result?.serverInfo?.version
    if (typeof name === 'string') {
      this.serverInfo = { name, version: typeof version === 'string' ? version : '' }
    }

    this.rpc.notify('notifications/initialized')
    this.connected = true
    await this.refreshTools()
  }

  /** 重新拉取工具清单（也用于 `notifications/tools/list_changed`）。 */
  async refreshTools(): Promise<McpToolInfo[]> {
    const result = (await this.rpc.request('tools/list', {})) as { tools?: unknown }
    const raw = Array.isArray(result?.tools) ? (result.tools as RawTool[]) : []
    this.tools = raw
      .filter((tool): tool is RawTool & { name: string } => typeof tool.name === 'string')
      .map((tool) => ({
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: normalizeSchema(tool.inputSchema),
      }))
    return this.tools
  }

  listTools(): McpToolInfo[] {
    return [...this.tools]
  }

  /** 调用一个工具；结果按 MCP `content` 数组拼接为文本。 */
  async callTool(
    name: string,
    args: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<ToolResult> {
    try {
      const result = (await this.rpc.request(
        'tools/call',
        { name, arguments: args ?? {} },
        options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
      )) as { content?: unknown; isError?: unknown }

      const text = flattenContent(result?.content)
      const isError = result?.isError === true
      return {
        content: text === '' ? (isError ? '（工具返回空错误）' : '（工具无输出）') : text,
        ...(isError ? { isError: true } : {}),
        summary: truncate(text === '' ? `${name} 无输出` : text, 200),
      }
    } catch (error) {
      const mcpError = toMcpError(error, 'E_PROTOCOL')
      throw mcpError
    }
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.connected = false
    await this.rpc.close()
  }
}

/** MCP `inputSchema` → `LlmToolParameterSchema`（非对象 schema 一律降级为无参数） */
export function normalizeSchema(raw: unknown): LlmToolParameterSchema {
  if (typeof raw !== 'object' || raw === null) return { type: 'object', properties: {} }
  const schema = raw as Record<string, unknown>
  if (schema['type'] !== 'object') return { type: 'object', properties: {} }
  const properties = schema['properties']
  const required = schema['required']
  return {
    type: 'object',
    ...(typeof properties === 'object' && properties !== null
      ? { properties: properties as Record<string, unknown> }
      : { properties: {} }),
    ...(Array.isArray(required)
      ? { required: required.filter((item): item is string => typeof item === 'string') }
      : {}),
    ...(typeof schema['additionalProperties'] === 'boolean'
      ? { additionalProperties: schema['additionalProperties'] }
      : {}),
  }
}

/** MCP content 数组 → 纯文本（不支持的块类型标注为占位符，不静默丢弃） */
export function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const item = block as Record<string, unknown>
    if (item['type'] === 'text' && typeof item['text'] === 'string') {
      parts.push(item['text'])
      continue
    }
    if (typeof item['type'] === 'string') {
      parts.push(`[${item['type']} 内容]`)
    }
  }
  return parts.join('\n').trim()
}

function truncate(text: string, max: number): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length <= max ? compact : `${compact.slice(0, max)}…`
}

export { McpError }
