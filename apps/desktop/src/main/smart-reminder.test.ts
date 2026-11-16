import { describe, expect, it, vi } from 'vitest'
import type { Logger } from '@aurora/shared'
import {
  buildDigestPrompt,
  isSmartWindowActive,
  localDateKey,
  SmartReminderService,
  SMART_DIGEST_PROMPT_MARKER,
  stripDigestMarker,
  type SmartReminderEntry,
  type SmartReminderPrefs,
} from './smart-reminder.js'
import type { Lesson } from './schedule.js'

/** 2026-03-02 是星期一 */
const MONDAY = new Date(2026, 2, 2, 9, 30, 0)

function lesson(overrides: Partial<Lesson> = {}): Lesson {
  return { weekday: 1, startTime: '08:00', endTime: '08:45', subject: '数学', ...overrides }
}

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger
}

interface Harness {
  service: SmartReminderService
  saved: ReturnType<typeof captureSaves>['saved']
  digestCalls: { text: string; count: number }[]
  summarizeCalls: number
  clearCalls: number
}

function captureSaves() {
  const saved: {
    version: number
    queue: SmartReminderEntry[]
    lastDigest?: string
    pendingSince?: string
  }[] = []
  return { saved }
}

interface HarnessOptions {
  prefs?: Partial<SmartReminderPrefs>
  mode?: string
  lessons?: Lesson[] | 'throw'
  preloaded?: SmartReminderEntry[]
  preloadedPendingSince?: string | null
  summarize?: ((entries: readonly SmartReminderEntry[]) => Promise<string | null>) | null
}

/** 组装一套内存依赖：`now` / `prefs` 由测试直接改写（闭包变量） */
function makeHarness(options: HarnessOptions = {}) {
  const logger = makeLogger()
  const clockNow = new Date(MONDAY)
  const prefs: SmartReminderPrefs = {
    smartEnabled: true,
    smartWindow: { start: '09:00', end: '10:00', daily: true, armedDate: localDateKey(MONDAY) },
    smartDuringClass: false,
    smartSummarize: true,
    smartDelayMinutes: 0,
    ...options.prefs,
  }
  const modeId = options.mode ?? 'classroom'
  const lessons = options.lessons ?? []
  const { saved } = captureSaves()
  const digestCalls: { text: string; count: number }[] = []
  let summarizeCalls = 0
  let clearCalls = 0

  const service = new SmartReminderService({
    logger,
    clock: () => clockNow,
    settings: () => prefs,
    mode: () => modeId,
    lessonsToday: async () => {
      if (lessons === 'throw') throw new Error('provider down')
      return lessons
    },
    loadQueue: async () => ({
      queue: options.preloaded ?? [],
      pendingSince: options.preloadedPendingSince ?? null,
    }),
    saveQueue: async (file) => {
      saved.push(JSON.parse(JSON.stringify(file)))
    },
    clearWindow: async () => {
      clearCalls += 1
      prefs.smartWindow = null
    },
    summarize:
      options.summarize === null
        ? async () => null
        : async (entries) => {
            summarizeCalls += 1
            return (
              options.summarize?.(entries) ??
              `总结：${entries.map((entry) => entry.title).join('、')}`
            )
          },
    deliverDigest: (text, count) => {
      digestCalls.push({ text, count })
    },
  })

  const harness: Harness & { now: Date; prefs: SmartReminderPrefs } = {
    service,
    saved,
    digestCalls,
    get summarizeCalls() {
      return summarizeCalls
    },
    get clearCalls() {
      return clearCalls
    },
    now: clockNow,
    prefs,
  }
  return harness
}

/** 落盘走 promise 链，等一拍让 saveQueue 落地 */
async function flushSaves(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('buildDigestPrompt / stripDigestMarker', () => {
  it('标记在首行，每条提醒（时刻 + 标题 + 正文）都在提示词里', () => {
    const prompt = buildDigestPrompt([
      { at: '2026-11-07T08:03:00.000Z', title: '分类完成', body: '《a.pdf》已分类到 数学' },
      { at: '2026-11-07T08:05:00.000Z', title: '课前提醒：数学', body: '还有 5 分钟上课' },
    ])
    const lines = prompt.split('\n')
    expect(lines[0]).toBe(SMART_DIGEST_PROMPT_MARKER)
    expect(prompt).toContain('08:03 分类完成：《a.pdf》已分类到 数学')
    expect(prompt).toContain('08:05 课前提醒：数学：还有 5 分钟上课')
  })

  it('stripDigestMarker 剥掉标记并保留其余文本（真实模型不该回显它）', () => {
    expect(stripDigestMarker(`AURORA_SMART_DIGEST 摘要正文`)).toBe(' 摘要正文')
    expect(stripDigestMarker('没有标记的输出')).toBe('没有标记的输出')
  })
})

describe('isSmartWindowActive / localDateKey', () => {
  it('每天重复窗口：时段内命中，支持跨天', () => {
    const daily = { start: '22:30', end: '07:00', daily: true, armedDate: '2000-01-01' }
    expect(isSmartWindowActive(new Date(2026, 2, 2, 23, 0), daily)).toBe(true)
    expect(isSmartWindowActive(new Date(2026, 2, 3, 6, 0), daily)).toBe(true)
    expect(isSmartWindowActive(new Date(2026, 2, 2, 12, 0), daily)).toBe(false)
  })

  it('一次性窗口：仅 armedDate 当天生效；起止相同视为未配置', () => {
    const once = { start: '09:00', end: '10:00', daily: false, armedDate: localDateKey(MONDAY) }
    expect(isSmartWindowActive(MONDAY, once)).toBe(true)
    expect(isSmartWindowActive(new Date(2026, 2, 3, 9, 30), once)).toBe(false)
    expect(
      isSmartWindowActive(MONDAY, { start: '09:00', end: '09:00', daily: true, armedDate: 'x' }),
    ).toBe(false)
    expect(isSmartWindowActive(MONDAY, null)).toBe(false)
  })
})

describe('SmartReminderService.gate', () => {
  it('总开关关闭时一律放行', () => {
    const h = makeHarness({ prefs: { smartEnabled: false } })
    expect(h.service.gate({ title: '分类完成', body: 'x' })).toBe('deliver')
    expect(h.service.diagnostics().queueLength).toBe(0)
  })

  it('每天重复窗口覆盖当前时刻：抑制并入队落盘', async () => {
    const h = makeHarness()
    await h.service.evaluate()
    expect(h.service.gate({ title: '分类完成', body: '《a.pdf》' })).toBe('suppress')
    expect(h.service.diagnostics().queueLength).toBe(1)
    await flushSaves()
    expect(h.saved.at(-1)?.queue).toHaveLength(1)
    expect(h.saved.at(-1)?.queue[0]?.title).toBe('分类完成')
  })

  it('一次性窗口已过期（armedDate 非今天）：放行并清理死配置', async () => {
    const h = makeHarness({
      prefs: {
        smartWindow: { start: '09:00', end: '10:00', daily: false, armedDate: '2026-02-01' },
      },
    })
    await h.service.evaluate()
    expect(h.service.gate({ title: 'x', body: 'y' })).toBe('deliver')
    expect(h.clearCalls).toBe(1)
    expect(h.prefs.smartWindow).toBeNull()
  })

  it('上课期间免打扰：classroom 模式且正在上课才抑制；provider 失败按没在上课', async () => {
    // 09:30 在这节课内（夹具时钟是 MONDAY 09:30）
    const h = makeHarness({
      prefs: { smartWindow: null, smartDuringClass: true },
      lessons: [lesson({ startTime: '09:00', endTime: '10:00' })],
    })
    await h.service.evaluate()
    expect(h.service.diagnostics().inClass).toBe(true)
    expect(h.service.gate({ title: 'x', body: 'y' })).toBe('suppress')

    const off = makeHarness({
      prefs: { smartWindow: null, smartDuringClass: true },
      mode: 'work',
      lessons: [lesson({ startTime: '09:00', endTime: '10:00' })],
    })
    await off.service.evaluate()
    expect(off.service.gate({ title: 'x', body: 'y' })).toBe('deliver')

    const down = makeHarness({
      prefs: { smartWindow: null, smartDuringClass: true },
      lessons: 'throw',
    })
    await down.service.evaluate()
    expect(down.service.diagnostics().inClass).toBe(false)
    expect(down.service.gate({ title: 'x', body: 'y' })).toBe('deliver')
  })

  it('队列超过上限丢最旧', async () => {
    const h = makeHarness()
    await h.service.evaluate()
    for (let i = 0; i < 55; i += 1) {
      h.service.gate({ title: `t${i}`, body: 'b' })
    }
    expect(h.service.diagnostics().queueLength).toBe(50)
    await flushSaves()
    expect(h.saved.at(-1)?.queue[0]?.title).toBe('t5')
  })

  it('设置读取失败按不抑制处理，绝不抛错', () => {
    const logger = makeLogger()
    const service = new SmartReminderService({
      logger,
      clock: () => MONDAY,
      settings: () => {
        throw new Error('store gone')
      },
      mode: () => 'classroom',
      lessonsToday: async () => [],
      loadQueue: async () => ({ queue: [], pendingSince: null }),
      saveQueue: async () => {},
      clearWindow: async () => {},
      summarize: async () => null,
      deliverDigest: () => {},
    })
    expect(service.gate({ title: 'x', body: 'y' })).toBe('deliver')
  })
})

describe('SmartReminderService 结算', () => {
  it('边沿（active → 非active）且队列非空：总结后投递，队列清空', async () => {
    const h = makeHarness()
    await h.service.evaluate()
    h.service.gate({ title: '分类完成', body: '《a.pdf》已分类到 数学' })
    h.service.gate({ title: '需要你确认分类', body: '《b.pdf》' })
    h.now.setTime(new Date(2026, 2, 2, 10, 5).getTime())
    await h.service.evaluate()
    expect(h.summarizeCalls).toBe(1)
    expect(h.digestCalls).toHaveLength(1)
    expect(h.digestCalls[0]).toMatchObject({ count: 2 })
    expect(h.digestCalls[0]?.text).toContain('分类完成')
    expect(h.service.diagnostics().queueLength).toBe(0)
    // 每天重复的窗口不清空
    expect(h.clearCalls).toBe(0)
    await flushSaves()
    expect(h.saved.at(-1)?.queue).toHaveLength(0)
    expect(h.saved.at(-1)?.lastDigest).toContain('分类完成')
  })

  it('一次性窗口结算后自动清空', async () => {
    const h = makeHarness({
      prefs: {
        smartWindow: {
          start: '09:00',
          end: '10:00',
          daily: false,
          armedDate: localDateKey(MONDAY),
        },
      },
    })
    await h.service.evaluate()
    h.service.gate({ title: 'x', body: 'y' })
    h.now.setTime(new Date(2026, 2, 2, 10, 5).getTime())
    await h.service.evaluate()
    expect(h.digestCalls).toHaveLength(1)
    expect(h.clearCalls).toBe(1)
    expect(h.prefs.smartWindow).toBeNull()
  })

  it('smartSummarize 关闭 / summarize 抛错 / 返回空：回落逐条纯文本，不丢提醒', async () => {
    for (const summarize of [null, async () => Promise.reject(new Error('llm down')), null]) {
      const h = makeHarness({
        prefs: { smartSummarize: false },
        summarize,
      })
      await h.service.evaluate()
      h.service.gate({ title: '分类完成', body: '《a.pdf》已分类到 数学' })
      h.now.setTime(new Date(2026, 2, 2, 10, 5).getTime())
      await h.service.evaluate()
      expect(h.digestCalls).toHaveLength(1)
      expect(h.digestCalls[0]?.text).toContain('分类完成')
      expect(h.digestCalls[0]?.text).toContain('《a.pdf》')
      expect(h.service.diagnostics().queueLength).toBe(0)
    }

    const h2 = makeHarness({ summarize: async () => '' })
    await h2.service.evaluate()
    h2.service.gate({ title: '课前提醒：数学', body: '还有 5 分钟上课' })
    h2.now.setTime(new Date(2026, 2, 2, 10, 5).getTime())
    await h2.service.evaluate()
    expect(h2.digestCalls[0]?.text).toContain('课前提醒：数学')
  })

  it('结算后再次抑制需要新的边沿（不会重复投递）', async () => {
    const h = makeHarness()
    await h.service.evaluate()
    h.service.gate({ title: 'x', body: 'y' })
    h.now.setTime(new Date(2026, 2, 2, 10, 5).getTime())
    await h.service.evaluate()
    expect(h.digestCalls).toHaveLength(1)
    // 队列已空，再次评估不再投递
    await h.service.evaluate()
    expect(h.digestCalls).toHaveLength(1)
  })
})

describe('SmartReminderService 延迟结算（v44）', () => {
  /** 把时钟推到 10:05（窗口 09:00–10:00 之外）并评估 = 制造一次下降沿 */
  async function edgeAt1005(h: ReturnType<typeof makeHarness>): Promise<void> {
    h.now.setTime(new Date(2026, 2, 2, 10, 5).getTime())
    await h.service.evaluate()
  }

  it('delay>0：边沿只记时刻不投递；到期投一次并清 pendingSince；延迟期间新提醒照常放行', async () => {
    const h = makeHarness({ prefs: { smartDelayMinutes: 10 } })
    await h.service.evaluate()
    h.service.gate({ title: 'x', body: 'y' })
    await edgeAt1005(h)
    expect(h.digestCalls).toHaveLength(0)
    expect(h.service.diagnostics().queueLength).toBe(1)
    const edge = new Date(2026, 2, 2, 10, 5)
    expect(h.service.diagnostics().pendingSettleAt).toBe(
      new Date(edge.getTime() + 10 * 60_000).toISOString(),
    )
    await flushSaves()
    expect(h.saved.at(-1)?.pendingSince).toBe(edge.toISOString())
    // 延迟期间不在免打扰期：新提醒照常逐条投递，不入队
    expect(h.service.gate({ title: 'new', body: 'z' })).toBe('deliver')
    expect(h.service.diagnostics().queueLength).toBe(1)

    // 差 1 秒不到期：不投
    h.now.setTime(new Date(2026, 2, 2, 10, 14, 59).getTime())
    await h.service.evaluate()
    expect(h.digestCalls).toHaveLength(0)
    // 到期：投一次，pendingSince 清除
    h.now.setTime(new Date(2026, 2, 2, 10, 15).getTime())
    await h.service.evaluate()
    expect(h.digestCalls).toHaveLength(1)
    expect(h.digestCalls[0]?.count).toBe(1)
    expect(h.service.diagnostics().queueLength).toBe(0)
    expect(h.service.diagnostics().pendingSettleAt).toBeUndefined()
    await flushSaves()
    expect(h.saved.at(-1)?.pendingSince).toBeUndefined()
  })

  it('延迟期间改 delay=0：立即结算', async () => {
    const h = makeHarness({ prefs: { smartDelayMinutes: 10 } })
    await h.service.evaluate()
    h.service.gate({ title: 'x', body: 'y' })
    await edgeAt1005(h)
    expect(h.digestCalls).toHaveLength(0)
    h.prefs.smartDelayMinutes = 0
    await h.service.evaluate()
    expect(h.digestCalls).toHaveLength(1)
    expect(h.service.diagnostics().queueLength).toBe(0)
  })

  it('延迟期间改大 delay：按新值顺延，原到期时刻不投', async () => {
    const h = makeHarness({ prefs: { smartDelayMinutes: 10 } })
    await h.service.evaluate()
    h.service.gate({ title: 'x', body: 'y' })
    await edgeAt1005(h)
    h.prefs.smartDelayMinutes = 30
    h.now.setTime(new Date(2026, 2, 2, 10, 15).getTime())
    await h.service.evaluate()
    expect(h.digestCalls).toHaveLength(0)
    expect(h.service.diagnostics().pendingSettleAt).toBe(new Date(2026, 2, 2, 10, 35).toISOString())
    h.now.setTime(new Date(2026, 2, 2, 10, 35).getTime())
    await h.service.evaluate()
    expect(h.digestCalls).toHaveLength(1)
  })

  it('延迟期间再次入窗：取消待投并落盘；出窗按新边沿重新计时，新旧队列合并结算', async () => {
    const h = makeHarness({ prefs: { smartDelayMinutes: 10 } })
    await h.service.evaluate()
    h.service.gate({ title: 'old', body: 'y' })
    await edgeAt1005(h)
    expect(h.service.diagnostics().pendingSettleAt).toBeDefined()

    // 重新入窗（10:00–11:00 覆盖当前 10:05）：取消待投
    h.prefs.smartWindow = {
      start: '10:00',
      end: '11:00',
      daily: true,
      armedDate: localDateKey(MONDAY),
    }
    await h.service.evaluate()
    expect(h.service.diagnostics().active).toBe(true)
    expect(h.service.diagnostics().pendingSettleAt).toBeUndefined()
    await flushSaves()
    expect(h.saved.at(-1)?.pendingSince).toBeUndefined()
    h.service.gate({ title: 'new', body: 'z' })
    expect(h.service.diagnostics().queueLength).toBe(2)

    // 出窗：按新边沿 11:05 重新计时
    h.prefs.smartWindow = null
    h.now.setTime(new Date(2026, 2, 2, 11, 5).getTime())
    await h.service.evaluate()
    expect(h.digestCalls).toHaveLength(0)
    expect(h.service.diagnostics().pendingSettleAt).toBe(new Date(2026, 2, 2, 11, 15).toISOString())
    h.now.setTime(new Date(2026, 2, 2, 11, 15).getTime())
    await h.service.evaluate()
    expect(h.digestCalls).toHaveLength(1)
    expect(h.digestCalls[0]?.count).toBe(2)
  })

  it('延迟期间关总开关：不到期不投，到期仍投（不丢提醒）', async () => {
    const h = makeHarness({ prefs: { smartDelayMinutes: 10 } })
    await h.service.evaluate()
    h.service.gate({ title: 'x', body: 'y' })
    await edgeAt1005(h)
    h.prefs.smartEnabled = false
    await h.service.evaluate()
    expect(h.digestCalls).toHaveLength(0)
    h.now.setTime(new Date(2026, 2, 2, 10, 15).getTime())
    await h.service.evaluate()
    expect(h.digestCalls).toHaveLength(1)
    expect(h.service.diagnostics().queueLength).toBe(0)
  })

  it('一次性窗口 + 延迟：待投期间不清窗口，到期结算后清空', async () => {
    const h = makeHarness({
      prefs: {
        smartDelayMinutes: 10,
        smartWindow: {
          start: '09:00',
          end: '10:00',
          daily: false,
          armedDate: localDateKey(MONDAY),
        },
      },
    })
    await h.service.evaluate()
    h.service.gate({ title: 'x', body: 'y' })
    await edgeAt1005(h)
    expect(h.clearCalls).toBe(0)
    expect(h.prefs.smartWindow).not.toBeNull()
    h.now.setTime(new Date(2026, 2, 2, 10, 15).getTime())
    await h.service.evaluate()
    expect(h.digestCalls).toHaveLength(1)
    expect(h.clearCalls).toBe(1)
    expect(h.prefs.smartWindow).toBeNull()
  })

  it('空队列边沿不武装；pendingSince 残留 + 空队列：清残留不投递', async () => {
    const h = makeHarness({ prefs: { smartDelayMinutes: 10 } })
    await h.service.evaluate()
    await edgeAt1005(h)
    expect(h.service.diagnostics().pendingSettleAt).toBeUndefined()
    expect(h.digestCalls).toHaveLength(0)

    const h2 = makeHarness({
      preloadedPendingSince: new Date(2026, 2, 2, 10, 5).toISOString(),
      prefs: { smartWindow: null, smartDelayMinutes: 10 },
    })
    await h2.service.start()
    expect(h2.digestCalls).toHaveLength(0)
    expect(h2.service.diagnostics().pendingSettleAt).toBeUndefined()
    await flushSaves()
    expect(h2.saved.at(-1)?.pendingSince).toBeUndefined()
    h2.service.stop()
  })
})

describe('SmartReminderService.start（跨重启）', () => {
  it('启动时遗留队列且当前不在免打扰期：立即补一次结算', async () => {
    const h = makeHarness({
      preloaded: [{ at: '2026-03-02T09:10:00.000Z', title: '分类完成', body: '《a.pdf》' }],
      prefs: { smartWindow: null },
    })
    await h.service.start()
    expect(h.digestCalls).toHaveLength(1)
    expect(h.digestCalls[0]?.count).toBe(1)
    h.service.stop()
  })

  it('启动时正在免打扰期内：遗留队列继续攒着，等边沿再结算', async () => {
    const h = makeHarness({
      preloaded: [{ at: '2026-03-02T09:10:00.000Z', title: 'x', body: 'y' }],
    })
    await h.service.start()
    expect(h.digestCalls).toHaveLength(0)
    expect(h.service.diagnostics().queueLength).toBe(1)
    h.now.setTime(new Date(2026, 2, 2, 10, 5).getTime())
    await h.service.evaluate()
    expect(h.digestCalls).toHaveLength(1)
    h.service.stop()
  })

  it('v44 跨重启：待投已到期 → 补结算；未到期 → 到点投；仍在窗内 → 取消待投', async () => {
    const entry = { at: '2026-03-02T09:10:00.000Z', title: 'x', body: 'y' }
    const edge = new Date(2026, 2, 2, 10, 5).toISOString()

    // 已到期（10:20 > 10:05 + 10min）
    const due = makeHarness({
      preloaded: [entry],
      preloadedPendingSince: edge,
      prefs: { smartWindow: null, smartDelayMinutes: 10 },
    })
    due.now.setTime(new Date(2026, 2, 2, 10, 20).getTime())
    await due.service.start()
    expect(due.digestCalls).toHaveLength(1)
    due.service.stop()

    // 未到期（10:10 < 10:15）：启动不投，到点投
    const pending = makeHarness({
      preloaded: [entry],
      preloadedPendingSince: edge,
      prefs: { smartWindow: null, smartDelayMinutes: 10 },
    })
    pending.now.setTime(new Date(2026, 2, 2, 10, 10).getTime())
    await pending.service.start()
    expect(pending.digestCalls).toHaveLength(0)
    expect(pending.service.diagnostics().queueLength).toBe(1)
    expect(pending.service.diagnostics().pendingSettleAt).toBe(
      new Date(2026, 2, 2, 10, 15).toISOString(),
    )
    pending.now.setTime(new Date(2026, 2, 2, 10, 15).getTime())
    await pending.service.evaluate()
    expect(pending.digestCalls).toHaveLength(1)
    pending.service.stop()

    // 仍在窗内（09:40 在 09:00–10:00 内）：取消陈旧待投，继续攒
    const inWindow = makeHarness({
      preloaded: [entry],
      preloadedPendingSince: edge,
      prefs: { smartDelayMinutes: 10 },
    })
    inWindow.now.setTime(new Date(2026, 2, 2, 9, 40).getTime())
    await inWindow.service.start()
    expect(inWindow.digestCalls).toHaveLength(0)
    expect(inWindow.service.diagnostics().active).toBe(true)
    expect(inWindow.service.diagnostics().queueLength).toBe(1)
    expect(inWindow.service.diagnostics().pendingSettleAt).toBeUndefined()
    await flushSaves()
    expect(inWindow.saved.at(-1)?.pendingSince).toBeUndefined()
    inWindow.service.stop()
  })

  it('v44 跨重启 + 一次性窗口跨天：待投到期 → 结算并清窗口', async () => {
    const h = makeHarness({
      preloaded: [{ at: '2026-03-01T09:10:00.000Z', title: 'x', body: 'y' }],
      preloadedPendingSince: new Date(2026, 2, 1, 10, 5).toISOString(),
      prefs: {
        smartDelayMinutes: 10,
        smartWindow: { start: '09:00', end: '10:00', daily: false, armedDate: '2026-03-01' },
      },
    })
    // MONDAY 09:30：一次性窗口昨天已过期，待投早已到期
    await h.service.start()
    expect(h.digestCalls).toHaveLength(1)
    expect(h.clearCalls).toBe(1)
    expect(h.prefs.smartWindow).toBeNull()
    h.service.stop()
  })

  it('队列文件损坏：按空队列启动，不抛错', async () => {
    const logger = makeLogger()
    const service = new SmartReminderService({
      logger,
      clock: () => MONDAY,
      settings: () => ({
        smartEnabled: true,
        smartWindow: null,
        smartDuringClass: false,
        smartSummarize: true,
        smartDelayMinutes: 0,
      }),
      mode: () => 'classroom',
      lessonsToday: async () => [],
      loadQueue: async () => {
        throw new Error('corrupted')
      },
      saveQueue: async () => {},
      clearWindow: async () => {},
      summarize: async () => null,
      deliverDigest: () => {},
    })
    await expect(service.start()).resolves.toBeUndefined()
    expect(service.diagnostics().queueLength).toBe(0)
    service.stop()
  })
})
