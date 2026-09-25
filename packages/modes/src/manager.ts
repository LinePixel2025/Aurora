/**
 * ModeManager（docs/05 §1.2、§2）。
 *
 * 纯逻辑：配置、窗口、引导、文件系统全部通过端口注入，可独立单测。
 * 切换流程：前置校验 → 落盘 → onDeactivate(旧) → onActivate(新) → 广播；
 * 任一步失败则回滚到旧模式并向调用方返回错误。
 */
import {
  MODE_IDS,
  createNoopLogger,
  type IMode,
  type Logger,
  type ModeContext,
  type ModeId,
  type ModeSummary,
  type Settings,
} from '@aurora/shared'

export interface ModeSwitchListener {
  (event: {
    current: ModeId
    previous: ModeId | null
    reason: 'user' | 'onboarding' | 'system'
    modes: ModeSummary[]
  }): void
}

export class ModeManager {
  private readonly modes = new Map<ModeId, IMode>()
  private readonly listeners = new Set<ModeSwitchListener>()
  private readonly logger: Logger
  private ctx: ModeContext | undefined

  constructor(logger?: Logger) {
    this.logger = logger ?? createNoopLogger()
  }

  /**
   * 装配模式并绑定上下文。启动时对当前模式执行一次 `onActivate`；
   * 失败只记日志（不阻塞启动，docs/02 §7 降级原则）。
   */
  async init(ctx: ModeContext): Promise<ModeSummary[]> {
    this.ctx = ctx
    const current = ctx.settings.get().modes.current
    const mode = this.modes.get(current)
    if (mode) {
      try {
        await mode.onActivate(ctx)
      } catch (error) {
        this.logger.error('启动时激活当前模式失败', { mode: current, error: String(error) })
      }
    } else {
      this.logger.warn('当前模式未注册，保持未激活状态', { mode: current })
    }
    return this.list()
  }

  register(mode: IMode): void {
    if (this.modes.has(mode.id)) {
      this.logger.warn('模式重复注册，已忽略', { mode: mode.id })
      return
    }
    this.modes.set(mode.id, mode)
    this.logger.debug('模式已注册', { mode: mode.id })
  }

  get(id: ModeId): IMode | undefined {
    return this.modes.get(id)
  }

  currentId(): ModeId {
    return this.requireCtx().settings.get().modes.current
  }

  list(): ModeSummary[] {
    const settings = this.requireCtx().settings.get()
    return MODE_IDS.filter((id) => this.modes.has(id)).map((id) =>
      this.summarize(this.modes.get(id)!, settings),
    )
  }

  get current(): IMode {
    const id = this.currentId()
    const mode = this.modes.get(id)
    if (!mode) throw new Error(`当前模式 ${id} 未注册`)
    return mode
  }

  /** 当前模式的摘要（供托盘 / 服务窗 / Agent 提示词读取）。 */
  currentSummary(): ModeSummary {
    const settings = this.requireCtx().settings.get()
    const mode = this.modes.get(this.currentId())
    if (!mode) {
      throw new Error(`当前模式 ${this.currentId()} 未注册`)
    }
    return this.summarize(mode, settings)
  }

  onChange(listener: ModeSwitchListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 当前模式的系统提示词片段（上下文组装时调用，docs/06 §5）。 */
  systemPrompt(): string {
    try {
      return this.current.systemPrompt(this.requireCtx())
    } catch (error) {
      this.logger.warn('生成模式提示词失败', { error: String(error) })
      return ''
    }
  }

  /** 切换模式；失败时回滚到原模式并返回 `ok: false`。 */
  async setCurrent(
    id: ModeId,
    reason: 'user' | 'onboarding' | 'system' = 'user',
  ): Promise<
    | { ok: true; current: ModeId; guideRequired: boolean; modes: ModeSummary[] }
    | { ok: false; message: string; current: ModeId; modes: ModeSummary[] }
  > {
    const ctx = this.requireCtx()
    const next = this.modes.get(id)
    if (!next) {
      return {
        ok: false,
        message: `模式 ${id} 未注册`,
        current: this.currentId(),
        modes: this.list(),
      }
    }

    const previousId = this.currentId()
    if (previousId === id) {
      return {
        ok: true,
        current: id,
        guideRequired: !this.isGuideCompleted(id),
        modes: this.list(),
      }
    }
    const previous = this.modes.get(previousId)

    const persisted = ctx.settings.mutate((draft) => {
      draft.modes.current = id
    })
    if (!persisted) {
      return {
        ok: false,
        message: '配置校验失败，模式未切换',
        current: previousId,
        modes: this.list(),
      }
    }

    try {
      if (previous) await previous.onDeactivate(ctx)
      await next.onActivate(ctx)
    } catch (error) {
      this.logger.error('模式激活失败，回滚', { from: previousId, to: id, error: String(error) })
      ctx.settings.mutate((draft) => {
        draft.modes.current = previousId
      })
      if (previous) {
        try {
          await previous.onActivate(ctx)
        } catch (rollbackError) {
          this.logger.error('回滚激活旧模式失败', {
            mode: previousId,
            error: String(rollbackError),
          })
        }
      }
      return {
        ok: false,
        message: `切换到 ${next.displayName} 失败：${error instanceof Error ? error.message : String(error)}`,
        current: previousId,
        modes: this.list(),
      }
    }

    const guideRequired = !this.isGuideCompleted(id)
    this.emit({ current: id, previous: previousId, reason, modes: this.list() })
    return { ok: true, current: id, guideRequired, modes: this.list() }
  }

  /** 引导是否已完成（docs/05 §2）。 */
  isGuideCompleted(id: ModeId): boolean {
    const settings = this.requireCtx().settings.get()
    switch (id) {
      case 'classroom':
        return settings.modes.classroom.guideCompleted
      case 'work':
        return settings.modes.work.guideCompleted
      case 'code':
        return settings.modes.code.guideCompleted
      default:
        return true
    }
  }

  /** 标记引导完成并广播（设置页 / 对话引导结束时调用）。 */
  completeGuide(id: ModeId): ModeSummary[] {
    const ctx = this.requireCtx()
    ctx.settings.mutate((draft) => {
      if (id === 'classroom') draft.modes.classroom.guideCompleted = true
      if (id === 'work') draft.modes.work.guideCompleted = true
      if (id === 'code') draft.modes.code.guideCompleted = true
    })
    this.emit({ current: this.currentId(), previous: null, reason: 'system', modes: this.list() })
    return this.list()
  }

  /** 重置引导状态（设置页「重新引导」）。 */
  resetGuide(id: ModeId): ModeSummary[] {
    const ctx = this.requireCtx()
    ctx.settings.mutate((draft) => {
      if (id === 'classroom') draft.modes.classroom.guideCompleted = false
      if (id === 'work') draft.modes.work.guideCompleted = false
      if (id === 'code') draft.modes.code.guideCompleted = false
    })
    return this.list()
  }

  /** 切换后若引导未完成，请求 Proactive 主动发起对话（docs/06 §9）。 */
  requestGuideIfNeeded(id: ModeId, reason: string): boolean {
    const guide = this.modes.get(id)?.guide
    if (!guide || this.isGuideCompleted(id)) return false
    this.requireCtx().proactive.requestGuide(id, reason)
    return true
  }

  /** 引导步骤 → 面向用户的说明文本（设置页展示用）。 */
  guideSteps(id: ModeId): string[] {
    return (this.modes.get(id)?.guide?.steps ?? []).map((step) => step.field)
  }

  private summarize(mode: IMode, settings: Settings): ModeSummary {
    const readiness = this.readiness(mode.id, settings)
    return {
      id: mode.id,
      displayName: mode.displayName,
      description: mode.description,
      ...(mode.icon === undefined ? {} : { icon: mode.icon }),
      guideCompleted: this.isGuideCompleted(mode.id),
      guideResumeable: mode.guide?.resumeable ?? false,
      placeholder: mode.placeholder,
      active: settings.modes.current === mode.id,
      guideSteps: (mode.guide?.steps ?? []).map((step) => step.field),
      ready: readiness.ready,
      ...(readiness.hint === undefined ? {} : { readinessHint: readiness.hint }),
    }
  }

  /**
   * 模式核心能力前提。实质校验只做 classroom（感知文件夹 + 科目）；
   * work 的 workspaceDir 未配置也能正常对话（产出落点待定），故暂视为就绪；
   * 更细的缺失项由 classroomReadiness / workReadiness 供设置页展示。
   */
  private readiness(id: ModeId, settings: Settings): { ready: boolean; hint?: string } {
    if (id !== 'classroom') return { ready: true }
    const missing: string[] = []
    if (settings.modes.classroom.watchDir.trim() === '') missing.push('智慧感知文件夹')
    if (settings.modes.classroom.subjects.length === 0) missing.push('科目列表')
    if (missing.length === 0) return { ready: true }
    return { ready: false, hint: `还缺少：${missing.join('、')}` }
  }

  private emit(event: {
    current: ModeId
    previous: ModeId | null
    reason: 'user' | 'onboarding' | 'system'
    modes: ModeSummary[]
  }): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        this.logger.warn('模式监听器抛错', { error: String(error) })
      }
    }
  }

  private requireCtx(): ModeContext {
    if (!this.ctx) throw new Error('ModeManager 尚未初始化，请先调用 init(ctx)')
    return this.ctx
  }
}
