/**
 * 工具注册表骨架（docs/06 §5）。
 *
 * 本模块只负责注册与查询；调用循环在 `loop/agentLoop.ts`。
 * （`loop` 模块会消费本文件暴露的工具表，MCP / Skill 都往这里注册）。
 */
import type { SubagentSnapshot } from '@aurora/shared'
import type { LlmImageInput, LlmToolDefinition, LlmToolParameterSchema } from '../llm/types.js'

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
  /**
   * 「这次调用已经获得用户批准」（docs/06 §11.2 三档权限）。
   *
   * 由**内核**（`loop/agentLoop.ts`）置位，且只在工具 `sensitivity === 'confirm'`
   * 且确认钩子给出放行结论时置 `true` —— 三条来源对工具层是同一件事：
   * ① 用户在确认卡片上点了放行；② 免确认模式（`terminal.allowPatterns` 之类）直接命中；
   * ③ `auto` 档判定目标落在项目根内。三者都在 `confirmTool` 里合成 `true` / `'always'`。
   *
   * 消费方是文件类 / 终端类工具：它们据此把 `allowOutside: true` 透传给端口
   * （端口层的越界拦截是第二道边界，内核不能替它做决定）。
   *
   * **未注入时（直接调用工具的单测）字段为 `undefined`，行为与今天完全一致**：
   * 端口看不到 `allowOutside`，越界仍然被拦 —— 缺省一律按"没批准"处理，
   * 这样任何忘记透传的调用点都只会更保守，而不会意外放宽边界。
   */
  approvedByUser?: boolean
}

/**
 * 工具产出的一张图片（图像工具，docs/06 §25）。
 *
 * 两个字段各管一件事，缺一不可：
 * - `image` 是**已经读好的内容**（内核不碰文件系统，端口读好交进来），本轮请求立即要用；
 * - `path` 是**落盘位置**：随 tool 消息存进会话历史（`StoredMessage.images`），
 *   后续轮次按路径重读重放 —— 与用户拖入的附件同一条回放口径。
 *
 * 剪贴板图片这类**原本没有路径**的产物，由主进程先落盘再回传路径，
 * 于是「回放」这条路径对所有来源都成立（没有例外分支）。
 */
export interface ToolImage {
  path: string
  image: LlmImageInput
}

/**
 * 对话图片区的一张图片（`show_image` / `generate_image`）。
 *
 * 与 `ToolImage` 分开：`ToolImage` 是“立即回填给模型看”的输入；`ToolDisplayImage`
 * 只用于用户界面展示。`path` 仅由内核透传给会话存储，渲染层与 Center 只拿
 * `ChatDisplayImage` 的无路径投影。
 */
export interface ToolDisplayImage {
  id: string
  path: string
  name: string
  mime: string
  caption?: string
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
  /**
   * 工具产出 / 读到的图片（图像工具，docs/06 §25）：非空时循环把它作为一条**合成 user 消息**
   * 附在本轮全部 tool 结果之后下发（tool 角色只能带字符串，两套协议都一样）。
   */
  images?: readonly ToolImage[]
  /**
   * 工具产出的对话展示图片：循环随工具卡持久化，并在 success 的 `tool` 事件里
   * 下发无路径元数据。与 `images` 互不替代。
   */
  displayImages?: readonly ToolDisplayImage[]
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

/**
 * 工具来源（**结构类型**）：调用循环只依赖这三个方法，注册表与「按运行来源过滤后的视图」
 * 都满足它（docs/06 §5.2）。
 *
 * 为什么要这个接口：自动化触发的会话不得再管理 / 触发自动化（否则「自动化 → 会话 → 自动化」
 * 形成自我延续的闭环），只能按**本次请求的来源**从工具面里摘掉若干名字。摘除发生在
 * 请求组装处（`host/agentHost.ts`），视图用 `filterTools` 现造，不污染全局注册表 ——
 * 注册表是进程级的（`sync()` 按时重建），而"哪些工具能用"是请求级的。
 */
export interface ToolSource {
  get(name: string): ToolDefinition | undefined
  list(): ToolDefinition[]
  toLlmTools(): LlmToolDefinition[]
}

/**
 * 按名字集合摘除若干工具，返回**只读视图**（不改动原注册表）。
 *
 * 摘除语义是"模型看不见、也调不到"：`list()` / `toLlmTools()` 不返回被摘的工具名，
 * `get()` 对它们返回 `undefined`（循环据此回填「工具不存在」）。
 */
export function filterTools(source: ToolSource, hidden: readonly string[]): ToolSource {
  if (hidden.length === 0) return source
  const blocked = new Set(hidden)
  const visible = <T extends { name: string }>(tool: T): boolean => !blocked.has(tool.name)
  let listCache: ToolDefinition[] | undefined
  let llmToolsCache: LlmToolDefinition[] | undefined
  return {
    get: (name) => (blocked.has(name) ? undefined : source.get(name)),
    list: () => {
      if (listCache === undefined) listCache = source.list().filter(visible)
      return listCache
    },
    toLlmTools: () => {
      if (llmToolsCache === undefined) llmToolsCache = source.toLlmTools().filter(visible)
      return llmToolsCache
    },
  }
}

/** 只保留白名单工具，返回**只读视图**；空数组即"本次运行没有工具"。 */
export function allowTools(source: ToolSource, allowed: readonly string[]): ToolSource {
  const permit = new Set(allowed)
  const visible = <T extends { name: string }>(tool: T): boolean => permit.has(tool.name)
  let listCache: ToolDefinition[] | undefined
  let llmToolsCache: LlmToolDefinition[] | undefined
  return {
    get: (name) => (permit.has(name) ? source.get(name) : undefined),
    list: () => {
      if (listCache === undefined) listCache = source.list().filter(visible)
      return listCache
    },
    toLlmTools: () => {
      if (llmToolsCache === undefined) llmToolsCache = source.toLlmTools().filter(visible)
      return llmToolsCache
    },
  }
}

export class ToolRegistry implements ToolSource {
  private readonly tools = new Map<string, ToolDefinition>()
  private llmToolsCache: LlmToolDefinition[] | undefined
  /**
   * 被 MCP 实现**覆盖掉**的旧定义（名字 → 原实现）。
   *
   * MCP 优先于内置 / Skill 是设计（docs/06 §7）：官方 filesystem server 就叫
   * `read_file` / `write_file` / `edit_file`。但覆盖必须是**可逆**的 ——
   * 该服务器断开 / 出错时 `McpClientHub` 按名单 `unregister`，若不恢复旧定义，
   * 被覆盖的内置工具会从注册表消失（模型此后拿到「工具不存在」），
   * 直到下一次 `sync()` 全量重建或重启才回来（P2-06）。
   */
  private readonly shadowed = new Map<string, ToolDefinition>()
  private readonly log: Array<{ message: string; detail?: string }> = []

  register(tool: ToolDefinition, source: 'builtin' | 'skill' | 'mcp' = 'builtin'): void {
    const existing = this.tools.get(tool.name)
    if (existing) {
      // MCP 优先于 Skill（docs/06 §7），同名冲突必须留痕
      if (source !== 'mcp') {
        this.log.push({ message: `工具重名，保留已有实现`, detail: tool.name })
        return
      }
      // 记录被替换的旧定义（只记最早那一份：MCP 刷新工具清单会重复注册同名工具，
      // 第二次的 existing 已经是上一个 MCP 实现，覆盖它会丢掉真正的内置实现）。
      if (!this.shadowed.has(tool.name)) this.shadowed.set(tool.name, existing)
      this.log.push({ message: 'MCP 工具覆盖同名工具', detail: tool.name })
    }
    this.tools.set(tool.name, tool)
    this.llmToolsCache = undefined
  }

  /**
   * 注销工具。
   *
   * 若该名字下有「被 MCP 覆盖前」的旧定义，注销后**恢复**它（P2-06）：
   * 断开 MCP 服务器不该连带删掉它覆盖的内置 / Skill 工具。
   * 恢复只发生一次 —— 恢复时同时清掉遮蔽记录，避免下一次注销把旧定义再"复活"。
   */
  unregister(name: string): boolean {
    const removed = this.tools.delete(name)
    if (removed) this.llmToolsCache = undefined
    const previous = this.shadowed.get(name)
    if (removed && previous !== undefined) {
      this.shadowed.delete(name)
      this.tools.set(name, previous)
    }
    return removed
  }

  /** 按前缀批量移除（MCP server 断开时使用）；同样恢复被覆盖的旧定义 */
  unregisterByPrefix(prefix: string): number {
    let removed = 0
    for (const name of [...this.tools.keys()]) {
      if (name.startsWith(prefix) && this.unregister(name)) removed += 1
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
    if (this.llmToolsCache !== undefined) return this.llmToolsCache
    this.llmToolsCache = this.list()
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }))
      // 按名字排序（**不用 localeCompare**：它是 locale 相关的，跨机器可能给不同结果）。
      // 顺序稳定 = tools 数组成为可缓存前缀的一部分；先摘除再重建的 sync() 不会再打乱它。
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return this.llmToolsCache
  }

  get conflicts(): ReadonlyArray<{ message: string; detail?: string }> {
    return this.log
  }
}
