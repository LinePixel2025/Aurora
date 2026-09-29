import { afterEach, describe, expect, it } from 'vitest'
import {
  createDefaultSettings,
  type AgentEvent,
  type FileSystemPort,
  type Logger,
  type Settings,
} from '@aurora/shared'
import type { AutomationDefinition } from '@aurora/shared'
import type { ToolDefinition } from '@aurora/agent-core'
import {
  AutomationEngine,
  BUILTIN_PRE_CLASS_NOTIFY_ID,
  BUILTIN_PRE_CLASS_OPEN_FOLDER_ID,
  type AutomationAgentPort,
  type AutomationEngineOptions,
} from './engine.js'
import { AutomationStore } from './store.js'
import type { AutomationActionPorts } from './actions.js'
import type { IScheduleProvider, Lesson } from '../schedule.js'

const DIR = 'C:\\aurora-engine-test'

/** 静默 Logger：单测不需要日志输出（引擎的 logger 是可注入端口） */
function silentLogger(): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  }
  return logger
}

/** 2026-03-02 是星期一；07:57 距 08:00 上课 3 分钟 */
const MONDAY_0757 = new Date(2026, 2, 2, 7, 57, 0)
const MONDAY_WEEKDAY = MONDAY_0757.getDay()

/** 与 store.test.ts 同款最小内存文件系统（满足 FileSystemPort） */
class MemoryFs implements FileSystemPort {
  readonly files = new Map<string, string>()

  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path)
    if (content === undefined) throw new Error(`ENOENT: ${path}`)
    return content
  }

  async writeFileAtomic(path: string, content: string): Promise<void> {
    this.files.set(path, content)
  }

  async rename(from: string, to: string): Promise<void> {
    const content = this.files.get(from)
    if (content === undefined) throw new Error(`ENOENT: ${from}`)
    this.files.set(to, content)
    this.files.delete(from)
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path)
  }

  async mkdirp(): Promise<void> {}

  async readdir(path: string): Promise<string[]> {
    const prefix = path.endsWith('\\') || path.endsWith('/') ? path : `${path}\\`
    const names = new Set<string>()
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue
      const first = file.slice(prefix.length).split(/[\\/]/)[0]
      if (first) names.add(first)
    }
    return [...names]
  }
}

/** 假 Agent 端口：记录 send 请求，允许测试手动 emit 事件触发 onEvent 监听器 */
class FakeAgentPort implements AutomationAgentPort {
  readonly sent: Array<{
    sessionId: string
    text: string
    origin: 'automation'
    extraContext?: string
  }> = []
  private counter = 0
  private readonly listeners: Array<(event: AgentEvent) => void> = []

  async send(request: {
    sessionId: string
    text: string
    origin: 'automation'
    extraContext?: string
  }): Promise<{ requestId: string }> {
    this.sent.push({ ...request })
    this.counter += 1
    return { requestId: `req-${this.counter}` }
  }

  abort(): boolean {
    return false
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.listeners.push(listener)
    return () => {
      const index = this.listeners.indexOf(listener)
      if (index >= 0) this.listeners.splice(index, 1)
    }
  }

  emit(event: AgentEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
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

function dailyNotifyDefinition(
  overrides: Partial<AutomationDefinition> = {},
): AutomationDefinition {
  return {
    id: 'am-daily',
    name: '早读提醒',
    enabled: true,
    mode: 'normal',
    trigger: { kind: 'daily', params: { at: '08:00' } },
    actions: [{ kind: 'system-notify', params: { title: '早读' } }],
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

function agentDefinition(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: 'am-agent',
    name: '整理笔记',
    enabled: true,
    mode: 'agent',
    trigger: { kind: 'interval', params: { everyMinutes: 30 } },
    prompt: '帮我整理今天的笔记',
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

interface HarnessOptions {
  /** 深拷贝默认配置后按需改动 */
  settings?: (settings: Settings) => void
  lessons?: Lesson[]
  /** 科目名 → 文件夹的映射根；'' = 未映射 */
  subjectDir?: string
  maxAgentRunMs?: number
}

interface BuiltinFiredInfo {
  builtinId: string
  subject: string
  minutesUntil: number
  targetDir: string
}

function createHarness(options: HarnessOptions = {}) {
  const settings = createDefaultSettings()
  options.settings?.(settings)
  const agent = new FakeAgentPort()
  const notifies: Array<{ title: string; body: string; openPath?: string }> = []
  const opened: string[] = []
  const builtinFired: BuiltinFiredInfo[] = []
  const subjectDir = options.subjectDir === undefined ? 'D:\\感知\\分类\\' : options.subjectDir
  const ports: AutomationActionPorts = {
    notify: (request) => {
      notifies.push({
        title: request.title,
        body: request.body,
        ...(request.openPath === undefined ? {} : { openPath: request.openPath }),
      })
      return true
    },
    classisland: { available: () => false, notify: async () => ({ ok: true }) },
    openPath: async (target) => {
      opened.push(target)
    },
    resolveSubjectDir: (subject) => (subjectDir === '' ? '' : `${subjectDir}${subject}`),
    // 静默 logger：单测不需要日志输出（引擎的 logger 是可注入端口）
    logger: silentLogger(),
  }
  const lessons = options.lessons ?? []
  const provider: IScheduleProvider = {
    id: 'manual',
    getToday: async () => lessons.map((item) => ({ ...item })),
  }
  let now = MONDAY_0757
  const store = new AutomationStore({ dir: DIR, fs: new MemoryFs(), writeDebounceMs: 0 })
  const engineOptions: AutomationEngineOptions = {
    store,
    agent,
    settings: () => settings,
    provider: () => provider,
    actions: ports,
    intervalMs: 60_000,
    clock: () => now,
    onBuiltinFired: (info) => {
      builtinFired.push({ ...info })
    },
    ...(options.maxAgentRunMs === undefined ? {} : { maxAgentRunMs: options.maxAgentRunMs }),
  }
  const engine = new AutomationEngine(engineOptions)
  engines.push(engine)
  return {
    engine,
    store,
    agent,
    notifies,
    opened,
    builtinFired,
    settings,
    setNow: (next: Date) => {
      now = next
    },
  }
}

/** 等待引擎里的 void 异步收尾（updateRun 等）落定 */
async function settle(ms = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

const engines: AutomationEngine[] = []
afterEach(() => {
  for (const engine of engines) engine.stop()
  engines.length = 0
})

describe('AutomationEngine · 用户定义触发', () => {
  it('daily 触发 Normal：notify 被调、历史 success；同一 key 再次 tick 不重复触发', async () => {
    const h = createHarness({
      settings: (s) => {
        s.modes.current = 'work'
      },
    })
    await h.store.saveDefinition(dailyNotifyDefinition())

    await h.engine.tick(new Date(2026, 2, 2, 8, 0, 0))
    expect(h.notifies).toHaveLength(1)
    expect(h.notifies[0]?.title).toBe('早读')
    const runs = await h.store.listRuns({ automationId: 'am-daily' })
    expect(runs).toHaveLength(1)
    expect(runs[0]?.status).toBe('success')
    expect(runs[0]?.finishedAt).toBeDefined()

    // 15s 节拍内的第二次评估：daily key（日期 + 时刻）相同 → firedKeys 去重
    await h.engine.tick(new Date(2026, 2, 2, 8, 0, 5))
    expect(h.notifies).toHaveLength(1)
    expect(await h.store.listRuns({ automationId: 'am-daily' })).toHaveLength(1)
  })

  it('automations.enabled=false 时 tick 什么都不做', async () => {
    const h = createHarness({
      settings: (s) => {
        s.automations.enabled = false
        s.modes.current = 'work'
      },
    })
    await h.store.saveDefinition(dailyNotifyDefinition())
    await h.engine.tick(new Date(2026, 2, 2, 8, 0, 0))
    expect(h.notifies).toEqual([])
    expect(await h.store.listRuns({ limit: 0 })).toEqual([])
  })
})

describe('AutomationEngine · Agent 模式', () => {
  it('触发时 send 带 auto- 会话、origin=automation 与触发上下文；历史 running 记录带 sessionId', async () => {
    const h = createHarness({
      settings: (s) => {
        s.modes.current = 'work'
      },
    })
    await h.store.saveDefinition(agentDefinition())

    await h.engine.tick(new Date(2026, 2, 2, 8, 0, 0))
    expect(h.agent.sent).toHaveLength(1)
    const request = h.agent.sent[0]!
    expect(request.sessionId.startsWith('auto-')).toBe(true)
    expect(request.origin).toBe('automation')
    expect(request.text).toBe('帮我整理今天的笔记')
    expect(request.extraContext).toContain('整理笔记')
    expect(request.extraContext).toContain('每 30 分钟')

    const runs = await h.store.listRuns({ automationId: 'am-agent' })
    expect(runs).toHaveLength(1)
    expect(runs[0]?.status).toBe('running')
    expect(runs[0]?.sessionId).toBe(request.sessionId)
  })

  it('done 事件收尾：历史 success 并带 durationMs / finishedAt', async () => {
    const h = createHarness({
      settings: (s) => {
        s.modes.current = 'work'
      },
    })
    await h.store.saveDefinition(agentDefinition())
    await h.engine.tick(new Date(2026, 2, 2, 8, 0, 0))
    const request = h.agent.sent[0]!

    h.agent.emit({ type: 'done', sessionId: request.sessionId, requestId: 'req-1', seq: 1 })
    await settle()
    const runs = await h.store.listRuns({ automationId: 'am-agent' })
    expect(runs[0]?.status).toBe('success')
    expect(runs[0]?.durationMs).toBeGreaterThanOrEqual(0)
    expect(runs[0]?.finishedAt).toBeDefined()
  })

  it('error 事件收尾：历史 failed 并带错误信息', async () => {
    const h = createHarness({
      settings: (s) => {
        s.modes.current = 'work'
      },
    })
    await h.store.saveDefinition(agentDefinition())
    await h.engine.tick(new Date(2026, 2, 2, 8, 0, 0))
    const request = h.agent.sent[0]!

    h.agent.emit({
      type: 'error',
      sessionId: request.sessionId,
      requestId: 'req-1',
      seq: 1,
      code: 'E_PROVIDER',
      message: '模型不可用',
    })
    await settle()
    const runs = await h.store.listRuns({ automationId: 'am-agent' })
    expect(runs[0]?.status).toBe('failed')
    expect(runs[0]?.error).toBe('模型不可用')
  })

  it('Agent 运行超时：maxAgentRunMs 到点后历史 failed（构造器强制下限 1000ms，故用真实 sleep）', async () => {
    const h = createHarness({
      settings: (s) => {
        s.modes.current = 'work'
      },
      maxAgentRunMs: 1000,
    })
    await h.store.saveDefinition(agentDefinition())
    await h.engine.tick(new Date(2026, 2, 2, 8, 0, 0))
    expect(h.agent.sent).toHaveLength(1)

    await settle(1150)
    const runs = await h.store.listRuns({ automationId: 'am-agent' })
    expect(runs[0]?.status).toBe('failed')
    expect(runs[0]?.error).toBe('运行超时，已中止')
    expect(runs[0]?.finishedAt).toBeDefined()
  }, 10_000)
})

describe('AutomationEngine · 内置自动化（课前提醒）', () => {
  const classroomSettings = (s: Settings): void => {
    s.modes.current = 'classroom'
    s.modes.classroom.preClassReminder = true
    s.modes.classroom.preClassOpenFolder = false
    s.modes.classroom.preClassLeadMinutes = 5
  }

  it('命中课前窗口：notify 收到「课前提醒：数学」，onBuiltinFired 被调；再次 tick 不重复', async () => {
    const h = createHarness({ lessons: [lesson()], settings: classroomSettings })
    await h.engine.tick(MONDAY_0757)

    expect(h.notifies).toHaveLength(1)
    expect(h.notifies[0]?.title).toBe('课前提醒：数学')
    expect(h.notifies[0]?.body).toBe('08:00 上课，还有 3 分钟')
    expect(h.builtinFired).toEqual([
      {
        builtinId: BUILTIN_PRE_CLASS_NOTIFY_ID,
        subject: '数学',
        minutesUntil: 3,
        targetDir: 'D:\\感知\\分类\\数学',
      },
    ])

    // 同一节课（lessonKey）只提醒一次
    await h.engine.tick(new Date(2026, 2, 2, 7, 58, 0))
    expect(h.notifies).toHaveLength(1)
    expect(h.builtinFired).toHaveLength(1)
  })

  it('preClassReminder=false 或 modes.current=work 时不触发', async () => {
    const off = createHarness({
      lessons: [lesson()],
      settings: (s) => {
        s.modes.current = 'classroom'
        s.modes.classroom.preClassReminder = false
        s.modes.classroom.preClassOpenFolder = false
      },
    })
    await off.engine.tick(MONDAY_0757)
    expect(off.notifies).toEqual([])
    expect(off.builtinFired).toEqual([])

    const work = createHarness({
      lessons: [lesson()],
      settings: (s) => {
        s.modes.current = 'work'
      },
    })
    await work.engine.tick(MONDAY_0757)
    expect(work.notifies).toEqual([])
    expect(work.builtinFired).toEqual([])
  })
})

describe('AutomationEngine · 内置自动化（课前打开科目文件夹）', () => {
  const openFolderSettings = (s: Settings): void => {
    s.modes.current = 'classroom'
    s.modes.classroom.preClassReminder = false
    s.modes.classroom.preClassOpenFolder = true
  }

  it('resolveSubjectDir 有值时 openPath 被调', async () => {
    const h = createHarness({
      lessons: [lesson()],
      subjectDir: 'D:\\科目\\',
      settings: openFolderSettings,
    })
    await h.engine.tick(MONDAY_0757)
    expect(h.opened).toEqual(['D:\\科目\\数学'])
    expect(h.builtinFired).toEqual([
      {
        builtinId: BUILTIN_PRE_CLASS_OPEN_FOLDER_ID,
        subject: '数学',
        minutesUntil: 3,
        targetDir: 'D:\\科目\\数学',
      },
    ])
    // 课前提醒已关：不发通知
    expect(h.notifies).toEqual([])
  })

  it('resolveSubjectDir 返回空串（未映射）时跳过打开且不抛错', async () => {
    const h = createHarness({ lessons: [lesson()], subjectDir: '', settings: openFolderSettings })
    await expect(h.engine.tick(MONDAY_0757)).resolves.toBeUndefined()
    expect(h.opened).toEqual([])
    expect(h.builtinFired).toEqual([])
  })
})

describe('AutomationEngine · 勿扰时段', () => {
  it('advanced.quietHours 覆盖当前时刻时内置不触发', async () => {
    const h = createHarness({
      lessons: [lesson()],
      settings: (s) => {
        s.modes.current = 'classroom'
        s.modes.classroom.preClassReminder = true
        s.modes.classroom.preClassOpenFolder = false
        s.advanced.quietHours = { start: '07:00', end: '09:00' }
      },
    })
    await h.engine.tick(MONDAY_0757)
    expect(h.notifies).toEqual([])
    expect(h.builtinFired).toEqual([])
  })
})

describe('AutomationEngine · runNow（手动触发）', () => {
  it('手动触发 normal 定义：动作执行且历史 success', async () => {
    const h = createHarness({
      settings: (s) => {
        s.modes.current = 'work'
      },
    })
    const saved = await h.store.saveDefinition(dailyNotifyDefinition())

    const result = await h.engine.runNow(saved.id)
    expect(result.ok).toBe(true)
    expect(h.notifies).toHaveLength(1)
    const runs = await h.store.listRuns({ automationId: saved.id })
    expect(runs).toHaveLength(1)
    expect(runs[0]?.status).toBe('success')
  })

  it('手动触发 agent 定义：真的跑 Agent（send + sessionId + done 收尾）', async () => {
    // 回归护栏：runNow 曾经只执行「操作组件」分支 —— agent 定义没有 actions，
    // 于是历史落一条永远「running」的记录、Agent 从未被调用（v0.2.5 smoke 实测踩到）。
    const h = createHarness({
      settings: (s) => {
        s.modes.current = 'work'
      },
    })
    const saved = await h.store.saveDefinition(agentDefinition())

    const result = await h.engine.runNow(saved.id)
    expect(result.ok).toBe(true)
    expect(h.agent.sent).toHaveLength(1)
    const request = h.agent.sent[0]!
    expect(request.sessionId.startsWith('auto-')).toBe(true)
    expect(request.text).toBe('帮我整理今天的笔记')

    const runs = await h.store.listRuns({ automationId: saved.id })
    expect(runs[0]?.status).toBe('running')
    expect(runs[0]?.sessionId).toBe(request.sessionId)

    h.agent.emit({ type: 'done', sessionId: request.sessionId, requestId: 'req-1', seq: 1 })
    await settle()
    const settled = await h.store.listRuns({ automationId: saved.id })
    expect(settled[0]?.status).toBe('success')
  })

  it('不存在的 id 与已停用的定义报错', async () => {
    const h = createHarness({
      settings: (s) => {
        s.modes.current = 'work'
      },
    })
    expect(await h.engine.runNow('am-missing')).toEqual({ ok: false, error: '自动化不存在' })

    const saved = await h.store.saveDefinition(dailyNotifyDefinition({ enabled: false }))
    const result = await h.engine.runNow(saved.id)
    expect(result).toEqual({ ok: false, error: '自动化已停用，请先开启' })
    expect(h.notifies).toEqual([])
  })

  it('内置 id runNow：立即建档并收尾 success（不走 firedKeys 去重）', async () => {
    const h = createHarness({
      lessons: [],
      settings: (s) => {
        s.modes.current = 'classroom'
      },
    })
    const result = await h.engine.runNow(BUILTIN_PRE_CLASS_NOTIFY_ID)
    expect(result.ok).toBe(true)
    const runs = await h.store.listRuns({ automationId: BUILTIN_PRE_CLASS_NOTIFY_ID })
    expect(runs).toHaveLength(1)
    expect(runs[0]?.status).toBe('success')
    // 当前实现：手动触发的内置 execute 拿不到 lesson 上下文，直接 return（不发通知）——见任务报告
    expect(h.notifies).toEqual([])
  })
})

describe('AutomationEngine · 调用次数（v0.2.8，docs/13 §3.1）', () => {
  it('每次触发计数 +1；到达上限的那一次照常执行，执行后自动停用', async () => {
    const h = createHarness({
      settings: (s) => {
        s.modes.current = 'work'
      },
    })
    await h.store.saveDefinition(dailyNotifyDefinition({ maxRuns: 2 }))

    await h.engine.tick(new Date(2026, 2, 2, 8, 0, 0))
    let stored = await h.store.getDefinition('am-daily')
    expect(stored?.runCount).toBe(1)
    expect(stored?.enabled).toBe(true)

    // 第二天同一时刻再触发一次（daily 去重键按日期，跨天不会互相挡）
    await h.engine.tick(new Date(2026, 2, 3, 8, 0, 0))
    expect(h.notifies).toHaveLength(2)
    stored = await h.store.getDefinition('am-daily')
    expect(stored?.runCount).toBe(2)
    // 用满即停用：最后一次运行**没有**被吞掉，停用是它的结果
    expect(stored?.enabled).toBe(false)

    // 停用后不再触发（第三天同一时刻）
    await h.engine.tick(new Date(2026, 2, 4, 8, 0, 0))
    expect(h.notifies).toHaveLength(2)
  })

  it('未设上限（maxRuns 缺省 / 0）不计数、不停用', async () => {
    const h = createHarness({
      settings: (s) => {
        s.modes.current = 'work'
      },
    })
    await h.store.saveDefinition(dailyNotifyDefinition())
    await h.engine.tick(new Date(2026, 2, 2, 8, 0, 0))
    const stored = await h.store.getDefinition('am-daily')
    // 未设上限时引擎根本不碰计数字段（缺省 = 完全没有这一项，不是 0）
    expect(stored?.runCount ?? 0).toBe(0)
    expect(stored?.enabled).toBe(true)
  })

  it('手动触发也计数；已用尽的定义 runNow 明确报错（不落历史）', async () => {
    const h = createHarness({
      settings: (s) => {
        s.modes.current = 'work'
      },
    })
    const saved = await h.store.saveDefinition(dailyNotifyDefinition({ maxRuns: 1 }))

    const first = await h.engine.runNow(saved.id)
    expect(first.ok).toBe(true)
    expect((await h.store.getDefinition(saved.id))?.enabled).toBe(false)

    // 用户把它重新打开：下一次触发会被拒绝并再次停用（计数只增不减）
    const reopened = await h.engine.saveDefinition({
      ...(await h.store.getDefinition(saved.id)),
      enabled: true,
    })
    expect(reopened.ok).toBe(true)

    const err = await h.engine.runNow(saved.id)
    expect(err.ok).toBe(false)
    if (!err.ok) {
      expect(err.error).toContain('调用次数已用尽')
    }
    expect(h.notifies).toHaveLength(1)
    // 被拒的那次不留运行历史
    expect(await h.store.listRuns({ automationId: saved.id })).toHaveLength(1)
    // 顺手停回去（状态与理由一致）
    expect((await h.store.getDefinition(saved.id))?.enabled).toBe(false)
  })

  it('内置自动化不计数（次数是用户自建定义的概念）', async () => {
    const h = createHarness({
      settings: (s) => {
        s.modes.current = 'classroom'
      },
    })
    const result = await h.engine.runNow(BUILTIN_PRE_CLASS_NOTIFY_ID)
    expect(result.ok).toBe(true)
    const builtin = h.engine.listBuiltin().find((item) => item.id === BUILTIN_PRE_CLASS_NOTIFY_ID)
    expect(builtin?.runCount).toBeUndefined()
  })

  it('并发触发不会少记（双击「立即运行」/ 定时与手动撞车都被按 id 串行化）', async () => {
    // 回归护栏（v0.2.8 独立审查）：countRun 是"读—改—写"，此前两条触发链各自读同一份
    // runCount 再各自 +1，后写覆盖先写 —— 结果是"真跑了 2 次、只记 1 次"，
    // maxRuns = 1 的定义被双击绕过一次。现在判定 + 计数 + 停用都在按 id 的临界区里。
    const h = createHarness({
      settings: (s) => {
        s.modes.current = 'work'
      },
    })
    await h.store.saveDefinition(dailyNotifyDefinition({ maxRuns: 1 }))

    const [a, b] = await Promise.all([h.engine.runNow('am-daily'), h.engine.runNow('am-daily')])
    const okCount = [a, b].filter((result) => result.ok).length
    // 两次并发里只有一次真的跑（另一次拿到锁后被"已用尽"挡下）
    expect(okCount).toBe(1)
    const stored = await h.store.getDefinition('am-daily')
    expect(stored?.runCount).toBe(1)
    expect(stored?.enabled).toBe(false)
    expect(await h.store.listRuns({ automationId: 'am-daily' })).toHaveLength(1)
  })

  it('未达上限时并发触发：计数与运行条数一一对应（不丢记）', async () => {
    const h = createHarness({
      settings: (s) => {
        s.modes.current = 'work'
      },
    })
    await h.store.saveDefinition(dailyNotifyDefinition({ maxRuns: 5 }))

    await Promise.all([
      h.engine.runNow('am-daily'),
      h.engine.runNow('am-daily'),
      h.engine.runNow('am-daily'),
    ])
    const stored = await h.store.getDefinition('am-daily')
    const runs = await h.store.listRuns({ automationId: 'am-daily' })
    expect(runs.length).toBe(3)
    expect(stored?.runCount).toBe(runs.length)
    expect(stored?.enabled).toBe(true)
  })

  it('saveDefinition：调用方不带 runCount / maxRuns 时沿用原值（防「编辑一次就清零」）', async () => {
    const h = createHarness({
      settings: (s) => {
        s.modes.current = 'work'
      },
    })
    await h.store.saveDefinition(dailyNotifyDefinition({ maxRuns: 5, runCount: 3 }))

    // 只改名字、不带计数两字段（老客户端 / 旧版界面就是这么发的）
    const saved = await h.engine.saveDefinition({
      id: 'am-daily',
      name: '早读',
      mode: 'normal',
      trigger: { kind: 'daily', params: { at: '08:00' } },
      actions: [{ kind: 'system-notify', params: { title: '早读' } }],
    })
    expect(saved.ok).toBe(true)
    const stored = await h.store.getDefinition('am-daily')
    expect(stored?.runCount).toBe(3)
    expect(stored?.maxRuns).toBe(5)

    // 显式给 0 = 真的清零 / 取消上限
    await h.engine.saveDefinition({ ...stored, maxRuns: 0, runCount: 0 })
    const cleared = await h.store.getDefinition('am-daily')
    expect(cleared?.runCount).toBe(0)
    expect(cleared?.maxRuns).toBe(0)
  })
})

describe('AutomationEngine · 定义 CRUD 防线', () => {
  it('saveDefinition：合法保存 ok 且 id 以 am- 开头', async () => {
    const h = createHarness({
      settings: (s) => {
        s.modes.current = 'work'
      },
    })
    const result = await h.engine.saveDefinition({
      name: '早读助手',
      mode: 'agent',
      trigger: { kind: 'daily', params: { at: '08:00' } },
      prompt: '播报今日安排',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.definition.id.startsWith('am-')).toBe(true)
      expect(result.definition.enabled).toBe(true)
    }
    expect((await h.store.listDefinitions()).map((item) => item.name)).toEqual(['早读助手'])
  })

  it('saveDefinition：builtin. 前缀 id 与非法定义被拒', async () => {
    const h = createHarness({
      settings: (s) => {
        s.modes.current = 'work'
      },
    })
    const builtin = await h.engine.saveDefinition({
      id: 'builtin.pre-class-notify',
      name: '冒名顶替',
      mode: 'agent',
      trigger: { kind: 'daily', params: { at: '08:00' } },
      prompt: 'p',
    })
    expect(builtin).toEqual({ ok: false, error: '内置自动化不可修改' })

    const invalid = await h.engine.saveDefinition({
      name: '',
      mode: 'agent',
      trigger: { kind: 'daily', params: { at: '08:00' } },
      prompt: 'p',
    })
    expect(invalid.ok).toBe(false)
    expect(await h.store.listDefinitions()).toEqual([])
  })

  it("deleteDefinition('builtin.x') 被拒", async () => {
    const h = createHarness()
    expect(await h.engine.deleteDefinition('builtin.pre-class-notify')).toEqual({
      ok: false,
      error: '内置自动化不可删除',
    })
  })
})

describe('AutomationEngine · 启动补偿', () => {
  it('start() 后遗留的 running 历史改判 interrupted', async () => {
    const h = createHarness({
      settings: (s) => {
        s.modes.current = 'work'
      },
    })
    await h.store.appendRun({
      id: 'run-1',
      automationId: 'am-1',
      automationName: '早读提醒',
      mode: 'normal',
      status: 'running',
      triggeredAt: '2026-03-01T08:00:00.000Z',
    })

    h.engine.start()
    await settle(50)
    const runs = await h.store.listRuns()
    expect(runs[0]?.status).toBe('interrupted')
    expect(runs[0]?.finishedAt).toBeDefined()
  })
})

// 类型哨兵：确保 harness 暴露的对象与工具定义的类型保持可赋值（未被消费时防漂移）
type _ToolShapeCheck = ToolDefinition
void (undefined as unknown as _ToolShapeCheck | undefined)
