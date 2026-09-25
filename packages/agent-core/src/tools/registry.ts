/**
 * 工具注册表骨架（docs/06 §5）。
 *
 * 本模块只负责注册与查询；调用循环在 `loop/agentLoop.ts`。
 * （`loop` 模块会消费本文件暴露的工具表，MCP / Skill 都往这里注册）。
 */
import type { SubagentSnapshot } from '@aurora/shared'
import type { LlmToolDefinition, LlmToolParameterSchema } from '../llm/types.js'

/**
 * 工具执行过程中的进度上报（docs/06 §19）。
 *
 * 目前只有 `task` 子代理使用：子代理的对话过程不落会话存储，唯一对外可见形态就是
 * 这份快照。循环把它转成 `subagent` 事件流实时推给渲染层，结束时随工具卡一起持久化。
 * （做成带 `kind` discriminated union，是为了将来别的长任务工具能复用同一条通道。）
 */
export type ToolProgress = { kind: 'subagent'; snapshot: SubagentSnapshot }

export interface ToolContext {
  /** 调用来源会话 */
  sessionId: string
  /** 本次调用的工具调用 id（子代理快照据此与工具卡配对） */
  toolCallId?: string
  signal?: AbortSignal
  /** 进度上报端口；未注入时（直接调用工具）静默丢弃 */
  emitProgress?(payload: ToolProgress): void
}

export interface ToolResult {
  /** 回填给模型的结果文本（会进入上下文，注意长度） */
  content: string
  /** 是否失败；失败的 content 会以"工具错误"形式回填 */
  isError?: boolean
  /** 展示给用户的摘要（渲染执行卡片） */
  summary?: string
  /**
   * 工具自报的最终子代理快照（仅 `task`）：随工具卡一起持久化，
   * 让「子代理」页面在重启后仍能回看历史运行。
   */
  subagent?: SubagentSnapshot
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

  /**
   * 暴露给 LLM 的工具清单（docs/06 §21.2）。
   *
   * **按工具名字典序**返回，与注册先后无关：`sync()` 的语义是「先全量摘除、再按当前配置
   * 重建」，按 Map 插入序返回会让任何一次设置变更把工具挪到数组末尾 → 请求体里的 `tools`
   * 顺序变化 → 前缀缓存整体失效。排序后顺序只取决于名字集合。
   * 系统提示词里的工具清单（`describeTools`）必须用**这一个**有序列表生成，两处才同序。
   */
  toLlmTools(): LlmToolDefinition[] {
    return (
      this.list()
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        }))
        // 按名字排序（**不用 localeCompare**：它是 locale 相关的，跨机器可能给不同结果）。
        // 顺序稳定 = tools 数组成为可缓存前缀的一部分；先摘除再重建的 sync() 不会再打乱它。
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    )
  }

  get conflicts(): ReadonlyArray<{ message: string; detail?: string }> {
    return this.log
  }
}
