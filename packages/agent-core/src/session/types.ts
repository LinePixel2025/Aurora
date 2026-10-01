/**
 * 会话领域类型（docs/06 §4）。
 *
 * 刻意与 `llm/types.ts` 的 `ChatRequestMessage` 分开：
 * 前者是 Aurora 自己的存储 / IPC 形状（带时间戳与工具卡片状态），
 * 后者是 LLM 侧线上形状，两者由 `history.ts` 负责转换。
 */
import type { PermissionMode, SubagentSnapshot } from '@aurora/shared'

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
  /**
   * 随这条消息一起发出的**图片附件路径**（多模态输入，docs/06 §3.1，v22；图像工具 §25）。
   *
   * 两个来源共用这一个字段：`role: 'user'` 是用户拖入的附件，`role: 'tool'` 是
   * `view_image` / `screenshot` / `clipboard_read_image` 的产物 —— 两者都是
   * **路径不是 base64**：一张 4 MB 的图 base64 后是 5.3 MB，几轮对话就能把
   * `sessions/*.json` 顶成几十 MB；跨轮次续聊时按路径重新读盘（用户追问「刚才那张图」时
   * 模型仍看得到图），文件被删 / 读不出就在那一轮跳过并记 warn —— 不编造内容，
   * 也不让整轮请求失败。是否真的作为图片分片下发由当前生效模型的 `llm.providers.<id>.modelParams.<模型 id>.vision` 决定。
   */
  images?: string[]
}

/**
 * 会话空间（2026-09-30，主界面左栏三分，docs/06 §4 / docs/07 §2.3）。
 *
 * 左栏会话列表按空间分三区，每区工作目录互不相同：
 * - `'agent'` → Agent对话（含未标记的历史会话与 `quick`），工作目录固定 `%USERPROFILE%\Desktop\Aurora`；
 * - `'work'` → 工作目录对话（Work 模式专属），工作目录 = `modes.work.workspaceDir`；
 * - 绑定了 `projectId` 的会话是**项目对话**（不需要 space 字段，projectId 优先于 space）；
 * - `'code'` 为 Code Mode 预留取值，当前不产生。
 */
export type SessionSpace = 'agent' | 'work'

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
  /**
   * 会话空间（`SessionSpace`，docs/06 §4 会话三分）。
   *
   * `undefined` 与 `'agent'` 等价（Agent 对话区）：未标记的会话（含历史会话与 `main`）
   * 一律按 Agent 空间解析工作目录与权限边界 —— 这是 2026-09-30 的有意行为变化。
   * 绑定了 `projectId` 的会话以项目为准，space 不参与判定（projectId 优先）。
   * 这是**会话数据**不是配置：不进 `config.json`、不进 `CONFIG_VERSION` 迁移链。
   */
  space?: SessionSpace
  /**
   * 客户端左栏可见性（docs/12 §6.3 远程会话管理，v0.2.3）。
   *
   * **缺省（undefined）= 可见**：与 `archived` 同款零迁移套路，老文件不写这个键。
   * Center 的 `session.visibility` 命令可把它置为 false —— 隐藏的会话不出现在
   * 客户端左栏，但仍可远程输入。这是**会话数据**不是配置：不进 `config.json`、
   * 不进 `CONFIG_VERSION` 迁移链。
   */
  centerVisible?: boolean
  /**
   * 会话级权限档覆盖（docs/06 §11.2 / docs/12 §6.3，v0.2.3）。
   *
   * **缺省（undefined）= 跟随全局** `resolvePermissionMode()`；写了就只对该会话的
   * 确认判定生效（装配层 `createConfirmTool` 的 `mode` getter 按 `info.sessionId` 现解析）。
   * 写入入口只有本机渲染层与 Center 的 `session.setPermission` 命令 ——
   * **AI 不可写**（改档位 = 自我提权）。同样是会话数据，不进 CONFIG_VERSION。
   */
  permissionMode?: PermissionMode
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
  /** 随这条用户消息发出的图片附件路径（多模态输入，docs/06 §3.1） */
  images?: string[]
  createdAt?: string
}

/**
 * 会话文件格式版本（与 `CONFIG_VERSION` 是两条独立的链，别混）。
 *
 * v1 → v2：新增可选 `meta`（归档等会话级元信息）。读取对 v1 **宽容**（缺 `meta` = 未归档），
 * 因此**不存在迁移脚本**，旧文件也无需重写。
 * v2 → v3：消息新增可选 `images`（随消息发出的图片附件**路径**，docs/06 §3.1 多模态输入）。
 * 同样**不存在迁移脚本**：缺字段 = 没有图片附件，旧文件天然合法、无需重写；
 * 版本号只用于说明"这个文件可能带图片路径"。
 */
export const SESSION_FILE_VERSION = 3 as const
