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

/** 追加一条消息的输入（`id` 缺省时由 SessionStore 生成） */
export interface NewMessage {
  /**
   * 指定的消息 id（缺省由 `SessionStore` 生成）。
   *
   * 存在的唯一理由：**流式正文**。助手消息要边收边渲染，就必须在正文还没收完时
   * 就已经有一个稳定 id 下发给渲染层；而落盘发生在流结束之后。由循环先用
   * `SessionStore.nextMessageId()` 领一个 id 边流边发，落盘时原样带上同一个 id ——
   * 渲染层那份「半成品消息」与磁盘上的最终消息因此是同一条（docs/06 §16.2）。
   */
  id?: string
  role: StoredRole
  content: string
  toolCalls?: StoredToolCall[]
  toolCallId?: string
  /** assistant 消息的思考链全文（不参与 API 请求构造） */
  reasoning?: string
  createdAt?: string
}

export const SESSION_FILE_VERSION = 1 as const
