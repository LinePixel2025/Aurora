/**
 * 主进程内部依赖契约。
 *
 * 用结构化接口（而非具体类）声明依赖，便于单测与后续替换实现；
 * `WindowManager` / `ModeManager` / `GuideRunner` 在结构上天然满足这些接口。
 */
import type {
  AskUserAnswerInput,
  AskUserRequest,
  CenterConnectionStatus,
  AgentEvent,
  AutomationCatalog,
  AutomationDefinition,
  AutomationHistoryQuery,
  AutomationListResult,
  AutomationRun,
  FileAwarenessNote,
  FileAwarenessNoteContent,
  FileAwarenessNoteExpiry,
  FileAwarenessRecord,
  FileAwarenessStatus,
  FileAwarenessSuggestion,
  CenterDeviceLoginRequest,
  CenterDeviceLoginResult,
  CenterDeviceLoginStarted,
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
  LlmProviderType,
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
import type { CompactOutcome } from '@aurora/agent-core'
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
  /** 等待窗口加载完成后再推送 payload 并显示（自动化详情窗口打开链） */
  showWithPayload(name: WindowName, channel: string, payload: unknown): Promise<WindowState>
  /** 提示条收起态（8px 竖条）/ 展开态（面板）切换（docs/07 §2.2） */
  setEdgeBarExpanded(expanded: boolean): WindowState
  /** Windows 式标题栏：真最小化（chat / 设置；docs/02 §2.2） */
  minimize(name: WindowName): WindowState
  /** 切换最大化（标题栏双击 / caption 按钮） */
  toggleMaximize(name: WindowName): WindowState
  focus(name: WindowName): void
  /** 向已存在的指定窗口推送事件；窗口不存在时静默跳过。 */
  sendTo(name: WindowName, channel: string, payload: unknown): void
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

/**
 * `ask_user` 的装配层接口（docs/06 §21）。
 *
 * 只声明 IPC 需要的那两面：`resolve`（回执）与 `onRequest`（推送）。
 * 内核那侧用的 `ask()` 端口在 `main/ask-user.ts` 里（那是完整的服务类型），
 * 这里刻意不把整个服务塞进契约 —— 契约面越小，越不会被别处顺手当成万能入口。
 */
export interface AskUserLike {
  /** 渲染层回执；已结算 / 未知 id 返回 false（幂等） */
  resolve(input: AskUserAnswerInput): boolean
  onRequest(listener: (request: AskUserRequest) => void): () => void
}

export interface AgentHost {
  /**
   * `images`（多模态输入，docs/06 §3.1）：本轮的**图片附件路径**，由 `ipc.ts` 按扩展名挑出、
   * 并已按当前生效模型的 `modelParams.<模型 id>.vision`（v23 起按模型绑定）判定过是否下发；内核经注入的 `loadImages` 读成内容。
   */
  send(
    request: SendMessageRequest & { extraContext?: string; images?: readonly string[] },
  ): Promise<{ requestId: string }>
  abort(requestId: string): boolean
  onEvent(listener: (event: AgentEvent) => void): () => void
  isReady(): boolean
  /** 该会话是否正在跑请求（`/compact` 的 E_BUSY 判定用；`KernelAgentHost.isBusy`） */
  isBusy(sessionId: string): boolean
  /**
   * 手动压缩会话上下文（`/compact`，docs/06 §4）：把全部消息压成摘要写进 `meta.compact`，
   * 此后组装请求只取压缩点之后的消息。**不抛错**：结局用 `CompactOutcome` 表达。
   */
  compact(sessionId: string): Promise<CompactOutcome>
}

/** LLM 连接测试：由主进程用解密后的凭据构造 provider 后调用 */
export interface LlmTesterLike {
  test(request: {
    providerId?: string
    baseUrl?: string
    apiKey?: string
    model?: string
    /** 接口协议（v22）：渲染层把正在编辑的类型一并送来，未保存也能测到正确的端点 */
    type?: LlmProviderType
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
    type?: LlmProviderType
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

/** 自动化（docs/13 §9）：引擎（`main/automation/engine.ts`）暴露给 IPC 的最小面 */
export interface AutomationControllerLike {
  list(): Promise<AutomationListResult>
  save(
    input: unknown,
  ): Promise<{ ok: true; definition: AutomationDefinition } | { ok: false; error: string }>
  delete(id: string): Promise<{ ok: boolean; error?: string }>
  history(query?: AutomationHistoryQuery): Promise<AutomationRun[]>
  run(id: string): Promise<{ ok: true; runId: string } | { ok: false; error: string }>
  catalog(): AutomationCatalog
  /** 定义变化（IPC 层广播 `automation:changed`） */
  onDefinitionsChanged(listener: () => void): () => void
  /** 运行记录变化（IPC 层广播 `automation:historyChanged`） */
  onHistoryChanged(listener: () => void): () => void
}

/** 文件自感知（docs/06 §26）：IPC 与设置页只依赖这一小面。 */
export interface FileAwarenessControllerLike {
  status(): FileAwarenessStatus
  records(limit?: number): FileAwarenessRecord[]
  notes(limit?: number): FileAwarenessNote[]
  readNote(noteId: string): Promise<FileAwarenessNoteContent>
  setNoteExpiry(noteId: string, expiry: FileAwarenessNoteExpiry): FileAwarenessNote
  analyzeNow(path: string): Promise<boolean>
  ignoreSuggestion(id: string): boolean
  suggestion(id: string): FileAwarenessSuggestion | undefined
  knowledgeDir(): string
  openNote(noteId: string): Promise<string>
  openSource(noteId: string): Promise<string>
  clearHistory(): void
  resetAll(): Promise<void>
  scanNow(): Promise<number>
  reconfigure(): Promise<void>
  flush(): Promise<void>
  onChanged(listener: () => void): () => void
  onSuggestion(listener: (suggestion: FileAwarenessSuggestion) => void): () => void
}

/** 自动更新（docs/09）：主进程用 UpdateService，IPC 只依赖这个最小面 */
/** Aurora Center 连接器（docs/12）：状态快照 + 账号 / 设备授权登录（docs/12 §3/§4.3/§7） */
export interface CenterConnectionLike {
  status(): CenterConnectionStatus
  /** 账号登录：换客户端令牌写入凭据链路 + 记住账号 + 自动启用连接 */
  login(request: CenterLoginRequest): Promise<Result<CenterLoginResult>>
  /** 设备授权登录：打开确认页并后台轮询，立即回执；最终结果走 onDeviceLoginResult 推送 */
  deviceLogin(request: CenterDeviceLoginRequest): Promise<Result<CenterDeviceLoginStarted>>
  /** 设备授权登录的最终结果推送（on/off 成对） */
  onDeviceLoginResult(listener: (result: CenterDeviceLoginResult) => void): () => void
  /** 取消在途的设备授权轮询（幂等） */
  deviceLoginCancel(): Promise<Result<boolean>>
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
