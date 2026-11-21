/**
 * PlanService —— 会话级计划模式的状态机（docs/06 §29）。
 *
 * 只做三件事：会话状态（`meta.plan`）、计划文件（`PlanFileStore`）、运行中守卫。
 * 真正「把批准后的计划发给 Agent」在 `ipc.ts`（那里才有 `agent.send` 与事件链）；
 * 这里不 import Electron，可用内存端口单测。
 *
 * 几条硬约束：
 * - 进入 / 退出 / 批准都不允许在会话运行中发生（`onRoundStart` 会按新状态重算工具面）；
 * - `approve` 先退出计划模式再返回，调用方随后 `agent.send`，保证执行轮拿到正常工具面；
 * - `submit` **先写文件再写 meta**：不允许出现「有卡片但没有 md 文件」的计划；
 * - 旧 pending 记录在被新计划取代时标 `superseded`（文件保留，侧栏显示历史）。
 */
import { randomUUID } from 'node:crypto'
import type { Logger, SessionPlan, SessionPlanRecord } from '@aurora/shared'
import { createNoopLogger } from '@aurora/shared'
import { SUBMIT_PLAN_MAX_CHARS } from '@aurora/agent-core'
import type { PlanFileContent, PlanFileInfo, PlanFileStatus } from '@aurora/shared'
import type { PlanFileStore } from './files.js'

export type PlanModeErrorCode = 'E_BUSY' | 'E_INVALID_STATE' | 'E_INVALID_ARGUMENT'

export class PlanModeError extends Error {
  readonly code: PlanModeErrorCode

  constructor(code: PlanModeErrorCode, message: string) {
    super(message)
    this.name = 'PlanModeError'
    this.code = code
  }
}

/** `SessionStore` 的结构子集（单测可注入内存实现） */
export interface PlanStorePort {
  planOf(sessionId: string): Promise<SessionPlan>
  planOfSync(sessionId: string): SessionPlan
  setPlan(sessionId: string, plan: SessionPlan | null): Promise<void>
}

export interface PlanServiceOptions {
  sessions: PlanStorePort
  files: PlanFileStore
  /** 该会话是否正在跑请求（来自 agent.isBusy） */
  isBusy: (sessionId: string) => boolean
  logger?: Logger
  clock?: () => Date
}

export interface SubmitPlanInput {
  sessionId: string
  planId: string
  markdown: string
}

export interface PlanService {
  status(sessionId: string): Promise<SessionPlan>
  isActiveSync(sessionId: string): boolean
  setActive(sessionId: string, active: boolean): Promise<SessionPlan>
  submit(input: SubmitPlanInput): Promise<SessionPlan>
  approve(sessionId: string, planId: string): Promise<SessionPlan>
  restorePending(sessionId: string, planId: string): Promise<void>
  list(sessionId: string): Promise<PlanFileInfo[]>
  read(sessionId: string, planId: string): Promise<PlanFileContent>
  deleteSessionFiles(sessionId: string): Promise<void>
}

export function createPlanService(options: PlanServiceOptions): PlanService {
  return new PlanServiceImpl(options)
}

class PlanServiceImpl implements PlanService {
  private readonly sessions: PlanStorePort
  private readonly files: PlanFileStore
  private readonly isBusy: (sessionId: string) => boolean
  private readonly logger: Logger
  private readonly clock: () => Date

  constructor(options: PlanServiceOptions) {
    this.sessions = options.sessions
    this.files = options.files
    this.isBusy = options.isBusy
    this.logger = options.logger ?? createNoopLogger()
    this.clock = options.clock ?? (() => new Date())
  }

  async status(sessionId: string): Promise<SessionPlan> {
    return this.sessions.planOf(sessionId)
  }

  isActiveSync(sessionId: string): boolean {
    return this.sessions.planOfSync(sessionId).active
  }

  async setActive(sessionId: string, active: boolean): Promise<SessionPlan> {
    this.assertIdle(sessionId)
    const current = await this.sessions.planOf(sessionId)
    if (active) {
      if (current.active) return current
      const next: SessionPlan = {
        active: true,
        ...(current.record === undefined ? {} : { record: current.record }),
      }
      await this.sessions.setPlan(sessionId, next)
      return next
    }

    if (!current.active) return current
    const record = current.record
    if (record === undefined) {
      await this.sessions.setPlan(sessionId, null)
      return { active: false }
    }
    const nextRecord: SessionPlanRecord =
      record.status === 'pending' ? { ...record, status: 'exited', updatedAt: this.now() } : record
    const next: SessionPlan = { active: false, record: nextRecord }
    await this.sessions.setPlan(sessionId, next)
    if (nextRecord.status === 'exited') await this.syncFileStatus(sessionId, record.id, 'exited')
    return next
  }

  async submit(input: SubmitPlanInput): Promise<SessionPlan> {
    const sessionId = input.sessionId
    const current = await this.sessions.planOf(sessionId)
    if (!current.active) {
      throw new PlanModeError('E_INVALID_STATE', '当前不在计划模式：请先用 /plan 进入计划模式')
    }
    const markdown = input.markdown.trim()
    if (markdown === '') throw new PlanModeError('E_INVALID_ARGUMENT', '计划正文为空')
    if (!markdown.startsWith('#')) {
      throw new PlanModeError('E_INVALID_ARGUMENT', '计划必须以 # 标题开头')
    }
    if (markdown.length > SUBMIT_PLAN_MAX_CHARS) {
      throw new PlanModeError('E_INVALID_ARGUMENT', '计划正文过长')
    }

    const planId = input.planId.trim() === '' ? `plan-${randomUUID()}` : input.planId.trim()
    const now = this.now()
    const previous = current.record

    // 先写文件：文件写失败就不更新 meta（工具会报错，模型可重试）。
    // 旧 pending 的 superseded 标记也放在写文件**之后**：新文件没写成时不能把旧计划标成「已被取代」。
    await this.files.write({ sessionId, planId, markdown, status: 'pending' })
    const supersedePrevious =
      previous !== undefined && previous.id !== planId && previous.status === 'pending'
    if (supersedePrevious) {
      await this.syncFileStatus(sessionId, previous.id, 'superseded')
    }

    const record: SessionPlanRecord = {
      id: planId,
      markdown,
      status: 'pending',
      createdAt: previous?.id === planId ? previous.createdAt : now,
      updatedAt: now,
    }
    const next: SessionPlan = { active: true, record }
    try {
      await this.sessions.setPlan(sessionId, next)
    } catch (error) {
      // meta 没写成就把刚写的文件撤掉，避免一份只有文件、没有当前记录的计划；
      // 旧计划恢复为待批准（否则文件索引会留下一条被误标的 superseded）
      await this.files.remove(sessionId, planId).catch(() => undefined)
      if (supersedePrevious) {
        await this.syncFileStatus(sessionId, previous.id, 'pending')
      }
      throw error
    }
    return next
  }

  async approve(sessionId: string, planId: string): Promise<SessionPlan> {
    this.assertIdle(sessionId)
    const current = await this.sessions.planOf(sessionId)
    const record = current.record
    if (!current.active || record === undefined || record.id !== planId) {
      throw new PlanModeError('E_INVALID_STATE', '这条计划已不在可批准的状态（可能已被新计划取代）')
    }
    if (record.status !== 'pending') {
      throw new PlanModeError('E_INVALID_STATE', '这条计划已经处理过了，不能重复批准')
    }
    const approved: SessionPlanRecord = {
      ...record,
      status: 'approved',
      updatedAt: this.now(),
    }
    const next: SessionPlan = { active: false, record: approved }
    await this.sessions.setPlan(sessionId, next)
    await this.syncFileStatus(sessionId, planId, 'approved')
    return next
  }

  async restorePending(sessionId: string, planId: string): Promise<void> {
    try {
      const current = await this.sessions.planOf(sessionId)
      const record = current.record
      if (record === undefined || record.id !== planId || record.status !== 'approved') return
      const pending: SessionPlanRecord = { ...record, status: 'pending', updatedAt: this.now() }
      await this.sessions.setPlan(sessionId, { active: true, record: pending })
      await this.syncFileStatus(sessionId, planId, 'pending')
    } catch (error) {
      this.logger.warn('回滚计划为待批准失败', { sessionId, planId, error: String(error) })
    }
  }

  async list(sessionId: string): Promise<PlanFileInfo[]> {
    const [entries, current] = await Promise.all([
      this.files.list(sessionId),
      this.sessions.planOf(sessionId),
    ])
    const record = current.record
    if (record === undefined) return entries
    return entries.map((entry) =>
      entry.id === record.id ? { ...entry, status: record.status } : entry,
    )
  }

  async read(sessionId: string, planId: string): Promise<PlanFileContent> {
    const [content, current] = await Promise.all([
      this.files.read(sessionId, planId),
      this.sessions.planOf(sessionId),
    ])
    const record = current.record
    return record !== undefined && record.id === planId
      ? { ...content, status: record.status }
      : content
  }

  async deleteSessionFiles(sessionId: string): Promise<void> {
    try {
      await this.files.deleteSession(sessionId)
    } catch (error) {
      this.logger.warn('删除会话计划目录失败（不阻断会话删除）', {
        sessionId,
        error: String(error),
      })
    }
  }

  private assertIdle(sessionId: string): void {
    if (this.isBusy(sessionId)) {
      throw new PlanModeError('E_BUSY', '会话正在运行，等这次回复结束后再切换计划模式或批准计划')
    }
  }

  private async syncFileStatus(
    sessionId: string,
    planId: string,
    status: PlanFileStatus,
  ): Promise<void> {
    try {
      await this.files.setStatus(sessionId, planId, status)
    } catch (error) {
      // 文件索引状态是展示数据：失败不该让状态机失败；list/read 会用 meta 覆盖当前记录
      this.logger.warn('计划文件状态更新失败（会话状态已更新）', {
        sessionId,
        planId,
        status,
        error: String(error),
      })
    }
  }

  private now(): string {
    return this.clock().toISOString()
  }
}
