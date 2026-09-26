/**
 * IPC 契约类型（主进程 / preload / 渲染层三方共用，docs/02 §6）。
 * 渲染层只依赖本文件与 `AuroraApi`，不直接接触 Electron。
 */
import type { Result } from '../utils/result.js'
import type {
  AdvancedSettings,
  GeneralSettings,
  ImageGenSettings,
  Lesson,
  LlmSettings,
  ModeId,
  Settings,
  SttSettings,
  TtsFormat,
  TtsProviderType,
  TtsSettings,
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
  /**
   * `project` = **当前项目根**（v13，docs/06 §5.1）：与 `workspace` 不同，
   * 后者打开的是 `agent.tools.workspaceDir`（工具默认工作目录），项目根另有归属。
   */
  kind: 'logs' | 'config' | 'watchDir' | 'subject' | 'workspace' | 'project'
  /** kind = subject 时使用：科目名 */
  subject?: string
}

/**
 * 「当前项目」的运行时状态（v13，docs/06 §5.1）。
 *
 * 渲染层没有文件系统能力，而"项目根是否存在"必须可见（假设 7：失效要有可见提示，
 * 不能只在日志里 warn），因此由主进程探测后经 IPC 回传，而不是让界面自己猜。
 */
export interface ProjectStatus {
  /** 当前项目 id；空串 = 无项目（此时其余字段均为空 / false） */
  currentId: string
  /** 当前项目展示名；未命名时为空串（界面回落成根目录末段） */
  name: string
  /** 归一后的项目根绝对路径；无项目时为空串 */
  root: string
  /** 项目根是否存在且是目录；false 时界面显示「项目目录不可用」 */
  rootAvailable: boolean
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
 *
 * 两条**删除语义**的例外（record 与数组不同，别混用）：
 * - `llm.providers` 是 record：**缺项 ≠ 删除**，删除必须用 `llm.removedProviders` 显式声明；
 * - `mcp.servers` 是数组：**整数组权威**，不在数组里就是删除，
 *   被删服务器的环境变量密文与内存明文缓存由主进程一并清理。
 */
export interface SettingsPatch {
  general?: Partial<GeneralSettings>
  llm?: Partial<LlmSettings> & {
    /**
     * 显式删除的 provider id 列表（`llm.providers` 是 record，局部合并删不掉条目）。
     *
     * 主进程会一并清掉这些 provider 的 `apiKeyEnc` 与内存里的明文缓存；
     * `llm.active` 指向被删 id 时由 `SettingsStore.sanitize` 重置为空串。
     * 同一个 patch 里既声明删除、又在 `providers` 里给出同一个 id 时，字段以**给出的**为准：
     * 给出的条目带非空密文则保留它，否则（含空串）按**新建**处理，旧密文与缓存照样清理。
     */
    removedProviders?: string[]
  }
  /**
   * 语音合成（TTS，docs/06 §13）。`tts.providers` 同样是 record，
   * 删除语义与 `llm.removedProviders` **完全一致**：缺项 ≠ 删除，删除必须显式声明。
   */
  tts?: Partial<TtsSettings> & {
    removedProviders?: string[]
  }
  /** 语音输入（STT）。`stt.providers` 是 record，删除语义与 `tts.removedProviders` 一致。 */
  stt?: Partial<SttSettings> & {
    removedProviders?: string[]
  }
  /** 图像生成。`imagegen.providers` 是 record，删除语义与 `tts.removedProviders` 一致。 */
  imagegen?: Partial<ImageGenSettings> & {
    removedProviders?: string[]
  }
  advanced?: Partial<AdvancedSettings>
  skills?: Partial<Settings['skills']>
  mcp?: Partial<Settings['mcp']>
  modes?: Partial<Settings['modes']>
  /**
   * 项目机制（v13，docs/06 §5.1）：顶层浅合并，调用方只传改动的键即可
   * （例如只传 `{ current: 'a' }`，`list` 原样保留）。
   */
  projects?: Partial<Settings['projects']>
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

// ───────────────────────── 语音合成（TTS，docs/06 §13） ─────────────────────────

export interface TtsSynthesizeRequest {
  text: string
  /** 缺省用 `tts.active` */
  providerId?: string
}

export interface TtsSynthesizeResult {
  audioBase64: string
  /** 由输出格式推导：mp3→audio/mpeg、opus→audio/ogg、aac→audio/aac、flac→audio/flac、wav→audio/wav、pcm→audio/L16 */
  mimeType: string
  bytes: number
  latencyMs: number
  /** 实际送出的字符数 */
  chars: number
  /** 是否被 `tts.maxChars` 截断 */
  truncated: boolean
}

export interface TtsTestRequest {
  providerId?: string
  baseUrl?: string
  /** 页面草稿里的明文；为空则回落已保存凭据 */
  apiKey?: string
  model?: string
  voice?: string
  speed?: number
  format?: TtsFormat
  /** 页面草稿的接口类型；缺省回落已保存配置，再缺省按 openai-compat（docs/06 §13.6） */
  type?: TtsProviderType
  /** 缺省用内置样例句「你好，我是 Aurora。」 */
  text?: string
}

export interface TtsTestResult {
  ok: boolean
  latencyMs: number
  message: string
  bytes?: number
  httpStatus?: number
}

export interface TtsListModelsRequest {
  /** 缺省用 `tts.active` */
  providerId?: string
  /** 页面草稿里的 baseURL；为空则回落已保存配置 */
  baseUrl?: string
  /** 页面草稿里的明文；为空则回落已保存凭据 */
  apiKey?: string
  /** 页面草稿的接口类型；缺省回落已保存配置，再缺省按 openai-compat（docs/06 §13.6） */
  type?: TtsProviderType
}

export interface TtsListModelsResult {
  ok: boolean
  /** OpenAI 格式 `data[].id`；失败时为空数组 */
  models: string[]
  /** 失败原因（防御性解析 / HTTP 错误），渲染层直接 toast */
  message?: string
}

// ───────────────────────── 语音输入（STT，docs/08 §1） ─────────────────────────

export interface SttTranscribeRequest {
  /** 录音内容的 base64（渲染层 MediaRecorder 产物） */
  audioBase64: string
  /** 录音 MIME 类型（如 `audio/webm;codecs=opus`），主进程据此拼 multipart */
  mime: string
  /** 覆盖 provider 配置的识别语言；缺省用 `stt.providers.<id>.language` */
  language?: string
}

export interface SttTranscribeResult {
  /** 识别出的文本 */
  text: string
}

// ───────────────────────── 图像生成（docs/08 §1） ─────────────────────────

export interface ImageGenGenerateRequest {
  prompt: string
  /** 覆盖 provider 配置的尺寸；缺省用 `imagegen.providers.<id>.size` */
  size?: string
}

export interface ImageGenResult {
  /** 落盘的绝对路径（`userData/generated/<ts>-<rand>.png`） */
  filePath: string
  /** `data:image/png;base64,...`，供渲染层直接预览 */
  dataUrl: string
}

export interface ImageGenReadRequest {
  /** `ImageGenResult.filePath`；仅允许 `userData/generated` 目录内的文件（主进程做路径校验） */
  filePath: string
}

export interface ImageGenReadResult {
  /** `data:image/png;base64,...` */
  dataUrl: string
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
 * 桥接插件写出的**课堂状态快照**（`schedule.json` 内嵌的 `status`，docs/05 §3.4 v3）。
 *
 * 由桥接插件一处计算：`onClass` / `currentSubject` 来自 ClassIsland 的实时课程状态，
 * 其余时间与科目来自同一份课表。所有字段宽容解析，取不到就不出现（不编造）。
 */
export interface ClassIslandBridgeSnapshot {
  /** 状态格式版本（v2 起为 2，v3 起为 3） */
  version: number
  /** 快照生成时间（ISO 时间戳） */
  generatedAt?: string
  /** 是否处于上课状态 */
  onClass: boolean
  /** 当前上课的科目名（经桥接侧 `subjectMap` 映射后；不在上课或未知时缺省） */
  currentSubject?: string
  /** 当前课的起止时间 `HH:mm`（v3 新增；不在上课时缺省） */
  currentStartTime?: string
  currentEndTime?: string
  /** 今天下一节课的科目与起止时间 `HH:mm`（没有则缺省） */
  nextSubject?: string
  nextStartTime?: string
  nextEndTime?: string
}

/**
 * ClassIsland 桥接状态（`classisland:status`，docs/05 §3.4 v2/v3）。
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
  /** 课堂状态快照（桥接 v2+ 提供；缺失 = 桥接未输出该字段） */
  status?: ClassIslandBridgeSnapshot
  /** 提醒通道（v3）：Aurora → ClassIsland 的提醒是否可用，以及最近一次结果 */
  notify?: ClassIslandNotifyState
  error?: string
}

/** 提醒通道状态（`classisland:notify` 的结果会更新这里，供设置页回显） */
export interface ClassIslandNotifyState {
  /** 桥接是否具备接收提醒命令的能力（v3 插件 + 端点/目录可达） */
  available: boolean
  /** 最近一次发送是否成功 */
  ok: boolean
  /** 最近一次发送时间（ISO 时间戳） */
  lastAt: string | null
  error?: string
}

/** `classisland:test`：立即按当前配置解析一次并回传预览 */
export interface ClassIslandTestResult {
  ok: boolean
  source: 'http' | 'file'
  endpoint: string
  /** 今日课程预览（已按开始时间升序） */
  lessons: Lesson[]
  /** 桥接给出的课堂状态快照（v2+；缺失表示桥接未输出） */
  status?: ClassIslandBridgeSnapshot
  warnings: string[]
  error?: string
  elapsedMs: number
}

/** 让 ClassIsland 弹出提醒（`classisland:notify`，docs/05 §3.4 v3） */
export interface ClassIslandNotifyRequest {
  title: string
  body: string
  /**
   * 提醒渠道：`class-started`（上课提醒）/ `pre-class`（课前提醒）/ `custom`（自定义）。
   * 桥接侧按渠道发送，实际是否弹出与是否朗读由 ClassIsland 的提醒设置决定。
   */
  channel?: 'class-started' | 'pre-class' | 'custom'
}

export interface ClassIslandNotifyResult {
  ok: boolean
  /** 失败原因（桥接未安装 / 端点不可达 / 命令文件不可写 / 超时） */
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
  /**
   * 已归档（`sessions/<id>.json` 的 `meta.archived`）。
   *
   * **按 `=== true` 判定**：`false`（显式取消归档过）与 `undefined`（从未归档 / v1 老文件）
   * 都表示「不在归档分组」，语义等价。归档会话**照常出现在列表里**，由渲染层分组，不做过滤。
   */
  archived?: boolean
}

/** 归档 / 取消归档请求（`chat:archiveSession`，docs/06 §4） */
export interface ChatArchiveRequest {
  sessionId: string
  archived: boolean
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
  /** 课堂状态快照（classisland provider 的 v2+ 输出，docs/05 §3.4 v3） */
  classStatus?: ClassIslandBridgeSnapshot
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
  /**
   * `task` 子代理工具的运行快照（docs/06 §19、docs/07 §2.4）。
   * 随工具卡状态一起持久化，因此「子代理」页面在重启后仍能回看历史运行。
   */
  subagent?: SubagentSnapshot
}

// ───────────────────────── Token 用量（上下文详解，docs/07 §2.3） ─────────────────────────

/**
 * 一次 LLM 调用的 token 用量（由 provider 原样透传，不做估算）。
 *
 * 刻意定义在 `shared` 而不是 `@aurora/agent-core`：它要经 `AgentEvent` 走 IPC 到渲染层，
 * 而 IPC 契约不得依赖内核包（docs/02 §6）。内核 `llm/types.ts` 再从本文件重导出，
 * 保持「内核对外的 TokenUsage 只有一份定义」。
 */
export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /**
   * 命中服务端前缀缓存的 prompt token 数；provider 未回传时缺省（docs/06 §21.4）。
   *
   * 与「回传了 0」必须可区分：缺省 = 这个 provider 不报缓存字段，0 = 报了但一个也没命中。
   * 因此解析侧遇到非法值宁可整条省略，也**不要**填 0。
   */
  cachedTokens?: number
}

// ───────────────────────── 子代理（`task` 工具） ─────────────────────────

/**
 * 子代理的一个执行步骤：一段思考 / 文本，或一次工具调用。
 * 只用于展示（子代理的原始消息不落会话存储），字段一律可缺省。
 */
export interface SubagentStep {
  id: string
  kind: 'text' | 'tool'
  /** 工具名（`kind === 'tool'`） */
  name?: string
  /** 文本内容（`kind === 'text'`，随流式增量累积） */
  text?: string
  /** 工具状态（`kind === 'tool'`） */
  state?: 'running' | 'success' | 'error'
  /** 工具结果单行摘要（`kind === 'tool'`） */
  summary?: string
}

/**
 * 子代理运行快照（`task` 工具的实时进度，docs/06 §19）。
 *
 * 子代理的对话过程**不落会话存储**（见 `tools/task.ts`），这份快照是它唯一的对外可见形态：
 * 内存里随事件流实时推给渲染层，结束时随工具卡一起持久化。
 */
export interface SubagentSnapshot {
  /** 子代理内部会话标识（`sub-1` 这类，用于日志对齐） */
  taskId: string
  /** 父对话里发起它的工具调用 id（渲染层据此与工具卡配对） */
  callId: string
  description: string
  prompt: string
  status: 'running' | 'success' | 'error'
  /** 毫秒时间戳 */
  startedAt: number
  endedAt?: number
  /** 已观察到的步骤（按发生顺序；上限见子代理实现） */
  steps: SubagentStep[]
  /** 已执行的工具调用次数 */
  toolCalls: number
  /** 最终报告（完成后才有；与回传给主代理的文本同源、可能截断） */
  report?: string
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
  /** 模型思考过程（reasoning_content 聚合），供「思考过程」折叠块展示 */
  reasoning?: string
}

export interface ChatHistoryRequest {
  sessionId: string
  /** 返回最近 N 条；缺省 100（与 main/ipc.ts 的 handler 对齐） */
  limit?: number
}

/**
 * 事件一律携带 `sessionId`：快速会话与完整会话共用一个交互窗，
 * 只按 `requestId` 过滤会串会话（docs/06 §4）。
 *
 * 顺序与归属（2026-09 增强，docs/06 §16.1）：
 * - `seq`：**会话内单调递增序号**，由主进程在事件发出时分配。渲染层据此排序消息、
 *   丢弃陈旧请求的迟到事件 —— 此前事件没有任何序号，消息顺序完全依赖 IPC 到达顺序。
 * - `round`：该事件属于本次请求的第几个工具调用轮次（从 0 起）。思考链增量自身没有
 *   `messageId`（那轮助手消息要等流结束才落盘），渲染层按 `(requestId, round)` 聚合，
 *   再用同一个 `round` 的文本 / 工具事件把思考绑到正确的消息上 —— 此前思考按 requestId
 *   全局累积，多轮时第二轮的消息会带上第一轮的思考全文。
 *
 * `messageId`（text / tool / subagent）：该轮助手消息在会话存储中的 id。
 * 多轮工具调用会产生多条助手消息，渲染层据此把文本与工具卡片
 * 归到正确的消息上（首轮前渲染层还不知道 id，收到后再认领）。
 */
export type AgentEvent =
  | { type: 'queued'; sessionId: string; requestId: string; seq: number }
  | {
      type: 'text'
      sessionId: string
      requestId: string
      seq: number
      round: number
      messageId: string
      delta: string
    }
  | {
      /**
       * 思考链增量（docs/06 §16.1）。
       *
       * `messageId` 自 2026-09 流式轮起**必带**：该轮助手消息的 id 在流开始前就已预领
       * （见 `text` 的说明），思考因此能在正文之前就挂到那条消息上 ——
       * 早先思考增量不带 id，而助手消息要等本轮文本到达才创建，
       * 于是「模型正在思考」这段**界面上完全看不到**，只有正文开始后思考才一起冒出来。
       */
      type: 'reasoning'
      sessionId: string
      requestId: string
      seq: number
      round: number
      messageId: string
      delta: string
    }
  | {
      type: 'tool'
      sessionId: string
      requestId: string
      seq: number
      round: number
      messageId: string
      call: AgentToolCall
    }
  | {
      /** `task` 子代理的实时进度（docs/06 §19）；`messageId` 为发起它的助手消息 */
      type: 'subagent'
      sessionId: string
      requestId: string
      seq: number
      round: number
      messageId: string
      callId: string
      subagent: SubagentSnapshot
    }
  | {
      /**
       * 一轮 LLM 调用的 token 用量（docs/06 §16.2）。
       *
       * 每个工具轮次各推一条：`promptTokens` 就是**该轮的上下文占用**
       * （历史 + 系统提示词 + 本轮到目前的全部内容），渲染层取最新一条作为
       * 「当前上下文占用」，并逐轮累加得到本会话消耗。provider 未回传 `usage` 时整条不发。
       */
      type: 'usage'
      sessionId: string
      requestId: string
      seq: number
      round: number
      usage: TokenUsage
    }
  | { type: 'done'; sessionId: string; requestId: string; seq: number; pending?: boolean }
  | {
      type: 'error'
      sessionId: string
      requestId: string
      seq: number
      code: string
      message: string
    }
  | {
      /** 用户消息落盘前的实时同步广播；渲染层按内容 + 时间去重 */
      type: 'user-message'
      sessionId: string
      requestId: string
      seq: number
      content: string
      createdAt: number
    }

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
  /** 项目机制（v13，docs/06 §5.1） */
  project: {
    /** 读当前项目状态（含项目根是否可用）；无项目时 `currentId` 为空串 */
    status(): Promise<Result<ProjectStatus>>
    /** 弹系统目录选择框；用户取消时 `value` 为 null（不是错误） */
    pickDirectory(): Promise<Result<string | null>>
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
  tts: {
    /** 合成语音并回传 base64 音频（渲染层不持有明文密钥） */
    synthesize(request: TtsSynthesizeRequest): Promise<Result<TtsSynthesizeResult>>
    /** 连接测试 / 试听（不回传音频，只回结果文字；试听播放走 synthesize） */
    testConnection(request: TtsTestRequest): Promise<Result<TtsTestResult>>
    /** 拉取模型列表（`GET {baseUrl}/models`，供模型名 datalist 候选；不抛，失败折 message） */
    listModels(request: TtsListModelsRequest): Promise<Result<TtsListModelsResult>>
  }
  stt: {
    /** 语音输入：上传录音片段转写为文本（渲染层不持有明文密钥） */
    transcribe(request: SttTranscribeRequest): Promise<Result<SttTranscribeResult>>
  }
  imagegen: {
    /** 生图：调用生图模型并把图片落盘 userData/generated */
    generate(request: ImageGenGenerateRequest): Promise<Result<ImageGenResult>>
    /** 读取 generated 目录内已生成图片的 dataUrl（路径校验在主进程） */
    read(request: ImageGenReadRequest): Promise<Result<ImageGenReadResult>>
  }
  window: {
    show(name: WindowName): Promise<Result<WindowState>>
    hide(name: WindowName): Promise<Result<WindowState>>
    toggle(name: WindowName): Promise<Result<WindowState>>
    showChat(): Promise<Result<WindowState>>
    setPosition(name: WindowName, position: { x: number; y: number }): Promise<Result<WindowState>>
    /** 提示条收起态（8px 竖条）/ 展开态（面板）切换（docs/07 §2.2） */
    setEdgeBarExpanded(expanded: boolean): Promise<Result<WindowState>>
    /** Windows 式标题栏：真最小化进任务栏（chat / 设置；提示条等不可最小化窗口为 no-op） */
    minimize(name: WindowName): Promise<Result<WindowState>>
    /** 切换最大化（标题栏双击 / 后续按钮）；最大化期间几何不写入 `general.windowState` */
    toggleMaximize(name: WindowName): Promise<Result<WindowState>>
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
    /** 桥接状态（最后一次读取结果，docs/05 §3.4 v2/v3） */
    status(): Promise<Result<ClassIslandStatus>>
    /** 立即按当前配置解析一次，回传今日课程预览与错误 */
    test(): Promise<Result<ClassIslandTestResult>>
    /**
     * 让 ClassIsland 弹出提醒（过桥接插件的提醒通道，docs/05 §3.4 v3）。
     * 桥接不可用时返回 `{ ok: false, error }`，不抛错。
     */
    notify(request: ClassIslandNotifyRequest): Promise<Result<ClassIslandNotifyResult>>
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
     * 归档 / 取消归档一个会话（docs/06 §4）。
     *
     * 状态写在会话文件自身的 `meta` 里；**幂等**，且主进程会等到落盘完成才返回，
     * 因此调用后紧跟一次 `sessions()` 一定能读到新状态。
     * 归档不删除任何消息、会话仍可继续对话；返回 `{ ok: false, error }` 不抛错。
     */
    archiveSession(request: ChatArchiveRequest): Promise<Result<{ archived: boolean }>>
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
    /**
     * 回执：`true` = 允许执行；超时/未知 id 返回 false（docs/06 §11.2）。
     * `always === true`（且 `approved === true`）= 本次放行 + **本会话内同名工具不再询问**。
     */
    resolveSensitiveTool(
      confirmId: string,
      approved: boolean,
      always?: boolean,
    ): Promise<Result<boolean>>
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
