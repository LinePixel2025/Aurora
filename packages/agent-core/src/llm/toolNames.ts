/**
 * 工具名的**出站线路名**（docs/06 §21.5）。
 *
 * 内部注册名保留点号（`plugin.<id>.<name>` / `mcp.<server>.<tool>`），但 OpenAI 官方
 * 与部分严格网关只接受 `^[a-zA-Z0-9_-]+$`；带点号会在调用模型之前整条请求 400。
 * 这里只做「内部名 ⇄ 线路名」的确定性映射，不动注册表、落盘与 UI。
 */
import type { LlmToolDefinition } from './types.js'

/** 服务端对 function name 的通用字符集（OpenAI / DeepSeek / Anthropic 系一致）。 */
export const TOOL_NAME_WIRE_PATTERN = /^[a-zA-Z0-9_-]+$/

/** OpenAI function name 上限。 */
const TOOL_NAME_MAX = 64

export interface ToolNameCodec {
  /** 内部注册名 → 线路名；表外的名字按同一规则即时归一。 */
  toWire(name: string): string
  /** 线路名 → 内部注册名；未知名称原样返回（让「工具不存在」走既有错误路径）。 */
  toInternal(name: string): string
  /** 重写工具定义的名字，description / parameters 原样透传。 */
  toWireTools(tools: readonly LlmToolDefinition[]): LlmToolDefinition[]
}

function sanitize(name: string): string {
  const replaced = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  return (replaced === '' ? 'tool' : replaced).slice(0, TOOL_NAME_MAX)
}

/** 截断到 64 以内再拼后缀，保证 `_2` 这类冲突后缀本身不会把名字顶出上限。 */
function withSuffix(base: string, suffix: string): string {
  const room = TOOL_NAME_MAX - suffix.length
  return `${base.slice(0, Math.max(1, room))}${suffix}`
}

/**
 * 为一组工具建立编解码表。
 *
 * 冲突处理按传入顺序（调用方的 `toLlmTools()` 已按名字排序）追加 `_2` / `_3`…：
 * 同一组工具每次得到相同的线路名，前缀缓存不会因为映射而抖。
 */
export function createToolNameCodec(tools: readonly { name: string }[]): ToolNameCodec {
  const wireByInternal = new Map<string, string>()
  const internalByWire = new Map<string, string>()
  const used = new Set<string>()

  for (const tool of tools) {
    if (wireByInternal.has(tool.name)) continue
    const base = sanitize(tool.name)
    let wire = base
    let suffix = 1
    while (used.has(wire)) {
      suffix += 1
      wire = withSuffix(base, `_${suffix}`)
    }
    used.add(wire)
    wireByInternal.set(tool.name, wire)
    internalByWire.set(wire, tool.name)
  }

  // 兼容模型照抄提示词 / 旧会话的情况：内部名也接受。线路名已占用的键优先，
  // 因为那才是模型实际看到的名字。
  for (const name of wireByInternal.keys()) {
    if (!internalByWire.has(name)) internalByWire.set(name, name)
  }

  const toWire = (name: string): string => wireByInternal.get(name) ?? sanitize(name)

  return {
    toWire,
    toInternal: (name) => internalByWire.get(name) ?? name,
    toWireTools: (list) => list.map((tool) => ({ ...tool, name: toWire(tool.name) })),
  }
}
