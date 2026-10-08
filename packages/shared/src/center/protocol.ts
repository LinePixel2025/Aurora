/**
 * Aurora Center 三方协议（docs/12 §4）—— 客户端 / 服务器 / Web 共享的 JSON 契约。
 *
 * 只含类型与字面量常量：渲染层可以 `import type`（编译期擦除，无 Node 依赖），
 * 服务器与客户端主进程直接引用。**协议演进只增不改**：所有消费方对未知
 * `type` / `kind` 一律忽略，不得因新字段抛错。
 */
import type {
  AgentEvent,
  AskUserRequest,
  AutomationDefinition,
  AutomationMode,
  ChatDisplayImage,
  SubagentSnapshot,
} from '../ipc/types.js'
import type { CenterOfficialCapability, ModeId, ReasoningEffort } from '../config/schema.js'
import type { PermissionMode } from '../config/permission.js'

/** 客户端能力声明（hello 上报；服务器据此决定哪些命令可发） */
export interface ClientCapabilities {
  /** 允许远程开 session 对话（`center.allowRemoteSession`） */
  session: boolean
  /** 允许远程改配置（`center.allowRemoteConfig`） */
  remoteConfig: boolean
  /** 允许接收文件（`center.allowFileTransfer`） */
  fileTransfer: boolean
}

/** 客户端握手信息（连接后第一条消息） */
export interface ClientHello {
  clientId: string
  name: string
  version: string
  platform: string
  mode: ModeId
  capabilities: ClientCapabilities
}

/** 客户端状态快照（连接后与每次相关变更时上报） */
export interface ClientStatus {
  mode: ModeId
  version: string
  platform: string
  agent: {
    permissionMode: string
    tools: { enabled: boolean; files: boolean; search: boolean; open: boolean; terminal: boolean }
  }
  center: { allowRemoteSession: boolean; allowRemoteConfig: boolean; allowFileTransfer: boolean }
  /** 生效 LLM 快照（网页端据此展示/切换模型与思考等级，docs/12 §6.3） */
  llm: { activeProviderId: string; model: string; reasoningEffort: ReasoningEffort }
  /**
   * 本机语音能力位（v0.3.2，docs/12 §6.4）。**可选字段**（旧客户端不下发）：
   * 网页端据此决定是否渲染麦克风 / 朗读按钮——未配置连按钮都不出现（同桌面端
   * STT/TTS 门控口径），字段缺失时同样不渲染（向后兼容）。
   */
  voice?: { stt: boolean; tts: boolean }
}

/** Center 官方模型能力（与 `CENTER_OFFICIAL_CAPABILITIES` 同源，单独导出供 Web 协议使用）。 */
export const CENTER_OFFICIAL_CAPABILITY_LABELS = {
  llm: '语言模型',
  imagegen: '图像生成',
  tts: '语音合成',
  stt: '语音识别',
} as const

/** 管理端保存的一条官方模型；字段按能力取用，未用字段不下发。 */
export interface CenterOfficialModelEntry {
  id: string
  label?: string
  enabled: boolean
  reasoningEffort?: ReasoningEffort
  contextWindow?: number
  vision?: boolean
  size?: string
  voice?: string
  speed?: number
  format?: string
  language?: string
}

/** 单个官方能力的管理面配置（API Key 只以 apiKeySet 标记返回）。 */
export interface CenterOfficialServiceConfig {
  enabled: boolean
  type: string
  baseUrl: string
  apiKeySet: boolean
  defaultModel: string
  models: CenterOfficialModelEntry[]
  error?: string
}

export type CenterOfficialServicesConfig = Record<
  CenterOfficialCapability,
  CenterOfficialServiceConfig
>

/** 客户端可见的官方模型目录：不含上游 baseUrl / 密钥 / 未开放模型。 */
export interface CenterOfficialModelCatalogEntry {
  id: string
  label?: string
  reasoningEffort?: ReasoningEffort
  contextWindow?: number
  vision?: boolean
  size?: string
  voice?: string
  speed?: number
  format?: string
  language?: string
}

export interface CenterOfficialServiceCatalog {
  type: string
  defaultModel: string
  models: CenterOfficialModelCatalogEntry[]
}

export interface CenterOfficialModelCatalog {
  revision: string
  services: Partial<Record<CenterOfficialCapability, CenterOfficialServiceCatalog>>
}

/** Token 用量汇总（终身总量或查询区间）。 */
export interface CenterTokenUsageTotals {
  requests: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  totalTokens: number
}

/** 折线图的一天。 */
export interface CenterTokenUsageDay {
  date: string
  requests: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  totalTokens: number
}

/** 最近请求元数据；刻意不含提示词 / 回复正文。 */
export interface CenterTokenUsageRecord {
  id: string
  at: string
  userId: string
  username: string
  clientId: string
  model: string
  promptTokens: number
  completionTokens: number
  cachedTokens?: number
  totalTokens: number
}

export interface CenterUsageQuery {
  from?: string
  to?: string
  userId?: string
  clientId?: string
  model?: string
  /** 明细分页条数（服务器夹到 1..500，默认 100） */
  limit?: number
  /** 明细分页起点（服务器夹到 ≥0，默认 0）；daily / totals 永远按全量算，不受它影响 */
  offset?: number
}

export interface CenterUsageResponse {
  scope: {
    allUsers: boolean
    userId: string
  }
  range: {
    from: string
    to: string
  }
  totals: CenterTokenUsageTotals
  lifetime: CenterTokenUsageTotals
  daily: CenterTokenUsageDay[]
  /** 本页明细（`recentTotal` 里的第 offset..offset+limit 条） */
  recent: CenterTokenUsageRecord[]
  /** 区间内过滤后的明细总数（与 limit / offset 无关，供网页端算页数） */
  recentTotal: number
}

/** Center 当前托管的一个客户端更新版本。 */
export interface CenterReleaseFileInfo {
  name: string
  size: number
  sha512: string
  kind: 'installer' | 'blockmap' | 'manifest'
}

export interface CenterReleaseInfo {
  version: string
  publishedAt: string
  channel: 'latest'
  files: CenterReleaseFileInfo[]
}

/** 敏感工具确认请求（客户端 → 服务器 → 网页端转发，docs/12 §5.1） */
export interface ConfirmRequestPayload {
  confirmId: string
  sessionId: string
  toolName: string
  /** 工具入参（主进程已按纯数据序列化，不包含凭据明文） */
  input: unknown
  createdAt: string
  /** 超时时间点；过期后网页端的批准 / 拒绝都无效 */
  expiresAt: string
}

/**
 * 向用户提问的请求（`ask_user`，v0.3.3，docs/12 §5）。
 *
 * 与 `AskUserRequest`（主进程 → 渲染层的 DTO，`../ipc/types.js`）**同一形状**：
 * 客户端上行时原文转发、网页端直接当卡片数据用，不做字段改名。注意 `expiresAt` 是
 * **毫秒时间戳**（不是 `ConfirmRequestPayload` 的 ISO 字符串），照抄会错。
 */
export type AskUserRequestPayload = AskUserRequest

/** 网页端对提问卡的作答（网页 → 服务器 → 客户端；`answers` 为空且未 `skipped` 按跳过处理） */
export interface AskResolvePayload {
  /** 选中的选项 label 或自由输入的文本（多选时多条） */
  answers: string[]
  /** 逐问作答（`questions[]` 多问时的分组答案；单问时缺省） */
  answersByQuestion?: string[][]
  /** 用户主动跳过（语义比超时更明确）；`answers` 非空时可以不带 */
  skipped?: boolean
}

/**
 * 提问的结算原因（客户端 → 服务器 `ask.settled`，本轮）。
 *
 * 与内核 `AskUserAnswer` 的三态一一对应，另加 `skipped`（用户点了跳过）：
 * 网页端据此把卡片切成「已作答 / 已跳过 / 已超时 / 已中止」的只读态。
 */
export type AskSettleOutcome = 'answered' | 'skipped' | 'timedOut' | 'aborted'

/** 设备授权登录（客户端点「登录账户」→ 打开 Center 网页 → 网页确认后客户端自动拿到令牌，docs/12 §4.3） */
export interface DeviceLoginChallenge {
  /** 设备码（客户端持有，轮询凭据） */
  deviceCode: string
  /** 展示码（人看的确认凭据，网页确认页回填 / 展示用） */
  userCode: string
  /** 用户在浏览器打开的确认页地址（含 `?code=` 展示码） */
  verifyUrl: string
  /** 挑战过期时间点 */
  expiresAt: string
  /** 建议轮询间隔（毫秒） */
  intervalMs: number
}

/** 设备授权轮询结果 */
export type DeviceLoginPollResult =
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'approved'; token: string; username: string }

/** 客户端上传 / 网页上传的文件索引条目（网页端文件管理页与 `file.received` 通知共用） */
export interface FileEntryInfo {
  fileId: string
  clientId: string
  name: string
  size: number
  note?: string
  uploadedAt: string
  /** 24 小时后自动删除的时间点 */
  expiresAt: string
  /**
   * 来源（本轮，**可选**：旧客户端 / 旧索引不下发，消费方缺省按 `'client'` 处理）：
   * `'client'` = 客户端经 `center_send_file` 上传；`'web'` = 网页端 `POST /api/uploads` 上传
   * （用于「发给某个客户端」）。
   */
  source?: 'client' | 'web'
}

/** 服务器发给客户端的命令 */
export type CenterCommand =
  | { kind: 'session.input'; requestId: string; sessionId: string; text: string }
  | {
      kind: 'session.abort'
      requestId: string
      sessionId: string
      /** 客户端侧 AgentHost 的 requestId（发起 input 时由 `result` 回执带出） */
      agentRequestId: string
    }
  | { kind: 'config.get'; requestId: string }
  /** 白名单外的补丁整条拒绝（docs/12 §6.2），客户端回 `E_FORBIDDEN_PATH` */
  | { kind: 'config.update'; requestId: string; patch: Record<string, unknown> }
  | { kind: 'mode.switch'; requestId: string; mode: ModeId }
  /** 网页端对确认卡的批复（服务器只转发给发起会话的客户端） */
  | { kind: 'confirm.resolve'; requestId: string; confirmId: string; approved: boolean }
  /**
   * 网页端对提问卡的作答（v0.3.3，docs/12 §5）：服务器只转发给发起会话的客户端；
   * 客户端调 `AskUserService.resolve`（对已结算 requestId 返回 `false`，先到先得），
   * `result.data` 携带 `{ settled }`。
   *
   * `requestId` 语义见 `CenterWebMessage.ask.resolve` 的注释：它是**提问卡 id**，
   * 原样穿到客户端并作为回执关联键。
   */
  | {
      kind: 'ask.resolve'
      requestId: string
      sessionId: string
      answers: string[]
      /** 逐问作答（`questions[]` 多问时的分组答案；单问 / 旧客户端不带） */
      answersByQuestion?: string[][]
      skipped?: boolean
    }
  /**
   * 把文件推给客户端落盘（本轮，docs/12 §5）：服务器查 `FileStore` 补齐 `name` / `size`
   * 后下发，客户端校验 `center.allowFileTransfer`，再用**自身令牌**走
   * `GET /api/client/files/:fileId` 流式拉回、写进本机下载目录，回执带 `{ path }`。
   * 待回执超时按 `FILE_KINDS` 放宽到 10 分钟（大文件远超 15s）。
   */
  | { kind: 'file.send'; requestId: string; fileId: string; name: string; size: number }
  // ── 远程会话管理（docs/12 §6.3，仅 center- 会话）──
  /** 枚举客户端的 center- 会话；`result.data` 携带 `CenterSessionSummary[]` */
  | { kind: 'session.list'; requestId: string }
  /** 让客户端主界面切到指定会话（会话未落盘时客户端可兜底创建） */
  | { kind: 'session.activate'; requestId: string; sessionId: string }
  /** center- 会话在客户端左栏的可见性（缺省可见；隐藏仍可远程输入） */
  | { kind: 'session.visibility'; requestId: string; sessionId: string; visible: boolean }
  /** 会话级权限档覆盖（SessionMeta 数据，不动全局 `agent.permissionMode`，docs/12 §6.3） */
  | {
      kind: 'session.setPermission'
      requestId: string
      sessionId: string
      permissionMode: PermissionMode
    } /** 会话绑定项目（`''` 清除绑定）；`projectId` 必须在客户端 `projects.list` 内 */
  | { kind: 'session.setProject'; requestId: string; sessionId: string; projectId: string }
  /**
   * 会话级模型覆盖（本轮，docs/06 §3 / docs/12 §6.3）：写会话文件
   * `meta.llm = { providerId, model }`；`model` 为空串 = **清除覆盖**（回落全局 `llm.active`）。
   * 与 `llm.switch`（全局默认）是**两份数据**：后者改的是所有未覆盖会话立刻跟随的默认值。
   */
  | {
      kind: 'session.setModel'
      requestId: string
      sessionId: string
      /** 缺省沿用客户端全局激活的 provider */
      providerId?: string
      model: string
    }
  /** 客户端项目选项列表；`result.data` 携带 `CenterProjectOption[]` */
  | { kind: 'project.list'; requestId: string }
  /**
   * 历史回放（v0.2.4，docs/12 §5 第 7 步 / §6.3）：客户端从 SessionStore 读该会话的
   * 渲染层历史（`rendererHistory`，最近 200 条），经 `result.data` 携带
   * `CenterSessionHistoryMessage[]` 回执。**服务器不缓存**——历史只在回执里路过。
   */
  | { kind: 'session.history'; requestId: string; sessionId: string }
  /**
   * 读取助手消息图片区的一张图片（`show_image` / `generate_image`）。
   * 客户端按会话 + imageId 查记录并再次校验路径，`result.data` 携带
   * `{ dataUrl, name, mime }`；服务器只转发，不缓存图片内容。
   */
  | { kind: 'session.readImage'; requestId: string; sessionId: string; imageId: string }
  /**
   * 远程切模型 / 思考等级（docs/12 §6.3）。**专用命令，不走 config.update 白名单**：
   * `llm.providers.` 前缀会连带放行 `apiKeyEnc`，故只放行这三个字段的点改。
   */
  | {
      kind: 'llm.switch'
      requestId: string
      /** 切换激活 provider（`llm.active`）；缺省沿用当前激活 */
      providerId?: string
      /** 覆盖激活 provider 的 model；缺省不改 */
      model?: string
      /** 覆盖激活 provider 的思考等级；缺省不改 */
      reasoningEffort?: ReasoningEffort
    }
  // ── 远程自动化管理（docs/13 §10）：客户端存数据、服务器只转发不缓存 ──
  /** 枚举自动化（user + builtin）；`result.data` 携带 `AutomationListResult` */
  | { kind: 'automation.list'; requestId: string }
  /** 组件目录（触发器 / 操作的表单元数据）；`result.data` 携带 `AutomationCatalog` */
  | { kind: 'automation.catalog'; requestId: string }
  /** 新建（definition.id 为空）/ 修改一份自动化；`result.data` 携带保存后的定义 */
  | { kind: 'automation.save'; requestId: string; definition: AutomationDefinition }
  | { kind: 'automation.delete'; requestId: string; id: string }
  | { kind: 'automation.run'; requestId: string; id: string }
  /** 运行历史；`result.data` 携带 `AutomationRun[]`（triggeredAt 倒序） */
  | {
      kind: 'automation.history'
      requestId: string
      automationId?: string
      mode?: AutomationMode
      limit?: number
    }
  // ── 语音中转（v0.3.2，docs/12 §6.4）：客户端用本机已配 provider，服务器只转发不缓存 ──
  /**
   * 语音识别中转：网页端录音（webm/opus 或 mp4，`mime` 标明容器）base64 上行，
   * 客户端调本机 STT service 转写；`result.data` 携带 `{ text }`。
   * 客户端未配置 STT 时回 `E_VOICE_NOT_CONFIGURED`。
   */
  | { kind: 'stt.transcribe'; requestId: string; audioBase64: string; mime: string }
  /**
   * 朗读合成中转：网页端送文本，客户端调本机 TTS service；
   * `result.data` 携带 `{ audioBase64, mimeType }`（网页端 blob 播放）。
   * 客户端未配置 TTS 时回 `E_VOICE_NOT_CONFIGURED`。
   */
  | { kind: 'tts.synthesize'; requestId: string; text: string }

/** 客户端 → 服务器 */
export type CenterClientMessage =
  | { type: 'hello'; hello: ClientHello }
  | { type: 'status'; status: ClientStatus }
  | { type: 'pong' }
  /** 命令回执；`session.input` 成功时 `data` 携带 `{ agentRequestId }` */
  | { type: 'result'; requestId: string; ok: boolean; data?: unknown; error?: string }
  | { type: 'session.event'; sessionId: string; event: AgentEvent }
  /** 敏感工具确认请求，转发给该会话属主 + 管理员（docs/12 §5.1） */
  | { type: 'confirm.request'; request: ConfirmRequestPayload }
  /**
   * 向用户提问的请求（v0.3.3，docs/12 §5）：仅 `center-` 前缀会话上行，
   * 转发路由同 `confirm.request`（属主 + 管理员），网页端刷新后由服务器回放未过期项。
   */
  | { type: 'ask.request'; request: AskUserRequestPayload }
  /**
   * 提问已在**客户端**结算（本轮，docs/12 §5）：本地作答 / 跳过 / 超时 / 中止都发一条，
   * 服务器据此摘除 `pendingAsks` 并广播（网页卡立即收起，不必等自己的倒计时走到 0）。
   *
   * 补发队列**不参与**：结算通知过期即无意义（网页端的卡会按自己的 `expiresAt` 消失），
   * 离线时直接丢弃并 debug 留痕。
   */
  | {
      type: 'ask.settled'
      requestId: string
      sessionId: string
      outcome: AskSettleOutcome
      /** 结算时的作答（`outcome === 'answered'` 时非空）：网页端据此在只读卡上显示"答了什么" */
      answers?: string[]
      /** 逐问作答（多问时；单问 / 未作答缺省） */
      answersByQuestion?: string[][]
    }

/** 服务器 → 客户端 */
export type CenterServerMessage =
  | { type: 'welcome'; serverVersion: string; clientId: string }
  | { type: 'cmd'; cmd: CenterCommand }
  | { type: 'ping' }

/** 网页端登记的客户端信息（REST 与 `clients` 快照共用） */
export interface ClientInfo {
  clientId: string
  name: string
  online: boolean
  version: string
  platform: string
  mode: ModeId
  ownerUserId: string
  ownerUsername: string
  lastSeenAt: string
  firstSeenAt: string
}

/** 客户端 center- 会话摘要（`session.list` 的 `result.data`，docs/12 §6.3） */
export interface CenterSessionSummary {
  sessionId: string
  title: string
  updatedAt: string
  /** 会话绑定的项目 id（`''` / 缺省 = 未绑定） */
  projectId?: string
  /** 会话级权限档覆盖（缺省 = 跟随全局 `agent.permissionMode`） */
  permissionMode?: PermissionMode
  /** 客户端主界面左栏是否可见（缺省 = 可见） */
  centerVisible?: boolean
  /**
   * 会话级模型覆盖（本轮，docs/06 §3）：`meta.llm`。
   * **缺省 = 跟随全局** `llm.active` 的 provider 与其 `model`；网页端会话行的模型下拉据此
   * 显示「跟随全局」还是具体模型（选项来自该会话生效 provider 的 `modelList`）。
   */
  llm?: { providerId: string; model: string }
}

/** 客户端项目选项（`project.list` 的 `result.data`，网页端会话绑项目下拉用） */
export interface CenterProjectOption {
  id: string
  name: string
}

/** 网页 → 服务器 */
export type CenterWebMessage =
  | { type: 'session.create'; requestId: string; clientId: string }
  | { type: 'session.input'; requestId: string; clientId: string; sessionId: string; text: string }
  | {
      type: 'session.readImage'
      requestId: string
      clientId: string
      sessionId: string
      imageId: string
    }
  | {
      type: 'session.abort'
      requestId: string
      clientId: string
      sessionId: string
      agentRequestId: string
    }
  | { type: 'config.get'; requestId: string; clientId: string }
  | { type: 'config.update'; requestId: string; clientId: string; patch: Record<string, unknown> }
  | { type: 'mode.switch'; requestId: string; clientId: string; mode: ModeId }
  | {
      type: 'confirm.resolve'
      requestId: string
      clientId: string
      confirmId: string
      approved: boolean
    }
  /**
   * 提问卡作答（v0.3.3，docs/12 §5）：授权 / 离线判定 / 回执同其他命令（`{ settled }`）。
   *
   * ⚠️ `requestId` 是**提问卡自身的 id**（客户端分配的 `ask-*`），不是网页端新生成的命令 id
   * ——网页端与客户端都只有这一个 id 能指认"答的是哪张卡"，它同时充当回执的关联键
   * （客户端在 `result.requestId` 里原样回显）。其它命令的 `requestId` 均为网页端生成，
   * 这一条是例外；两条页签答同一张卡时会用同一个 id 各记一条 pending，按命令顺序 FIFO 配对
   * （与 `settlePending` 的既有语义一致）。
   */
  | {
      type: 'ask.resolve'
      requestId: string
      clientId: string
      sessionId: string
      answers: string[]
      /** 逐问作答（`questions[]` 多问时；单问 / 旧网页不带） */
      answersByQuestion?: string[][]
      skipped?: boolean
    }
  // ── 远程会话管理（docs/12 §6.3）：授权与回执同其他命令 ──
  | { type: 'session.list'; requestId: string; clientId: string }
  | { type: 'session.activate'; requestId: string; clientId: string; sessionId: string }
  | {
      type: 'session.visibility'
      requestId: string
      clientId: string
      sessionId: string
      visible: boolean
    }
  | {
      type: 'session.setPermission'
      requestId: string
      clientId: string
      sessionId: string
      permissionMode: PermissionMode
    }
  | {
      type: 'session.setProject'
      requestId: string
      clientId: string
      sessionId: string
      projectId: string
    }
  /** 会话级模型覆盖（本轮，docs/06 §3）：`model` 空串 = 清除覆盖、回落全局 */
  | {
      type: 'session.setModel'
      requestId: string
      clientId: string
      sessionId: string
      providerId?: string
      model: string
    }
  /** 把暂存文件推给该客户端落盘（本轮，docs/12 §5）：先 `POST /api/uploads` 拿到 fileId 再发它 */
  | { type: 'file.send'; requestId: string; clientId: string; fileId: string }
  | { type: 'project.list'; requestId: string; clientId: string }
  /** 历史回放（v0.2.4，docs/12 §6.3）：客户端读盘回传，`result.data` 携带历史消息数组 */
  | { type: 'session.history'; requestId: string; clientId: string; sessionId: string }
  | {
      type: 'llm.switch'
      requestId: string
      clientId: string
      providerId?: string
      model?: string
      reasoningEffort?: ReasoningEffort
    }
  // ── 远程自动化管理（docs/13 §10）：授权与回执同其他命令 ──
  | { type: 'automation.list'; requestId: string; clientId: string }
  | { type: 'automation.catalog'; requestId: string; clientId: string }
  | {
      type: 'automation.save'
      requestId: string
      clientId: string
      definition: AutomationDefinition
    }
  | { type: 'automation.delete'; requestId: string; clientId: string; id: string }
  | { type: 'automation.run'; requestId: string; clientId: string; id: string }
  | {
      type: 'automation.history'
      requestId: string
      clientId: string
      automationId?: string
      mode?: AutomationMode
      limit?: number
    }
  // ── 语音中转（v0.3.2，docs/12 §6.4）：授权与回执同其他命令；网页端回执等待放宽到 60s ──
  | {
      type: 'stt.transcribe'
      requestId: string
      clientId: string
      audioBase64: string
      mime: string
    }
  | { type: 'tts.synthesize'; requestId: string; clientId: string; text: string }

/** 服务器 → 网页 */
export type CenterWebServerMessage =
  | { type: 'clients'; clients: ClientInfo[] }
  | { type: 'client.status'; clientId: string; status: ClientStatus }
  | { type: 'client.event'; clientId: string; sessionId: string; event: AgentEvent }
  | { type: 'result'; requestId: string; ok: boolean; data?: unknown; error?: string }
  | {
      type: 'file.received'
      fileId: string
      clientId: string
      name: string
      size: number
      note?: string
      at: string
    }
  /** 敏感工具确认请求（客户端转来，路由给会话属主 + 管理员） */
  | {
      type: 'confirm.request'
      clientId: string
      sessionId: string
      request: ConfirmRequestPayload
    }
  /**
   * 向用户提问（v0.3.3，docs/12 §5）：路由同 `confirm.request`（客户端登记表属主 + 全部
   * 管理员）；网页端新连上时服务器**回放未过期项**（`pendingAsks`，窗口 180s 比确认卡的
   * 60s 长得多，不回放会让刷新一次就永远答不上）。
   */
  | {
      type: 'ask.request'
      clientId: string
      sessionId: string
      request: AskUserRequestPayload
    }
  /**
   * 提问已在客户端结算（本轮，docs/12 §5）：服务器摘除 `pendingAsks` 后广播给同一受众，
   * 网页端据此把卡片收起（或切成只读的已结算卡）。
   */
  | {
      type: 'ask.settled'
      clientId: string
      sessionId: string
      requestId: string
      outcome: AskSettleOutcome
      /** 结算时的作答（客户端本地作答时带上；超时 / 中止为空） */
      answers?: string[]
      answersByQuestion?: string[][]
    }

/** 历史回放里的单条工具调用（客户端 SessionStore 的渲染层形状，`input` 已是解析后的对象） */
export interface CenterHistoryToolCall {
  id: string
  name: string
  state: 'running' | 'success' | 'error'
  input?: unknown
  outputSummary?: string
  /** `task` 子代理工具的运行快照（与实时 `subagent` 事件同形状） */
  subagent?: SubagentSnapshot
  /** 对话图片区元数据（无本地路径；网页按 imageId 走 `session.readImage` 读取） */
  displayImages?: ChatDisplayImage[]
}

/**
 * 历史回放消息（`session.history` 的 `result.data` 数组元素，v0.2.4）。
 *
 * 形状与客户端 `SessionStore.rendererHistory` 的输出对齐（user / assistant 两种 role，
 * 工具卡片挂在助手消息上）；网页端把它映射进会话 items——助手消息按**存储消息 id**
 * 与实时聚合同源，用户消息按内容去重（与 `user-message` 事件同口径）。
 */
export interface CenterSessionHistoryMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  /** 产生这条消息的 Agent 请求 id；旧客户端不下发，网页端按相邻助手消息回退分组。 */
  requestId?: string
  reasoning?: string
  toolCalls?: CenterHistoryToolCall[]
  /**
   * 条目种类（本轮，**可选**：旧客户端不下发，消费方缺省按 `'message'` 处理）。
   * `'ask'` = 提问留痕（`StoredSession.asks` 的条目），网页端渲染成**只读的已结算卡**；
   * 这类条目 `content` 是问题原文（搜索 / 复制仍可用），细节在 `ask` 里。
   */
  kind?: 'message' | 'ask'
  /** `kind === 'ask'` 时的提问详情（问题 / 选项 / 作答 / 结算原因） */
  ask?: CenterHistoryAsk
}

/**
 * 历史回放里的提问留痕（`kind: 'ask'` 条目，本轮）。
 *
 * 由客户端在会话文件里持久化（`StoredSession.asks`，有界环），因此刷新页面 / 换设备后
 * 「刚才问了什么、答了什么」仍然可见 —— 服务器依旧零存储。
 */
export interface CenterHistoryAsk {
  requestId: string
  question: string
  header?: string
  options?: { label: string; description?: string }[]
  /** 是否多选（决定只读卡上把多个答案并列还是取一条） */
  multiSelect: boolean
  /** 逐问作答（多问时按 questions 顺序；单问时 `answers` 与它等价） */
  answers: string[]
  answersByQuestion?: string[][]
  outcome: AskSettleOutcome
  settledAt: string
}

/** 远程会话的 sessionId 前缀（客户端渲染层据此区分远程会话） */
export const CENTER_SESSION_PREFIX = 'center-'

/** 远程配置白名单（客户端侧强制，docs/12 §6.2）——服务器端同表用于预检 */
export const CENTER_REMOTE_CONFIG_PREFIXES = [
  'modes.current',
  'agent.tools.enabled',
  'agent.tools.files.enabled',
  'agent.tools.search.enabled',
  'agent.tools.open.enabled',
  'agent.tools.terminal.enabled',
] as const
