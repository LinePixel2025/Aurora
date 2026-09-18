/**
 * 主进程内部依赖契约。
 *
 * 用结构化接口（而非具体类）声明依赖，便于单测与后续替换实现；
 * `WindowManager` / `ModeManager` / `GuideRunner` 在结构上天然满足这些接口。
 */
import type {
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
} from '@aurora/shared'

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
  showMiniChat(): WindowState
  setPosition(name: WindowName, position: { x: number; y: number }): WindowState
  /** 服务窗收起态（圆形浮球）/ 展开态（输入条）切换（docs/07 §2.1） */
  setDockExpanded(expanded: boolean): WindowState
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
  /** 敏感工具执行前的确认；勿扰时段内直接拒绝 */
  requestSensitiveToolConfirm(input: {
    sessionId: string
    toolName: string
    input: unknown
  }): Promise<boolean>
  /** 渲染层回执 */
  resolve(confirmId: string, approved: boolean): boolean
  /** 会话取消 / 退出时让在途确认立即失败 */
  rejectAll(reason: string): void
  onRequest(listener: (request: SensitiveToolRequest) => void): () => void
}

export interface AgentHost {
  send(request: SendMessageRequest): Promise<{ requestId: string }>
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

export interface SkillsInfoLike {
  list(): Array<{
    name: string
    description: string
    whenToUse?: string
    source: 'builtin' | 'user'
    hasScripts: boolean
    enabled: boolean
    dir: string
  }>
  setDisabled(names: readonly string[]): void
}

/** 自动更新（docs/09）：主进程用 UpdateService，IPC 只依赖这个最小面 */
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
