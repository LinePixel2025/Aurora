/**
 * 工具面预算（docs/06 §5.4）：防止内置 / 插件工具无限膨胀。
 *
 * 这里只做**度量与阈值**，不改变注册集合、不阻断请求 —— 超限由主进程在
 * `syncToolRegistries()` 结束时 `warn` 一次，CI 由 `toolFaceBudget.test.ts` 拦住。
 * MCP 是异步注册的，不在启动那次测量的即时覆盖内；下一次 sync 时会一并纳入。
 */

/** 内置全量工具面的预算（ratchet）：当前 62 个 / 34,272 字符，留约 7.7k 余量。 */
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
