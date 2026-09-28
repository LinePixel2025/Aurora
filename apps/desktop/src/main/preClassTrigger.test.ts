import { describe, expect, it } from 'vitest'
import { lessonKey, needsNextDayLessons, preClassTrigger, type Lesson } from './schedule.js'

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
