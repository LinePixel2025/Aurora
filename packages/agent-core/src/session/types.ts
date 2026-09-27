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

/**
 * 会话级元信息（`userData/sessions/<sessionId>.json` 的 `meta` 字段，docs/06 §4）。
 *
 * 刻意存在**会话文件自身**里，不做 sidecar 索引：`listSessions()` 把 `sessions/`
 * 下任何 `*.json` 都当作会话 id，放 `index.json` 会立刻多出一个假会话。
 * 也正因如此它**不进 `config.json`**，不需要配置迁移。
 */
export interface SessionMeta {
  /** 已归档：从主列表移入「已归档」分组，但会话本身照常可读可继续对话 */
  archived?: boolean
  /** 归档时刻（ISO）；取消归档时清掉 */
  archivedAt?: string
  /**
   * 预留：置顶（**本轮不实现**，不加 IPC / UI）。
   *
   * 留类型不留实现，是为了让「未来加置顶」不必再动一次会话文件格式 ——
   * 读取侧已按字段白名单宽容归化，写入侧也只写已知字段，因此现在留着零成本。
   */
  pinned?: boolean
  /**
   * 会话绑定的项目 id（`projects.list` 里的某一项，docs/06 §5.1 会话级项目）。
   *
   * `''` 与 `undefined` 都视为「未指定」：未绑定（或绑定的项目已被删除）的会话
   * 回落到 `projects.current`，再按原有链回落 `agent.tools.workspaceDir` / 主目录。
   *
   * 这是**会话数据**不是配置：存在会话文件自身的 `meta` 里，**不进 `config.json`**、
   * 不进 `CONFIG_VERSION` 迁移链 —— 读取侧按白名单宽容归化（老文件缺字段 = 未绑定），
   * 与 `archived` 同一套零迁移套路。
   */
  projectId?: string
}

/** `userData/sessions/<sessionId>.json` 的结构（v1 无 `meta`，读取侧必须容忍） */
export interface StoredSession {
  version: typeof SESSION_FILE_VERSION
  sessionId: string
  updatedAt: string
  messages: StoredMessage[]
  /** 会话级元信息；空 meta 不写这个键（老文件形状保持不变） */
  meta?: SessionMeta
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

/**
 * 会话文件格式版本（与 `CONFIG_VERSION` 是两条独立的链，别混）。
 *
 * v1 → v2：新增可选 `meta`（归档等会话级元信息）。读取对 v1 **宽容**（缺 `meta` = 未归档），
 * 因此**不存在迁移脚本**，旧文件也无需重写。
 */
export const SESSION_FILE_VERSION = 2 as const
