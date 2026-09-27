/**
 * Aurora Center 三方协议（docs/12 §4）—— 客户端 / 服务器 / Web 共享的 JSON 契约。
 *
 * 只含类型与字面量常量：渲染层可以 `import type`（编译期擦除，无 Node 依赖），
 * 服务器与客户端主进程直接引用。**协议演进只增不改**：所有消费方对未知
 * `type` / `kind` 一律忽略，不得因新字段抛错。
 */
import type { AgentEvent } from '../ipc/types.js'
import type { ModeId } from '../config/schema.js'

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
