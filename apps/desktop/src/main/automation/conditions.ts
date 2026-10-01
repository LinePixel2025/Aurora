/**
 * 触发器评估（docs/13 §4）。纯逻辑、不依赖 Electron：课程数据与时间由调用方注入。
 *
 * 统一模型：每个条件评估输出 `{ matched, key }` —— `key` 标识「这次触发机会」，
 * 引擎按自动化维护已触发键集合（firedKeys，**仅在内存**，重启即空；`daily` 的跨进程幂等
 * 由引擎用 `dailyTriggerKey` 从运行历史重建当日键保证，见 docs/13 §4.1），命中即跳过。
 * 于是「电平 + 边沿」全部由同一个去重机制表达：daily 键带日期、interval 键带时间桶、
 * 课表键是 lessonKey（同节课外不再触发，跨天由 48h TTL 清理，不会挡住下周同一节课）。
 *
 * 课表条件**全部从课程表（`IScheduleProvider.getToday`）推导**，不依赖桥接 status
 * 快照 —— 与既有课前提醒同一口径（快照只用于展示，见桥接 README 的约定）。
 */
import type { AutomationTrigger } from '@aurora/shared'
import { lessonKey, parseClock, type Lesson } from '../schedule.js'

/** 一次 tick 的评估上下文：`lessons` 已含当天（临近午夜并入次日）课程 */
export interface TriggerContext {
  now: Date
  lessons: readonly Lesson[]
}

export interface TriggerEvaluation {
  matched: boolean
  /** 去重键（matched 时必非空）；引擎按它过滤已触发项 */
  key: string | null
  /** 触发上下文描述（进 Agent extraContext 与日志，如「距上课 3 分钟」） */
  detail?: string
  /** 课堂类触发命中的课（供操作取科目 / 打开文件夹） */
  lesson?: Lesson
  /** 课表类触发的分钟差（pre-class / pre-end / next-lesson） */
  minutesUntil?: number
}

const MINUTE_MS = 60_000

/** 评估一个触发器；参数非法一律返回不匹配（保存侧已按 catalog 校验，这里只兜底）。 */
export function evaluateTrigger(
  trigger: AutomationTrigger,
  ctx: TriggerContext,
): TriggerEvaluation {
  const params = isRecord(trigger.params) ? trigger.params : {}
  switch (trigger.kind) {
    case 'daily':
      return evaluateDaily(trigger, ctx)
    case 'interval':
      return evaluateInterval(params, ctx)
    case 'pre-class':
      return evaluatePreClass(params, ctx)
    case 'class-start':
      return evaluateClassStart(ctx)
    case 'pre-end':
      return evaluatePreEnd(params, ctx)
    case 'class-end':
      return evaluateClassEnd(ctx)
    case 'next-lesson':
      return evaluateNextLesson(params, ctx)
    default:
      return notMatched()
  }
}

function evaluateDaily(trigger: AutomationTrigger, ctx: TriggerContext): TriggerEvaluation {
  const at = parseDailyAt(trigger)
  if (at === undefined) return notMatched()
  const weekdays = normalizeWeekdays(
    isRecord(trigger.params) ? trigger.params['weekdays'] : undefined,
  )
  if (weekdays !== undefined && !weekdays.includes(ctx.now.getDay())) return notMatched()
  const nowMinutes = ctx.now.getHours() * 60 + ctx.now.getMinutes()
  // 错过补偿（P2-11，docs/13 §4.1）：`>=` 而不是 `===` —— 触发那一分钟主进程若没在评估
  // （睡眠 / 休眠、主线程被长任务阻塞、时间跳变），恢复后的首个 tick 补触发一次。
  // 键含日期（`daily-<本地日期>-<at>`）：同日重复评估得到同一个键，引擎的 firedKeys 去重使其
  // 在**一次进程生命周期内**只触发一次。**跨进程**的幂等不在这里 —— `firedKeys` 只在内存，
  // 重启后为空，故引擎在首轮评估前用下面的 `dailyTriggerKey` 从运行历史重建当日键
  // （否则「当天 at 已过且已触发过」会被误判成错过补偿，每次重启都再触发一次）。
  if (nowMinutes < at.minutes) return notMatched()
  return {
    matched: true,
    key: dailyKeyOf(at.text, ctx.now),
    detail: `定时 ${at.text}`,
  }
}

/** daily 的 `at` 解析结果（分钟数 + 原文）；非法一律 undefined。评估与键重建共用同一份判据。 */
function parseDailyAt(trigger: AutomationTrigger): { minutes: number; text: string } | undefined {
  if (trigger.kind !== 'daily' || !isRecord(trigger.params)) return undefined
  const raw = trigger.params['at']
  if (typeof raw !== 'string') return undefined
  const minutes = parseClock(raw)
  if (minutes === undefined) return undefined
  return { minutes, text: raw.trim() }
}

/**
 * daily 的去重键（`daily-<本地日期>-<at>`）；非 daily / 参数非法返回 null。
 *
 * 引擎在进程启动后的首轮评估前用它**从运行历史重建当日键**（docs/13 §4.1）：`firedKeys`
 * 只在内存，重启后为空 —— 不重建的话，错过补偿（`nowMinutes >= at`）会把当天**已经触发过**
 * 的任务再触发一次（Normal 重复通知；Agent 真的再跑一轮并重复消耗 `runCount`）。
 */
export function dailyTriggerKey(trigger: AutomationTrigger, date: Date): string | null {
  const at = parseDailyAt(trigger)
  return at === undefined ? null : dailyKeyOf(at.text, date)
}

/** daily 去重键的**唯一**格式来源（评估与历史重建共用，防两处漂移） */
function dailyKeyOf(atText: string, date: Date): string {
  return `daily-${ymd(date)}-${atText}`
}

function evaluateInterval(params: Record<string, unknown>, ctx: TriggerContext): TriggerEvaluation {
  const every = params['everyMinutes']
  if (typeof every !== 'number' || !Number.isInteger(every) || every <= 0) return notMatched()
  const bucket = Math.floor(ctx.now.getTime() / (every * MINUTE_MS))
  return {
    matched: true,
    // 键带时间桶：对齐桶触发；去重集合只在内存，同一桶只在**本进程生命周期内**不重复
    // （重启后若仍在同一桶会再触发一次 —— 与课堂类条件一致；跨进程幂等的是 daily，见上）
    key: `interval-${every}-${bucket}`,
    detail: `每 ${every} 分钟`,
  }
}

function evaluatePreClass(params: Record<string, unknown>, ctx: TriggerContext): TriggerEvaluation {
  const lead = params['leadMinutes']
  if (typeof lead !== 'number' || !Number.isFinite(lead) || lead <= 0) return notMatched()
  let best: { lesson: Lesson; minutesUntil: number } | undefined
  for (const lesson of ctx.lessons) {
    const startMs = lessonStartMs(lesson, ctx.now)
    if (startMs === undefined) continue
    const minutesUntil = (startMs - ctx.now.getTime()) / MINUTE_MS
    if (minutesUntil < 0 || minutesUntil > lead) continue
    if (best === undefined || minutesUntil < best.minutesUntil) best = { lesson, minutesUntil }
  }
  if (best === undefined) return notMatched()
  const minutes = Math.max(0, Math.round(best.minutesUntil))
  return {
    matched: true,
    key: lessonKey(best.lesson),
    detail: `「${best.lesson.subject}」${best.lesson.startTime} 上课，还有 ${minutes} 分钟`,
    lesson: best.lesson,
    minutesUntil: minutes,
  }
}

function evaluateClassStart(ctx: TriggerContext): TriggerEvaluation {
  const current = currentLesson(ctx)
  if (current === undefined) return notMatched()
  return {
    matched: true,
    key: lessonKey(current),
    detail: `「${current.subject}」上课中（${current.startTime}–${current.endTime}）`,
    lesson: current,
  }
}

function evaluatePreEnd(params: Record<string, unknown>, ctx: TriggerContext): TriggerEvaluation {
  const lead = params['leadMinutes']
  if (typeof lead !== 'number' || !Number.isFinite(lead) || lead <= 0) return notMatched()
  const current = currentLesson(ctx)
  if (current === undefined) return notMatched()
  const endMs = lessonEndMs(current, ctx.now)
  if (endMs === undefined) return notMatched()
  const minutesUntil = (endMs - ctx.now.getTime()) / MINUTE_MS
  if (minutesUntil < 0 || minutesUntil > lead) return notMatched()
  const minutes = Math.max(0, Math.round(minutesUntil))
  return {
    matched: true,
    key: lessonKey(current),
    detail: `「${current.subject}」距下课还有 ${minutes} 分钟`,
    lesson: current,
    minutesUntil: minutes,
  }
}

function evaluateClassEnd(ctx: TriggerContext): TriggerEvaluation {
  const nowMs = ctx.now.getTime()
  for (const lesson of ctx.lessons) {
    const endMs = lessonEndMs(lesson, ctx.now)
    if (endMs === undefined) continue
    if (endMs <= nowMs && nowMs < endMs + MINUTE_MS) {
      return {
        matched: true,
        key: lessonKey(lesson),
        detail: `「${lesson.subject}」已下课（${lesson.endTime}）`,
        lesson,
      }
    }
  }
  return notMatched()
}

function evaluateNextLesson(
  params: Record<string, unknown>,
  ctx: TriggerContext,
): TriggerEvaluation {
  const subject = params['subject']
  if (typeof subject !== 'string' || subject.trim() === '') return notMatched()
  const next = nextLesson(ctx)
  if (next === undefined || next.subject !== subject.trim()) return notMatched()
  const startMs = lessonStartMs(next, ctx.now)
  const minutes =
    startMs === undefined
      ? undefined
      : Math.max(0, Math.round((startMs - ctx.now.getTime()) / MINUTE_MS))
  return {
    matched: true,
    key: lessonKey(next),
    detail:
      minutes === undefined
        ? `下一节「${next.subject}」`
        : `下一节「${next.subject}」${next.startTime} 开始，还有 ${minutes} 分钟`,
    lesson: next,
    minutesUntil: minutes,
  }
}

function notMatched(): TriggerEvaluation {
  return { matched: false, key: null }
}

// ───────────────────────── 课表辅助 ─────────────────────────

/** 正在上的课（startTime ≤ now < endTime）；找不到返回 undefined。 */
export function currentLesson(ctx: TriggerContext): Lesson | undefined {
  const nowMs = ctx.now.getTime()
  for (const lesson of ctx.lessons) {
    const startMs = lessonStartMs(lesson, ctx.now)
    const endMs = lessonEndMs(lesson, ctx.now)
    if (startMs === undefined || endMs === undefined) continue
    if (startMs <= nowMs && nowMs < endMs) return lesson
  }
  return undefined
}

/** 下一节未开始的课（按开始时间最近的）；找不到返回 undefined。 */
export function nextLesson(ctx: TriggerContext): Lesson | undefined {
  let best: { lesson: Lesson; startMs: number } | undefined
  for (const lesson of ctx.lessons) {
    const startMs = lessonStartMs(lesson, ctx.now)
    if (startMs === undefined || startMs <= ctx.now.getTime()) continue
    if (best === undefined || startMs < best.startMs) best = { lesson, startMs }
  }
  return best?.lesson
}

/**
 * 课的绝对开始时间：weekday 匹配今天 → 今天；匹配明天 → 明天；其余忽略
 * （引擎在临近午夜时并入次日课程，见 `collectLessonsFor`）。
 */
function lessonStartMs(lesson: Lesson, now: Date): number | undefined {
  return lessonTimeMs(lesson, now, lesson.startTime)
}

function lessonEndMs(lesson: Lesson, now: Date): number | undefined {
  return lessonTimeMs(lesson, now, lesson.endTime)
}

function lessonTimeMs(lesson: Lesson, now: Date, clock: string): number | undefined {
  const minutes = parseClock(clock)
  if (minutes === undefined) return undefined
  const weekday = normalizeWeekdayOf(lesson.weekday)
  if (weekday === undefined) return undefined
  for (const offset of [0, 1] as const) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
    if (day.getDay() !== weekday) continue
    return day.getTime() + minutes * MINUTE_MS
  }
  return undefined
}

function normalizeWeekdayOf(value: number): number | undefined {
  if (!Number.isInteger(value)) return undefined
  return ((value % 7) + 7) % 7
}

/** 归一 weekdays 参数：缺省 / 空数组 = 每天（返回 undefined 表示不限制）；非法值丢弃。 */
function normalizeWeekdays(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const days = value
    .filter((item): item is number => typeof item === 'number' && Number.isInteger(item))
    .map((item) => ((item % 7) + 7) % 7)
  return days.length === 0 ? undefined : [...new Set(days)]
}

function ymd(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
