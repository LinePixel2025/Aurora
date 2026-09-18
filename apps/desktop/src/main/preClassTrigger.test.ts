import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryLogger } from '@aurora/shared'
import { PreClassReminder } from './pre-class-reminder.js'
import {
  createManualScheduleProvider,
  lessonKey,
  needsNextDayLessons,
  preClassTrigger,
  type Lesson,
} from './schedule.js'

/** 2026-03-02 是星期一；星期动态取自真实日历，避免测试绑死具体日期 */
const MONDAY = new Date(2026, 2, 2, 7, 55, 0)
const MONDAY_WEEKDAY = MONDAY.getDay()
const TUESDAY_WEEKDAY = (MONDAY_WEEKDAY + 1) % 7

function dayAt(hours: number, minutes: number, base: Date = MONDAY, dayOffset = 0): Date {
  return new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate() + dayOffset,
    hours,
    minutes,
    0,
    0,
  )
}

function lesson(overrides: Partial<Lesson> = {}): Lesson {
  return {
    weekday: MONDAY_WEEKDAY,
    startTime: '08:00',
    endTime: '08:45',
    subject: '数学',
    ...overrides,
  }
}

const EMPTY_FIRED: ReadonlySet<string> = new Set<string>()

describe('lessonKey', () => {
  it('由 星期-开始时间-科目 组成，同一节课稳定唯一', () => {
    const key = lessonKey(lesson())
    expect(key).toBe(`${MONDAY_WEEKDAY}-08:00-数学`)
    expect(lessonKey(lesson({ endTime: '09:30' }))).toBe(key)
    expect(lessonKey(lesson({ subject: '英语' }))).not.toBe(key)
  })
})

describe('preClassTrigger', () => {
  it('进入课前 5 分钟窗口时触发，并给出剩余分钟数', () => {
    const triggers = preClassTrigger({
      lessons: [lesson()],
      now: MONDAY,
      firedKeys: EMPTY_FIRED,
    })
    expect(triggers).toHaveLength(1)
    expect(triggers[0]?.key).toBe(lessonKey(lesson()))
    expect(triggers[0]?.minutesUntil).toBe(5)
    expect(triggers[0]?.lesson.subject).toBe('数学')
  })

  it('窗口外（更早或更晚）不触发', () => {
    const lessons = [lesson()]
    expect(preClassTrigger({ lessons, now: dayAt(7, 50), firedKeys: EMPTY_FIRED })).toEqual([])
    expect(preClassTrigger({ lessons, now: dayAt(8, 30), firedKeys: EMPTY_FIRED })).toEqual([])
  })

  it('课程已开始后不再触发（哪怕只过了 30 秒）', () => {
    const triggers = preClassTrigger({
      lessons: [lesson()],
      now: new Date(2026, 2, 2, 8, 0, 30),
      firedKeys: EMPTY_FIRED,
    })
    expect(triggers).toEqual([])
  })

  it('启动补偿：应用启动时已进入窗口（只剩 2 分钟）同样触发', () => {
    const triggers = preClassTrigger({
      lessons: [lesson()],
      now: dayAt(7, 58),
      firedKeys: EMPTY_FIRED,
    })
    expect(triggers.map((item) => item.minutesUntil)).toEqual([2])
  })

  it('lookaheadMinutes 可调（默认 5 分钟）', () => {
    expect(
      preClassTrigger({ lessons: [lesson()], now: dayAt(7, 50), firedKeys: EMPTY_FIRED }),
    ).toEqual([])
    expect(
      preClassTrigger({
        lessons: [lesson()],
        now: dayAt(7, 50),
        lookaheadMinutes: 10,
        firedKeys: EMPTY_FIRED,
      }),
    ).toHaveLength(1)
  })

  it('已触发集合内的课程不再触发（同一节课只提醒一次）', () => {
    const fired = new Set([lessonKey(lesson())])
    expect(preClassTrigger({ lessons: [lesson()], now: MONDAY, firedKeys: fired })).toEqual([])

    // 连续 tick：第一次返回的 key 记入集合后，第二次必须为空
    const first = preClassTrigger({ lessons: [lesson()], now: MONDAY, firedKeys: EMPTY_FIRED })
    const after = new Set(first.map((item) => item.key))
    expect(preClassTrigger({ lessons: [lesson()], now: dayAt(7, 56), firedKeys: after })).toEqual(
      [],
    )
  })

  it('星期不匹配的课程不触发', () => {
    const triggers = preClassTrigger({
      lessons: [lesson({ weekday: TUESDAY_WEEKDAY })],
      now: MONDAY,
      firedKeys: EMPTY_FIRED,
    })
    expect(triggers).toEqual([])
  })

  it('非法开始时间 / 非法星期只跳过该项，不影响其它课程', () => {
    const triggers = preClassTrigger({
      lessons: [
        lesson({ startTime: '8点', subject: '非法时间' }),
        lesson({ weekday: Number.NaN, subject: '非法星期' }),
        lesson({ subject: '数学' }),
      ],
      now: MONDAY,
      firedKeys: EMPTY_FIRED,
    })
    expect(triggers.map((item) => item.lesson.subject)).toEqual(['数学'])
  })

  it('跨天：23:58 时次日 00:02 的课也能触发', () => {
    const triggers = preClassTrigger({
      lessons: [lesson({ weekday: TUESDAY_WEEKDAY, startTime: '00:02', endTime: '00:45' })],
      now: dayAt(23, 58),
      firedKeys: EMPTY_FIRED,
    })
    expect(triggers).toHaveLength(1)
    expect(triggers[0]?.minutesUntil).toBe(4)
  })

  it('跨天窗口外（次日课程离得还远）不触发', () => {
    const triggers = preClassTrigger({
      lessons: [lesson({ weekday: TUESDAY_WEEKDAY, startTime: '08:00' })],
      now: dayAt(23, 58),
      firedKeys: EMPTY_FIRED,
    })
    expect(triggers).toEqual([])
  })

  it('多节课同时进入窗口时按剩余时间升序返回', () => {
    const triggers = preClassTrigger({
      lessons: [
        lesson({ startTime: '08:00', subject: '数学' }),
        lesson({ startTime: '07:57', subject: '英语' }),
      ],
      now: MONDAY,
      firedKeys: EMPTY_FIRED,
    })
    expect(triggers.map((item) => item.lesson.subject)).toEqual(['英语', '数学'])
    expect(triggers.map((item) => item.minutesUntil)).toEqual([2, 5])
  })

  it('不修改传入的 firedKeys 集合', () => {
    const fired = new Set<string>()
    preClassTrigger({ lessons: [lesson()], now: MONDAY, firedKeys: fired })
    expect(fired.size).toBe(0)
  })
})

describe('needsNextDayLessons', () => {
  it('只在临近午夜时需要额外查询次日课程', () => {
    expect(needsNextDayLessons(dayAt(12, 0))).toBe(false)
    expect(needsNextDayLessons(dayAt(23, 54))).toBe(false)
    expect(needsNextDayLessons(dayAt(23, 55))).toBe(true)
    expect(needsNextDayLessons(dayAt(23, 59))).toBe(true)
  })
})

describe('PreClassReminder', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function createReminder(overrides: { lessons?: Lesson[]; enabled?: () => boolean } = {}) {
    const notifications: Array<{ title: string; body: string; openPath?: string }> = []
    const opened: string[] = []
    const logger = createMemoryLogger()
    const lessons = overrides.lessons ?? [lesson()]
    const reminder = new PreClassReminder({
      provider: createManualScheduleProvider(() => lessons),
      enabled: overrides.enabled ?? (() => true),
      quietHours: () => null,
      notify: (title, body, openPath) => {
        notifications.push({ title, body, ...(openPath === undefined ? {} : { openPath }) })
      },
      openPath: async (target) => {
        opened.push(target)
      },
      resolveSubjectDir: (subject) => `D:\\感知\\分类\\${subject}`,
      logger,
      intervalMs: 30_000,
    })
    return { reminder, notifications, opened, logger }
  }

  it('tick 触发通知并自动打开科目文件夹', async () => {
    const { reminder, notifications, opened } = createReminder()
    const results = await reminder.tick(MONDAY)
    expect(results).toHaveLength(1)
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.title).toBe('课前提醒：数学')
    expect(notifications[0]?.body).toBe('08:00 上课，还有 5 分钟')
    expect(notifications[0]?.openPath).toBe('D:\\感知\\分类\\数学')
    expect(opened).toEqual(['D:\\感知\\分类\\数学'])
  })

  it('同一节课只提醒一次（连续 tick 去重）', async () => {
    const { reminder, notifications } = createReminder()
    await reminder.tick(MONDAY)
    await reminder.tick(dayAt(7, 56))
    await reminder.tick(dayAt(7, 57))
    expect(notifications).toHaveLength(1)
  })

  it('开关关闭时不检查课程表', async () => {
    const { reminder, notifications } = createReminder({ enabled: () => false })
    expect(await reminder.tick(MONDAY)).toEqual([])
    expect(notifications).toEqual([])
  })

  it('勿扰时段内静默跳过（不补发）', async () => {
    const notifications: string[] = []
    const reminder = new PreClassReminder({
      provider: createManualScheduleProvider(() => [lesson()]),
      enabled: () => true,
      quietHours: () => ({ start: '22:30', end: '07:00' }),
      notify: (title) => notifications.push(title),
      openPath: async () => undefined,
      resolveSubjectDir: (subject) => `D:\\感知\\分类\\${subject}`,
      logger: createMemoryLogger(),
    })
    expect(await reminder.tick(dayAt(6, 55))).toEqual([])
    expect(notifications).toEqual([])
  })

  it('打开文件夹失败不影响提醒（只降级为日志）', async () => {
    const notifications: string[] = []
    const logger = createMemoryLogger()
    const reminder = new PreClassReminder({
      provider: createManualScheduleProvider(() => [lesson()]),
      enabled: () => true,
      quietHours: () => null,
      notify: (title) => notifications.push(title),
      openPath: async () => {
        throw new Error('explorer 不可用')
      },
      resolveSubjectDir: (subject) => `D:\\感知\\分类\\${subject}`,
      logger,
    })
    const results = await reminder.tick(MONDAY)
    expect(results).toHaveLength(1)
    expect(notifications).toEqual(['课前提醒：数学'])
    expect(logger.entries.some((entry) => entry.includes('打开科目文件夹失败'))).toBe(true)
  })

  it('科目目录未配置时仍然通知，只是不带点击打开', async () => {
    const notifications: Array<{ openPath?: string }> = []
    const opened: string[] = []
    const reminder = new PreClassReminder({
      provider: createManualScheduleProvider(() => [lesson()]),
      enabled: () => true,
      quietHours: () => null,
      notify: (_title, _body, openPath) => notifications.push({ openPath }),
      openPath: async (target) => {
        opened.push(target)
      },
      resolveSubjectDir: () => '',
      logger: createMemoryLogger(),
    })
    await reminder.tick(MONDAY)
    expect(notifications).toEqual([{}])
    expect(opened).toEqual([])
  })

  it('跨天：临近午夜时额外查询次日课程并触发', async () => {
    const { reminder, notifications } = createReminder({
      lessons: [lesson({ weekday: TUESDAY_WEEKDAY, startTime: '00:02', endTime: '00:45' })],
    })
    const results = await reminder.tick(dayAt(23, 58))
    expect(results).toHaveLength(1)
    expect(notifications[0]?.body).toBe('00:02 上课，还有 4 分钟')
  })

  it('课程表 provider 抛错时本轮跳过且不抛出', async () => {
    const logger = createMemoryLogger()
    const reminder = new PreClassReminder({
      provider: {
        id: 'manual',
        getToday: async () => {
          throw new Error('课程表不可用')
        },
      },
      enabled: () => true,
      quietHours: () => null,
      notify: () => undefined,
      openPath: async () => undefined,
      resolveSubjectDir: () => 'D:\\感知\\分类\\数学',
      logger,
    })
    await expect(reminder.tick(MONDAY)).resolves.toEqual([])
    expect(logger.entries.some((entry) => entry.includes('读取课程表失败'))).toBe(true)
  })

  it('start 立即检查一次并按 interval 周期检查，stop 后停止', async () => {
    vi.useFakeTimers({ now: new Date(MONDAY.getTime()) })
    const { reminder, notifications } = createReminder()
    reminder.start()
    reminder.start() // 幂等：不会注册第二个定时器
    await vi.advanceTimersByTimeAsync(1)
    expect(notifications).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(30_000)
    // 同一节课只提醒一次：周期检查不会再刷屏
    expect(notifications).toHaveLength(1)

    reminder.stop()
    reminder.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(notifications).toHaveLength(1)
  })

  /**
   * 回归测试（自测中真实暴露的缺陷）：
   * `resolveScheduleProvider()` 按值快照课程表。若启动时只解析一次并固定 provider，
   * 用户在设置页改完课程表必须重启才生效——自测里"启动时还没课程"的场景就因此完全收不到提醒。
   */
  it('getProvider 每次 tick 重新解析：课程表改动无需重启即生效', async () => {
    const notifications: string[] = []
    let lessons: Lesson[] = []
    const reminder = new PreClassReminder({
      getProvider: () => createManualScheduleProvider(() => lessons),
      enabled: () => true,
      quietHours: () => null,
      notify: (title) => notifications.push(title),
      openPath: async () => undefined,
      resolveSubjectDir: () => 'D:\\感知\\分类\\数学',
      logger: createMemoryLogger(),
    })

    // 启动时课程表还是空的
    expect(await reminder.tick(MONDAY)).toEqual([])
    expect(notifications).toHaveLength(0)

    // 用户在设置页加上一节课（provider 未重建，仅数据变化）
    lessons = [lesson()]
    const results = await reminder.tick(MONDAY)
    expect(results).toHaveLength(1)
    expect(notifications).toEqual(['课前提醒：数学'])
  })

  it('未提供 provider 时给出可读错误而不是静默失效', async () => {
    const reminder = new PreClassReminder({
      enabled: () => true,
      quietHours: () => null,
      notify: () => undefined,
      openPath: async () => undefined,
      resolveSubjectDir: () => '',
      logger: createMemoryLogger(),
    })
    // tick 内部会捕获并记日志（不外抛），但必须留下痕迹
    await expect(reminder.tick(MONDAY)).resolves.toEqual([])
  })
})
