/**
 * 课程表 provider 与课前触发判定（docs/05 §3.4、docs/06 §8.1）。
 *
 * 纯逻辑、**不依赖 Electron**：系统能力（ClassIsland 数据源、PowerShell、通知）
 * 一律由调用方注入，因此 provider 与触发函数都能在 Node 里完整单测。
 *
 * 课程表有两个来源：`manual`（设置里手填）与 `classisland`（读桥接插件的本地 JSON，
 * 见 `classisland.ts`）。两者都实现同一个 `IScheduleProvider`，消费方无需区分。
 */
import type { Lesson as ScheduledLesson } from '@aurora/shared'

/** 一节课（星期 × 节次 → 科目） */
export interface Lesson {
  /** 0=周日 … 6=周六 */
  weekday: number
  /** "HH:mm" */
  startTime: string
  /** "HH:mm" */
  endTime: string
  subject: string
}

export interface IScheduleProvider {
  readonly id: 'manual' | 'classisland'
  /** 当天（`now` 所在星期的当天）的课程，按开始时间升序 */
  getToday(now: Date): Promise<Lesson[]>
}

/** 默认课前进度窗口：课前 5 分钟（docs/05 §3.4、docs/06 §9） */
export const DEFAULT_LOOKAHEAD_MINUTES = 5

const MINUTE_MS = 60_000
const MINUTES_PER_DAY = 24 * 60

/**
 * 与 `@aurora/shared` 的 `Lesson`（配置 Schema 推导类型）保持结构一致：
 * 任一方向不可赋值都会在这一行编译失败，防止两处形状各自漂移。
 */
type Assignable<_From extends To, To> = true
const _lessonShapeCompatible: [
  Assignable<Lesson, ScheduledLesson>,
  Assignable<ScheduledLesson, Lesson>,
] = [true, true]
void _lessonShapeCompatible

/**
 * 手动课程表：直接从设置读取（每次调用即时读取，改完课程表无需重启）。
 * `getToday` 过滤出 `now` 当天的课程并按开始时间排序。
 */
export function createManualScheduleProvider(
  getLessons: () => readonly Lesson[],
): IScheduleProvider {
  return {
    id: 'manual',
    async getToday(now: Date): Promise<Lesson[]> {
      const weekday = now.getDay()
      return getLessons()
        .filter((lesson) => lesson.weekday === weekday)
        .map((lesson) => ({ ...lesson }))
        .sort(compareLessons)
    },
  }
}

/**
 * ClassIsland 占位 provider（未配置桥接端点时使用，docs/05 §3.4 v2）。
 *
 * 与 v1 的区别：v1 无论配置如何都返回空数组，属于「功能未实现」；
 * 现在只有**用户选了 classisland 但没填端点**时才走到这里，
 * 语义是「已配置但尚未接线」，因此同样返回空数组且不抛错
 * （未接入属于已知状态，不应让调用方进入降级分支）。
 */
export function createClassislandPlaceholderProvider(): IScheduleProvider {
  return {
    id: 'classisland',
    async getToday(): Promise<Lesson[]> {
      return []
    },
  }
}

/** `resolveScheduleProvider` 的可选依赖（不传时 classisland 走空实现，保持既有行为） */
export interface ScheduleProviderDeps {
  /** 已配置的 ClassIsland provider；缺省 / 未配置端点时回落到空实现 */
  classisland?: IScheduleProvider | undefined
}

/** 按设置挑选 provider（`manual` / `classisland`），结构上接受 `settings.modes.classroom`。 */
export function resolveScheduleProvider(
  settings: {
    schedule: {
      provider: 'manual' | 'classisland'
      lessons: readonly Lesson[]
      classisland?: { source: 'http' | 'file'; endpoint: string; timeoutMs: number }
    }
  },
  deps: ScheduleProviderDeps = {},
): IScheduleProvider {
  if (settings.schedule.provider === 'classisland') {
    return deps.classisland ?? createClassislandPlaceholderProvider()
  }
  return createManualScheduleProvider(() => settings.schedule.lessons)
}

/** 解析 "HH:mm" → 当日分钟数；非法输入返回 `undefined`（调用方跳过该节课）。 */
export function parseClock(value: string): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(value.trim())
  if (match === null) return undefined
  const [, hours = '', minutes = ''] = match
  const hour = Number(hours)
  const minute = Number(minutes)
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return undefined
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined
  return hour * 60 + minute
}

/** 同一节课的去重键：`<weekday>-<startTime>-<subject>`。 */
export function lessonKey(lesson: Lesson): string {
  return `${lesson.weekday}-${lesson.startTime}-${lesson.subject}`
}

/**
 * 纯函数：挑出「课前进度窗口内应触发」的课程。
 *
 * - 窗口：`0 <= minutesUntil <= lookaheadMinutes`（默认 5）。应用启动时若已进入窗口
 *   （例如只剩 2 分钟）同样触发 —— 即启动补偿；等到整点才开始算会漏掉提醒。
 * - `firedKeys` 为已触发集合，命中即跳过，保证同一节课只触发一次；
 *   返回值只包含本次新触发的项，调用方负责把 `key` 记入集合。
 * - 跨天：同时考察「当日」与「次日」两个候选时刻，因此 23:5x 启动时
 *   次日 00:0x 的课也能触发（provider 需要提供次日课程，见 `automation/engine.ts` 的 `collectLessons`）。
 * - 非法时间（无法解析的 "HH:mm"）与非法星期直接跳过，绝不抛错。
 * - 返回值按 `minutesUntil` 升序，便于"最紧急的课先提醒"。
 */
export function preClassTrigger(input: {
  lessons: readonly Lesson[]
  now: Date
  lookaheadMinutes?: number
  firedKeys: ReadonlySet<string>
}): { lesson: Lesson; key: string; minutesUntil: number }[] {
  const lookahead = input.lookaheadMinutes ?? DEFAULT_LOOKAHEAD_MINUTES
  const nowMs = input.now.getTime()
  const fired = new Set(input.firedKeys)
  const triggers: { lesson: Lesson; key: string; minutesUntil: number }[] = []

  for (const lesson of input.lessons) {
    const startMinutes = parseClock(lesson.startTime)
    if (startMinutes === undefined) continue

    const weekday = normalizeWeekday(lesson.weekday)
    if (weekday === undefined) continue

    const key = lessonKey(lesson)
    if (fired.has(key)) continue

    for (const dayOffset of [0, 1]) {
      const day = new Date(
        input.now.getFullYear(),
        input.now.getMonth(),
        input.now.getDate() + dayOffset,
      )
      if (day.getDay() !== weekday) continue

      const startMs = day.getTime() + startMinutes * MINUTE_MS
      const minutesUntil = round((startMs - nowMs) / MINUTE_MS)
      if (minutesUntil < 0 || minutesUntil > lookahead) continue

      fired.add(key)
      triggers.push({ lesson, key, minutesUntil })
      break
    }
  }

  return triggers.sort((a, b) => a.minutesUntil - b.minutesUntil)
}

/** 临近午夜才需要额外查询次日课程（避免每次 tick 都多查一次）。 */
export function needsNextDayLessons(
  now: Date,
  lookaheadMinutes = DEFAULT_LOOKAHEAD_MINUTES,
): boolean {
  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  return nowMinutes >= MINUTES_PER_DAY - lookaheadMinutes
}

function compareLessons(left: Lesson, right: Lesson): number {
  const leftStart = parseClock(left.startTime) ?? Number.POSITIVE_INFINITY
  const rightStart = parseClock(right.startTime) ?? Number.POSITIVE_INFINITY
  if (leftStart !== rightStart) return leftStart - rightStart
  return left.subject.localeCompare(right.subject, 'zh-Hans-CN')
}

function normalizeWeekday(value: number): number | undefined {
  if (!Number.isInteger(value)) return undefined
  return ((value % 7) + 7) % 7
}

/** 抹掉浮点噪声，便于日志与断言（毫秒级定时器差） */
function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
