/**
 * 主进程内部依赖契约。
 *
 * 用结构化接口（而非具体类）声明依赖，便于单测与后续替换实现；
 * `WindowManager` / `ModeManager` / `GuideRunner` 在结构上天然满足这些接口。
 */
import type {
  AgentEvent,
  GuideAnswerResult,
  GuideSession,
  Logger,
  ModeChangedEvent,
  ModeId,
  ModeSummary,
  OpenPathRequest,
  PerceptionSummary,
  SendMessageRequest,
  Settings,
  UpdateState,
  WindowName,
  WindowState,
} from '@aurora/shared'

/** 也用于 agent-host 的最小依赖面 */
export type {
  AgentEvent,
  GuideAnswerResult,
  GuideSession,
  Logger,
  ModeChangedEvent,
  ModeId,
  ModeSummary,
  OpenPathRequest,
  PerceptionSummary,
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
