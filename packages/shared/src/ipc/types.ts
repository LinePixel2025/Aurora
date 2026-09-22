/**
 * IPC 契约类型（主进程 / preload / 渲染层三方共用，docs/02 §6）。
 * 渲染层只依赖本文件与 `AuroraApi`，不直接接触 Electron。
 */
import type { Result } from '../utils/result.js'
import type {
  AdvancedSettings,
  GeneralSettings,
  Lesson,
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
  kind: 'logs' | 'config' | 'watchDir' | 'subject' | 'workspace'
  /** kind = subject 时使用：科目名 */
  subject?: string
}

/**
 * 仅开发态自测用的诊断信息（`AURORA_SMOKE=1`）。
 *
 * 存在的理由：像"课前提醒真的触发过并打开了科目文件夹"这类**主进程内部副作用**
 * 无法从渲染层观察（自测里不能用真实 `shell.openPath` 弹资源管理器），
 * 又必须被端到端断言覆盖，因此留这一个只读回执口。
 * 生产环境（未打包开发态之外）一律返回 `enabled: false`，不暴露任何信息。
 */
export interface SmokeDiagnostics {
  enabled: boolean
  /** 课前提醒触发记录（最新在前） */
  preClassFired?: Array<{
    subject: string
    minutesUntil: number
    targetDir: string
    /** 是否已调用过打开目录 */
    opened: boolean
  }>
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
  /** 电脑操控工具（docs/06 §11）：顶层浅合并，调用方必须带上完整的 `tools` 子树 */
  agent?: Partial<Settings['agent']>
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

export interface WindowState {
  visible: Partial<Record<WindowName, boolean>>
  /** 当前主对话窗口；交互窗是唯一候选（独立小窗已删除，docs/07 §3） */
  primary: 'chat' | null
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

/** Skill 扫描状态（`skills:rescan` / `skills:status`，docs/06 §6） */
export interface SkillsStatus {
  /** 生效的用户技能目录（`skills.userDir` 为空时为 `userData/skills`） */
  userDir: string
  builtinDir: string
  /** 本次扫描发现的技能数（含被禁用的） */
  total: number
  /** frontmatter 解析失败等被跳过的条目数 */
  failed: number
  /** 上次扫描时间（ISO 时间戳），尚未扫描时为 null */
  scannedAt: string | null
  /** 扫描过程中的告警（最多若干条，供设置页展示） */
  warnings: string[]
}

/** 全局快捷键注册状态（`hotkey:status`，docs/07 §5） */
export interface HotkeyStatus {
  /** 当前配置里的快捷键字符串（如 `Alt+Space`） */
  hotkey: string
  /** 是否已在系统注册成功 */
  registered: boolean
  /** 注册失败原因（被占用 / 非法格式 / 未注册） */
  message?: string
}

/**
 * ClassIsland 桥接状态（`classisland:status`，docs/05 §3.4 v2）。
 * 未启用 classisland provider 时 `enabled` 为 false，其余字段表示「最后一次尝试」。
 */
export interface ClassIslandStatus {
  enabled: boolean
  source: 'http' | 'file'
  endpoint: string
  /** 最近一次读取是否成功 */
  ok: boolean
  /** 最近一次读取成功的时间（ISO 时间戳） */
  lastSyncAt: string | null
  /** 最近一次读取到的今日课程数 */
  lessonCount: number
  /** 桥接数据里的告警（逐行校验失败等） */
  warnings: string[]
  error?: string
}

/** `classisland:test`：立即按当前配置解析一次并回传预览 */
export interface ClassIslandTestResult {
  ok: boolean
  source: 'http' | 'file'
  endpoint: string
  /** 今日课程预览（已按开始时间升序） */
  lessons: Lesson[]
  warnings: string[]
  error?: string
  elapsedMs: number
}

/** 会话摘要（`chat:sessions`，docs/06 §4） */
export interface ChatSessionSummary {
  id: string
  /** 取首条用户消息前若干字符；空会话用「新会话」 */
  title: string
  /** 最后一条消息时间（ISO 时间戳）；空会话取创建/发现时间 */
  updatedAt: string
  messageCount: number
  /** 当前窗口正在使用的会话 */
  active?: boolean
}

// ───────────────────────── 感知（P5 补全） ─────────────────────────

export interface PerceptionSummary {
  /** ISO 时间戳 */
  timestamp: string
  localTime: string
  weekday: string
  battery?: { hasBattery: boolean; percent: number; isCharging: boolean }
  network?: { online: boolean; type: string }
  /** 前台应用与窗口标题（docs/06 §8.1） */
  foreground?: { app: string; title: string }
  /** 主显示器状态（docs/06 §8.1） */
  display?: { width: number; height: number; scaleFactor: number; count: number }
  /** 今天剩余的课程（来自课程表 provider，docs/05 §3.4） */
  lessons?: Lesson[]
  /** 未实现的采集项统一为 unknown，绝不抛错（ADR-007） */
  unknown: string[]
}

// ───────────────────────── 分类管线（docs/05 §3） ─────────────────────────

/** 单个文件的处理阶段；`fallback` = 进「待分类」，`skipped` = 无需处理/文件已消失 */
export type ClassificationState =
  'queued' | 'extracting' | 'classifying' | 'moving' | 'done' | 'fallback' | 'skipped' | 'error'

/** 判定来源：规则命中 / 模型判定 / 兜底 / 用户修正 */
export type ClassificationSource = 'rule' | 'llm' | 'fallback' | 'user'

/** 一条分类流水（持久化为 `userData/classification.json`） */
export interface ClassificationRecord {
  id: string
  /** ISO 时间戳 */
  occurredAt: string
  path: string
  fileName: string
  ext: string
  sizeBytes: number
  /** 判定出的科目名；空串表示未判定 */
  subject: string
  confidence: number
  /** 判定依据（一句话，展示给用户） */
  reason: string
  source: ClassificationSource
  /** 落盘后的绝对路径；缺省表示未移动 */
  movedTo?: string
  /** 用户是否修正过该条 */
  corrected?: boolean
  /**
   * 源文件的修改时间（ISO 时间戳）。
   *
   * 与 `path` / `sizeBytes` 一起构成「这个文件已处理过」的签名：文件**没被移动**时
   * （`autoMove=false` 或移动失败），Aurora 重启后会再次收到同一个文件的 add 事件
   * （`ignoreInitial: false`），靠签名跳过重复的流水与通知（docs/05 §3.2）。
   * 老记录没有该字段，首次重新处理后即会补上。
   */
  modifiedAt?: string
  /** 失败原因（state = error） */
  error?: string
}

/** 分类事件：既用于实时推送，也用于渲染层挂载时水合 */
export interface ClassificationEvent {
  record: ClassificationRecord
  state: ClassificationState
  queueDepth: number
  running: number
}

/** 用户就地修正分类结果（反哺规则缓存，docs/05 §3.2） */
export interface ClassificationCorrection {
  recordId: string
  subject: string
}

// ───────────────────────── 敏感工具确认（docs/06 §5） ─────────────────────────

/**
 * 敏感工具执行前的确认请求。渲染层用 `confirmId` 回执；
 * `expiresAt` 之后主进程按「拒绝」处理，避免会话永久挂起。
 */
export interface SensitiveToolRequest {
  confirmId: string
  toolName: string
  input: unknown
  sessionId: string
  /** ISO 时间戳 */
  expiresAt: string
}

// ───────────────────────── 对话（Agent 内核，docs/06 §4/§5） ─────────────────────────

export interface SendMessageRequest {
  sessionId: string
  text: string
  /** 系统提示词会被注入的来源窗口，用于日志与后续多窗口路由 */
  origin: WindowName
  /**
   * 附件绝对路径列表（拖拽发送，docs/07 §2.3）。
   * 主进程用 `extract.ts` 提取文本后拼进本轮用户消息；提取失败按降级处理，不阻断发送。
   */
  attachments?: string[]
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
 * 事件一律携带 `sessionId`：快速会话与完整会话共用一个交互窗，
 * 只按 `requestId` 过滤会串会话（docs/06 §4）。
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
    /** 打开日志目录（等价 `openPath({ kind: 'logs' })`），与托盘入口行为一致 */
    openLogs(): Promise<Result<string>>
    /** 仅开发态自测可用；其它情况返回 `{ enabled: false }` */
    getSmokeDiagnostics(): Promise<Result<SmokeDiagnostics>>
    /**
     * 仅开发态自测可用：把文件放进当前感知文件夹。
     * 渲染层没有文件系统能力，而"新文件拖入 → 自动分类"必须经真实
     * chokidar add 事件验证，因此留这一个受 `smokeMode` 保护的口子。
     */
    smokeDropFile(request: { fileName: string; content: string }): Promise<Result<string>>
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
    setPosition(name: WindowName, position: { x: number; y: number }): Promise<Result<WindowState>>
    /** 提示条收起态（8px 竖条）/ 展开态（面板）切换（docs/07 §2.2） */
    setEdgeBarExpanded(expanded: boolean): Promise<Result<WindowState>>
    getState(): Promise<Result<WindowState>>
    onStateChanged(listener: (state: WindowState) => void): () => void
  }
  perception: {
    summary(): Promise<Result<PerceptionSummary>>
  }
  skills: {
    list(): Promise<Result<SkillSummary[]>>
    /** 重新扫描内置 + 用户技能目录（设置页「重新扫描」） */
    rescan(): Promise<Result<SkillsStatus>>
    status(): Promise<Result<SkillsStatus>>
  }
  hotkey: {
    /** 当前快捷键注册状态（docs/07 §5） */
    status(): Promise<Result<HotkeyStatus>>
    /** 注册状态变化推送（改绑 / 冲突时） */
    onChanged(listener: (status: HotkeyStatus) => void): () => void
  }
  classisland: {
    /** 桥接状态（最后一次读取结果，docs/05 §3.4 v2） */
    status(): Promise<Result<ClassIslandStatus>>
    /** 立即按当前配置解析一次，回传今日课程预览与错误 */
    test(): Promise<Result<ClassIslandTestResult>>
  }
  chat: {
    send(request: SendMessageRequest): Promise<Result<{ requestId: string }>>
    abort(requestId: string): Promise<Result<boolean>>
    onEvent(listener: (event: AgentEvent) => void): () => void
    /** 会话历史（窗口挂载时水合，docs/06 §4） */
    history(request: ChatHistoryRequest): Promise<Result<ChatMessageDto[]>>
    /** 会话列表（新的在前） */
    sessions(): Promise<Result<ChatSessionSummary[]>>
    /** 新建会话并返回其 id */
    newSession(): Promise<Result<string>>
    /**
     * 拖拽文件的绝对路径（docs/07 §2.3）。
     *
     * **同步方法**，且只能在 preload 里实现：Electron 32+ 已移除 `File.path`，
     * 唯一途径是 `webUtils.getPathForFile`；而 `File` 对象不可结构化克隆，
     * 无法经 IPC 传到主进程再解析。返回空串表示该文件拿不到本地路径（如网页拖拽）。
     */
    filePath(file: File): string
  }
  classification: {
    /** 分类流水（新的在前）；缺省返回全部（主进程上限 500 条） */
    history(limit?: number): Promise<Result<ClassificationRecord[]>>
    /** 当前在途事件（窗口挂载水合，避免只靠推送丢状态） */
    state(): Promise<Result<ClassificationEvent[]>>
    /** 就地修正分类结果；返回更新后的流水 */
    correct(input: ClassificationCorrection): Promise<Result<ClassificationRecord[]>>
    /** 清空分类流水（不删规则） */
    clear(): Promise<Result<boolean>>
    onEvent(listener: (event: ClassificationEvent) => void): () => void
  }
  proactive: {
    /** 敏感工具确认请求（docs/06 §5） */
    onSensitiveTool(listener: (request: SensitiveToolRequest) => void): () => void
    /** 回执：true = 允许执行；超时/未知 id 返回 false */
    resolveSensitiveTool(confirmId: string, approved: boolean): Promise<Result<boolean>>
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
