/**
 * 模式系统契约（docs/05 §1.1）。
 *
 * `packages/modes` 只能依赖本文件的类型与其自身实现：
 * 系统能力（窗口、感知、Agent）以接口注入，保证核心逻辑可单测、不依赖 Electron。
 */
import type { Settings } from '../config/schema.js'
import type { ModeId } from '../ipc/types.js'
import type { Logger } from '../utils/logger.js'

/** 配置读写端口：实现由主进程 SettingsStore 提供。 */
export interface ModeSettingsPort {
  get(): Settings
  /** 在副本上修改并落盘；返回 undefined 表示校验失败。 */
  mutate(mutator: (draft: Settings) => void): Settings | undefined
}

/** 窗口控制端口：主进程 WindowManager 提供。 */
export interface ModeWindowPort {
  showChat(): void
  notify(title: string, body: string, openPath?: string): void
}

/** 主动引导端口（docs/06 §9）：P1 只用于模式引导。 */
export interface ModeProactivePort {
  requestGuide(mode: ModeId, reason: string): void
  cancelGuide(mode: ModeId): void
}

/** 文件系统端口：模式实现用它校验 / 创建用户填写的目录（不依赖 Electron）。 */
export interface ModeFsPort {
  exists(path: string): Promise<boolean>
  isDirectory(path: string): Promise<boolean>
  ensureDir(path: string): Promise<void>
  /** 注入 home / userData，用于把 `~` 与相对路径解析为绝对路径 */
  resolveUserPath(path: string): string
}

export interface ModeContext {
  settings: ModeSettingsPort
  windows: ModeWindowPort
  proactive: ModeProactivePort
  fs: ModeFsPort
  logger: Logger
  /** 引导过程中的临时状态（如已收集的科目列表），跨步骤共享 */
  state: Map<string, unknown>
}

export interface GuideStep {
  id: string
  /** 向用户提问的文案（由 AI 在对话中提出） */
  question: string
  /** 配置字段说明，供设置页与引导实现对齐 */
  field: string
  /** 校验用户答案；返回错误信息表示不通过 */
  validate?(answer: string, ctx: ModeContext): string | undefined
  /** 把答案写入配置 */
  apply?(answer: string, ctx: ModeContext): void
}

export interface ModeGuide {
  id: string
  /** 可中断续接（docs/05 §2） */
  resumeable: boolean
  steps: GuideStep[]
}

export interface PerceptionSubscription {
  kind: 'clock' | 'power' | 'network' | 'foreground' | 'schedule'
  intervalMs?: number
}

export interface IMode {
  id: ModeId
  displayName: string
  description: string
  icon?: string
  /** v1 中 work / code 为占位实现 */
  placeholder: boolean
  guide?: ModeGuide
  onActivate(ctx: ModeContext): Promise<void>
  onDeactivate(ctx: ModeContext): Promise<void>
  systemPrompt(ctx: ModeContext): string
  perceptionSubscriptions?: PerceptionSubscription[]
}
