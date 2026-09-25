/**
 * 会话领域类型（docs/06 §4）。
 *
 * 刻意与 `llm/types.ts` 的 `ChatRequestMessage` 分开：
 * 前者是 Aurora 自己的存储 / IPC 形状（带时间戳与工具卡片状态），
 * 后者是 LLM 侧线上形状，两者由 `history.ts` 负责转换。
 */
import type { SubagentSnapshot } from '@aurora/shared'

export type StoredRole = 'user' | 'assistant' | 'tool' | 'system'

export interface StoredToolCall {
  id: string
  name: string
  /** JSON 字符串（原样回填给模型） */
  arguments: string
  state: 'running' | 'success' | 'error'
  outputSummary?: string
  /**
   * `task` 子代理的运行快照（docs/06 §19）。
   *
   * 子代理的对话过程不落会话存储，这份快照是它唯一的留痕：随工具卡一起持久化后，
   * 「子代理」页面在重启后仍能回看历史运行（步骤、耗时与最终报告）。
   */
  subagent?: SubagentSnapshot
}

export interface StoredMessage {
  id: string
  role: StoredRole
  content: string
  /** ISO 时间戳 */
  createdAt: string
  /** assistant 消息发起的工具调用 */
  toolCalls?: StoredToolCall[]
  /**
   * `role = 'tool'` 的调用 id：模型发起的 `tool_calls` 必须配上这些结果才能继续推理，
   * 因此它们与 assistant 消息一同持久化，但渲染层只展示 assistant 的工具卡片。
   */
  toolCallId?: string
  /**
   * assistant 消息的思考链全文（`reasoning_content` / `reasoning` 增量累积，
   * Design/betav2-spec.md §6）。只用于渲染层展示；构造 API 请求时**绝不**回传给模型。
   */
  reasoning?: string
}

/** `userData/sessions/<sessionId>.json` 的结构 */
export interface StoredSession {
  version: 1
  sessionId: string
  updatedAt: string
  messages: StoredMessage[]
}

/** 追加一条消息的输入（id 由 SessionStore 生成） */
export interface NewMessage {
  role: StoredRole
  content: string
  toolCalls?: StoredToolCall[]
  toolCallId?: string
  /** assistant 消息的思考链全文（不参与 API 请求构造） */
  reasoning?: string
  createdAt?: string
}

export const SESSION_FILE_VERSION = 1 as const
