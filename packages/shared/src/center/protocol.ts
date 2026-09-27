/**
 * Aurora Center 三方协议（docs/12 §4）—— 客户端 / 服务器 / Web 共享的 JSON 契约。
 *
 * 只含类型与字面量常量：渲染层可以 `import type`（编译期擦除，无 Node 依赖），
 * 服务器与客户端主进程直接引用。**协议演进只增不改**：所有消费方对未知
 * `type` / `kind` 一律忽略，不得因新字段抛错。
 */
import type { AgentEvent } from '../ipc/types.js'
import type { ModeId, ReasoningEffort } from '../config/schema.js'
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

/** 客户端上传文件的索引条目（网页端文件管理页与 `file.received` 通知共用） */
export interface FileEntryInfo {
  fileId: string
  clientId: string
  name: string
  size: number
  note?: string
  uploadedAt: string
  /** 24 小时后自动删除的时间点 */
  expiresAt: string
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
    }
  /** 会话绑定项目（`''` 清除绑定）；`projectId` 必须在客户端 `projects.list` 内 */
  | { kind: 'session.setProject'; requestId: string; sessionId: string; projectId: string }
  /** 客户端项目选项列表；`result.data` 携带 `CenterProjectOption[]` */
  | { kind: 'project.list'; requestId: string }
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
  | { type: 'project.list'; requestId: string; clientId: string }
  | {
      type: 'llm.switch'
      requestId: string
      clientId: string
      providerId?: string
      model?: string
      reasoningEffort?: ReasoningEffort
    }

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
