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
  LlmProviderType,
  LlmSettings,
  ModeId,
  ReminderChannel,
  Settings,
  SttSettings,
  TtsFormat,
  TtsProviderType,
  TtsSettings,
  WindowName,
} from '../config/schema.js'
import type { CenterOfficialModelCatalog } from '../center/protocol.js'
import type { PluginPermission } from '../plugin/permissions.js'
import type {
  PluginConfigField,
  PluginWidgetWindowLevel,
  PluginWidgetWindowMaterial,
} from '../plugin/manifest.js'
import type { PluginPanelSchema } from '../plugin/ui.js'

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
   * `workspace` = 生效工作目录（docs/06 §5.1 回落链）。`project`（v13 的「当前项目根」）
   * 已于 v25 随全局 `projects.current` 一并退役 —— 项目改为按会话绑定，没有全局「当前项目」。
   */
  kind: 'logs' | 'config' | 'watchDir' | 'subject' | 'workspace'
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
  /** 每个已登记项目的根可用性（渲染层没有文件系统能力，只能问主进程） */
  items: ProjectRuntimeStatus[]
}

/** 单个项目的根探测结果；不可用时界面在对应行显示「项目目录不可用」 */
export interface ProjectRuntimeStatus {
  id: string
  name: string
  /** 归一后的项目根绝对路径 */
  root: string
  /** 项目根是否存在且是目录；false 时界面显示「项目目录不可用」 */
  rootAvailable: boolean
}

/**
 * 桌面小组件窗口诊断（仅 `AURORA_SMOKE=1`，docs/14 §5.3）。
 *
 * 层级 / 材质都是原生窗口状态，渲染层无法观察；自测据此断言声明值真的落到了
 * `BrowserWindow` 上（尤其是 `alwaysOnTop` 与 `desktop` 的 owner 亲和）。
 */
export interface WidgetWindowDiagnostics {
  pluginId: string
  widgetId: string
  /** 清单声明值 */
  windowLevel: PluginWidgetWindowLevel
  /** 用户覆盖优先后的实际层级 */
  effectiveWindowLevel: PluginWidgetWindowLevel
  alwaysOnTop: boolean
  /** desktop 层是否成功挂到桌面 shell owner（Win32 最佳努力） */
  desktopOwner: boolean
  /** minimize 恢复守护是否已连续失败（true = 已按 normal 回落） */
  desktopGuardFailed: boolean
  windowMaterial: PluginWidgetWindowMaterial
  /** 原生 Acrylic 是否真的挂上（false 时渲染层保持不透明） */
  materialActive: boolean
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
  /** 桌面小组件窗口原生状态（层级 / 材质，v37 起） */
  widgetWindows?: WidgetWindowDiagnostics[]
  /** 流光提醒的运行态（服务队列 + 两个原生窗口，2026-10-24） */
  banner?: BannerDiagnostics
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
   * （例如只传 `{ maxAgentsBytes: 4096 }`，`list` 原样保留）。
   * 全局 `projects.current` 已于 v25 从 Schema 删除，补丁里不再出现该键。
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
  /** 文件自感知（v28，docs/06 §26）：顶层浅合并，调用方需回传完整分组。 */
  fileAwareness?: Partial<Settings['fileAwareness']>
  /**
   * 插件（v36，docs/14 §5）：总开关 / 开发目录 / 当前主题。**已安装插件不在这里**
   * （安装态走 `plugins:*` 通道），因此这里的 patch 只影响"启用哪些插件与主题"。
   */
  plugins?: Partial<Settings['plugins']>
  /**
   * 外观自定义（v21 强调色；v32 起扩为明暗档位 / 强调色 / 毛玻璃，docs/08 §1）：
   * 顶层浅合并，只传改动的键即可（`Object.assign(draft.appearance, patch.appearance)`）。
   */
  appearance?: Partial<Settings['appearance']>
  /**
   * 默认提醒方式（v37，docs/07 §4）：顶层浅合并，只传 `{ channel }` 即可。
   */
  notifications?: Partial<Settings['notifications']>
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
  /**
   * 接口协议（v22 多模态轮）：设置页把**正在编辑**的类型一起送过来，
   * 用户才能在选择 `openai-responses` 之后、保存之前就点「保存并测试连接」——
   * 不传时按已保存配置的 `type`，再缺省为 `openai-compat`（与 Schema 默认值一致）。
   */
  type?: LlmProviderType
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
  /**
   * 录音 MIME 类型（如 `audio/webm;codecs=opus`）。主进程两套协议都用它：
   * OpenAI 兼容侧拼 multipart（据此选扩展名），阿里云原生侧拼 `data:<type/subtype>;base64,…`。
   */
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

// ───────────────────────── 文件预览（右栏「文件」tab，2026-10-03） ─────────────────────────

export interface FilePreviewRequest {
  /** 预览按**发起会话**解析边界根（会话绑定项目 > 会话空间目录 > …，docs/06 §5.1） */
  sessionId: string
  /** 绝对路径；越界（边界根之外）主进程拒绝 */
  path: string
}

export interface FilePreviewResult {
  /** 归一后的绝对路径（主进程回填，渲染层据此存「最近预览」） */
  path: string
  /** 内容形态：markdown 走渲染器、text 纯文本、image 走 dataUrl，其余一律 unsupported */
  kind: 'markdown' | 'text' | 'image' | 'unsupported'
  /** `kind = 'markdown' | 'text'` 时的文本内容（超限截断，`truncated` 标记） */
  content?: string
  /** `kind = 'image'` 时的 data URL（`data:image/<ext>;base64,…`） */
  dataUrl?: string
  bytes: number
  /** 文本超出预览上限被截断 */
  truncated?: boolean
  /** kind = unsupported 时的原因说明 */
  note?: string
}

export interface FileListRequest {
  /** 与 `FilePreviewRequest` 同一条边界链（按**发起会话**解析边界根，docs/06 §5.1） */
  sessionId: string
  /** 要列出的目录绝对路径；空 / 缺省 = 列出会话边界根本身 */
  path?: string
}

export interface FileListEntry {
  name: string
  /** 绝对路径（点开即用，渲染层不需要自己拼） */
  path: string
  kind: 'dir' | 'file'
  /** 文件字节数；目录为 0 */
  bytes: number
}

export interface FileListResult {
  /** 会话边界根（项目文件夹 / 会话空间目录）：「向上」止于此，渲染层不允许再往上走 */
  root: string
  /** 本次列出的目录（绝对路径） */
  dir: string
  /** 目录在前、同类按名称（数字感知）升序 */
  entries: FileListEntry[]
  /** 条目数超过上限被截断（只列前 N 条） */
  truncated?: boolean
}

/**
 * `preview:show` 推送（`show_preview` 工具，2026-10-03，主进程 → 渲染层）。
 *
 * 渲染层只认**当前会话**的展示请求（`sessionId` 对不上就丢弃）—— 避免后台会话
 * （自动化 / 远程）把用户正在看的右栏顶掉。
 */
export interface PreviewShowEvent {
  /** 发起展示的会话（工具执行时的 `ctx.sessionId`） */
  sessionId: string
  /** 可直接加载进 webview 的地址（http/https 或 `file://` 本地文件） */
  url: string
  /** 地址栏展示串：URL 原样；本地文件显示原始路径 */
  display: string
  /** 来源标题（工具入参 `title`，缺省为空串） */
  title: string
}

/**
 * `browser:openTab` 推送（站点自开标签，2026-10-03，主进程 → 渲染层）。
 *
 * 网页里 `target="_blank"` / `window.open` 的 http(s) 目标：渲染层收到后**另开一个
 * 浏览器标签**并让它加载 `url`（当前页不动）。`url` 已由主进程按白名单过滤过
 *（只放行 http(s)，见 window-manager 的 `setWindowOpenHandler`）。
 */
export interface BrowserOpenTabEvent {
  /** 站点请求打开的地址（http/https） */
  url: string
}

// ─────────────────── Agent 内置浏览器控制（v35，docs/06 §27） ───────────────────

/**
 * `browser:agentOpen` 推送（主进程 → 渲染层，on/off 成对）。
 *
 * Agent 要操作网页时先让渲染层**新建一个 Agent 专属浏览器标签**：渲染层建好 webview、
 * 拿到 `getWebContentsId()` 后经 `browser:agentReport` 回执，主进程才真正接管驱动。
 * 与 `preview:show` 的区别：这条是**控制**通道（需要回执），展示仍走同一个
 * `panelTarget` → BrowserPanel 管线，不另造第二条"右栏打开 URL"通道。
 */
export interface BrowserAgentOpenEvent {
  /** 一次打开请求的幂等 id：回执据此配对（超时即失效） */
  requestId: string
  /** 发起工具的会话（`ctx.sessionId`，子代理各自独立） */
  sessionId: string
  /** 初始地址（http/https；本地夹具只在开发自测里经主进程直调） */
  url: string
  /** 标签初始标题（缺省空串，页面加载后由 page-title-updated 覆盖） */
  title: string
}

/**
 * `browser:agentStatus` 推送（主进程 → 渲染层，on/off 成对）。
 *
 * 只用于**可见性**：徽章文案、`focus`（截图前把标签切到前台）、以及 `released`
 * （会话结束：清映射、恢复正常标签行为）。
 */
export interface BrowserAgentStatusEvent {
  sessionId: string
  /** 对应的右栏标签 id（会话还没 attach 时缺省） */
  tabId?: string
  state: 'opening' | 'ready' | 'busy' | 'released'
  /** 徽章副文案（如「点击 e3」「空闲 10 分钟已释放」） */
  detail: string
  /** true = 渲染层应激活该标签（Agent 正在操作 / 即将截图） */
  focus?: boolean
}

/**
 * `browser:agentReport` 回执（渲染层 → 主进程 invoke）。
 *
 * 成功路径只带 `webContentsId`；失败路径（标签达 12 上限 / 窗口没建好）带 `error`，
 * 主进程把错误原样折成工具失败 —— 不允许静默丢弃（否则 Agent 会一直等到超时）。
 */
export interface BrowserAgentReportRequest {
  requestId: string
  sessionId: string
  tabId?: string
  webContentsId?: number
  error?: string
}

/** `browser:agentStop`（渲染层 → 主进程 invoke）：用户点「停止」或关闭标签时结束控制 */
export interface BrowserAgentStopRequest {
  sessionId: string
}

// ───────────────────────── PTY 终端（右栏「终端」标签，2026-10-03） ─────────────────────────

export interface TerminalCreateRequest {
  /** cwd 按**发起会话**的工作目录回落链解析（docs/06 §5.1） */
  sessionId: string
}

export interface TerminalCreateResult {
  /** 终端 id（每次 create 都是**新的** shell —— 一个标签一条 PTY，2026-10-03 二次修订） */
  terminalId: string
  /** 创建时解析出的工作目录（渲染层拿它做标签标题：取末段，如 `Aurora`） */
  cwd: string
}

export interface TerminalInputRequest {
  terminalId: string
  /** 键盘输入（含控制序列，原样透传给 PTY） */
  data: string
}

export interface TerminalResizeRequest {
  terminalId: string
  cols: number
  rows: number
}

/** `terminal:data` / `terminal:exit` 推送（只发给创建终端的窗口） */
export interface TerminalDataEvent {
  terminalId: string
  data: string
}

export interface TerminalExitEvent {
  terminalId: string
  exitCode: number
}

// ───────────────────────── 窗口 ─────────────────────────

export interface WindowState {
  visible: Partial<Record<WindowName, boolean>>
  /** 当前主对话窗口；交互窗是唯一候选（独立小窗已删除，docs/07 §3） */
  primary: 'chat' | null
  /**
   * 各窗口当前是否处于最大化（自绘 caption 的「最大化 / 还原」按钮据此切换图标）。
   * 由 WindowManager 在 getState 时**现算**（不进状态机），未创建 / 已销毁的窗口不出现。
   */
  maximized?: Partial<Record<WindowName, boolean>>
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
  source: 'builtin' | 'user' | 'plugin'
  hasScripts: boolean
  enabled: boolean
  dir: string
  /** source = 'plugin' 时：提供该 Skill 的插件 id（设置页归组展示） */
  pluginId?: string
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
  /**
   * 会话标题：优先取主进程异步生成的 `meta.title`；
   * 生成前 / 失败时回退首条用户消息前 24 字，空会话用「新会话」。
   */
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
  /**
   * 会话级模型覆盖（docs/06 §3，本轮，`meta.llm`）。
   * **缺省（不含这个键）= 跟随全局** `llm.active` 的 provider 与其 `model`；
   * 含这个键 = 该会话用这一对 `(providerId, model)`。渲染层据此在下拉里显示本会话的模型、
   * 会话行显示覆盖徽标（见 docs/07 §2.3）。
   */
  llm?: { providerId: string; model: string }
  /**
   * 会话级用量累计（docs/06 §4，`meta.usage`；本轮新增）。
   * **缺省（不含这个键）= 该会话从未回传过 usage**。渲染层切回会话时以它为种子恢复
   * 用量累计与平均缓存命中率（跨切换、跨重启连续）。
   */
  usage?: SessionUsageStats
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

/**
 * 会话删除推送（`chat:sessionDeleted`，docs/07 §2.3）：
 * 主进程在 `chat:deleteSession` 删除成功后广播被删会话 id，chat 窗口据此重拉
 * 会话列表；被删会话正是当前会话时按「最近会话 / 新建」回落。
 */
export interface ChatSessionDeletedEvent {
  sessionId: string
}

/**
 * 会话标题变更推送（`chat:sessionTitleChanged`，docs/06 §4）：
 * 主进程异步生成标题并落盘成功后广播，chat 渲染层原位更新列表，不重新水合消息。
 */
export interface ChatSessionTitleChangedEvent {
  sessionId: string
  title: string
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

/**
 * 会话级模型覆盖（`chat:setSessionModel`，docs/06 §3，本轮）。
 *
 * 写的是会话文件自身的 `meta.llm = { providerId, model }`（与 `setSessionProject` 同一条路），
 * **不是配置项**、不进 `CONFIG_VERSION` 迁移链。`model` 空串（或 providerId 空串）= **清除覆盖**，
 * 回落全局 `llm.active` 的 provider 与其 `model`。
 * 思考等级不在这里 —— 它是模型级参数（`modelParams[<model>]`），随所选模型取。
 */
export interface ChatSessionModelRequest {
  sessionId: string
  /** 目标 provider id；空串与 `model` 空串同为「清除覆盖」 */
  providerId: string
  /** 目标模型 id；空串 = 清除覆盖 */
  model: string
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

/** 触发器类型：调度类（daily / interval）+ 课堂条件类（依赖课程表）+ 插件事件（v36） */
export type AutomationTriggerKind =
  | 'daily'
  | 'interval'
  | 'pre-class'
  | 'class-start'
  | 'pre-end'
  | 'class-end'
  | 'next-lesson'
  | 'plugin-event'

/** 操作组件类型（Normal Mode 的封闭能力集 + 插件动作，docs/13 §5 / docs/14 §3.5） */
export type AutomationActionKind =
  'system-notify' | 'classisland-remind' | 'open-folder' | 'open-url' | 'open-app' | 'plugin-action'

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

/** 自动化详情窗口承载的视图（docs/07 §2.2.1） */
export type AutomationWindowView = 'history' | 'editor'

/** 打开 / 切换自动化详情窗口的请求参数 */
export interface AutomationOpenWindowRequest {
  view: AutomationWindowView
  mode: AutomationMode
  /** 编辑器按 id 加载既有定义；新建 / 历史时省略 */
  automationId?: string
}

/** 主进程在校验并落地打开请求后，向自动化详情窗口推送的最终参数 */
export interface AutomationWindowRequest extends AutomationOpenWindowRequest {
  /** 每次打开 / 切换递增，用于渲染层去重与重置视图 */
  requestId: string
}

/** Normal Mode 单个操作组件的执行结果（列表折叠成一行，展开逐步看） */
export interface AutomationRunStep {
  kind: AutomationActionKind
  /** 组件中文名（落库时按 catalog 取好，历史视图不必再拉 catalog） */
  label: string
  ok: boolean
  /** 成功时的一句话摘要（可能含本机路径 / 网址） */
  summary?: string
  /** 失败时的原因 */
  error?: string
}

/**
 * 一次自动化运行。
 *
 * 列表只放**能一行读完的派生信息**（触发上下文 / Normal 逐步结果 / Agent 结论摘要与步数），
 * Agent 的完整对话仍然只在会话里（`sessionId`），历史不复制正文（docs/13 §12）。
 */
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
  /** 触发上下文（「距上课 5 分钟」/「手动触发」；定时到点触发时省略） */
  triggerDetail?: string
  /** Normal Mode：逐个操作组件的执行结果（按定义里的顺序） */
  steps?: AutomationRunStep[]
  /** Agent Mode：本次会话的工具调用数（列表行的「N 步」） */
  toolCallCount?: number
  /** Agent Mode：最终结论首行摘要（列表行显示；正文看回放） */
  summary?: string
  error?: string
}

/** 触发器 / 操作组件的表单元数据（主进程 catalog 提供，编辑器与 Center 网页共用） */
export interface AutomationDescriptorField {
  key: string
  label: string
  type: 'text' | 'number' | 'time' | 'weekdays' | 'select' | 'json'
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
  /** 默认 50，上限 200（`0` = 不分页、返回全部，供引擎内部重建去重键使用） */
  limit?: number
  /** 分页偏移（`triggeredAt` 倒序后的跳过条数） */
  offset?: number
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
  /**
   * 是否允许自由文本作答（缺省 true；`false` 时卡片**不渲染**自由输入框）。
   * 由 `ask_user` 工具的 `allowCustom` 决定，用于「只能从这几个选项里选」的场合。
   */
  allowCustom?: boolean
  /**
   * 一次多问（1–4 个，本轮）：渲染成一张卡里的分节，用户一次提交后按顺序回填
   * `answersByQuestion`。缺省 = 单问（顶层的 `question` / `options` / `multiSelect`，
   * 多问时它们是第一问的副本，供老消费方降级显示）。
   */
  questions?: {
    question: string
    header?: string
    options?: { label: string; description?: string }[]
    multiSelect: boolean
  }[]
}

/** 渲染层回执：`answers` 为空且未 `skipped` 时主进程按「跳过」处理 */
export interface AskUserAnswerInput {
  requestId: string
  answers: string[]
  /** 逐问作答（一次多问时按 `questions` 顺序；单问时缺省。`answers` 是它的扁平化副本） */
  answersByQuestion?: string[][]
  skipped?: boolean
}

// ───────────────────────── 流光提醒（Banner Notification，docs/07 §2.2.3） ─────────────────────────

/** 提醒的语义档位：只影响卡片左侧强调条与图标，不改变排队 / 超时行为。 */
export type BannerLevel = 'info' | 'success' | 'warning' | 'error'

/**
 * 一条流光提醒的**请求**（三个来源共用：Agent 工具 / 插件 `ctx.banner` / `ask_user`）。
 *
 * `title` + `body` 是 R2 的硬性要求：标题必填（空标题会被服务回落成「Aurora 提醒」），
 * 正文允许空串 —— 此时卡片只显示标题，不会留一条空的第二行。
 */
export interface BannerRequest {
  title: string
  body: string
  /** 是否朗读 `title + body`；缺省跟随 TTS 配置（未配置时一律跳过） */
  speak?: boolean
  /** 是否播放提示音；缺省 true */
  sound?: boolean
  /** 自动关闭时长（毫秒，缺省 6000；服务钳制在 2000–30000） */
  durationMs?: number
  /** 同内容合并键（缺省 `title\0body`）：短窗口内的重复请求只显示一次 */
  dedupeKey?: string
  level?: BannerLevel
}

/**
 * 主进程 → banner 渲染层的展示载荷（`banner:show` 推送）。
 *
 * 与 `BannerRequest` 的差别只在**已经定稿的字段**：`speak` / `sound` / `durationMs` / `level`
 * 都已由主进程按配置与缺省值解算，渲染层不再各自判一遍（两处判据必然漂移）。
 */
export interface BannerShowPayload {
  /** 本次展示的 id：渲染层关闭 / 超时回执时带回，主进程据此丢弃迟到的回执 */
  id: string
  title: string
  body: string
  speak: boolean
  sound: boolean
  durationMs: number
  level: BannerLevel
}

/**
 * 渲染层 → 主进程：卡片**内容高度**上报（`banner:measure`）。
 *
 * 为什么由渲染层量：卡片高度取决于真实排版（换行、字体回退），主进程按字符数估算必然
 * 在某些文案上偏大或偏小 —— 偏大 = 透明窗口多出一块挡住点击的死区，偏小 = 正文被裁掉。
 * 渲染层量完（`getBoundingClientRect().height`）回报，主进程把窗口调成「卡片 + 24px 外边距」。
 */
export interface BannerMeasureRequest {
  /** 正在展示的那一条的 id；预览 / 截图场景为空串（主进程只做高度钳制） */
  id?: string
  /** 卡片内容的真实高度（CSS 像素） */
  height: number
}

/** 渲染层 → 主进程的关闭回执（`banner:dismiss`）。 */
export interface BannerDismissResult {
  /** 这次回执是否真的关掉了正在显示的那一条（重复 / 迟到 / 未知 id → false） */
  dismissed: boolean
  /** 仍在排队等待展示的条数 */
  pending: number
}

/**
 * 流光提醒的运行态读数（开发自测用，生产不暴露）。
 *
 * 服务侧的队列读数与两个**原生窗口**的可见性分开给：卡片没显示可能是窗口没建起来，
 * 也可能只是服务还在排队 —— 合成一个 `visible` 会把这两种故障混成一条。
 */
export interface BannerDiagnostics {
  /** 当前有一条正在显示（服务侧 current 非空） */
  visible: boolean
  pending: number
  shownCount: number
  cardVisible: boolean
  glowVisible: boolean
}

// ───────────────────────── 默认提醒方式（v37，docs/07 §4） ─────────────────────────

/** 「试一下」的回执：只回报本次实际走的通道与是否投递成功，不回传任何正文。 */
export interface NotificationTestResult {
  /** 本次实际使用的通道（= 当前默认提醒方式） */
  channel: ReminderChannel
  /** 是否真的投递出去了（`off` / 载体不可用时为 false） */
  delivered: boolean
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

// ───────────────────────── 文件自感知（v28，docs/06 §26） ─────────────────────────

export type FileAwarenessAnalysisStage = 'queued' | 'extracting' | 'analyzing' | 'writing'

export interface FileAwarenessAnalysisProgress {
  stage: FileAwarenessAnalysisStage
  fileName: string
}

export interface FileAwarenessStatus {
  enabled: boolean
  consentAccepted: boolean
  active: boolean
  waitingForModel: boolean
  /** 前台 / 自动化 Agent 正在工作时，自感知队列暂停但不丢任务。 */
  waitingForAgent: boolean
  /** 后台模型不可用时的可操作原因；正常或未启用时不带键。 */
  modelError?: string
  knowledgeDir: string
  knowledgeDirAvailable: boolean
  watchedDirs: string[]
  includeRecent: boolean
  suggestionsEnabled: boolean
  /** 当前全局模型是否开启图片输入；关闭时仍分析正文，但不会读取内嵌图片。 */
  visionEnabled: boolean
  dailyAnalysisLimit: number
  todayAnalyzed: number
  queueDepth: number
  queueOverflow: number
  noteCount: number
  expiredNoteCount: number
  conflictCount: number
  /** 自感知后台分析的真实 provider 用量；从未回传过 usage 时不带键。 */
  usage?: SessionUsageStats
  lastScanAt?: string
  lastError?: string
  /** 当前排队 / 分析文件的阶段进度；空闲时不带键。 */
  analysisProgress?: FileAwarenessAnalysisProgress
  /**
   * v33：四周流光特效是否开启（`appearance.awarenessGlow`）。
   *
   * **刻意可选**：老夹具 / 第三方构造的这个结构不必补字段；读取方一律按
   * 「`!== false`」判开（缺字段 = 开），与 Schema 的 `.default(true)` 同一口径。
   */
  glowEnabled?: boolean
  current?: {
    fileName: string
    sourcePath: string
  }
}

export type FileAwarenessRecordStatus = 'done' | 'skipped' | 'error' | 'conflict'

export interface FileAwarenessRecord {
  id: string
  sourcePath: string
  fileName: string
  ext: string
  kind: 'add' | 'change' | 'rename' | 'delete' | 'recent'
  status: FileAwarenessRecordStatus
  occurredAt: string
  sourceAvailable: boolean
  noteId?: string
  notePath?: string
  summary?: string
  error?: string
}

export interface FileAwarenessNote {
  id: string
  title: string
  sourcePath: string
  notePath: string
  /** 源文件格式（docx / pptx…），记忆库左侧一级分组。 */
  ext: string
  /** 首次感知时间；知识库目录按这个日期分层。 */
  createdAt: string
  updatedAt: string
  sourceAvailable: boolean
  conflict: boolean
  excerpt: string
  /** 后台分析得到的标签；关键词搜索与 Agent 工具会使用。 */
  tags: string[]
  /** 单条过期策略；inherit = 跟随全局默认并按 updatedAt 续期。 */
  expiry: FileAwarenessNoteExpiry
  /** 当前有效到期时间（ISO）；undefined = 永不过期。 */
  expiresAt?: string
  /** 当前时刻是否已停止提供给 Agent；仍可在记忆库中查看。 */
  expired: boolean
}

export type FileAwarenessNoteExpiry =
  | { mode: 'inherit' }
  | { mode: 'never' }
  /** `manual` = 手动立即过期；`at` 只保存操作时间，判定始终为已过期且不自动续期。 */
  | { mode: 'at'; at: string; preset?: 'at24' | 'at7' | 'at30' | 'manual' }

export interface FileAwarenessNoteContent {
  noteId: string
  title: string
  sourcePath: string
  notePath: string
  content: string
  truncated: boolean
  conflict: boolean
}

export interface FileAwarenessSuggestion {
  id: string
  noteId: string
  sourcePath: string
  sourceHash: string
  headline: string
  body: string
  createdAt: string
  confidence: number
  /** 仅当建议可直接转成一次 Agent 任务时存在；由用户点击执行按钮后才真正创建会话。 */
  action?: FileAwarenessAgentAction
}

export interface FileAwarenessAgentAction {
  /** 气泡按钮文案，例如「整理成待办」。 */
  label: string
  /** 新 Agent 会话的首条用户消息；必须自包含，不依赖文件自感知后台会话。 */
  prompt: string
}

export interface FileAwarenessListRequest {
  /** 缺省 100，上限 500 */
  limit?: number
}

export interface FileAwarenessAnalyzeRequest {
  path: string
}

export interface FileAwarenessSuggestionAction {
  suggestionId: string
}

export interface FileAwarenessExecution {
  sessionId: string
}

export interface FileAwarenessNoteRequest {
  noteId: string
}

export interface FileAwarenessSetNoteExpiryRequest {
  noteId: string
  expiry: FileAwarenessNoteExpiry
}

// ───────────────────────── 对话（Agent 内核，docs/06 §4/§5） ─────────────────────────

export interface SendMessageRequest {
  sessionId: string
  text: string
  /**
   * 系统提示词会被注入的来源窗口，用于日志与后续多窗口路由；
   * 'center' = 远程会话（docs/12）；'automation' = 自动化触发（docs/13 §7，无人值守）。
   */
  origin: WindowName | 'center' | 'automation' | 'file-awareness'
  /**
   * 附件绝对路径列表（拖拽发送，docs/07 §2.3）。
   * 主进程按扩展名分成两类：**图片**（png / jpg / jpeg / webp / gif / bmp）走多模态图片分片
   * （docs/06 §3.1，是否真的送进模型由当前生效模型的 `modelParams.<模型 id>.vision` 决定），
   * 其余用 `extract.ts` 提取文本后拼进本轮用户消息；提取失败按降级处理，不阻断发送。
   */
  attachments?: string[]
  /**
   * 续跑哪条 job（v15，docs/06 §4.1）：只接受 `status === 'paused'` 的 job；
   * 其余状态主进程回 `E_JOB_STATE`。给了它时**不会重复落盘**那条用户消息。
   */
  resumeJobId?: string
}

/**
 * 附件缩略图请求 / 回执（v22 多模态输入，docs/07 §2.3、通道 `chat:readAttachment`）。
 *
 * 渲染层拖入图片后要在 chip 上显示缩略图，而渲染进程没有 fs 能力 —— 由主进程读盘转
 * `data:` URL。**只回数据 URL、不回磁盘内容**，且超过 `PREVIEW_MAX_BYTES` 或读取失败时
 * `dataUrl` 缺省、`note` 写明原因（渲染层退回纯文字 chip，不显示裂图）。
 */
export interface ChatAttachmentPreviewRequest {
  /** 附件绝对路径（与 `SendMessageRequest.attachments` 里的同一个值） */
  path: string
}

export interface ChatAttachmentPreview {
  path: string
  /** 文件名（chip 上的文字，主进程用 basename 解析） */
  name: string
  /** 是否被识别为图片（扩展名判定；false 时不尝试读盘） */
  image: boolean
  /** `data:image/png;base64,…`；非图片 / 超限 / 读取失败时缺省 */
  dataUrl?: string
  /** 未能给出缩略图时的原因（超限 / 读取失败），会原样展示在 chip 的 title 里 */
  note?: string
}

/**
 * 粘贴图片上限（2026-10-18，docs/07 §2.3）。
 *
 * 与主进程 `IMAGE_MAX_BYTES` 同一个值：剪贴板图片先落盘再走附件链路，
 * 超过这个尺寸就该走“发文件”而不是“发一张图”。渲染层在粘贴时先拦一道，
 * 主进程再校验一次（渲染层传入的 mime / 大小不可信）。
 */
export const PASTED_IMAGE_MAX_BYTES = 8 * 1024 * 1024

/**
 * 把剪贴板图片暂存成本地附件（通道 `chat:stageImage`，2026-10-18）。
 *
 * 渲染进程的 paste 事件只能拿到 `File`（没有本地路径），而附件链路按路径工作：
 * 主进程负责把字节写进 `<userData>/pasted/`，返回路径与一张小预览图。
 * `data` 用 ArrayBuffer 而不是 base64：结构化克隆不需要再编码一次。
 */
export interface ChatStageImageRequest {
  mimeType: string
  /** 原始文件名（只用于展示参考；落盘名由主进程生成） */
  name?: string
  data: ArrayBuffer
}

export interface ChatStageImageResult {
  /** 暂存后的绝对路径（与 `SendMessageRequest.attachments` 里的同一个值） */
  path: string
  /** 落盘文件名（chip / title 用） */
  name: string
  /**
   * 96px 缩略图的 `data:` URL。
   *
   * 粘贴图可能超过 `PREVIEW_MAX_BYTES`（2 MiB），此时走 `chat:readAttachment` 拿不到缩略图；
   * 主进程在落盘时顺手缩一张随结果回传，保证“粘贴进去就看得见缩略图”。
   */
  previewDataUrl?: string
}

/**
 * 助手消息里展示的一张图片（`show_image` / `generate_image`，docs/06 §14）。
 *
 * 渲染层与 Center 只拿到这份**无路径元数据**；真实文件按 `id` 通过 IPC / Center
 * 命令向客户端按需读取。这样会话图片不需要把 base64 写进会话文件，也不会把本机路径
 * 带出客户端。
 */
export interface ChatDisplayImage {
  id: string
  name: string
  mime: string
  caption?: string
}

export interface AgentToolCall {
  id: string
  name: string
  input?: unknown
  state: 'running' | 'success' | 'error'
  outputSummary?: string
  /**
   * 工具调用**发起**时刻（ISO 时间戳，随工具卡持久化）。
   * 渲染层的耗时徽章以它为计时起点 —— 切走会话再切回、甚至重启后，耗时仍是真实值，
   * 不再从「渲染层首次观察到 running 的那一刻」重新起表。
   */
  startedAt?: string
  /** 工具调用**结算**（success / error）时刻；`running` 态没有这个字段 */
  endedAt?: string
  /**
   * `task` 子代理工具的运行快照（docs/06 §19、docs/07 §2.3）。
   * 随工具卡状态一起持久化，因此「子代理」页面在重启后仍能回看历史运行。
   */
  subagent?: SubagentSnapshot
  /** 本工具调用产出的对话图片；只含安全元数据，原图路径绝不跨 IPC / Center */
  displayImages?: ChatDisplayImage[]
}

export interface ChatDisplayImageReadRequest {
  sessionId: string
  imageId: string
  /**
   * 可选：把返回图片的最长边缩到这个像素数再回 data URL（列表缩略图用，docs/06 §14）。
   *
   * 原图最大 10MB，直接 base64 会让多图会话的渲染进程常驻几百 MB；缺省 / <=0 时原样返回。
   */
  maxDimension?: number
}

export interface ChatDisplayImageReadResult {
  dataUrl: string
  name: string
  mime: string
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

/**
 * 会话级用量累计（`sessions/<id>.json` 的 `meta.usage`，随会话落盘）。
 *
 * 与「本次会话窗口内逐轮累加」的渲染层 totals 不同：它是主进程在每轮 usage 事件
 * 发出时同步累计的**持久值**，跨切换、跨重启都连续。渲染层切回会话时以它为种子，
 * 之后逐轮继续累加 —— 平均缓存命中率（`cachedTokens / promptTokens`）因此按**会话**
 * 而不是「本窗口本次观看期间」计算。
 */
export interface SessionUsageStats {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** 累计命中量（provider 未回传缓存字段的轮次按 0 计入） */
  cachedTokens: number
  /** 已累计的 LLM 轮次（provider 未回传 usage 的轮次不计） */
  rounds: number
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
  /**
   * 产生这条消息的 Agent 请求 id（同一请求的用户 / 助手消息共享）。
   *
   * 旧会话没有该字段；渲染层会按相邻助手消息回退分组，不要求迁移旧文件。
   */
  requestId?: string
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
  origin: 'write_file' | 'edit_file' | 'office_edit' | 'office_export' | 'rollback'
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
/**
 * 为什么停在 `paused`：轮次用尽 / 被用户取消。
 *
 * v34 起少了 `'budget'`：token 预算这个上限被取消（只统计不限制，docs/06 §4.1 / §5），
 * 而轮次上限退回内核常量 `RUNAWAY_MAX_ROUNDS`（防失控，不再是用户可配的 32/128）。
 */
export type JobPendingReason = 'max-rounds' | 'aborted'
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
  origin: 'chat' | 'edge-bar' | 'resume' | 'center' | 'automation' | 'file-awareness'
  /** 本 job 的用户消息原文（续跑不再重复落盘，靠它还原上下文） */
  text: string
  /** 已经跑到第几轮（从 0 起） */
  round: number
  /**
   * 本次请求实际生效的轮次上限。v34 起它不再是设置项，而是内核的防失控常量
   * `RUNAWAY_MAX_ROUNDS`（docs/06 §5）—— 记下来是为了让界面能说清「第 N / 上限」这个数从哪来。
   */
  maxRounds: number
  stepsDone: JobStep[]
  todos: Array<{ id: string; text: string; status: 'pending' | 'in_progress' | 'completed' }>
  /** 游标：下一轮从哪里开始（续跑的起点） */
  cursor: { nextRound: number; note?: string }
  /**
   * 用量账本。**v34 起只有累计值**：`maxTotalTokens`（预算上限）与 `autoContinued`
   * （自动续轮额度）随那两个概念一起退役 —— 留着一个永远等于 0 的字段，
   * 就是下一个"能写不生效"的死口子。
   */
  budget: { usedTokens: number }
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

/** Center 官方模型的运行态提示（回落本地模型等；仅展示，不阻断请求）。 */
export interface CenterRuntimeNotice {
  capability: 'llm' | 'imagegen' | 'tts' | 'stt'
  message: string
  at: string
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

// ───────────────────────── 插件（v36，docs/14） ─────────────────────────

/** `disabled` = 用户关闭或总开关关闭；`stopped` = 已启用但懒加载尚未启动。 */
export type PluginRuntimeStatus =
  'disabled' | 'stopped' | 'starting' | 'ready' | 'crashed' | 'error'

export type PluginSource = 'local' | 'marketplace' | 'dev'

export interface PluginToolInfo {
  name: string
  /** 实际注册名 `plugin.<id>.<name>` */
  fullName: string
  description: string
  sensitivity: 'safe' | 'confirm'
  readonly: boolean
}

export interface PluginPanelInfo {
  pluginId: string
  pluginName: string
  id: string
  title: string
  icon: string
  kind: 'schema' | 'page'
  /** 页面型面板的入口（插件包内相对路径；渲染层拼成 `aurora-plugin://` URL） */
  entry?: string
}

export interface PluginThemeInfo {
  pluginId: string
  pluginName: string
  id: string
  name: string
  tokens: Record<string, string>
}

/** 小组件快照（桌面浮动卡片或提示条条目）。 */
export interface PluginWidgetInfo {
  pluginId: string
  pluginName: string
  id: string
  title: string
  icon?: string
  slot: 'desktop' | 'edge-bar'
  kind: 'schema' | 'page'
  /** 桌面小组件声明层级；提示条固定为默认值（v37） */
  windowLevel: PluginWidgetWindowLevel
  /** 桌面小组件声明材质；提示条固定为 `none`（v37） */
  windowMaterial: PluginWidgetWindowMaterial
  /** 隐藏宿主标题栏的「隐藏小组件」按钮；提示条恒为 false */
  hideCloseButton: boolean
  /** 页面型小组件的入口（插件包内相对路径） */
  entry?: string
  defaultSize?: { width: number; height: number }
}

/** 桌面小组件的持久化布局（`<userData>/plugin-widget-layout.json`，不进 settings）。 */
export interface PluginWidgetLayoutEntry {
  visible: boolean
  x: number
  y: number
  width: number
  height: number
  /**
   * 用户在设置页选择的层级覆盖（v37）；缺省 = 跟随清单 `contributions.widgets[].windowLevel`。
   * 布局文件仍是 version 1：该字段是可选的向后兼容扩展。
   */
  windowLevelOverride?: PluginWidgetWindowLevel
}

export interface PluginWidgetLayout {
  version: 1
  widgets: Record<string, PluginWidgetLayoutEntry>
}

/** 主进程 → 渲染层的插件推送（面板 / 桌面小组件 / 提示条小组件共用）。 */
export interface PluginPushEvent {
  pluginId: string
  panelId?: string
  widgetId?: string
  event: string
  payload?: unknown
}

export interface PluginCommandInfo {
  pluginId: string
  pluginName: string
  name: string
  title: string
  description: string
  mode: 'action' | 'prompt'
}

export interface PluginAutomationActionInfo {
  pluginId: string
  pluginName: string
  name: string
  title: string
  description: string
}

export interface PluginAutomationEventInfo {
  pluginId: string
  pluginName: string
  name: string
  title: string
  description?: string
}

/** 设置页「已安装」列表与详情用的完整快照（含声明式贡献，不读盘）。 */
export interface PluginSummary {
  id: string
  name: string
  version: string
  description: string
  author: string
  license?: string
  homepage?: string
  enabled: boolean
  trusted: boolean
  source: PluginSource
  status: PluginRuntimeStatus
  activeVersion: string
  previousVersion?: string
  installPath: string
  checksum?: string
  installedAt: string
  updatedAt: string
  lastError?: string
  isDev: boolean
  permissions: PluginPermission[]
  tools: PluginToolInfo[]
  commands: PluginCommandInfo[]
  panels: PluginPanelInfo[]
  widgets: PluginWidgetInfo[]
  themes: PluginThemeInfo[]
  automationActions: PluginAutomationActionInfo[]
  automationEvents: PluginAutomationEventInfo[]
  configFields: PluginConfigField[]
  events: string[]
  skills: string[]
}

/** 打开 / 复用插件配置窗口的请求（docs/07 §2.2.2）。 */
export interface PluginOpenWindowRequest {
  pluginId: string
}

/** 插件配置窗口的视图参数：requestId 单调递增，用于同一窗口切换不同插件。 */
export interface PluginWindowRequest {
  requestId: string
  pluginId: string
}

/** 安装前预览（安装同意弹窗唯一的数据来源）。 */
export interface PluginInstallPreview {
  id: string
  name: string
  version: string
  apiVersion: number
  minAuroraVersion?: string
  description: string
  author: string
  license?: string
  homepage?: string
  checksum: string
  sizeBytes: number
  permissions: PluginPermission[]
  tools: PluginToolInfo[]
  commands: PluginCommandInfo[]
  panels: PluginPanelInfo[]
  widgets: PluginWidgetInfo[]
  themes: PluginThemeInfo[]
  automationActions: PluginAutomationActionInfo[]
  automationEvents: PluginAutomationEventInfo[]
  configFields: PluginConfigField[]
  events: string[]
  /** 与已安装版本 / 其他插件的冲突（非空时安装会被拒绝） */
  conflicts: string[]
  warnings: string[]
  /** 同 id 已安装时：将被替换的版本 */
  replaces: { version: string; enabled: boolean } | null
  /** 包来源（本地路径或市场下载缓存路径，仅用于诊断） */
  sourcePath: string
}

/** 安装来源：本地文件，或 Center 市场的某个版本。 */
export interface PluginPackageRef {
  kind: 'file' | 'marketplace'
  /** kind = file 时必填 */
  path?: string
  /** kind = marketplace 时必填 */
  pluginId?: string
  version?: string
}

export interface PluginUninstallRequest {
  pluginId: string
  /** 同时删除 `<userData>/plugin-data/<id>`（默认保留） */
  deleteData?: boolean
}

export interface PluginConfigValues {
  pluginId: string
  values: Record<string, unknown>
}

export interface PluginSetConfigRequest {
  pluginId: string
  /** 只传改动的键；主进程按清单字段过滤未知键并做类型校验 */
  values: Record<string, unknown>
}

export interface PluginPanelDataRequest {
  pluginId: string
  panelId: string
  method?: string
  params?: unknown
  /** 面板控件当前值（`bind` 键 → 值） */
  values?: Record<string, unknown>
}

export interface PluginPanelDataResult {
  schema?: PluginPanelSchema
  toast?: string
}

export interface PluginWidgetDataRequest {
  pluginId: string
  widgetId: string
  /** 拉取 / 动作方法名（事件推送时为 `event`） */
  method?: string
  params?: unknown
  /** 控件当前值（`bind` 键 → 值） */
  values?: Record<string, unknown>
}

export interface PluginWidgetDataResult {
  schema?: PluginPanelSchema
  toast?: string
  data?: unknown
}

export interface PluginSetWidgetVisibleRequest {
  pluginId: string
  widgetId: string
  visible: boolean
}

/** 用户层级覆盖（v37）：`auto` = 清除覆盖、跟随清单声明。 */
export interface PluginSetWidgetWindowLevelRequest {
  pluginId: string
  widgetId: string
  windowLevel: 'auto' | PluginWidgetWindowLevel
}

/** 主进程 → 小组件窗口：当前实际可用的原生材质（v37）。 */
export interface PluginWidgetMaterialEvent {
  pluginId: string
  widgetId: string
  material: PluginWidgetWindowMaterial
}

export interface PluginPageRpcRequest {
  pluginId: string
  /** 页面所属面板 id（同一插件有多个页面面板时必填；缺省取第一个页面面板） */
  panelId?: string
  /** 页面属于桌面小组件时必填（与 panelId 二选一） */
  widgetId?: string
  /**
   * 承载页面的 webview guest 的 `webContentsId`（渲染层从 `<webview>` 读）。
   * 主进程只接受已由 `did-attach-webview` 登记、且归属该插件的 guest。
   */
  guestId: number
  /** `invokePanel` 的方法名（页面侧 `auroraPlugin.request(method, params)`） */
  method: string
  params?: unknown
}

export interface PluginRunCommandRequest {
  pluginId: string
  name: string
  args?: string
}

export interface PluginRunCommandResult {
  summary?: string
  /** prompt 命令返回的提示词（渲染层插入输入框 / 主进程直接替换发送文本） */
  prompt?: string
}

export interface PluginMarketVersionInfo {
  version: string
  apiVersion: number
  minAuroraVersion?: string
  sha256: string
  size: number
  publishedAt: string
  changelog?: string
}

export interface PluginMarketEntry {
  id: string
  name: string
  summary: string
  author: string
  license?: string
  homepage?: string
  iconUrl?: string
  latestVersion: string
  updatedAt: string
  downloads: number
  versions: PluginMarketVersionInfo[]
  /** 本机已安装版本（未安装时缺省） */
  installedVersion?: string
  updateAvailable?: boolean
}

export interface PluginMarketplaceListResult {
  /** 当前使用的 Center 地址；未配置时为空串（界面展示空态） */
  serverUrl: string
  entries: PluginMarketEntry[]
  error?: string
}

export interface PluginMarketplaceInstallRequest {
  pluginId: string
  version?: string
}

export interface PluginUpdateInfo {
  pluginId: string
  name: string
  currentVersion: string
  latestVersion: string
  sha256: string
}

export interface PluginOpenPanelEvent {
  pluginId: string
  panelId: string
}

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
    /**
     * 仅开发态自测可用：手动推一条 / 收一条流光提醒。
     *
     * 流光提醒的三个真实入口（Agent 工具 / 插件 / 提问）都不适合在自测里当触发器 ——
     * 前两者要跑一整轮模型调用或装插件，后者要等 3 分钟超时。这个口子只做
     * 「show 后窗口真的可见、dismiss 后真的不可见」这一段，参数固定、不接受任意内容。
     */
    smokeBanner(action: 'show' | 'dismiss'): Promise<Result<BannerDiagnostics>>
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
  preview: {
    /**
     * 读一个文件用于右栏预览（docs/07 §2.3 右栏「文件」tab，2026-10-03）。
     * 路径必须在**发起会话**的边界根之内（越界返回 `ok: false`，与 file-port 同一条
     * `resolveWithin` 口径）；文本 2 MB / 图片 10 MB 上限，超限截断或拒绝。
     */
    read(request: FilePreviewRequest): Promise<Result<FilePreviewResult>>
    /**
     * 列一个目录（docs/07 §2.3，2026-10-03）：缺省列出会话边界根（项目文件夹 /
     * 会话空间目录），路径同样受边界根约束；目录在前、同类按名称升序，超上限截断。
     */
    list(request: FileListRequest): Promise<Result<FileListResult>>
    /**
     * Agent 展示推送（`show_preview` 工具，on/off 成对）：主界面据此把右栏切到
     * 「浏览器」tab 并加载目标；`sessionId` 不是当前会话时渲染层忽略。
     */
    onShow(listener: (event: PreviewShowEvent) => void): () => void
  }
  browser: {
    /**
     * 站点自开标签（`target="_blank"` / `window.open` 的 http(s) 目标，on/off 成对）：
     * 主界面收到后**另开一个浏览器标签**加载 `url`（当前页不动）。
     */
    onOpenTab(listener: (event: BrowserOpenTabEvent) => void): () => void
    /**
     * Agent 请求新建/复用浏览器标签（docs/06 §27，on/off 成对）：渲染层建好 webview 后
     * 必须经 `agentReport` 回执 `webContentsId`，主进程才能接管驱动。
     */
    onAgentOpen(listener: (event: BrowserAgentOpenEvent) => void): () => void
    /** Agent 会话状态推送（on/off 成对）：徽章 / 激活标签 / 释放 */
    onAgentStatus(listener: (event: BrowserAgentStatusEvent) => void): () => void
    /** 回执一次 agentOpen（成功带 webContentsId，失败带 error） */
    agentReport(request: BrowserAgentReportRequest): Promise<Result<void>>
    /** 用户点「停止」或关闭标签：结束该会话的控制（保留标签页） */
    agentStop(request: BrowserAgentStopRequest): Promise<Result<void>>
  }
  terminal: {
    /**
     * 新建一条 PTY shell（docs/07 §2.3 右栏「终端」标签）：**每次调用都是新 shell**
     * （一个标签一条 PTY，2026-10-03 二次修订；此前是「每窗口一个 shell」的复用语义）。
     * 每个窗口上限 6 条，超限返回可读错误；窗口销毁时该窗口全部 shell 由主进程收掉。
     */
    create(request: TerminalCreateRequest): Promise<Result<TerminalCreateResult>>
    /** 键盘输入原样透传（非终端 id / 已退出时静默丢弃） */
    input(request: TerminalInputRequest): Promise<Result<boolean>>
    /** cols/rows 变化同步给 PTY（越界值主进程夹取） */
    resize(request: TerminalResizeRequest): Promise<Result<boolean>>
    /** 主动关闭一条 shell（关闭标签 = 关闭那条 PTY） */
    kill(request: { terminalId: string }): Promise<Result<boolean>>
    /** shell 输出推送（on/off 成对；只推给创建终端的窗口） */
    onData(listener: (event: TerminalDataEvent) => void): () => void
    /** shell 退出推送（on/off 成对） */
    onExit(listener: (event: TerminalExitEvent) => void): () => void
  }
  chat: {
    /**
     * `queued: true`（docs/06 §5.3）：该会话正在跑请求，这条消息**排进了队列**而不是立即开始，
     * 会在下一次轮次边界作为一条用户消息插进那一轮。缺省 / false = 本轮立即执行。
     */
    send(
      request: SendMessageRequest,
    ): Promise<Result<{ requestId: string; queued?: boolean; handled?: { summary?: string } }>>
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
     * 会话删除推送（docs/07 §2.3，on/off 成对）：主进程在 `deleteSession` 删除成功后
     * 广播被删会话 id（payload 只含 sessionId）；渲染层重拉会话列表，且当前会话被删时
     * 按「左栏最近一条会话回落，列表空则新建」处理。
     */
    onSessionDeleted(listener: (event: ChatSessionDeletedEvent) => void): () => void
    /**
     * 会话自动标题变更推送（docs/06 §4，on/off 成对）：
     * 主进程生成并落盘成功后广播 `{ sessionId, title }`，渲染层原位更新会话列表。
     */
    onSessionTitleChanged(listener: (event: ChatSessionTitleChangedEvent) => void): () => void
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
     * 手动压缩会话上下文（`/compact`，docs/06 §4）：把全部消息压成摘要写进 `meta.compact`，
     * 此后组装请求只取压缩点之后的消息（消息本体不删，历史仍可回看）。
     * 在跑的会话拒绝（`ok: false`，错误文案即 E_BUSY 语义）；不抛错。
     */
    compact(sessionId: string): Promise<Result<{ summaryChars: number; coveredMessages: number }>>
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
     * 覆盖 / 清除一个会话的模型（docs/06 §3，本轮）。
     *
     * 状态写在会话文件自身的 `meta.llm` 里；**幂等**，且主进程会等到落盘完成才返回，
     * 因此调用后紧跟一次 `sessions()` 一定能读到新覆盖。`model`（或 `providerId`）空串 =
     * 清除覆盖、回落全局档；providerId 不在 `llm.providers` 里返回 `{ ok: false }`
     * （静默成功会让用户以为绑定生效了，实际请求仍走全局档）。
     */
    setSessionModel(
      request: ChatSessionModelRequest,
    ): Promise<Result<{ providerId: string; model: string }>>
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
     * 图片附件的缩略图（v22 多模态输入，docs/07 §2.3）。
     *
     * 渲染进程没有 fs 能力，chip 上那张 48×48 的缩略图由主进程读盘转成 `data:` URL；
     * 非图片 / 超过 `PREVIEW_MAX_BYTES` / 读取失败时 `dataUrl` 缺省、`note` 写明原因，
     * 渲染层据此退回纯文字 chip（不显示裂图）。
     */
    readAttachment(request: ChatAttachmentPreviewRequest): Promise<Result<ChatAttachmentPreview>>
    /**
     * 把剪贴板图片暂存成本地附件（2026-10-18，docs/07 §2.3）。
     *
     * 渲染层粘贴时拿到的 `File` 没有本地路径，主进程写盘后回路径 + 96px 预览图；
     * 只在渲染层调用，写入目录固定为 `<userData>/pasted/`，不接受任意目标路径。
     */
    stageImage(request: ChatStageImageRequest): Promise<Result<ChatStageImageResult>>
    /**
     * 读取助手消息图片区的一张图片（`show_image` / `generate_image`）。
     * 主进程按会话 + imageId 查会话记录并读盘，只回 data URL。
     */
    readDisplayImage(
      request: ChatDisplayImageReadRequest,
    ): Promise<Result<ChatDisplayImageReadResult>>
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
  /**
   * 流光提醒（Banner Notification，docs/07 §2.2.3）：屏幕顶端的置顶卡片 + 流光。
   *
   * 渲染层只有「收推送 + 回回执」两件事 —— **没有** `show`：提醒的来源是主进程
   * （Agent 工具 / 插件 / 提问），渲染层不该成为第四种来源。
   */
  banner: {
    /** 收到一条提醒（主进程 → banner 窗口推送，on/off 成对） */
    onShow(listener: (payload: BannerShowPayload) => void): () => void
    /** 关闭回执（用户点关闭 / 超时 / 播完） */
    dismiss(id: string): Promise<Result<BannerDismissResult>>
    /** 上报卡片内容高度（主进程据此把卡片窗调到「卡片 + 外边距」） */
    measure(request: BannerMeasureRequest): Promise<Result<boolean>>
  }
  /**
   * 提醒通道（v37，docs/07 §4）：设置页「提醒」的试一下按钮。
   * 只按当前默认方式投递一条固定的示例提醒，不接受调用方指定标题 / 正文。
   */
  notifications: {
    test(): Promise<Result<NotificationTestResult>>
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
    /** 读取当前官方模型目录（未登录 / 未拉取到为 null） */
    modelServices(): Promise<Result<CenterOfficialModelCatalog | null>>
    /** 立即从 Center 刷新官方模型目录 */
    refreshModelServices(): Promise<Result<CenterOfficialModelCatalog | null>>
    /** 目录变化推送（on/off 成对） */
    onModelServicesChanged(
      listener: (catalog: CenterOfficialModelCatalog | null) => void,
    ): () => void
    /** 官方模型回落等运行态提示（on/off 成对） */
    onRuntimeNotice(listener: (notice: CenterRuntimeNotice) => void): () => void
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
    /** 打开 / 复用单例自动化详情窗口 */
    openWindow(request: AutomationOpenWindowRequest): Promise<Result<WindowState>>
    /** 详情窗口视图请求推送（on/off 成对） */
    onWindowRequest(listener: (request: AutomationWindowRequest) => void): () => void
    /** 定义变化推送（on/off 成对） */
    onChanged(listener: () => void): () => void
    /** 运行记录落库 / 状态变化推送（on/off 成对） */
    onHistoryChanged(listener: () => void): () => void
  }
  /** 插件（v36，docs/14）：安装 / 启停 / 配置 / 命令 / 面板 / 市场 */
  plugins: {
    /** 已安装（含启用 / 信任 / 运行状态）与开发目录里的插件 */
    list(): Promise<Result<PluginSummary[]>>
    /** 安装前预览（校验清单、计算校验和、列出权限与冲突；不改动任何状态） */
    inspect(ref: PluginPackageRef): Promise<Result<PluginInstallPreview>>
    install(ref: PluginPackageRef): Promise<Result<PluginSummary>>
    uninstall(request: PluginUninstallRequest): Promise<Result<boolean>>
    setEnabled(request: { pluginId: string; enabled: boolean }): Promise<Result<PluginSummary>>
    setTrusted(request: { pluginId: string; trusted: boolean }): Promise<Result<PluginSummary>>
    /** 重启单个插件进程（崩溃 / 开发态改代码后） */
    restart(request: { pluginId: string }): Promise<Result<PluginSummary>>
    /** 回滚到上一版本（仅本地 / 市场安装的插件有 previousVersion） */
    rollback(request: { pluginId: string }): Promise<Result<PluginSummary>>
    /** 打开 / 复用单例插件配置窗口（docs/07 §2.2.2） */
    openWindow(request: PluginOpenWindowRequest): Promise<Result<WindowState>>
    /** 配置窗口的插件切换推送（on/off 成对；按 requestId 去重） */
    onWindowRequest(listener: (request: PluginWindowRequest) => void): () => void
    /** 系统选择框：选 `.aurora-plugin` / `.zip`（只返回路径，不安装） */
    choosePackage(): Promise<Result<string | null>>
    /** 系统选择框：选开发目录（只返回路径，写配置走 settings:update） */
    chooseDir(): Promise<Result<string | null>>
    openFolder(request: { pluginId: string }): Promise<Result<string>>
    openLog(request: { pluginId: string }): Promise<Result<string>>
    getConfig(request: { pluginId: string }): Promise<Result<Record<string, unknown>>>
    setConfig(request: PluginSetConfigRequest): Promise<Result<Record<string, unknown>>>
    /** 当前可用的插件斜杠命令（action 立即执行 / prompt 插入输入框） */
    listCommands(): Promise<Result<PluginCommandInfo[]>>
    runCommand(request: PluginRunCommandRequest): Promise<Result<PluginRunCommandResult>>
    /** 打开 / 刷新一个面板（声明式返回 schema；页面型面板不走这里） */
    panelData(request: PluginPanelDataRequest): Promise<Result<PluginPanelDataResult>>
    /** 打开 / 刷新一个小组件（声明式返回 schema；页面型小组件走 pageRpc） */
    widgetData(request: PluginWidgetDataRequest): Promise<Result<PluginWidgetDataResult>>
    /** 桌面小组件布局（位置 / 尺寸 / 显隐；与 settings 无关） */
    widgetLayout(): Promise<Result<PluginWidgetLayout>>
    /** 显示 / 隐藏某个桌面小组件（写入布局文件并立即生效） */
    setWidgetVisible(request: PluginSetWidgetVisibleRequest): Promise<Result<boolean>>
    /** 设置 / 清除某个桌面小组件的层级覆盖（写入布局文件并立即生效，v37） */
    setWidgetWindowLevel(request: PluginSetWidgetWindowLevelRequest): Promise<Result<boolean>>
    /** 宿主内部：小组件窗口实际可用的原生材质变化（on/off 成对，v37） */
    onWidgetMaterial(listener: (event: PluginWidgetMaterialEvent) => void): () => void
    /** 插件页面（webview）的 RPC 中继 */
    pageRpc(request: PluginPageRpcRequest): Promise<Result<unknown>>
    /** Center 插件市场列表（未配置 Center 时 entries 为空并带 error） */
    marketplaceList(request?: { refresh?: boolean }): Promise<Result<PluginMarketplaceListResult>>
    marketplaceInstall(request: PluginMarketplaceInstallRequest): Promise<Result<PluginSummary>>
    /** 检查已安装插件是否有市场新版本（每个插件一次 HEAD/元数据请求） */
    checkUpdates(): Promise<Result<PluginUpdateInfo[]>>
    /** 插件集合 / 状态变化推送（on/off 成对） */
    onChanged(listener: () => void): () => void
    /** 插件请求打开右栏面板（on/off 成对） */
    onOpenPanel(listener: (event: PluginOpenPanelEvent) => void): () => void
    /** 插件推送 → 面板事件（on/off 成对；渲染层按 pluginId + panelId 过滤） */
    onPanelEvent(listener: (event: PluginPushEvent) => void): () => void
    /** 插件推送 → 小组件事件（on/off 成对；桌面窗口与提示条各自过滤） */
    onWidgetEvent(listener: (event: PluginPushEvent) => void): () => void
  }
  /** 文件自感知（v28，docs/06 §26） */
  awareness: {
    status(): Promise<Result<FileAwarenessStatus>>
    records(request?: FileAwarenessListRequest): Promise<Result<FileAwarenessRecord[]>>
    notes(request?: FileAwarenessListRequest): Promise<Result<FileAwarenessNote[]>>
    /** 读取一篇已登记笔记的 Markdown；只接受 noteId，不接受任意路径。 */
    readNote(request: FileAwarenessNoteRequest): Promise<Result<FileAwarenessNoteContent>>
    /** 设置单条记忆的过期策略；过期只停止提供给 Agent，不删除笔记。 */
    setNoteExpiry(request: FileAwarenessSetNoteExpiryRequest): Promise<Result<FileAwarenessNote>>
    /** 在记忆库窗口选中并展示一篇笔记（不是系统默认程序打开）。 */
    presentNote(request: FileAwarenessNoteRequest): Promise<Result<boolean>>
    /** 记忆库窗口接收“选中并展示笔记”推送（on/off 成对）。 */
    onNotePresented(listener: (request: FileAwarenessNoteRequest) => void): () => void
    analyzeNow(request: FileAwarenessAnalyzeRequest): Promise<Result<boolean>>
    ignore(request: FileAwarenessSuggestionAction): Promise<Result<boolean>>
    /** 用建议里的 Agent action 新建会话并发送首条消息；工具权限仍走既有确认链。 */
    execute(request: FileAwarenessSuggestionAction): Promise<Result<FileAwarenessExecution>>
    openKnowledge(): Promise<Result<string>>
    openNote(request: FileAwarenessNoteRequest): Promise<Result<string>>
    openSource(request: FileAwarenessNoteRequest): Promise<Result<string>>
    clearHistory(): Promise<Result<boolean>>
    /** 完整重置 Aurora 管理的记忆、历史与后台分析会话；保留配置和源文件。 */
    reset(): Promise<Result<boolean>>
    scanNow(): Promise<Result<number>>
    onSuggestion(listener: (suggestion: FileAwarenessSuggestion) => void): () => void
    onChanged(listener: () => void): () => void
  }
}
