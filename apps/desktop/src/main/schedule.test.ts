import { describe, expect, it } from 'vitest'
import {
  createClassislandPlaceholderProvider,
  createManualScheduleProvider,
  parseClock,
  resolveScheduleProvider,
  type Lesson,
} from './schedule.js'

/** 2026-03-02 是星期一；用 `getDay()` 动态取星期，避免把测试绑死在具体日历上 */
const MONDAY = new Date(2026, 2, 2, 8, 0, 0)
const MONDAY_WEEKDAY = MONDAY.getDay()
const TUESDAY = new Date(2026, 2, 3, 8, 0, 0)

function lesson(overrides: Partial<Lesson> = {}): Lesson {
  return {
    weekday: MONDAY_WEEKDAY,
    startTime: '08:00',
    endTime: '08:45',
    subject: '数学',
    ...overrides,
  }
}

describe('parseClock', () => {
  it('解析 "HH:mm" 为当日分钟数', () => {
    expect(parseClock('00:00')).toBe(0)
    expect(parseClock('08:00')).toBe(480)
    expect(parseClock('7:05')).toBe(425)
    expect(parseClock('23:59')).toBe(1439)
  })

  it('忽略首尾空格', () => {
    expect(parseClock(' 08:30 ')).toBe(510)
  })

  it('非法输入返回 undefined（调用方跳过该节课）', () => {
    expect(parseClock('')).toBeUndefined()
    expect(parseClock('abc')).toBeUndefined()
    expect(parseClock('8')).toBeUndefined()
    expect(parseClock('08')).toBeUndefined()
    expect(parseClock('24:00')).toBeUndefined()
    expect(parseClock('08:60')).toBeUndefined()
    expect(parseClock('-1:00')).toBeUndefined()
    expect(parseClock('08:00:00')).toBeUndefined()
    expect(parseClock(undefined as unknown as string)).toBeUndefined()
  })
})

describe('createManualScheduleProvider', () => {
  it('只返回当天的课程，并按开始时间升序', () => {
    const lessons: Lesson[] = [
      lesson({ startTime: '10:00', subject: '英语' }),
      lesson({ startTime: '08:00', subject: '数学' }),
      lesson({ weekday: TUESDAY.getDay(), startTime: '09:00', subject: '物理' }),
    ]
    const provider = createManualScheduleProvider(() => lessons)
    expect(provider.id).toBe('manual')
    return provider.getToday(MONDAY).then((today) => {
      expect(today.map((item) => item.subject)).toEqual(['数学', '英语'])
    })
  })

  it('每次调用即时读取课程表（改配置无需重启）', async () => {
    let lessons: Lesson[] = []
    const provider = createManualScheduleProvider(() => lessons)
    expect(await provider.getToday(MONDAY)).toEqual([])
    lessons = [lesson()]
    expect(await provider.getToday(MONDAY)).toHaveLength(1)
    lessons = []
    expect(await provider.getToday(MONDAY)).toEqual([])
  })

  it('返回副本，调用方改写不会污染设置里的课程表', async () => {
    const lessons: Lesson[] = [lesson()]
    const provider = createManualScheduleProvider(() => lessons)
    const today = await provider.getToday(MONDAY)
    today[0]!.subject = '被改写'
    expect(lessons[0]?.subject).toBe('数学')
  })

  it('非法开始时间的课程排到最后（不丢数据），开始时间无法解析返回 undefined', () => {
    expect(parseClock('8点')).toBeUndefined()
    return createManualScheduleProvider(() => [
      lesson({ startTime: '8点', subject: '未知时间' }),
      lesson({ startTime: '09:00', subject: '英语' }),
    ])
      .getToday(MONDAY)
      .then((today) => {
        expect(today.map((item) => item.subject)).toEqual(['英语', '未知时间'])
      })
  })
})

describe('createClassislandPlaceholderProvider', () => {
  it('永远返回空数组且不抛错（P7 实现）', async () => {
    const provider = createClassislandPlaceholderProvider()
    expect(provider.id).toBe('classisland')
    await expect(provider.getToday(MONDAY)).resolves.toEqual([])
    await expect(provider.getToday(new Date())).resolves.toEqual([])
  })
})

describe('resolveScheduleProvider', () => {
  it('manual：读取当前课程表', async () => {
    const settings = {
      schedule: { provider: 'manual' as const, lessons: [lesson()] },
    }
    const provider = resolveScheduleProvider(settings)
    expect(provider.id).toBe('manual')
    expect(await provider.getToday(MONDAY)).toHaveLength(1)
  })

  it('classisland：忽略手动课程表，返回占位实现', async () => {
    const settings = {
      schedule: { provider: 'classisland' as const, lessons: [lesson()] },
    }
    const provider = resolveScheduleProvider(settings)
    expect(provider.id).toBe('classisland')
    expect(await provider.getToday(MONDAY)).toEqual([])
  })
})
