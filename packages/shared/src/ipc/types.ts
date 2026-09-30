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
  /**
   * 自动化运行记录快照（最新在前，v0.2.5 / docs/13 §13）：自测据此断言
   * 「触发 → 落历史 → Agent 会话收尾」这条链路真的跑通（而不是只看日志）。
   */
  automationRuns?: AutomationRun[]
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
  /**
   * Aurora Center 连接（v16，docs/12）：顶层浅合并。`tokenEnc` **刻意不出现在补丁类型里**
   * —— 配对令牌是凭据，只走 `setSecrets({ 'center.token': ... })`（docs/12 §7）；
   * 主进程合并时还会运行期剥一次（防构造出的 patch 洗掉已存密文）。
   */
  center?: Omit<Partial<Settings['center']>, 'tokenEnc'>
  /** 自动化总开关（v19，docs/13 §2.2）：定义与历史不进配置，这里只有这一个闸门 */
  automations?: Partial<Settings['automations']>
  /** 外观自定义（v21，docs/08 §1）：顶层浅合并（当前只有强调色主题） */
  appearance?: Partial<Settings['appearance']>
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
  /**
   * 会话绑定的项目 id（docs/06 §5.1 会话级项目，`sessions/<id>.json` 的 `meta.projectId`）。
   * 未绑定的会话**不含这个键**：渲染层据此把下拉框显示成「未指定（跟随全局）」。
   */
  projectId?: string
  /**
   * 会话空间（docs/06 §4 会话三分，2026-09-30，`meta.space`）。
   * 未标记的会话**不含这个键** = Agent 空间（undefined 与 `'agent'` 等价）；
   * 绑定了 `projectId` 的会话以 projectId 为准（项目对话），本字段不参与判定。
   * 渲染层按 `projectId` / `space` 把左栏分成 项目对话 / 工作目录对话 / Agent对话 三区。
   */
  space?: 'agent' | 'work'
  /**
   * 客户端左栏可见性（docs/12 §6.3 远程会话管理，`meta.centerVisible`）。
   * **缺省（不含这个键）= 可见**；false = Center 已把该会话从左栏隐藏（仍可远程输入）。
   */
  centerVisible?: boolean
}

/** 远程会话激活推送（docs/12 §6.3，v0.2.3）：主进程驱动主界面切到指定会话 */
export interface ChatRemoteActivateEvent {
  sessionId: string
}

/**
 * 远程会话可见性变更推送（docs/12 §5 第 8 步，v0.2.4）：Center 的 `session.visibility`
 * 在客户端落盘成功后，主进程经 `chat:centerVisibilityChanged` 通知 chat 渲染层
 * 重拉会话列表（左栏立即按新可见性过滤）。
 */
export interface ChatRemoteVisibilityEvent {
  sessionId: string
}

/** 归档 / 取消归档请求（`chat:archiveSession`，docs/06 §4） */
export interface ChatArchiveRequest {
  sessionId: string
  archived: boolean
}

/**
 * 绑定 / 解绑会话项目（`chat:setSessionProject`，docs/06 §5.1 会话级项目）。
 *
 * `projectId` 是 `projects.list` 里某一项的 id；**空串 = 清除绑定**（回落全局
 * `projects.current`）。状态写在会话文件自身的 `meta` 里（与归档同一条路），
 * **不是配置项**、不进 `CONFIG_VERSION` 迁移链。
 */
export interface ChatSessionProjectRequest {
  sessionId: string
  /** 目标项目 id；空串 = 清除绑定 */
  projectId: string
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

// ───────────────────────── 自动化（docs/13） ─────────────────────────

/** 自动化模式：agent = 触发后跑一次完整 Agent 会话；normal = 顺序执行预设操作组件 */
export type AutomationMode = 'agent' | 'normal'

/** 触发器类型：调度类（daily / interval）+ 课堂条件类（依赖课程表，docs/13 §4.2） */
export type AutomationTriggerKind =
  'daily' | 'interval' | 'pre-class' | 'class-start' | 'pre-end' | 'class-end' | 'next-lesson'

/** 操作组件类型（Normal Mode 的封闭能力集，docs/13 §5） */
export type AutomationActionKind =
  | 'system-notify'
  | 'classisland-remind'
  | 'open-folder'
  | 'open-url'
  | 'open-app'

/** 触发器参数（按 kind 取子集；宽容 JSON 形状，主进程评估时逐字段校验） */
export interface AutomationTrigger {
  kind: AutomationTriggerKind
  params: Record<string, unknown>
}

/** 操作组件调用（Normal Mode 顺序执行） */
export interface AutomationAction {
  kind: AutomationActionKind
  params: Record<string, unknown>
}

/** 一份自动化定义（用户自建；内置自动化是引擎硬编码的只读实例，见 docs/13 §6） */
export interface AutomationDefinition {
  id: string
  name: string
  enabled: boolean
  mode: AutomationMode
  trigger: AutomationTrigger
  /** Agent Mode 的任务指令（mode === 'agent' 时必填） */
  prompt?: string
  /** Normal Mode 的操作组件列表（mode === 'normal' 时非空） */
  actions?: AutomationAction[]
  /**
   * 调用次数上限（0 / 缺省 = 不限）。`runCount` 达到上限时引擎自动停用该自动化（docs/13 §3.1）。
   * 计数是**累计**的：重新启用不清零，要继续用请提高上限或在编辑器里「重置计数」。
   */
  maxRuns?: number
  /** 已调用次数（触发即计一次，含手动触发；内置自动化不计数） */
  runCount?: number
  createdAt: string
  updatedAt: string
}

export type AutomationRunStatus = 'running' | 'success' | 'failed' | 'interrupted'

/** 一次自动化运行（Normal 只记触发时间与状态，不落操作明细；Agent 带 sessionId 供对话回放） */
export interface AutomationRun {
  id: string
  automationId: string
  automationName: string
  mode: AutomationMode
  status: AutomationRunStatus
  /** ISO 时间戳 */
  triggeredAt: string
  finishedAt?: string
  durationMs?: number
  /** Agent Mode：本次会话 id（= runId，`auto-` 前缀），经 `chat:history` 回放对话 */
  sessionId?: string
  error?: string
}

/** 触发器 / 操作组件的表单元数据（主进程 catalog 提供，编辑器与 Center 网页共用） */
export interface AutomationDescriptorField {
  key: string
  label: string
  type: 'text' | 'number' | 'time' | 'weekdays' | 'select'
  min?: number
  max?: number
  step?: number
  options?: Array<{ value: string; label: string }>
  placeholder?: string
  hint?: string
}

/** 条件（触发器）组件描述符 */
export interface AutomationConditionDescriptor {
  kind: AutomationTriggerKind
  label: string
  description: string
  fields: AutomationDescriptorField[]
  /** true = 依赖课程表数据（manual / classisland 皆可；无课表数据时在 UI 标记不可用） */
  requiresSchedule: boolean
}

/** 操作组件描述符 */
export interface AutomationActionDescriptor {
  kind: AutomationActionKind
  label: string
  description: string
  fields: AutomationDescriptorField[]
  /** true = 依赖 ClassIsland 桥接（未配置时 UI 不允许选，docs/13 §5） */
  requiresClassIsland: boolean
  /** 当前环境是否可用（ClassIsland 未配置时 classisland-remind 为 false） */
  available: boolean
}

export interface AutomationCatalog {
  conditions: AutomationConditionDescriptor[]
  actions: AutomationActionDescriptor[]
}

export interface AutomationListResult {
  user: AutomationDefinition[]
  builtin: AutomationDefinition[]
}

export interface AutomationHistoryQuery {
  automationId?: string
  mode?: AutomationMode
  /** 默认 50，上限 200 */
  limit?: number
}

// ───────────────────────── Agent 向用户提问（`ask_user`，docs/06 §21） ─────────────────────────

/**
 * 一次提问的卡片数据（主进程 → 渲染层）。
 *
 * 与 `SensitiveToolRequest` 的三处差别是**产品语义**，不是遗漏：
 * 超时更长（3 分钟）、超时不算失败、用户可以主动跳过。
 */
export interface AskUserRequest {
  requestId: string
  sessionId: string
  question: string
  /** 卡片顶部的短标签（如「目标目录」）；缺省时界面显示「需要你确认」 */
  header?: string
  /** 备选项（0–4 个）：0 个 = 自由回答 */
  options?: { label: string; description?: string }[]
  /** 是否多选（单选时点选项即选中，仍走「提交」这道确认） */
  multiSelect: boolean
  /** 到期时刻（毫秒时间戳）：卡片据此显示倒计时 */
  expiresAt: number
}

/** 渲染层回执：`answers` 为空且未 `skipped` 时主进程按「跳过」处理 */
export interface AskUserAnswerInput {
  requestId: string
  answers: string[]
  skipped?: boolean
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
  /**
   * 系统提示词会被注入的来源窗口，用于日志与后续多窗口路由；
   * 'center' = 远程会话（docs/12）；'automation' = 自动化触发（docs/13 §7，无人值守）。
   */
  origin: WindowName | 'center' | 'automation'
  /**
   * 附件绝对路径列表（拖拽发送，docs/07 §2.3）。
   * 主进程用 `extract.ts` 提取文本后拼进本轮用户消息；提取失败按降级处理，不阻断发送。
   */
  attachments?: string[]
  /**
   * 续跑哪条 job（v15，docs/06 §4.1）：只接受 `status === 'paused'` 的 job；
   * 其余状态主进程回 `E_JOB_STATE`。给了它时**不会重复落盘**那条用户消息。
   */
  resumeJobId?: string
}

export interface AgentToolCall {
  id: string
  name: string
  input?: unknown
  state: 'running' | 'success' | 'error'
  outputSummary?: string
  /**
   * `task` 子代理工具的运行快照（docs/06 §19、docs/07 §2.3）。
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
 *
 * 这是**紧凑轨迹**（工具卡内的一段、进度条的数据源）：文本段按流式增量合并，
 * 工具段只留名字 / 状态 / 结果摘要。要看完整对话用 `SubagentSnapshot.messages`。
 */
export interface SubagentStep {
  id: string
  kind: 'text' | 'tool'
  /** 工具名（`kind === 'tool'`） */
  name?: string
  /** 文本内容（`kind === 'text'`，连续的流式增量合并成一段） */
  text?: string
  /** 工具状态（`kind === 'tool'`） */
  state?: 'running' | 'success' | 'error'
  /** 工具结果单行摘要（`kind === 'tool'`） */
  summary?: string
  /** 工具入参（`kind === 'tool'`，紧凑 JSON、已截断）—— 一眼看出"它拿什么参数做了什么" */
  args?: string
}

/**
 * 子代理独立对话视图里的一次工具调用（docs/06 §19）。
 * 与 `SubagentStep` 的工具段同源，但**带上了结果正文**，供「子代理」页面的对话视图展开看。
 */
export interface SubagentTranscriptToolCall {
  id: string
  name: string
  /** 入参（紧凑 JSON、已截断） */
  args?: string
  state: 'running' | 'success' | 'error'
  /** 结果摘要（一行） */
  summary?: string
  /** 结果正文（已截断）：子代理拿到的工具输出，主对话里看不到 */
  output?: string
}

/**
 * 子代理对话里的一条消息（docs/06 §19 / docs/07 §2.3）。
 *
 * 子代理的过程不落会话存储，这份投影是「独立对话界面」的数据源：
 * user = 主代理给的任务指令；assistant = 子代理的正文与它发起的工具调用；
 * 工具结果**就地挂在对应调用的 `output` 上**，不单独成条（与主对话的工具卡同款信息组织）。
 */
export interface SubagentTranscriptMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  text?: string
  toolCalls?: SubagentTranscriptToolCall[]
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
  /**
   * 本次派生授予子代理的权限档（2026-09 新增，`task` 工具的 `permission` 参数）。
   * **可缺省**：老快照（该字段出现前持久化的）读出来是 undefined，一律按 `'read'` 显示。
   */
  permission?: 'read' | 'write'
  /** 子代理实际拿到的工具名（过滤后的结果，供界面与排查对齐） */
  tools?: string[]
  /**
   * 完整对话（独立对话界面的数据源）：条数 / 每条长度都有上限，超出从**中间**截断
   * （保留开头与最近的消息，见 `tools/task.ts` 的口径）。
   */
  messages?: SubagentTranscriptMessage[]
  /** 对话记录超上限、中间已省略（界面据此如实标出，不假装完整） */
  transcriptTruncated?: boolean
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
 * 一条写前快照的引用（docs/06 §11.8，v14）—— 跨 IPC 序列化，所以**不含 Buffer**。
 *
 * 定义放在 shared 而不是 agent-core：渲染层要拿它渲染「文件备份」卡（`@aurora/shared/browser`
 * 会一并导出），内核的 `SnapshotPort` 直接复用这个类型（`agent-core` 依赖 `@aurora/shared`，
 * 反向不行）。
 */
export interface SnapshotRef {
  /** `<ISO 时间戳>-<8 位内容哈希>`；同一文件下字典序 = 时间序 */
  id: string
  sessionId: string
  /** 被快照的**绝对路径** */
  path: string
  /** 触发它的工具调用 id */
  toolCallId?: string
  /** `rollback` = 回滚**之前**留下的那一份（所以回滚也能被再次回滚） */
  origin: 'write_file' | 'edit_file' | 'rollback'
  createdAt: string
  /** 内容文件名（相对快照目录；`exists: false` 时为空串） */
  contentPath: string
  bytes: number
  sha256?: string
  /** false = 记的是"当时文件还不存在"；回滚它等于删除该文件 */
  exists: boolean
  truncated?: boolean
  /** 写文件时的模式（`append` 的快照是**追加前**的全文） */
  mode?: 'overwrite' | 'append'
}

export interface SnapshotListRequest {
  /** 缺省 = 所有会话（按 createdAt 倒序，取 limit 条） */
  sessionId?: string
  /** 只看某个文件的快照（绝对路径） */
  path?: string
  /** 缺省 50 */
  limit?: number
}

export interface SnapshotRestoreRequest {
  snapshotId: string
}

/** Job 状态（docs/06 §4.1，v15）：一次 Agent 请求就是一条 job。 */
export type AgentJobStatus = 'queued' | 'running' | 'paused' | 'done' | 'error' | 'aborted'
/** 为什么停在 `paused`：轮次用尽 / 预算用尽 / 被用户取消 */
export type JobPendingReason = 'max-rounds' | 'budget' | 'aborted'
/** job 已完成的一步（工具调用）—— 界面画时间线用 */
export interface JobStep {
  round: number
  tool: string
  ok: boolean
  at: string
}
/**
 * 一条 Agent job（可查询、可续跑，docs/06 §4.1）。
 *
 * 定义在 shared（渲染层要经 IPC 读它、`AgentEvent` 也带它），内核的 `jobs/types.ts` 只再导出
 * —— 与 `SnapshotRef` 同款口径：跨进程的形状只能有一份定义。
 */
export interface AgentJob {
  id: string
  sessionId: string
  requestId?: string
  status: AgentJobStatus
  /** `center` = 由 Aurora Center 远程会话发起（docs/12 §5）；`automation` = 自动化触发（docs/13） */
  origin: 'chat' | 'edge-bar' | 'resume' | 'center' | 'automation'
  /** 本 job 的用户消息原文（续跑不再重复落盘，靠它还原上下文） */
  text: string
  /** 已经跑到第几轮（从 0 起） */
  round: number
  maxRounds: number
  stepsDone: JobStep[]
  todos: Array<{ id: string; text: string; status: 'pending' | 'in_progress' | 'completed' }>
  /** 游标：下一轮从哪里开始（续跑的起点） */
  cursor: { nextRound: number; note?: string }
  budget: {
    maxTotalTokens: number
    usedTokens: number
    /** 已自动续轮的次数 —— **必须持久化**，否则重启后会重新拿到一份额度 */
    autoContinued: number
  }
  pendingReason?: JobPendingReason
  createdAt: string
  updatedAt: string
  error?: string
}

/** 推给渲染层的轻量形状（不含 todos / stepsDone 全量，避免事件里带一整份账本） */
export interface JobSummary {
  id: string
  sessionId: string
  status: AgentJobStatus
  round: number
  maxRounds: number
  usedTokens: number
  maxTotalTokens: number
  autoContinued: number
  pendingReason?: JobPendingReason
  stepCount: number
  lastStep?: string
  updatedAt: string
  error?: string
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
  | {
      type: 'done'
      sessionId: string
      requestId: string
      seq: number
      pending?: boolean
      /** 为什么没收敛就结束了（v15）：轮次用尽 / 预算用尽 / 被取消 */
      pendingReason?: JobPendingReason
      round?: number
      usedTokens?: number
    }
  | {
      /**
       * job 生命周期事件（v15，docs/06 §4.1）：创建 / 每轮游标更新 / 落终态时各推一条。
       * **不走 text 合并通路** —— 暂停事件被 16ms 合并吞掉的话，用户就看不到"任务停了"。
       */
      type: 'job'
      sessionId: string
      requestId: string
      seq: number
      job: JobSummary
    }
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

/** Aurora Center 连接状态（渲染层展示口径，docs/12 §7） */
export interface CenterConnectionStatus {
  enabled: boolean
  connected: boolean
  serverUrl: string
  displayName: string
  state: 'disabled' | 'connecting' | 'connected' | 'error'
  lastError?: string
}

/**
 * Aurora Center 账号登录（v0.2.1，docs/12 §3/§7）：渲染层 → 主进程的登录请求。
 * `password` 只在本次请求里使用 —— 主进程拿它换客户端令牌（写入凭据链路），
 * **不落配置、不进日志**；页面也不回显。
 */
export interface CenterLoginRequest {
  serverUrl: string
  username: string
  password: string
}

/** 账号登录结果：`account` 是记住的账号名；`tokenPersisted` = 令牌是否已持久化（安全存储可用）。 */
export interface CenterLoginResult {
  account: string
  tokenPersisted: boolean
}

/**
 * 设备授权登录请求（docs/12 §4.3）：渲染层只提供服务器地址；主进程负责
 * clientId（持久化的优先，缺失时自动生成并持久化）。`clientId` 仅作展示值回传，
 * 主进程不以此为准。
 */
export interface CenterDeviceLoginRequest {
  serverUrl: string
  clientId?: string
}

/** 设备授权登录的触发回执：`started` = 已打开确认页并开始后台轮询 */
export interface CenterDeviceLoginStarted {
  started: true
  /** 打开给用户确认的网页地址 */
  verifyUrl: string
}

/** 设备授权登录最终结果（`center:deviceLoginResult` 推送，docs/12 §4.3） */
export type CenterDeviceLoginResult =
  | { status: 'approved' }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'error'; message: string }

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
  /** 写前快照与一键回滚（v14，docs/06 §11.8） */
  snapshots: {
    /** 列出快照（新的在前）；缺省按 50 条上限 */
    list(request?: SnapshotListRequest): Promise<Result<SnapshotRef[]>>
    /**
     * 回滚到某份快照：**先给"回滚前状态"再打一份 `origin:'rollback'` 快照**，
     * 然后把旧内容写回（`exists:false` 的回滚 = 删除该文件）。返回值是那份新快照。
     */
    restore(request: SnapshotRestoreRequest): Promise<Result<SnapshotRef>>
    /** 手动清理某个会话的快照，返回删掉的条数 */
    prune(request: { sessionId: string }): Promise<Result<number>>
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
    /**
     * 远程会话激活推送（docs/12 §6.3，on/off 成对）：Center 的 `session.activate` 命令
     * 命中客户端时，主进程经此通道让主界面切到指定会话（payload 只含 sessionId）。
     */
    onRemoteActivate(listener: (event: ChatRemoteActivateEvent) => void): () => void
    /**
     * 远程会话可见性变更推送（docs/12 §5 第 8 步，v0.2.4，on/off 成对）：
     * Center 网页端开关某会话的左栏可见性且客户端落盘成功后触发，
     * 渲染层收到后重拉会话列表即可（payload 只含 sessionId）。
     */
    onCenterVisibilityChanged(listener: (event: ChatRemoteVisibilityEvent) => void): () => void
    /**
     * 新建会话并返回其 id。
     *
     * `options.space`（docs/06 §4 会话三分，2026-09-30）：给新会话打空间戳 ——
     * `'agent'`（缺省）= Agent对话、`'work'` = 工作目录对话；`options.projectId`
     * 传入则**绑定到该项目**（校验存在性，同 `setSessionProject`；绑定优先于 space）。
     * 空会话不落盘：space 只写内存，首条消息落盘时 meta 随消息一起写入。
     */
    newSession(options?: { space?: 'agent' | 'work'; projectId?: string }): Promise<Result<string>>
    /**
     * 真删除会话（docs/08 会话管理页）：删 `sessions/<id>.json` + 清全部内存态，**不可逆**。
     * 渲染层负责二次确认（两步按钮，不用浏览器 confirm）；主进程守卫 running 的 job
     * （E_INVALID_STATE：状态冲突，不是参数错误）。
     * 幂等：删除不存在的会话文件返回 ok。
     */
    deleteSession(sessionId: string): Promise<Result<boolean>>
    /**
     * 归档 / 取消归档一个会话（docs/06 §4）。
     *
     * 状态写在会话文件自身的 `meta` 里；**幂等**，且主进程会等到落盘完成才返回，
     * 因此调用后紧跟一次 `sessions()` 一定能读到新状态。
     * 归档不删除任何消息、会话仍可继续对话；返回 `{ ok: false, error }` 不抛错。
     */
    archiveSession(request: ChatArchiveRequest): Promise<Result<{ archived: boolean }>>
    /**
     * 绑定 / 解绑一个会话的项目（docs/06 §5.1 会话级项目）。
     *
     * 状态写在会话文件自身的 `meta.projectId` 里；**幂等**，且主进程会等到落盘完成才返回，
     * 因此调用后紧跟一次 `sessions()` 一定能读到新绑定。`projectId` 空串 = 清除绑定；
     * 绑定到不存在的项目返回 `{ ok: false }`（静默成功会让用户以为绑定生效了）。
     */
    setSessionProject(request: ChatSessionProjectRequest): Promise<Result<{ projectId: string }>>
    /**
     * Job（任务）列表（v15，docs/06 §4.1）。
     *
     * 缺省按 `updatedAt` 倒序；给了 `sessionId` 就只看该会话。界面的「任务」面板靠它水合 ——
     * 重启后 `paused` 的 job 依然列在这里，用户点「继续」即可跑完。
     */
    jobs(request?: {
      sessionId?: string
      status?: AgentJobStatus
      limit?: number
    }): Promise<Result<AgentJob[]>>
    /** 续跑一条 `paused` 的 job（等价于带着 `resumeJobId` 再发一次）；返回新的 requestId */
    resumeJob(request: { sessionId: string; jobId: string }): Promise<Result<{ requestId: string }>>
    /** 取消一条未结束的 job（落 `aborted`；与「停止」按钮同一语义） */
    cancelJob(request: { sessionId: string; jobId: string }): Promise<Result<boolean>>
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
  /**
   * `ask_user` 的问答通道（docs/06 §21）：请求推送 + 回答回执。
   *
   * 与 `proactive`（敏感动作确认）**刻意分开**：那是安全闸门（超时按拒绝、有本会话 always 记忆），
   * 这是协作问答（超时不算拒绝、可以跳过）。混用会让"超时"这一件事有两套语义。
   */
  askUser: {
    /** 有提问时推送卡片（同一时刻最多一张 —— 主循环同轮工具顺序执行，不会并发提问） */
    onRequest(listener: (request: AskUserRequest) => void): () => void
    /** 回执：已结算 / 未知 requestId 返回 false（幂等，与确认回执同款） */
    answer(input: AskUserAnswerInput): Promise<Result<boolean>>
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
  /** Aurora Center 连接（docs/12）：设置页展示连接机与诊断信息 + 账号 / 设备授权登录 */
  center: {
    status(): Promise<Result<CenterConnectionStatus>>
    login(request: CenterLoginRequest): Promise<Result<CenterLoginResult>>
    /**
     * 设备授权登录（docs/12 §4.3）：主进程打开确认页并按建议间隔后台轮询，
     * **立即**回执（不等用户确认）；最终结果经 onDeviceLoginResult 推送。
     * 重复调用会取消上一次的轮询。
     */
    deviceLogin(request: CenterDeviceLoginRequest): Promise<Result<CenterDeviceLoginStarted>>
    /** 设备授权登录的最终结果推送（on/off 成对） */
    onDeviceLoginResult(listener: (result: CenterDeviceLoginResult) => void): () => void
    /** 取消在途的设备授权轮询（设置页关闭时调用；幂等，没有在途轮询时是 no-op） */
    deviceLoginCancel(): Promise<Result<boolean>>
  }
  /** 自动化（docs/13 §9）：定义 CRUD + 历史 + 手动触发 + 组件目录 */
  automation: {
    /** 拉定义（user = 自建；builtin = 内置，只读启停走 settings:update） */
    list(): Promise<Result<AutomationListResult>>
    /**
     * 新建（id 为空）/ 修改一份自动化。主进程做 catalog 之外组件与参数的合法化校验，
     * 非法组件回 `E_INVALID_ARGUMENT`（UI 由 catalog 驱动，正常路径到不了）。
     */
    save(definition: AutomationDefinition): Promise<Result<AutomationDefinition>>
    /** 删除一份自建自动化（内置不可删，回 `E_INVALID_STATE`） */
    delete(request: { id: string }): Promise<Result<boolean>>
    /** 运行历史（triggeredAt 倒序；limit 默认 50、上限 200） */
    history(request?: AutomationHistoryQuery): Promise<Result<AutomationRun[]>>
    /** 手动触发一次（Agent / Normal 皆可）；返回 runId（Agent 模式下即会话 id） */
    run(request: { id: string }): Promise<Result<{ runId: string }>>
    /** 组件目录（触发器 + 操作的表单元数据，available 现取） */
    catalog(): Promise<Result<AutomationCatalog>>
    /** 定义变化推送（on/off 成对） */
    onChanged(listener: () => void): () => void
    /** 运行记录落库 / 状态变化推送（on/off 成对） */
    onHistoryChanged(listener: () => void): () => void
  }
}
