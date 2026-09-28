import { describe, expect, it } from 'vitest'
import { currentLesson, evaluateTrigger, nextLesson, type TriggerContext } from './conditions.js'
import { lessonKey, type Lesson } from '../schedule.js'

/** 2026-03-02 是星期一；星期动态取自真实日历，避免测试绑死具体日期（同 preClassTrigger.test.ts） */
const MONDAY = new Date(2026, 2, 2, 8, 0, 0)
const MONDAY_WEEKDAY = MONDAY.getDay()
const TUESDAY_WEEKDAY = (MONDAY_WEEKDAY + 1) % 7

function dayAt(hours: number, minutes: number, seconds = 0, base: Date = MONDAY): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), hours, minutes, seconds, 0)
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

function ctx(now: Date, lessons: Lesson[] = []): TriggerContext {
  return { now, lessons }
}

describe('evaluateTrigger · daily（每天定时）', () => {
  it('HH:mm 命中时触发，key 含日期与时刻', () => {
    const result = evaluateTrigger({ kind: 'daily', params: { at: '08:00' } }, ctx(dayAt(8, 0)))
    expect(result.matched).toBe(true)
    expect(result.key).toBe('daily-2026-03-02-08:00')
    expect(result.detail).toContain('08:00')
  })

  it('时刻不匹配不触发', () => {
    const result = evaluateTrigger({ kind: 'daily', params: { at: '08:01' } }, ctx(dayAt(8, 0)))
    expect(result.matched).toBe(false)
    expect(result.key).toBeNull()
  })

  it('weekdays 过滤：指定星期之外不触发，命中星期触发', () => {
    const tuesday = { kind: 'daily' as const, params: { at: '08:00', weekdays: [TUESDAY_WEEKDAY] } }
    expect(evaluateTrigger(tuesday, ctx(dayAt(8, 0))).matched).toBe(false)

    const monday = { kind: 'daily' as const, params: { at: '08:00', weekdays: [MONDAY_WEEKDAY] } }
    expect(evaluateTrigger(monday, ctx(dayAt(8, 0))).matched).toBe(true)
  })

  it('空 weekdays = 每天', () => {
    const trigger = { kind: 'daily' as const, params: { at: '08:00', weekdays: [] } }
    expect(evaluateTrigger(trigger, ctx(dayAt(8, 0))).matched).toBe(true)
  })

  it('非法 at（错格式 / 缺失 / 错型）不触发', () => {
    expect(
      evaluateTrigger({ kind: 'daily', params: { at: '8点' } }, ctx(dayAt(8, 0))).matched,
    ).toBe(false)
    expect(evaluateTrigger({ kind: 'daily', params: {} }, ctx(dayAt(8, 0))).matched).toBe(false)
    expect(evaluateTrigger({ kind: 'daily', params: { at: 800 } }, ctx(dayAt(8, 0))).matched).toBe(
      false,
    )
  })
})

describe('evaluateTrigger · interval（固定间隔）', () => {
  const trigger = { kind: 'interval' as const, params: { everyMinutes: 30 } }

  it('everyMinutes=30：同一时间桶内 key 相同', () => {
    const first = evaluateTrigger(trigger, ctx(dayAt(8, 0)))
    const second = evaluateTrigger(trigger, ctx(dayAt(8, 10)))
    expect(first.matched).toBe(true)
    expect(first.key).toBe(second.key)
  })

  it('相隔超过间隔的两个时刻 key 不同', () => {
    const first = evaluateTrigger(trigger, ctx(dayAt(8, 0)))
    const second = evaluateTrigger(trigger, ctx(dayAt(8, 35)))
    expect(first.key).not.toBe(second.key)
  })

  it('非法参数（0 / 负数 / 小数 / 错型）不触发', () => {
    for (const bad of [0, -5, 1.5, '30', null]) {
      const result = evaluateTrigger(
        { kind: 'interval', params: { everyMinutes: bad } },
        ctx(dayAt(8, 0)),
      )
      expect(result.matched).toBe(false)
    }
  })
})

describe('evaluateTrigger · pre-class（距上课不足 N 分钟）', () => {
  const trigger = { kind: 'pre-class' as const, params: { leadMinutes: 5 } }

  it('窗口内命中（minutesUntil=3，lead=5）：key = lessonKey，返回 lesson 与 detail', () => {
    const math = lesson()
    const result = evaluateTrigger(trigger, ctx(dayAt(7, 57), [math]))
    expect(result.matched).toBe(true)
    expect(result.key).toBe(lessonKey(math))
    expect(result.lesson?.subject).toBe('数学')
    expect(result.minutesUntil).toBe(3)
    expect(result.detail).toContain('数学')
    expect(result.detail).toContain('3 分钟')
  })

  it('窗口外不触发：提前 10 分钟（lead=5）与已开始（过了 1 分钟）', () => {
    const math = lesson()
    expect(evaluateTrigger(trigger, ctx(dayAt(7, 50), [math])).matched).toBe(false)
    expect(evaluateTrigger(trigger, ctx(dayAt(8, 1), [math])).matched).toBe(false)
  })

  it('多节课在窗口内时取最近的下一节', () => {
    const math = lesson()
    const english = lesson({ startTime: '07:59', endTime: '08:44', subject: '英语' })
    const result = evaluateTrigger(trigger, ctx(dayAt(7, 57), [math, english]))
    expect(result.matched).toBe(true)
    expect(result.lesson?.subject).toBe('英语')
    expect(result.minutesUntil).toBe(2)
  })
})

describe('evaluateTrigger · class-start（上课时）', () => {
  it('正在上的课命中（startTime ≤ now < endTime）', () => {
    const math = lesson()
    const result = evaluateTrigger({ kind: 'class-start', params: {} }, ctx(dayAt(8, 10), [math]))
    expect(result.matched).toBe(true)
    expect(result.key).toBe(lessonKey(math))
    expect(result.lesson?.subject).toBe('数学')
    expect(result.detail).toContain('08:00')
  })

  it('无课（课前 / 课后）不触发', () => {
    const math = lesson()
    expect(
      evaluateTrigger({ kind: 'class-start', params: {} }, ctx(dayAt(7, 30), [math])).matched,
    ).toBe(false)
    expect(
      evaluateTrigger({ kind: 'class-start', params: {} }, ctx(dayAt(9, 0), [math])).matched,
    ).toBe(false)
    expect(evaluateTrigger({ kind: 'class-start', params: {} }, ctx(dayAt(8, 10))).matched).toBe(
      false,
    )
  })
})

describe('evaluateTrigger · pre-end（距下课不足 N 分钟）', () => {
  const trigger = { kind: 'pre-end' as const, params: { leadMinutes: 5 } }

  it('距结束 ≤ lead 命中（08:43 距 08:45 下课 2 分钟）', () => {
    const math = lesson()
    const result = evaluateTrigger(trigger, ctx(dayAt(8, 43), [math]))
    expect(result.matched).toBe(true)
    expect(result.key).toBe(lessonKey(math))
    expect(result.minutesUntil).toBe(2)
    expect(result.detail).toContain('2 分钟')
  })

  it('窗口外不触发：距结束还早（15 分钟）与刚下课', () => {
    const math = lesson()
    expect(evaluateTrigger(trigger, ctx(dayAt(8, 30), [math])).matched).toBe(false)
    expect(evaluateTrigger(trigger, ctx(dayAt(8, 46), [math])).matched).toBe(false)
  })
})

describe('evaluateTrigger · class-end（下课时）', () => {
  it('endTime ≤ now < endTime+1min 命中（08:45:30）', () => {
    const math = lesson()
    const result = evaluateTrigger({ kind: 'class-end', params: {} }, ctx(dayAt(8, 45, 30), [math]))
    expect(result.matched).toBe(true)
    expect(result.key).toBe(lessonKey(math))
    expect(result.lesson?.subject).toBe('数学')
  })

  it('上课中与下课超过 1 分钟都不触发', () => {
    const math = lesson()
    expect(
      evaluateTrigger({ kind: 'class-end', params: {} }, ctx(dayAt(8, 40), [math])).matched,
    ).toBe(false)
    expect(
      evaluateTrigger({ kind: 'class-end', params: {} }, ctx(dayAt(8, 46, 1), [math])).matched,
    ).toBe(false)
  })
})

describe('evaluateTrigger · next-lesson（下节课是指定科目）', () => {
  it('下一节科目匹配命中并给出分钟差', () => {
    const next = lesson({ startTime: '09:00', endTime: '09:45', subject: '语文' })
    const result = evaluateTrigger(
      { kind: 'next-lesson', params: { subject: '语文' } },
      ctx(dayAt(8, 50), [next]),
    )
    expect(result.matched).toBe(true)
    expect(result.key).toBe(lessonKey(next))
    expect(result.lesson?.subject).toBe('语文')
    expect(result.minutesUntil).toBe(10)
  })

  it('科目不匹配 / 无下一节不触发', () => {
    const next = lesson({ startTime: '09:00', endTime: '09:45', subject: '语文' })
    expect(
      evaluateTrigger(
        { kind: 'next-lesson', params: { subject: '数学' } },
        ctx(dayAt(8, 50), [next]),
      ).matched,
    ).toBe(false)
    // 所有课都已开始：没有「下一节」
    expect(
      evaluateTrigger(
        { kind: 'next-lesson', params: { subject: '语文' } },
        ctx(dayAt(9, 0), [next]),
      ).matched,
    ).toBe(false)
    expect(
      evaluateTrigger({ kind: 'next-lesson', params: {} }, ctx(dayAt(8, 50), [next])).matched,
    ).toBe(false)
  })
})

describe('evaluateTrigger · 跨天（临近午夜）', () => {
  it('lessons 含明天 weekday 的课时也能命中课前窗口', () => {
    const tomorrow = lesson({
      weekday: TUESDAY_WEEKDAY,
      startTime: '00:02',
      endTime: '00:45',
      subject: '英语',
    })
    const result = evaluateTrigger(
      { kind: 'pre-class', params: { leadMinutes: 5 } },
      ctx(dayAt(23, 58), [tomorrow]),
    )
    expect(result.matched).toBe(true)
    expect(result.key).toBe(lessonKey(tomorrow))
    expect(result.minutesUntil).toBe(4)
  })

  it('明天的课离得还远（次日 08:00）不触发', () => {
    const tomorrow = lesson({ weekday: TUESDAY_WEEKDAY, startTime: '08:00' })
    const result = evaluateTrigger(
      { kind: 'pre-class', params: { leadMinutes: 5 } },
      ctx(dayAt(23, 58), [tomorrow]),
    )
    expect(result.matched).toBe(false)
  })
})

describe('currentLesson / nextLesson 辅助', () => {
  it('currentLesson 返回正在上的课，否则 undefined', () => {
    const math = lesson()
    const english = lesson({ startTime: '09:00', endTime: '09:45', subject: '英语' })
    expect(currentLesson(ctx(dayAt(8, 10), [math, english]))?.subject).toBe('数学')
    expect(currentLesson(ctx(dayAt(8, 50), [math, english]))).toBeUndefined()
  })

  it('nextLesson 返回开始时间最近的未开始课，否则 undefined', () => {
    const math = lesson()
    const english = lesson({ startTime: '09:00', endTime: '09:45', subject: '英语' })
    const chinese = lesson({ startTime: '10:00', endTime: '10:45', subject: '语文' })
    expect(nextLesson(ctx(dayAt(8, 50), [math, english, chinese]))?.subject).toBe('英语')
    expect(nextLesson(ctx(dayAt(11, 0), [math, english, chinese]))).toBeUndefined()
  })
})

describe('evaluateTrigger · 非法与缺参兜底', () => {
  it('params 为空对象或错型一律 matched:false，绝不抛错', () => {
    const kinds = [
      'daily',
      'interval',
      'pre-class',
      'class-start',
      'pre-end',
      'class-end',
      'next-lesson',
    ] as const
    const now = dayAt(8, 0)
    for (const kind of kinds) {
      expect(evaluateTrigger({ kind, params: {} }, ctx(now)).matched, kind).toBe(false)
      expect(
        evaluateTrigger({ kind, params: 'oops' as unknown as Record<string, unknown> }, ctx(now))
          .matched,
        kind,
      ).toBe(false)
    }
  })

  it('未知 kind 不触发', () => {
    const result = evaluateTrigger(
      { kind: 'cron' as never, params: {} },
      ctx(dayAt(8, 0), [lesson()]),
    )
    expect(result.matched).toBe(false)
    expect(result.key).toBeNull()
  })
})
