/**
 * 主进程内部依赖契约。
 *
 * 用结构化接口（而非具体类）声明依赖，便于单测与后续替换实现；
 * `WindowManager` / `ModeManager` / `GuideRunner` 在结构上天然满足这些接口。
 */
import type {
  CenterConnectionStatus,
  AgentEvent,
  CenterLoginRequest,
  CenterLoginResult,
  ChatSessionSummary,
  ClassIslandStatus,
  ClassIslandTestResult,
  ClassificationEvent,
  ClassificationRecord,
  GuideAnswerResult,
  GuideSession,
  HotkeyStatus,
  ImageGenGenerateRequest,
  ImageGenReadRequest,
  ImageGenReadResult,
  ImageGenResult,
  Lesson,
  Logger,
  ModeChangedEvent,
  ModeId,
  ModeSummary,
  OpenPathRequest,
  PerceptionSummary,
  Result,
  SensitiveToolRequest,
  SendMessageRequest,
  Settings,
  SkillSummary,
  SkillsStatus,
  SttTranscribeRequest,
  SttTranscribeResult,
  TtsListModelsRequest,
  TtsListModelsResult,
  TtsSynthesizeRequest,
  TtsSynthesizeResult,
  TtsTestRequest,
  TtsTestResult,
  UpdateState,
  WindowName,
  WindowState,
} from '@aurora/shared'
import type { ConfirmResolution } from './proactive.js'

/** 也用于 agent-host 的最小依赖面 */
export type {
  AgentEvent,
  ClassificationEvent,
  ClassificationRecord,
  GuideAnswerResult,
  GuideSession,
  Lesson,
  Logger,
  ModeChangedEvent,
  ModeId,
  ModeSummary,
  OpenPathRequest,
  PerceptionSummary,
  SensitiveToolRequest,
  SendMessageRequest,
  Settings,
  UpdateState,
  WindowName,
  WindowState,
}

export interface SettingsStoreLike {
  get(): Settings
  mutate(mutator: (draft: Settings) => void): Settings | undefined
  update(patch: Partial<Settings>): Settings | undefined
  getSecret(path: string): string
  setSecret(path: string, plain: string): boolean
  clearSecret(path: string): void
  isCryptoAvailable(): boolean
  needsOnboarding(): boolean
  exportRedacted(): Settings
  flush(): Promise<void>
  onChange(listener: (settings: Settings) => void): () => void
}

export interface WindowManagerLike {
  getState(): WindowState
  show(name: WindowName): WindowState
  hide(name: WindowName): WindowState
  toggle(name: WindowName): WindowState
  showChat(): WindowState
  setPosition(name: WindowName, position: { x: number; y: number }): WindowState
  /** 提示条收起态（8px 竖条）/ 展开态（面板）切换（docs/07 §2.2） */
  setEdgeBarExpanded(expanded: boolean): WindowState
  /** Windows 式标题栏：真最小化（chat / 设置；docs/02 §2.2） */
  minimize(name: WindowName): WindowState
  /** 切换最大化（标题栏双击 / caption 按钮） */
  toggleMaximize(name: WindowName): WindowState
  focus(name: WindowName): void
  onStateChanged(listener: (state: WindowState) => void): () => void
}

export interface ModeManagerLike {
  list(): ModeSummary[]
  currentSummary(): ModeSummary
  systemPrompt(): string
  setCurrent(
    id: ModeId,
  ): Promise<
    | { ok: true; current: ModeId; guideRequired: boolean; modes: ModeSummary[] }
    | { ok: false; message: string; current: ModeId; modes: ModeSummary[] }
  >
  completeGuide(id: ModeId): ModeSummary[]
  resetGuide(id: ModeId): ModeSummary[]
  isGuideCompleted(id: ModeId): boolean
  requestGuideIfNeeded(id: ModeId, reason: string): boolean
  onChange(
    listener: (event: {
      current: ModeId
      previous: ModeId | null
      reason: 'user' | 'onboarding' | 'system'
      modes: ModeSummary[]
    }) => void,
  ): () => void
}

export interface GuideRunnerLike {
  start(id: ModeId): GuideSession
  answer(id: ModeId, answer: string): GuideAnswerResult
  reset(id: ModeId): GuideSession
}

export interface PerceptionLike {
  summary(): Promise<PerceptionSummary>
  contextSummary(): Promise<string>
  start(): void
  stop(): void
}

/** 课程表 provider（docs/05 §3.4）：主进程 `schedule.ts` 的 `IScheduleProvider` 结构上满足。 */
export interface ScheduleProviderLike {
  readonly id: 'manual' | 'classisland'
  /** 当天的课程，按开始时间升序 */
  getToday(now: Date): Promise<Lesson[]>
}

/** 分类管线（docs/05 §3）：IPC 只依赖这个最小面，便于单测注入假实现。 */
export interface ClassificationControllerLike {
  list(): ClassificationRecord[]
  recentEvents(): ClassificationEvent[]
  correct(recordId: string, subject: string): Promise<ClassificationRecord[]>
  clear(): void
  onEvent(listener: (event: ClassificationEvent) => void): () => void
  /** 与配置对齐，返回当前是否处于可工作状态 */
  reconfigure(): boolean
}

/** 主动引导 / 敏感工具确认（docs/06 §5、§9） */
export interface ProactiveLike {
  /**
   * 敏感工具执行前的确认；勿扰时段内直接拒绝。
   * 返回值多一个 `'always'`（v13）：用户点了「本会话都允许」（docs/06 §11.2）。
   */
  requestSensitiveToolConfirm(input: {
    sessionId: string
    toolName: string
    input: unknown
  }): Promise<ConfirmResolution>
  /** 渲染层回执；`always = true` 且 `approved = true` 时升级为本会话授权 */
  resolve(confirmId: string, approved: boolean, always?: boolean): boolean
  /** 会话取消 / 退出时让在途确认立即失败 */
  rejectAll(reason: string): void
  onRequest(listener: (request: SensitiveToolRequest) => void): () => void
}

export interface AgentHost {
  send(request: SendMessageRequest & { extraContext?: string }): Promise<{ requestId: string }>
  abort(requestId: string): boolean
  onEvent(listener: (event: AgentEvent) => void): () => void
  isReady(): boolean
}

/** LLM 连接测试：由主进程用解密后的凭据构造 provider 后调用 */
export interface LlmTesterLike {
  test(request: {
    providerId?: string
    baseUrl?: string
    apiKey?: string
    model?: string
    withModels?: boolean
  }): Promise<{
    ok: boolean
    latencyMs: number
    message: string
    models?: string[]
    httpStatus?: number
  }>
  listModels(request: {
    providerId?: string
    baseUrl?: string
    apiKey?: string
    model?: string
  }): Promise<Array<{ id: string; ownedBy?: string }>>
}

/** 语音合成（TTS 朗读，docs/06 §13）：`TtsSynthesizer` 结构上满足 */
export interface TtsSynthesizerLike {
  synthesize(request: TtsSynthesizeRequest): Promise<TtsSynthesizeResult>
  test(request: TtsTestRequest): Promise<TtsTestResult>
  /** 「获取模型列表」（tts:listModels）：不抛，失败折 `ok: false + message` */
  listModels(request: TtsListModelsRequest): Promise<TtsListModelsResult>
}

/** 语音输入（STT 转写，Design/betav2-spec.md §8.2）：`createSttService` 的返回值满足 */
export interface SttServiceLike {
  transcribe(request: SttTranscribeRequest): Promise<SttTranscribeResult>
}

/** 图像生成（Design/betav2-spec.md §8.3）：`createImageGenService` 的返回值满足 */
export interface ImageGenServiceLike {
  generate(request: ImageGenGenerateRequest): Promise<ImageGenResult>
  read(request: ImageGenReadRequest): Promise<ImageGenReadResult>
}

export interface SkillsInfoLike {
  list(): SkillSummary[]
  setDisabled(names: readonly string[]): void
  /** 重新扫描（`skills:rescan`，docs/06 §6） */
  rescan(): Promise<SkillsStatus>
  /** 扫描状态：生效的用户目录、技能数、解析告警 */
  status(): SkillsStatus
  /** 设置变更后按新配置重解析目录并重扫（`skills.userDir` 生效路径） */
  reconfigure(settings: Settings): Promise<SkillsStatus>
}

/** 全局快捷键（docs/07 §5）：`HotkeyManager` 结构上满足 */
export interface HotkeyControllerLike {
  getStatus(): HotkeyStatus
  apply(hotkey: string): HotkeyStatus
  onChange(listener: (status: HotkeyStatus) => void): () => void
}

/** ClassIsland 桥接（docs/05 §3.4 v2）：`ClassIslandProvider` 结构上满足 */
export interface ClassIslandControllerLike {
  /** 桥接是否启用（配置里选了 classisland 且填了端点） */
  enabled(): boolean
  /**
   * 桥接状态（最后一次读取结果 + 缓存过期时的按需重读）。
   * 异步：缓存过期时接口自己会读一次桥接源（见 `ClassIslandProvider.refreshIfStale`），
   * 否则刚切到 ClassIsland 时右栏状态卡会空着等下一次感知摘要。
   */
  status(): Promise<ClassIslandStatus>
  /** 立即按当前配置解析一次 */
  test(): Promise<ClassIslandTestResult>
}

/** 会话列表 / 新建会话（`chat:sessions` / `chat:newSession`，docs/06 §4） */
export interface SessionListLike {
  listSessions(): Promise<ChatSessionSummary[]>
  createSession(): Promise<string>
}

/** 自动更新（docs/09）：主进程用 UpdateService，IPC 只依赖这个最小面 */
/** Aurora Center 连接器（docs/12）：状态快照 + 账号登录（v0.2.1，docs/12 §7） */
export interface CenterConnectionLike {
  status(): CenterConnectionStatus
  /** 账号登录：换客户端令牌写入凭据链路 + 记住账号 + 自动启用连接 */
  login(request: CenterLoginRequest): Promise<Result<CenterLoginResult>>
}

export interface UpdateControllerLike {
  getState(): UpdateState
  check(): Promise<UpdateState>
  download(): Promise<UpdateState>
  install(): boolean
  scheduleAutoCheck(): void
  onStateChanged(listener: (state: UpdateState) => void): () => void
  dispose(): void
}

export interface TrayLike {
  refresh(): void
}

export interface AppPaths {
  userData: string
  logs: string
  config: string
  builtinSkills: string
  userSkills: string
}
