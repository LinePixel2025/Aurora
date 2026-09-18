/**
 * 对话式模式引导的运行器（docs/05 §2、docs/06 §9）。
 *
 * 职责：持有"下一步索引"，逐步把用户回答喂给 `IMode.guide.steps`，
 * 校验通过后写入配置；全部完成时置 `guideCompleted = true`。
 * 纯逻辑，可单测；载体窗口（交互窗 / 引导窗）由调用方决定。
 */
import type {
  GuideAnswerResult,
  GuideSession,
  GuideStepPayload,
  ModeContext,
  ModeId,
  ModeSummary,
  Settings,
} from '@aurora/shared'
import { createNoopLogger, type Logger } from '@aurora/shared'
import type { ModeManager } from './manager.js'

export interface GuideRunnerOptions {
  manager: ModeManager
  ctx: ModeContext
  logger?: Logger
}

export class GuideRunner {
  private readonly manager: ModeManager
  private readonly ctx: ModeContext
  private readonly logger: Logger
  private readonly cursors = new Map<ModeId, number>()

  constructor(options: GuideRunnerOptions) {
    this.manager = options.manager
    this.ctx = options.ctx
    this.logger = options.logger ?? createNoopLogger()
  }

  /** 开始或续接引导；已完成时返回 completed 会话。 */
  start(id: ModeId): GuideSession {
    const mode = this.manager.get(id)
    const guide = mode?.guide
    if (!mode || !guide) throw new Error(`模式 ${id} 没有可用的引导流程`)

    if (this.manager.isGuideCompleted(id)) {
      this.cursors.set(id, guide.steps.length)
      return this.session(id)
    }

    const cursor = this.cursors.get(id)
    if (cursor === undefined) {
      // 首次进入从第 0 步开始；续接时保留已有进度
      this.cursors.set(id, 0)
    }
    return this.session(id)
  }

  /** 重置到第一步（设置页「重新引导」）。 */
  reset(id: ModeId): GuideSession {
    this.cursors.set(id, 0)
    this.manager.resetGuide(id)
    return this.session(id)
  }

  /** 提交一步回答。 */
  answer(id: ModeId, answer: string): GuideAnswerResult {
    const mode = this.manager.get(id)
    const guide = mode?.guide
    if (!mode || !guide) throw new Error(`模式 ${id} 没有可用的引导流程`)

    const session = this.session(id)
    if (session.completed || session.step === null) {
      return { session, settings: this.ctx.settings.get() }
    }

    const step = guide.steps[session.nextIndex]
    if (!step) return { session, settings: this.ctx.settings.get() }

    const error = step.validate?.(answer, this.ctx)
    if (error !== undefined) {
      this.logger.info('引导回答未通过校验', { mode: id, step: step.id, error })
      return { session, error, settings: this.ctx.settings.get() }
    }

    try {
      step.apply?.(answer, this.ctx)
    } catch (applyError) {
      const message = applyError instanceof Error ? applyError.message : String(applyError)
      this.logger.error('引导写入配置失败', { mode: id, step: step.id, error: message })
      return { session, error: `保存失败：${message}`, settings: this.ctx.settings.get() }
    }

    const nextIndex = session.nextIndex + 1
    this.cursors.set(id, nextIndex)
    if (nextIndex >= guide.steps.length) {
      this.manager.completeGuide(id)
      this.logger.info('模式引导完成', { mode: id })
    }
    return { session: this.session(id), settings: this.ctx.settings.get() }
  }

  /** 由设置页 / 引导窗一次提交整份答案（例如引导窗为表单式）。 */
  answerAll(id: ModeId, answers: readonly string[]): GuideAnswerResult {
    let result: GuideAnswerResult = {
      session: this.start(id),
      settings: this.ctx.settings.get(),
    }
    for (const answer of answers) {
      result = this.answer(id, answer)
      if (result.error !== undefined) return result
    }
    return result
  }

  /** 当前会话状态（不改动游标）。 */
  session(id: ModeId): GuideSession {
    const mode = this.manager.get(id)
    const guide = mode?.guide
    if (!mode || !guide) throw new Error(`模式 ${id} 没有可用的引导流程`)

    const total = guide.steps.length
    const completed = this.manager.isGuideCompleted(id)
    const raw = completed ? total : (this.cursors.get(id) ?? 0)
    const nextIndex = Math.min(Math.max(raw, 0), total)
    const step = nextIndex < total ? guide.steps[nextIndex] : undefined

    return {
      mode: id,
      guideId: guide.id,
      resumeable: guide.resumeable,
      nextIndex,
      total,
      step: step
        ? this.toStepPayload(id, nextIndex, step.id, step.field, step.question, total)
        : null,
      completed: nextIndex >= total,
    }
  }

  /** 一次性拿到全部模式的引导摘要（渲染层启动时用）。 */
  summaries(): ModeSummary[] {
    return this.manager.list()
  }

  private toStepPayload(
    id: ModeId,
    index: number,
    stepId: string,
    field: string,
    question: string,
    total: number,
  ): GuideStepPayload {
    const currentValue = this.currentValueFor(id, field)
    return {
      index,
      total,
      stepId,
      field,
      question,
      ...(currentValue === undefined ? {} : { currentValue }),
    }
  }

  /** 让引导文案能显示当前值（如已有感知文件夹）。 */
  private currentValueFor(id: ModeId, field: string): string | undefined {
    const settings: Settings = this.ctx.settings.get()
    if (id !== 'classroom') return undefined
    if (field === 'modes.classroom.watchDir') {
      const value = settings.modes.classroom.watchDir
      return value === '' ? undefined : value
    }
    if (field === 'modes.classroom.subjects') {
      return settings.modes.classroom.subjects.map((s) => s.name).join('、') || undefined
    }
    if (field === 'modes.classroom.preClassReminder') {
      return settings.modes.classroom.preClassReminder ? '是' : '否'
    }
    return undefined
  }
}
