/**
 * 工具面预算（docs/06 §5.4）：防止内置 / 插件工具无限膨胀。
 *
 * 这里只做**度量与阈值**，不改变注册集合、不阻断请求 —— 超限由主进程在
 * `syncToolRegistries()` 结束时 `warn` 一次，CI 由 `toolFaceBudget.test.ts` 拦住。
 * 插件 / MCP 工具各有全局硬上限（`PLUGIN_TOOL_FACE_LIMIT` / `MCP_TOOL_FACE_LIMIT`），
 * 因此运行期预算只按**内置**统计（见 `measureBuiltinToolFace`）；
 * MCP 是异步注册的，不再参与这个 ratchet（它有独立上限与日志）。
 */

/**
 * 内置全量工具面的预算（ratchet）：当前 63 个（含 use_skill / submit_plan），
 * 字符数见 `toolFaceBudget.test.ts` 的实测；上限 42,000 留约 7k 余量。
 */
export const TOOL_FACE_BUDGET = { maxTools: 65, maxChars: 42_000 } as const

export interface ToolFaceEntry {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
}

export interface ToolFaceMeasurement {
  readonly count: number
  readonly chars: number
}

/**
 * 与 `ToolRegistry.toLlmTools()` 同口径的字符数：名称 + 描述 + 参数 JSON。
 *
 * 不用 `JSON.stringify(整条定义)`，是为了让运行期与单测都只依赖这三个字段，
 * 避免 `LlmToolDefinition` 形状演进时口径漂移。
 */
export function measureToolFace(entries: readonly ToolFaceEntry[]): ToolFaceMeasurement {
  let chars = 0
  for (const entry of entries) {
    chars += entry.name.length + entry.description.length
    chars += JSON.stringify(entry.parameters)?.length ?? 0
  }
  return { count: entries.length, chars }
}

/**
 * 运行期预算口径：只统计内置（含 Skill 桥接的 `use_skill`），**不含 `plugin.` / `mcp.`**。
 *
 * 插件与 MCP 工具都有各自的全局硬上限（64，超出不注册），再计入 65 的 ratchet 会让
 * 「装一个 3 工具插件 / 连一台中等 MCP 服务器」永久越过阈值、告警失去意义（docs/06 §5.4）。
 */
export function measureBuiltinToolFace(entries: readonly ToolFaceEntry[]): ToolFaceMeasurement {
  return measureToolFace(
    entries.filter((entry) => !entry.name.startsWith('plugin.') && !entry.name.startsWith('mcp.')),
  )
}
