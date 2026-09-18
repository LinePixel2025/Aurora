/**
 * 工具注册表骨架（docs/06 §5）。
 *
 * P1 只需类型与注册表；真实的工具调用循环在 P3 接入
 * （`loop` 模块会消费本文件暴露的工具表，MCP / Skill 都往这里注册）。
 */
import type { LlmToolDefinition, LlmToolParameterSchema } from '../llm/types.js'

export interface ToolContext {
  /** 调用来源会话 */
  sessionId: string
  signal?: AbortSignal
}

export interface ToolResult {
  /** 回填给模型的结果文本（会进入上下文，注意长度） */
  content: string
  /** 是否失败；失败的 content 会以"工具错误"形式回填 */
  isError?: boolean
  /** 展示给用户的摘要（渲染执行卡片） */
  summary?: string
}

export interface ToolDefinition {
  /** 命名：内置用 `snake_case`，MCP 用 `mcp.<server>.<tool>`（docs/06 §7） */
  name: string
  description: string
  parameters: LlmToolParameterSchema
  /** 敏感工具需用户确认（docs/06 §5） */
  sensitivity?: 'safe' | 'confirm'
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()
  private readonly log: Array<{ message: string; detail?: string }> = []

  register(tool: ToolDefinition, source: 'builtin' | 'skill' | 'mcp' = 'builtin'): void {
    const existing = this.tools.get(tool.name)
    if (existing) {
      // MCP 优先于 Skill（docs/06 §7），同名冲突必须留痕
      if (source !== 'mcp') {
        this.log.push({ message: `工具重名，保留已有实现`, detail: tool.name })
        return
      }
      this.log.push({ message: 'MCP 工具覆盖同名工具', detail: tool.name })
    }
    this.tools.set(tool.name, tool)
  }

  unregister(name: string): boolean {
    return this.tools.delete(name)
  }

  /** 按前缀批量移除（MCP server 断开时使用） */
  unregisterByPrefix(prefix: string): number {
    let removed = 0
    for (const name of [...this.tools.keys()]) {
      if (name.startsWith(prefix) && this.tools.delete(name)) removed += 1
    }
    return removed
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()]
  }

  /** 暴露给 LLM 的工具清单 */
  toLlmTools(): LlmToolDefinition[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))
  }

  get conflicts(): ReadonlyArray<{ message: string; detail?: string }> {
    return this.log
  }
}
