/**
 * IPC 契约类型（主进程 / preload / 渲染层三方共用，docs/02 §6）。
 * 渲染层只依赖本文件与 `AuroraApi`，不直接接触 Electron。
 */
import type { Result } from '../utils/result.js'
import type {
  AdvancedSettings,
  GeneralSettings,
  LlmSettings,
  ModeId,
  Settings,
  WindowName,
} from '../config/schema.js'

export type { ModeId, WindowName }

// ───────────────────────── 应用信息 ─────────────────────────

export interface AppInfo {
  appVersion: string
  electronVersion: string
  platform: string
  arch: string
  isDev: boolean
  configPath: string
  logDir: string
  userDataDir: string
  /** 是否必须走首次引导（docs/08 §3） */
  needsOnboarding: boolean
  /** safeStorage 是否可用；false 时凭据只驻留内存 */
  cryptoAvailable: boolean
  defaultHotkey: string
}

export interface OpenPathRequest {
  kind: 'logs' | 'config' | 'watchDir' | 'subject'
  /** kind = subject 时使用：科目名 */
  subject?: string
}

// ───────────────────────── 设置 ─────────────────────────

/**
 * 局部更新配置：每个分组是**局部**更新（如只传 `mcp.servers`）。
 * 主进程会把未提及的子字段补回当前值后再合并（见 `main/ipc.ts` 的 applyPatch），
 * 因此调用方不需要先读出完整分组。
 */
export interface SettingsPatch {
  general?: Partial<GeneralSettings>
  llm?: Partial<LlmSettings>
  advanced?: Partial<AdvancedSettings>
  skills?: Partial<Settings['skills']>
  mcp?: Partial<Settings['mcp']>
  modes?: Partial<Settings['modes']>
}

/** 敏感字段路径 → 明文值；由主进程加密后落盘（docs/08 §2）。 */
export type SecretEntries = Record<string, string>

export interface SetSecretsOutcome {
  /** false 表示 safeStorage 不可用，值只驻留内存 */
  persisted: boolean
  paths: string[]
}

// ───────────────────────── 模式 ─────────────────────────

export type GuideStepStatus = 'pending' | 'collecting' | 'completed'

export interface ModeSummary {
  id: ModeId
  displayName: string
  description: string
  icon?: string
  guideCompleted: boolean
  guideResumeable: boolean
  /** 占位模式（work / code）在执行层的行为差异 */
  placeholder: boolean
  active: boolean
  /** 该模式引导需要收集的字段说明，供设置页展示 */
  guideSteps: string[]
  /** 当前配置是否已具备该模式的核心能力前提（如 classroom 需要感知文件夹 + 科目） */
  ready: boolean
  /** `ready = false` 时给用户看的一句话说明 */
  readinessHint?: string
}

export interface GuideStepPayload {
  index: number
  total: number
  stepId: string
  field: string
  question: string
  /** 该步骤是否已有可用的当前值 */
  currentValue?: string
}

export interface GuideSession {
  mode: ModeId
  guideId: string
  resumeable: boolean
  /** 尚未开始的步骤索引；等于 total 表示全部完成 */
  nextIndex: number
  total: number
  step: GuideStepPayload | null
  completed: boolean
}

export interface GuideAnswerResult {
  session: GuideSession
  /** 校验失败时返回原因，session 保持不变 */
  error?: string
  settings: Settings
}

export interface ModeChangedEvent {
  current: ModeId
  modes: ModeSummary[]
  reason: 'user' | 'onboarding' | 'system'
}

// ───────────────────────── LLM ─────────────────────────

export interface TestConnectionRequest {
  /** 已有 provider id；与 inline 二选一 */
  providerId?: string
  baseUrl?: string
  apiKey?: string
  model?: string
  /** true 时同时拉取模型列表 */
  withModels?: boolean
}

export interface TestConnectionResult {
  ok: boolean
  latencyMs: number
  message: string
  models?: string[]
  httpStatus?: number
}

export interface ModelInfo {
  id: string
  ownedBy?: string
}

// ───────────────────────── 窗口 ─────────────────────────

export type PrimaryWindow = 'mini-chat' | 'chat'

export interface WindowState {
  visible: Partial<Record<WindowName, boolean>>
  /** 迷你窗与交互窗同屏互斥（docs/07 §3） */
  primary: PrimaryWindow | null
}

// ───────────────────────── 更新（docs/04 §P6、docs/09） ─────────────────────────

/** `disabled`：开发态 / 未打包 / 更新源不可用时不可用（降级为"仅手动检查"）。 */
export type UpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateState {
  status: UpdateStatus
  /** 当前运行版本 */
  currentVersion: string
  /** 检测到的新版本（status 为 available / downloading / downloaded 时存在） */
  availableVersion?: string
  /** 下载进度 0–100 */
  progressPercent?: number
  /** 已下载字节 / 总字节 */
  transferred?: number
  total?: number
  /** 人话错误说明（status = error） */
  error?: string
  /** 更新源（公开 releases 仓库），便于用户在设置页确认 */
  feed?: string
  /** 最近一次检查时间（ISO） */
  checkedAt?: string
  /** 是否处于可用状态（disabled 时为 false） */
  enabled: boolean
}

// ───────────────────────── MCP ─────────────────────────

export type McpServerState = 'idle' | 'connecting' | 'ready' | 'error'

export interface McpServerStatus {
  name: string
  transport: 'stdio' | 'http'
  enabled: boolean
  state: McpServerState
  /** 已注册到工具表的工具数量（state = ready 时有效） */
  toolCount: number
  lastError?: string
}

// ───────────────────────── Skill ─────────────────────────

export interface SkillSummary {
  name: string
  description: string
  whenToUse?: string
  source: 'builtin' | 'user'
  hasScripts: boolean
  enabled: boolean
  dir: string
}

// ───────────────────────── 感知（P5 补全） ─────────────────────────

export interface PerceptionSummary {
  /** ISO 时间戳 */
  timestamp: string
  localTime: string
  weekday: string
  battery?: { hasBattery: boolean; percent: number; isCharging: boolean }
  network?: { online: boolean; type: string }
  /** 未实现的采集项统一为 unknown，绝不抛错（ADR-007） */
  unknown: string[]
}

// ───────────────────────── 对话（P3 接入 Agent 内核） ─────────────────────────

export interface SendMessageRequest {
  sessionId: string
  text: string
  /** 系统提示词会被注入的来源窗口，用于日志与后续多窗口路由 */
  origin: WindowName
}

export interface AgentToolCall {
  id: string
  name: string
  input?: unknown
  state: 'running' | 'success' | 'error'
  outputSummary?: string
}

/**
 * 会话消息（持久化 + IPC 回传共用，docs/06 §4）。
 * 刻意不依赖 `@aurora/agent-core`：内核的 `ChatRequestMessage` 是 LLM 侧形状，
 * 这里是 Aurora 自己的存储 / 渲染形状，两者由 session 模块负责转换。
 */
export interface ChatMessageDto {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  /** ISO 时间戳 */
  createdAt: string
  /** assistant 消息发起的工具调用（含最终状态），供渲染层显示执行卡片 */
  toolCalls?: AgentToolCall[]
}

export interface ChatHistoryRequest {
  sessionId: string
  /** 返回最近 N 条；缺省返回全部 */
  limit?: number
}

/**
 * 事件一律携带 `sessionId`：快速会话由服务窗与迷你窗共享，
 * 只按 `requestId` 过滤会串窗（docs/06 §4）。
 *
 * `messageId`（text / tool）：该轮助手消息在会话存储中的 id。
 * 多轮工具调用会产生多条助手消息，渲染层据此把文本与工具卡片
 * 归到正确的消息上（首轮前渲染层还不知道 id，收到后再认领）。
 */
export type AgentEvent =
  | { type: 'queued'; sessionId: string; requestId: string }
  | { type: 'text'; sessionId: string; requestId: string; messageId: string; delta: string }
  | {
      type: 'tool'
      sessionId: string
      requestId: string
      messageId: string
      call: AgentToolCall
    }
  | { type: 'done'; sessionId: string; requestId: string; pending?: boolean }
  | { type: 'error'; sessionId: string; requestId: string; code: string; message: string }

// ───────────────────────── preload 暴露面 ─────────────────────────

export interface AuroraApi {
  app: {
    getInfo(): Promise<Result<AppInfo>>
    quit(): Promise<void>
    openPath(request: OpenPathRequest): Promise<Result<string>>
  }
  settings: {
    get(): Promise<Result<Settings>>
    update(patch: SettingsPatch): Promise<Result<Settings>>
    reset(): Promise<Result<Settings>>
    setSecrets(entries: SecretEntries): Promise<Result<SetSecretsOutcome>>
    hasSecret(path: string): Promise<Result<boolean>>
    clearSecret(path: string): Promise<Result<boolean>>
    exportRedacted(): Promise<Result<Settings>>
    onChanged(listener: (settings: Settings) => void): () => void
  }
  mode: {
    list(): Promise<Result<ModeSummary[]>>
    set(id: ModeId): Promise<Result<ModeSummary[]>>
    completeGuide(id: ModeId): Promise<Result<ModeSummary[]>>
    resetGuide(id: ModeId): Promise<Result<ModeSummary[]>>
    guideStart(id: ModeId): Promise<Result<GuideSession>>
    guideAnswer(id: ModeId, answer: string): Promise<Result<GuideAnswerResult>>
    guideReset(id: ModeId): Promise<Result<GuideSession>>
    onChanged(listener: (event: ModeChangedEvent) => void): () => void
  }
  llm: {
    testConnection(request: TestConnectionRequest): Promise<Result<TestConnectionResult>>
    listModels(request: TestConnectionRequest): Promise<Result<ModelInfo[]>>
  }
  window: {
    show(name: WindowName): Promise<Result<WindowState>>
    hide(name: WindowName): Promise<Result<WindowState>>
    toggle(name: WindowName): Promise<Result<WindowState>>
    showChat(): Promise<Result<WindowState>>
    showMiniChat(): Promise<Result<WindowState>>
    setPosition(name: WindowName, position: { x: number; y: number }): Promise<Result<WindowState>>
    getState(): Promise<Result<WindowState>>
    onStateChanged(listener: (state: WindowState) => void): () => void
  }
  perception: {
    summary(): Promise<Result<PerceptionSummary>>
  }
  skills: {
    list(): Promise<Result<SkillSummary[]>>
  }
  chat: {
    send(request: SendMessageRequest): Promise<Result<{ requestId: string }>>
    abort(requestId: string): Promise<Result<boolean>>
    onEvent(listener: (event: AgentEvent) => void): () => void
    /** 会话历史（窗口挂载时水合，docs/06 §4） */
    history(request: ChatHistoryRequest): Promise<Result<ChatMessageDto[]>>
  }
  mcp: {
    status(): Promise<Result<McpServerStatus[]>>
    onStatusChanged(listener: (servers: McpServerStatus[]) => void): () => void
  }
  update: {
    getState(): Promise<Result<UpdateState>>
    /** 检查更新（不自动下载） */
    check(): Promise<Result<UpdateState>>
    download(): Promise<Result<UpdateState>>
    /** 退出并安装；调用后进程会结束 */
    install(): Promise<Result<boolean>>
    onStateChanged(listener: (state: UpdateState) => void): () => void
  }
}
