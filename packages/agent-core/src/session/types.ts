/**
 * 会话领域类型（docs/06 §4）。
 *
 * 刻意与 `llm/types.ts` 的 `ChatRequestMessage` 分开：
 * 前者是 Aurora 自己的存储 / IPC 形状（带时间戳与工具卡片状态），
 * 后者是 LLM 侧线上形状，两者由 `history.ts` 负责转换。
 */
import type {
  AskSettleOutcome,
  ChatDisplayImage,
  PermissionMode,
  SessionUsageStats,
  SubagentSnapshot,
} from '@aurora/shared'

export type StoredRole = 'user' | 'assistant' | 'tool' | 'system'

export interface StoredToolCall {
  id: string
  name: string
  /** JSON 字符串（原样回填给模型） */
  arguments: string
  state: 'running' | 'success' | 'error'
  outputSummary?: string
  /**
   * 工具调用发起时刻（ISO，随工具卡落盘）：渲染层耗时徽章的真实计时起点。
   * 切走会话再切回、重启后，耗时都从这两个字段算，不再由渲染层重新起表。
   */
  startedAt?: string
  /** 结算（success / error）时刻；`running` 态没有这个字段 */
  endedAt?: string
  /**
   * `task` 子代理的运行快照（docs/06 §19）。
   *
   * 子代理的对话过程不落会话存储，这份快照是它唯一的留痕：随工具卡一起持久化后，
   * 「子代理」页面在重启后仍能回看历史运行（步骤、耗时与最终报告）。
   */
  subagent?: SubagentSnapshot
  /**
   * 本工具调用产出的对话图片（docs/06 §14，v5 引入该字段）。
   *
   * `path` 是客户端内部字段：`rendererHistory` / Center 回放只投影成
   * `ChatDisplayImage`（无路径），真实文件按 id 读取。
   */
  displayImages?: StoredDisplayImage[]
}

export interface StoredDisplayImage extends ChatDisplayImage {
  path: string
}

export interface StoredMessage {
  id: string
  role: StoredRole
  content: string
  /** ISO 时间戳 */
  createdAt: string
  /** 产生这条消息的 Agent 请求 id；旧文件缺省。 */
  requestId?: string
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
 * 会话级模型覆盖（docs/06 §3，`sessions/<id>.json` 的 `meta.llm`）。
 *
 * 只存**一对** `(providerId, model)` 而不是只存 model：模型名可跨 provider 重名，
 * 且思考等级 / 上下文窗口等参数是按 `providers.<pid>.modelParams[<model>]` 取的
 * （`resolveModelParams` 的唯一口径）—— 只存 model 会在切全局 provider 后取错参数表。
 *
 * 解析链只有一级：**会话覆盖 > 全局 `llm.active` 的 provider + 它的 `model`**。
 * 覆盖里的 provider 已被删除 / model 为空时**静默回落全局**（与 `meta.projectId`
 * 绑定失效同款：会话级绑定是可选的，逐次执行不刷 warn）。
 */
export interface SessionModelOverride {
  providerId: string
  model: string
}

/**
 * 手动压缩留痕（`/compact`，2026-10-03，docs/06 §4）。
 *
 * 用户显式触发（渲染层 `/compact` 命令 → `chat:compact` → 内核 `agent.compact`）：
 * 把**当时的全部消息**压成一段摘要存进 `meta.compact`，此后组装请求时只取
 * `upToMessageId` 之后的消息、摘要注入 systemPrompt 的 `historySummary` 小节——
 * 上下文占用显著下降，而**消息本体不删**（历史仍可在界面回看）。
 */
export interface SessionCompact {
  /** 压缩摘要文本（随每次组装注入 systemPrompt；也参与后续自动压缩的累计链） */
  summary: string
  /** 压缩时刻（ISO） */
  at: string
  /** 压缩覆盖到的最后一条消息 id：组装请求时只取它**之后**的消息 */
  upToMessageId: string
}

/**
 * 会话级元信息（`userData/sessions/<sessionId>.json` 的 `meta` 字段，docs/06 §4）。
 *
 * 刻意存在**会话文件自身**里，不做 sidecar 索引：`listSessions()` 把 `sessions/`
 * 下任何 `*.json` 都当作会话 id，放 `index.json` 会立刻多出一个假会话。
 * 也正因如此它**不进 `config.json`**，不需要配置迁移。
 */
export interface SessionMeta {
  /**
   * 自动生成 / 未来手动设置的会话标题。
   *
   * 非空时优先于“首条用户消息前 24 字”的回退标题；生成失败不写这个字段，
   * 由 `titleState: 'pending'` 记录后续发送需要重试。属于会话数据，
   * 不进 `config.json` / `CONFIG_VERSION`。
   */
  title?: string
  /**
   * 标题生成状态（内部重试标记）。
   *
   * 只在标题请求已经开始但尚未成功时写 `'pending'`；成功写入 title 后删除。
   * 旧会话没有这个字段，因此不会被批量回填。
   */
  titleState?: 'pending'
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
  /**
   * 会话级模型覆盖（docs/06 §3，本轮）。
   *
   * **缺省（undefined）= 跟随全局** `llm.active` + 该 provider 的 `model`；写了就只对
   * 该会话生效（内核每轮经注入的 `AgentProviderFactory.createForSession` 现解析）。
   * 写入入口只有本机渲染层（`chat:setSessionModel`）与 Center 的 `session.setModel` 命令。
   * 同样是**会话数据**：不进 `config.json`、不进 `CONFIG_VERSION` 迁移链，
   * 读取侧按白名单宽容归化（老文件缺字段 = 未覆盖）。
   */
  llm?: SessionModelOverride
  /**
   * 会话级用量累计（本轮，docs/06 §16.2）：主进程在每轮 usage 事件处同步累加。
   * 渲染层切回会话时以它为种子恢复「平均缓存命中率」等累计口径——
   * 跨切换、跨重启连续。同样是**会话数据**：不进 config.json、不进 CONFIG_VERSION，
   * 读取侧按白名单宽容归化（畸形值整段丢弃 = 没有累计）。
   */
  usage?: SessionUsageStats
  /**
   * 手动压缩留痕（`/compact`，本轮）：`undefined` = 从未手动压缩过。
   * 与自动压缩（内存 `summaries` Map，重启即丢）不同，这里**随会话文件落盘**，
   * 重启后上下文仍然是压缩后的口径。同样是会话数据，零迁移。
   */
  compact?: SessionCompact
}

/** `userData/sessions/<sessionId>.json` 的结构（v1 无 `meta`，读取侧必须容忍） */
export interface StoredSession {
  version: typeof SESSION_FILE_VERSION
  sessionId: string
  updatedAt: string
  messages: StoredMessage[]
  /** 会话级元信息；空 meta 不写这个键（老文件形状保持不变） */
  meta?: SessionMeta
  /**
   * 提问留痕（本轮，docs/12 §5）：Agent 问过什么、用户答了什么、怎么结算的。
   *
   * 与 `messages` **分开存**：它不是对话轮次，绝不能进模型上下文（`context()` 只读
   * `messages`），只是给渲染层 / Center 回放看的记录。有界环（最近 50 条），空数组不写键。
   */
  asks?: StoredAskRecord[]
}

/**
 * 一次提问的留痕（`StoredSession.asks` 的元素，本轮 docs/12 §5）。
 *
 * 字段与 Center 协议里的 `CenterHistoryAsk` 一一对应：客户端的这份结构经
 * `rendererHistoryWithAsks` 原样交给网页端渲染成只读卡。
 */
export interface StoredAskRecord {
  requestId: string
  question: string
  header?: string
  options?: { label: string; description?: string }[]
  multiSelect: boolean
  /** 扁平化的作答（多选时多条；未作答为空数组） */
  answers: string[]
  /** 逐问作答（一次多问时按提问顺序；单问 / 未作答缺省） */
  answersByQuestion?: string[][]
  outcome: AskSettleOutcome
  /** 提问时刻（ISO）：与消息一起排序用 */
  createdAt: string
  /** 结算时刻（ISO） */
  settledAt: string
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
  /** 产生这条消息的 Agent 请求 id；装配层统一注入。 */
  requestId?: string
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
 * v3 → v4：新增可选 `asks`（提问留痕，本轮 docs/12 §5）。同款零迁移：缺字段 = 没有留痕，
 * 旧文件天然合法；版本号只用于说明"这个文件可能带提问记录"。
 * v4 → v5：工具调用新增可选 `displayImages`（对话图片展示，docs/06 §14）。
 * 同样零迁移：缺字段 = 没有展示图片，旧文件天然合法。
 * v6 → v7：消息新增可选 `requestId`（请求级工作折叠 / 总用时）。同款零迁移：
 * 缺字段 = 老历史，由渲染层按相邻助手消息回退分组。
 */
export const SESSION_FILE_VERSION = 7 as const
