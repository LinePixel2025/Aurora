/**
 * 自动化引擎（docs/13 §3 / §6）。
 *
 * 主进程常驻服务：按固定节拍（默认 15s）评估所有启用的自动化 → 去重触发 →
 * 执行（Normal = 顺序执行操作组件；Agent = 创建专属会话跑一次完整 Agent 会话）→
 * 记录运行历史。ClassRoom 既有的课前提醒 / 课前自动打开科目文件夹由**内置自动化**
 * 承接（`PreClassReminder` 服务的语义等价迁移，docs/13 §6）。
 *
 * 约定：
 * - 引擎常驻，不随模式启停；每次 tick 前现读配置（总开关 / 模式 / 课表参数）——
 *   「改了没反应、要重启」是本仓库明令禁止的坑；
 * - firedKeys **按自动化隔离**（两个内置共用 lessonKey，共用一个集合会互相挡），
 *   条目 48h TTL + 容量上限（lessonKey 每周重复，TTL 保证下周不误挡）；
 * - 先记键再执行副作用（失败不重试，防 15s 刷屏 —— 同旧课前提醒口径）；
 * - Agent 会话的敏感工具确认走既有确认链：无人值守时 60s 超时默认拒绝，
 *   不新增静默放行通道（docs/13 §3）；
 * - 纯 Node：Agent / 通知 / 桥接 / 文件系统全部注入，可完整单测。
 */
import type {
  AgentEvent,
  AutomationDefinition,
  AutomationHistoryQuery,
  AutomationRun,
} from '@aurora/shared'
import type { Settings } from '@aurora/shared'
import { createNoopLogger, type Logger } from '@aurora/shared'
import { isQuietHour } from '../proactive.js'
import { needsNextDayLessons, type IScheduleProvider, type Lesson } from '../schedule.js'
import { executeAction, type AutomationActionPorts } from './actions.js'
import {
  buildCatalog,
  isRunsExhausted,
  normalizeDefinition,
  validateDefinition,
} from './catalog.js'
import { evaluateTrigger, type TriggerContext, type TriggerEvaluation } from './conditions.js'
import { AUTOMATION_SESSION_PREFIX, isAutomationSession } from './session-id.js'
import type { AutomationStore } from './store.js'

/** 内置自动化 id（`builtin.` 前缀保留；用户自建定义禁止使用） */
export const BUILTIN_PRE_CLASS_NOTIFY_ID = 'builtin.pre-class-notify'
export const BUILTIN_PRE_CLASS_OPEN_FOLDER_ID = 'builtin.pre-class-open-folder'
export const BUILTIN_IDS = [BUILTIN_PRE_CLASS_NOTIFY_ID, BUILTIN_PRE_CLASS_OPEN_FOLDER_ID] as const

/**
 * Agent 会话 / 运行记录的 id 前缀（渲染层据此把 auto- 会话排除在左栏之外）。
 * 常量与判据都在 `session-id.ts`（提示词运行档与工具层拒绝也依赖它，见文件注释）。
 */
export { AUTOMATION_SESSION_PREFIX, isAutomationSession }
/** 内置自动化的保留 id 前缀 */
export const BUILTIN_ID_PREFIX = 'builtin.'

export const DEFAULT_TICK_INTERVAL_MS = 15_000
/** Agent 运行的兜底超时：超时按失败收尾并 abort（正常由 done / error 事件收尾） */
export const DEFAULT_MAX_AGENT_RUN_MS = 30 * 60_000
/** firedKeys 条目保留时长：跨周重复的 lessonKey 必须先过期 */
const FIRED_KEY_TTL_MS = 48 * 60 * 60_000
/** firedKeys 容量上限（防异常参数把集合撑大） */
const FIRED_KEY_CAP = 256

/** 触发器里依赖课程表的 kind（决定本轮是否要取课程数据） */
const SCHEDULE_TRIGGER_KINDS = new Set([
  'pre-class',
  'class-start',
  'pre-end',
  'class-end',
  'next-lesson',
])

/** 引擎需要的 Agent 能力（`DesktopAgentHost` 的子集；`origin` 固定为 automation） */
export interface AutomationAgentPort {
  send(request: {
    sessionId: string
    text: string
    origin: 'automation'
    extraContext?: string
  }): Promise<{ requestId: string }>
  abort(requestId: string): boolean
  onEvent(listener: (event: AgentEvent) => void): () => void
}

export interface AutomationEngineOptions {
  store: AutomationStore
  agent: AutomationAgentPort
  /** 每次现读全量设置（总开关 / 当前模式 / 课表参数 / 勿扰 / 科目表都在里面） */
  settings: () => Settings
  /** 每次现读课程表 provider（设置改完即生效，同旧课前提醒） */
  provider: () => IScheduleProvider
  actions: AutomationActionPorts
  logger?: Logger
  intervalMs?: number
  clock?: () => Date
  maxAgentRunMs?: number
  onDefinitionsChanged?: () => void
  onHistoryChanged?: () => void
  /**
   * 每次运行记录**落库或状态变化**时回调（终态与 running 各一次）。
   * 自测据此断言「触发 → 落历史 → 收尾」链路（`smokeDiagnostics.automationRuns`）。
   */
  onRunRecorded?: (run: AutomationRun) => void
  /** smoke 自测钩子：内置课前提醒触发（与旧 `PreClassReminder.onFired` 同形状） */
  onBuiltinFired?: (info: {
    builtinId: string
    subject: string
    minutesUntil: number
    targetDir: string
  }) => void
}

/** 内置自动化的运行时规格：启用条件与副作用都是动态（现读设置，docs/13 §6） */
interface BuiltinSpec {
  id: string
  /** 每次评估现读：模式门控 + 既有配置开关 */
  enabled(settings: Settings): boolean
  /** 勿扰时段内跳过（旧课前提醒语义） */
  quietHoursGate: boolean
  /** 执行副作用（触发时调用；失败只记日志） */
  execute(evaluation: TriggerEvaluation, settings: Settings, ctx: BuiltinRunContext): Promise<void>
}

/** 内置自动化执行时拿到的引擎能力 */
interface BuiltinRunContext {
  ports: AutomationActionPorts
  logger: Logger
  onBuiltinFired: AutomationEngineOptions['onBuiltinFired']
}

export class AutomationEngine {
  private readonly store: AutomationStore
  private readonly agent: AutomationAgentPort
  private readonly settings: () => Settings
  private readonly provider: () => IScheduleProvider
  private readonly actions: AutomationActionPorts
  private readonly logger: Logger
  private readonly intervalMs: number
  private readonly clock: () => Date
  private readonly maxAgentRunMs: number
  private readonly onDefinitionsChanged?: () => void
  private readonly onHistoryChanged?: () => void
  private readonly onRunRecorded?: AutomationEngineOptions['onRunRecorded']
  private readonly onBuiltinFired?: AutomationEngineOptions['onBuiltinFired']

  /** 每个自动化的已触发键集合（键 → 加入时刻，TTL 清理） */
  private readonly firedKeys = new Map<string, Map<string, number>>()
  /** 在途 Agent 运行：sessionId → run 信息 */
  private readonly pendingAgentRuns = new Map<
    string,
    { runId: string; requestId: string; startedAt: number; timer?: NodeJS.Timeout }
  >()
  private timer?: NodeJS.Timeout
  private ticking = false
  private unsubscribe?: () => void
  private idCounter = 0

  constructor(options: AutomationEngineOptions) {
    this.store = options.store
    this.agent = options.agent
    this.settings = options.settings
    this.provider = options.provider
    this.actions = options.actions
    this.logger = options.logger ?? createNoopLogger()
    this.intervalMs = Math.max(1_000, options.intervalMs ?? DEFAULT_TICK_INTERVAL_MS)
    this.clock = options.clock ?? (() => new Date())
    this.maxAgentRunMs = Math.max(1_000, options.maxAgentRunMs ?? DEFAULT_MAX_AGENT_RUN_MS)
    this.onDefinitionsChanged = options.onDefinitionsChanged
    this.onHistoryChanged = options.onHistoryChanged
    this.onRunRecorded = options.onRunRecorded
    this.onBuiltinFired = options.onBuiltinFired
    // 事件订阅在**构造期**建立（而不是 start()）：引擎一旦存在就要收自己发起的运行的终态，
    // 否则「构造完成 → start() 之间」落下的 done / error 会让历史永远停在 running。
    // start() 仍会兜底补订阅（stop() 之后可重新 start），重复订阅由 unsubscribe 标记避免。
    this.unsubscribe = this.agent.onEvent((event) => this.handleAgentEvent(event))
  }

  // ───────────────────────── 生命周期 ─────────────────────────

  start(): void {
    if (this.unsubscribe === undefined) {
      this.unsubscribe = this.agent.onEvent((event) => this.handleAgentEvent(event))
    }
    if (this.timer !== undefined) return
    void this.store
      .markInterruptedRuns()
      .then((changed) => {
        if (changed > 0) {
          this.logger.info('自动化历史启动补偿', { interrupted: changed })
          this.onHistoryChanged?.()
        }
      })
      .catch((error: unknown) => {
        this.logger.warn('自动化历史启动补偿失败', { error: String(error) })
      })
    void this.tick().catch((error: unknown) => {
      this.logger.warn('自动化检查失败', { error: String(error) })
    })
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.logger.warn('自动化检查失败', { error: String(error) })
      })
    }, this.intervalMs)
    this.timer.unref?.()
    this.logger.debug('自动化引擎已启动', { intervalMs: this.intervalMs })
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    this.unsubscribe?.()
    this.unsubscribe = undefined
    for (const pending of this.pendingAgentRuns.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer)
    }
    this.pendingAgentRuns.clear()
  }

  /** 跑一次评估（单测入口）。互斥：上一轮未结束时直接跳过。 */
  async tick(now: Date = this.clock()): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const settings = this.settings()
      if (!settings.automations.enabled) return

      const definitions = await this.store.listDefinitions()
      const enabled = definitions.filter((item) => item.enabled)
      const builtins = BUILTIN_SPECS.filter((spec) => spec.enabled(settings))
      const needsSchedule =
        enabled.some((item) => SCHEDULE_TRIGGER_KINDS.has(item.trigger.kind)) || builtins.length > 0
      const ctx: TriggerContext = needsSchedule
        ? { now, lessons: await this.collectLessons(now, enabled, settings) }
        : { now, lessons: [] }

      for (const definition of enabled) {
        const evaluation = evaluateTrigger(definition.trigger, ctx)
        if (!evaluation.matched || evaluation.key === null) continue
        const keys = this.keysOf(definition.id)
        if (keys.has(evaluation.key)) continue
        keys.set(evaluation.key, now.getTime())
        this.pruneKeys(keys, now.getTime())
        await this.runDefinition(definition, evaluation.detail)
      }

      for (const spec of builtins) {
        const evaluation = evaluateTrigger(
          {
            kind: 'pre-class',
            params: { leadMinutes: settings.modes.classroom.preClassLeadMinutes },
          },
          ctx,
        )
        if (!evaluation.matched || evaluation.key === null) continue
        const keys = this.keysOf(spec.id)
        if (keys.has(evaluation.key)) continue
        keys.set(evaluation.key, now.getTime())
        await this.fireBuiltin(spec, evaluation, settings)
      }
    } finally {
      this.ticking = false
    }
  }

  // ───────────────────────── 定义 CRUD ─────────────────────────

  async listDefinitions(): Promise<AutomationDefinition[]> {
    return this.store.listDefinitions()
  }

  /** 内置自动化（展示形状；enabled / 提前分钟数现读，UI 直接渲染）。 */
  listBuiltin(): AutomationDefinition[] {
    const settings = this.settings()
    const lead = settings.modes.classroom.preClassLeadMinutes
    const classroom = settings.modes.current === 'classroom'
    return [
      {
        id: BUILTIN_PRE_CLASS_NOTIFY_ID,
        name: '课前提醒',
        enabled: classroom && settings.modes.classroom.preClassReminder,
        mode: 'normal',
        trigger: { kind: 'pre-class', params: { leadMinutes: lead } },
        actions: [{ kind: 'system-notify', params: { title: '课前提醒' } }],
        createdAt: '',
        updatedAt: '',
      },
      {
        id: BUILTIN_PRE_CLASS_OPEN_FOLDER_ID,
        name: '课前打开科目文件夹',
        enabled: classroom && settings.modes.classroom.preClassOpenFolder,
        mode: 'normal',
        trigger: { kind: 'pre-class', params: { leadMinutes: lead } },
        actions: [{ kind: 'open-folder', params: { target: 'subject' } }],
        createdAt: '',
        updatedAt: '',
      },
    ]
  }

  /** 校验并保存（id 为空 = 新建）。非法定义返回错误文案，绝不写半份数据。 */
  async saveDefinition(
    input: unknown,
  ): Promise<{ ok: true; definition: AutomationDefinition } | { ok: false; error: string }> {
    const result = validateDefinition(input, this.catalog())
    if (!result.ok) return { ok: false, error: result.error ?? '定义不合法' }
    const record = (input as Record<string, unknown>) ?? {}
    const rawId = typeof record['id'] === 'string' ? record['id'] : ''
    if (rawId.startsWith(BUILTIN_ID_PREFIX)) {
      return { ok: false, error: '内置自动化不可修改' }
    }
    const definition = normalizeDefinition(record)
    if (definition.id === '') definition.id = this.generateId('am')
    else {
      // 缺字段 = 保持原值（v0.2.8）：保存通道是"整份替换"语义，但调用侧未必知道新字段
      // 的存在 —— 漏 `runCount` 会把已调用次数清零、漏 `maxRuns` 会把上限悄悄改成不限。
      // 显式给 0 才表示"不限 / 清零"（0 是合法值，与"没给"必须区分开）。
      const existing = await this.store.getDefinition(definition.id)
      if (existing !== undefined) {
        if (record['runCount'] === undefined) definition.runCount = existing.runCount ?? 0
        if (record['maxRuns'] === undefined) definition.maxRuns = existing.maxRuns ?? 0
      }
    }
    const saved = await this.store.saveDefinition(definition)
    this.keysOf(saved.id).clear()
    this.onDefinitionsChanged?.()
    return { ok: true, definition: saved }
  }

  async deleteDefinition(id: string): Promise<{ ok: boolean; error?: string }> {
    if (id.startsWith(BUILTIN_ID_PREFIX)) {
      return { ok: false, error: '内置自动化不可删除' }
    }
    const removed = await this.store.deleteDefinition(id)
    if (!removed) return { ok: false, error: '自动化不存在' }
    this.firedKeys.delete(id)
    this.onDefinitionsChanged?.()
    return { ok: true }
  }

  /** 重新读盘（自测夹具在启动后写盘时用；生产路径不需要，见 AutomationStore.reload）。 */
  async reload(): Promise<void> {
    await this.store.reload()
    this.firedKeys.clear()
    this.onDefinitionsChanged?.()
    this.onHistoryChanged?.()
  }

  catalog() {
    return buildCatalog(this.actions.classisland.available())
  }

  async history(query: AutomationHistoryQuery = {}): Promise<AutomationRun[]> {
    return this.store.listRuns(query)
  }

  // ───────────────────────── 手动触发 ─────────────────────────

  /** 手动触发一次（UI / AI 工具 / Center 同一入口）。不走 firedKeys 去重。 */
  async runNow(id: string): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
    const spec = BUILTIN_SPECS.find((item) => item.id === id)
    if (spec !== undefined) {
      const builtin = this.listBuiltin().find((item) => item.id === id)
      if (builtin === undefined) return { ok: false, error: '内置自动化不存在' }
      const settings = this.settings()
      return await this.startRun(
        {
          id: builtin.id,
          name: builtin.name,
          enabled: true,
          mode: 'normal',
          trigger: builtin.trigger,
          actions: builtin.actions,
          createdAt: '',
          updatedAt: '',
        },
        '手动触发',
        async (run) => {
          await spec.execute({ matched: true, key: null, detail: '手动触发' }, settings, {
            ports: this.actions,
            logger: this.logger,
            onBuiltinFired: this.onBuiltinFired,
          })
          void run
        },
      )
    }
    const definition = await this.store.getDefinition(id)
    if (definition === undefined) return { ok: false, error: '自动化不存在' }
    // 用尽的判定先于"已停用"：自动停用后这条定义**同时**是用尽且停用的，
    // 只说"请先开启"会让用户开了又被停，找不到真正的原因（v0.2.8）。
    if (isRunsExhausted(definition)) {
      // 顺手把它停回去（幂等）：手动触发也走"用尽即停用"这一条口径，
      // 界面上的状态与拒绝理由因此始终一致。
      await this.suspendForExhaustion(definition)
      return {
        ok: false,
        error: `调用次数已用尽（${definition.runCount ?? 0}/${definition.maxRuns ?? 0}）：请提高上限或重置计数`,
      }
    }
    if (!definition.enabled) return { ok: false, error: '自动化已停用，请先开启' }
    // 按模式分派（**不能**只执行操作组件）：Agent 模式的定义没有 actions，
    // 手动触发若走错分支会落一条永远「进行中」的历史（本轮 smoke 实测就是这个症状）。
    return await this.runDefinition(definition, '手动触发')
  }

  // ───────────────────────── 触发执行 ─────────────────────────

  /** 按模式执行一份定义（定时触发与手动触发共用同一条分派）。 */
  private async runDefinition(
    definition: AutomationDefinition,
    detail: string | undefined,
  ): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
    // 调用次数闸门（v0.2.8，docs/13 §3.1）：用尽即不再执行。
    // 走到这里通常意味着"用户手动重新启用了一条已用尽的自动化"（定时触发路径上引擎
    // 已经在停用的那一刻把它摘出启用集），因此顺手把它停回去并留痕，让状态与理由一致，
    // 而不是每次 tick 都白跑一遍。
    if (isRunsExhausted(definition)) {
      const settled = await this.suspendForExhaustion(definition)
      if (settled !== undefined) definition = settled
      return {
        ok: false,
        error: `调用次数已用尽（${definition.runCount ?? 0}/${definition.maxRuns ?? 0}），已自动停用；请提高上限或重置计数`,
      }
    }
    const counted = await this.countRun(definition)
    if (counted !== undefined) definition = counted
    if (definition.mode === 'agent') {
      return await this.fireAgentRun(definition, detail)
    }
    return await this.startRun(definition, detail, async () => {
      await this.executeDefinitionActions(definition)
    })
  }

  /**
   * 记一次调用（v0.2.8，docs/13 §3.1）：次数 +1；达到上限的那一次**照常执行**，
   * 执行前先把 `enabled` 置 false —— "用满即停用"，最后这一跑是用户要的那一次。
   *
   * 只对**用户自建**定义计数：内置自动化的启停由 ClassRoom 配置驱动，没有"次数"可言
   * （`runNow` 的内置分支与 `fireBuiltin` 都不经过这里）。
   * 计数落盘失败只记日志：它不该让一次已经决定要跑的运行失败。
   */
  private async countRun(
    definition: AutomationDefinition,
  ): Promise<AutomationDefinition | undefined> {
    if (definition.maxRuns === undefined || definition.maxRuns <= 0) return undefined
    const runCount = (definition.runCount ?? 0) + 1
    const exhausted = runCount >= definition.maxRuns
    try {
      const saved = await this.store.saveDefinition({
        ...definition,
        runCount,
        enabled: exhausted ? false : definition.enabled,
      })
      if (exhausted) {
        this.logger.info('自动化调用次数已用尽，已自动停用', {
          automationId: definition.id,
          runCount,
          maxRuns: definition.maxRuns,
        })
      }
      this.onDefinitionsChanged?.()
      return saved
    } catch (error) {
      this.logger.warn('自动化调用次数落盘失败', {
        automationId: definition.id,
        error: String(error),
      })
      return undefined
    }
  }

  /** 把一条"已用尽却仍启用"的定义停用（幂等：已停用时不再写盘）。 */
  private async suspendForExhaustion(
    definition: AutomationDefinition,
  ): Promise<AutomationDefinition | undefined> {
    if (!definition.enabled) return undefined
    try {
      const saved = await this.store.saveDefinition({ ...definition, enabled: false })
      this.logger.info('自动化调用次数已用尽，已停用', {
        automationId: definition.id,
        runCount: definition.runCount ?? 0,
        maxRuns: definition.maxRuns ?? 0,
      })
      this.onDefinitionsChanged?.()
      return saved
    } catch (error) {
      this.logger.warn('自动停用失败', { automationId: definition.id, error: String(error) })
      return undefined
    }
  }

  /** Agent Mode：专属会话（sessionId = runId）+ 完整 Agent 会话；done / error 事件收尾。 */
  private async fireAgentRun(
    definition: AutomationDefinition,
    detail: string | undefined,
  ): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
    const prompt = definition.prompt ?? ''
    return await this.startRun(definition, detail, async (_run, runId) => {
      const sessionId = runId
      // 会话 id 在 send **之前**就落进运行记录：它就是 runId，与 send 成败无关 ——
      // send 失败（如未配置模型）时这条记录仍能指向「本该承载本次任务的会话」，
      // 历史面板据此显示会话回放入口，而不是一片空白。
      const withSession = await this.store.updateRun(runId, { sessionId })
      if (withSession !== undefined) this.reportRun(withSession)
      const extraContext = [
        `这是一次自动化触发（自动化名称：${definition.name}）。`,
        detail === undefined ? '' : `触发上下文：${detail}。`,
        '请直接开始执行任务，无需向触发者确认身份。',
      ]
        .filter((line) => line !== '')
        .join('\n')
      const { requestId } = await this.agent.send({
        sessionId,
        text: prompt,
        origin: 'automation',
        extraContext,
      })
      const timer = setTimeout(() => {
        this.finalizeAgentRun(sessionId, 'failed', '运行超时，已中止')
      }, this.maxAgentRunMs)
      timer.unref?.()
      this.pendingAgentRuns.set(sessionId, {
        runId,
        requestId,
        startedAt: Date.now(),
        timer,
      })
    })
  }

  private handleAgentEvent(event: AgentEvent): void {
    const pending = this.pendingAgentRuns.get(event.sessionId)
    if (pending === undefined) return
    if (event.type === 'done') {
      this.finalizeAgentRun(event.sessionId, 'success')
    } else if (event.type === 'error') {
      this.finalizeAgentRun(event.sessionId, 'failed', event.message)
    }
  }

  private finalizeAgentRun(sessionId: string, status: 'success' | 'failed', error?: string): void {
    const pending = this.pendingAgentRuns.get(sessionId)
    if (pending === undefined) return
    this.pendingAgentRuns.delete(sessionId)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    const finishedAt = this.clock().toISOString()
    const durationMs = Date.now() - pending.startedAt
    void this.store
      .updateRun(pending.runId, { status, finishedAt, durationMs, error })
      .then((settled) => {
        this.logger.info('自动化 Agent 运行结束', { runId: pending.runId, status, durationMs })
        if (settled !== undefined) this.reportRun(settled)
        this.onHistoryChanged?.()
      })
      .catch((error: unknown) => {
        this.logger.warn('自动化运行记录收尾失败', { error: String(error) })
      })
  }

  private async executeDefinitionActions(definition: AutomationDefinition): Promise<void> {
    const actions = definition.actions ?? []
    for (const action of actions) {
      const result = await executeAction(action, this.actions)
      if (!result.ok) {
        this.logger.warn('自动化操作执行失败（继续后续操作）', {
          automationId: definition.id,
          kind: action.kind,
          error: result.error,
        })
      } else {
        this.logger.info('自动化操作已执行', {
          automationId: definition.id,
          kind: action.kind,
          summary: result.summary,
        })
      }
    }
  }

  /**
   * 统一的运行建档：先落 `running` 历史再执行副作用，最后按结果收尾。
   * Agent 模式的终态由事件驱动（`finalizeAgentRun`），这里只补 sessionId；
   * Normal 模式执行完同步收尾（存在失败也记 success —— 历史只关心「触发过、做完了」）。
   */
  private async startRun(
    definition: AutomationDefinition,
    detail: string | undefined,
    execute: (run: AutomationRun, runId: string) => Promise<void>,
  ): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
    const runId = this.generateId(AUTOMATION_SESSION_PREFIX)
    const triggeredAt = this.clock().toISOString()
    const run: AutomationRun = {
      id: runId,
      automationId: definition.id,
      automationName: definition.name,
      mode: definition.mode,
      status: 'running',
      triggeredAt,
    }
    await this.store.appendRun(run)
    this.reportRun(run)
    this.onHistoryChanged?.()
    try {
      await execute(run, runId)
    } catch (error) {
      const settled = await this.store.updateRun(runId, {
        status: 'failed',
        finishedAt: this.clock().toISOString(),
        durationMs: Math.max(0, Date.now() - Date.parse(triggeredAt)),
        error: String(error),
      })
      if (settled !== undefined) this.reportRun(settled)
      this.onHistoryChanged?.()
      this.logger.warn('自动化运行失败', {
        runId,
        automationId: definition.id,
        error: String(error),
      })
      return { ok: true, runId }
    }
    if (definition.mode === 'normal') {
      const settled = await this.store.updateRun(runId, {
        status: 'success',
        finishedAt: this.clock().toISOString(),
        durationMs: Math.max(0, Date.now() - Date.parse(triggeredAt)),
      })
      if (settled !== undefined) this.reportRun(settled)
      this.onHistoryChanged?.()
      this.logger.info('自动化已触发', {
        runId,
        automationId: definition.id,
        detail: detail ?? '',
      })
    }
    return { ok: true, runId }
  }

  // ───────────────────────── 内部 ─────────────────────────

  /** 回调运行记录（自测诊断用；回调抛错不影响引擎主流程） */
  private reportRun(run: AutomationRun): void {
    try {
      this.onRunRecorded?.(structuredClone(run))
    } catch (error) {
      this.logger.debug('自动化运行记录回调抛错', { error: String(error) })
    }
  }

  private keysOf(automationId: string): Map<string, number> {
    let keys = this.firedKeys.get(automationId)
    if (keys === undefined) {
      keys = new Map()
      this.firedKeys.set(automationId, keys)
    }
    return keys
  }

  private pruneKeys(keys: Map<string, number>, nowMs: number): void {
    for (const [key, addedAt] of keys) {
      if (nowMs - addedAt > FIRED_KEY_TTL_MS) keys.delete(key)
    }
    while (keys.size > FIRED_KEY_CAP) {
      const oldest = keys.keys().next()
      if (oldest.done === true) break
      keys.delete(oldest.value)
    }
  }

  private builtinContext(): BuiltinRunContext {
    return {
      ports: this.actions,
      logger: this.logger,
      onBuiltinFired: this.onBuiltinFired,
    }
  }

  private async fireBuiltin(
    spec: BuiltinSpec,
    evaluation: TriggerEvaluation,
    settings: Settings,
  ): Promise<void> {
    if (spec.quietHoursGate && isQuietHour(this.clock(), settings.advanced.quietHours)) {
      this.logger.debug('处于勿扰时段，跳过内置自动化', { builtinId: spec.id })
      return
    }
    const displayName = spec.id === BUILTIN_PRE_CLASS_NOTIFY_ID ? '课前提醒' : '课前打开科目文件夹'
    await this.startRun(
      {
        id: spec.id,
        name: displayName,
        enabled: true,
        mode: 'normal',
        trigger: { kind: 'pre-class', params: {} },
        actions: [],
        createdAt: '',
        updatedAt: '',
      },
      evaluation.detail,
      async () => {
        await spec.execute(evaluation, settings, this.builtinContext())
      },
    )
  }

  /** 当天课程；临近午夜补次日（跨天课前窗口，同旧课前提醒的 collectLessons）。 */
  private async collectLessons(
    now: Date,
    enabled: AutomationDefinition[],
    settings: Settings,
  ): Promise<Lesson[]> {
    let provider: IScheduleProvider
    try {
      provider = this.provider()
    } catch {
      return []
    }
    const leads = enabled
      .filter((item) => item.trigger.kind === 'pre-class')
      .map((item) => {
        const value = item.trigger.params['leadMinutes']
        return typeof value === 'number' && Number.isFinite(value) ? value : 0
      })
    const maxLead = Math.max(0, ...leads, settings.modes.classroom.preClassLeadMinutes)
    try {
      const today = await provider.getToday(now)
      if (!needsNextDayLessons(now, Math.max(1, maxLead))) return today
      const tomorrow = await provider.getToday(new Date(now.getTime() + 24 * 60 * 60 * 1000))
      return [...today, ...tomorrow]
    } catch (error) {
      this.logger.warn('读取课程表失败，本轮课堂条件跳过', { error: String(error) })
      return []
    }
  }

  private generateId(prefix: string): string {
    this.idCounter += 1
    return `${prefix}-${Date.now().toString(36)}-${this.idCounter}`
  }
}

/**
 * 内置自动化规格（docs/13 §6）：ClassRoom 既有的课前提醒 / 课前自动打开科目文件夹。
 * 行为与迁移前的 `PreClassReminder` 一致：同一提前窗口（现读
 * `modes.classroom.preClassLeadMinutes`）、同一通知文案、勿扰内跳过、`onFired` 钩子。
 */
const BUILTIN_SPECS: BuiltinSpec[] = [
  {
    id: BUILTIN_PRE_CLASS_NOTIFY_ID,
    enabled: (settings) =>
      settings.modes.current === 'classroom' && settings.modes.classroom.preClassReminder,
    quietHoursGate: true,
    async execute(evaluation, _settings, ctx) {
      const lesson = evaluation.lesson
      if (lesson === undefined) return
      const minutesUntil = evaluation.minutesUntil ?? 0
      const subject = lesson.subject
      const targetDir = resolveSubjectDirSafe(ctx, subject)
      ctx.ports.notify({
        title: `课前提醒：${subject}`,
        body: `${lesson.startTime} 上课，还有 ${minutesUntil} 分钟`,
        openPath: targetDir === '' ? undefined : targetDir,
      })
      ctx.onBuiltinFired?.({
        builtinId: BUILTIN_PRE_CLASS_NOTIFY_ID,
        subject,
        minutesUntil,
        targetDir,
      })
    },
  },
  {
    id: BUILTIN_PRE_CLASS_OPEN_FOLDER_ID,
    enabled: (settings) =>
      settings.modes.current === 'classroom' && settings.modes.classroom.preClassOpenFolder,
    quietHoursGate: true,
    async execute(evaluation, _settings, ctx) {
      const lesson = evaluation.lesson
      if (lesson === undefined) return
      const subject = lesson.subject
      const targetDir = resolveSubjectDirSafe(ctx, subject)
      if (targetDir === '') {
        ctx.logger.debug('科目未映射文件夹，跳过打开', { subject })
        return
      }
      try {
        await ctx.ports.openPath(targetDir)
        ctx.logger.info('已打开科目文件夹', { subject, dir: targetDir })
      } catch (error) {
        ctx.logger.warn('打开科目文件夹失败', { subject, dir: targetDir, error: String(error) })
      }
      ctx.onBuiltinFired?.({
        builtinId: BUILTIN_PRE_CLASS_OPEN_FOLDER_ID,
        subject,
        minutesUntil: evaluation.minutesUntil ?? 0,
        targetDir,
      })
    },
  },
]

function resolveSubjectDirSafe(ctx: BuiltinRunContext, subject: string): string {
  try {
    return ctx.ports.resolveSubjectDir(subject).trim()
  } catch (error) {
    ctx.logger.warn('解析科目目录失败', { subject, error: String(error) })
    return ''
  }
}
