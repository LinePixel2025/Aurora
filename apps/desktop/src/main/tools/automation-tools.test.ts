/**
 * 自动化管理工具单测（docs/13 §8）。
 *
 * 六个工具只认识注入的管理端口（`AutomationManagePort`），因此用假件即可覆盖
 * 参数校验 / 合并逻辑 / 文案与 `isError` 语义；真实的存储与调度在 engine.ts（另测）。
 */
import { describe, expect, it } from 'vitest'
import type { AutomationCatalog, AutomationDefinition, AutomationRun } from '@aurora/shared'
import {
  AUTOMATION_CREATE_TOOL_NAME,
  AUTOMATION_DELETE_TOOL_NAME,
  AUTOMATION_HISTORY_TOOL_NAME,
  AUTOMATION_LIST_TOOL_NAME,
  AUTOMATION_RUN_TOOL_NAME,
  AUTOMATION_UPDATE_TOOL_NAME,
  AUTOMATION_WRITE_TOOL_NAMES,
  createAutomationCreateTool,
  createAutomationDeleteTool,
  createAutomationHistoryTool,
  createAutomationListTool,
  createAutomationRunTool,
  createAutomationUpdateTool,
  describeTrigger,
  type AutomationManagePort,
} from './automation-tools.js'

const CATALOG: AutomationCatalog = {
  conditions: [
    {
      kind: 'daily',
      label: '每天定时',
      description: '',
      fields: [{ key: 'at', label: '触发时刻', type: 'time' }],
      requiresSchedule: false,
    },
    {
      kind: 'pre-class',
      label: '距上课不足 N 分钟',
      description: '',
      fields: [{ key: 'leadMinutes', label: '提前（分钟）', type: 'number' }],
      requiresSchedule: true,
    },
  ],
  actions: [
    {
      kind: 'system-notify',
      label: '系统通知',
      description: '',
      fields: [],
      requiresClassIsland: false,
      available: true,
    },
    {
      kind: 'classisland-remind',
      label: 'ClassIsland 提醒',
      description: '',
      fields: [],
      requiresClassIsland: true,
      available: false,
    },
  ],
}

function definition(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: 'am-1',
    name: '早读提醒',
    enabled: true,
    mode: 'normal',
    trigger: { kind: 'daily', params: { at: '07:30' } },
    actions: [{ kind: 'system-notify', params: { title: '早读' } }],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'auto-1',
    automationId: 'am-1',
    automationName: '早读提醒',
    mode: 'normal',
    status: 'success',
    triggeredAt: '2026-09-28T00:00:00.000Z',
    durationMs: 120,
    ...overrides,
  }
}

interface Harness {
  port: AutomationManagePort
  saved: unknown[]
  deleted: string[]
  triggered: string[]
  historyQueries: Array<{ automationId?: string; mode?: 'agent' | 'normal'; limit?: number }>
  user: AutomationDefinition[]
  builtin: AutomationDefinition[]
  runs: AutomationRun[]
}

function createHarness(overrides: Partial<Omit<Harness, 'port'>> = {}): Harness {
  const saved: unknown[] = []
  const deleted: string[] = []
  const triggered: string[] = []
  const historyQueries: Harness['historyQueries'] = []
  const user = overrides.user ?? []
  const builtin = overrides.builtin ?? []
  const runs = overrides.runs ?? []
  const port: AutomationManagePort = {
    list: async () => ({ user, builtin }),
    save: async (input) => {
      saved.push(input)
      const record = input as Partial<AutomationDefinition>
      const id = typeof record.id === 'string' && record.id !== '' ? record.id : 'am-new'
      return { ok: true, definition: { ...(record as AutomationDefinition), id } }
    },
    delete: async (id) => {
      deleted.push(id)
      return { ok: true }
    },
    run: async (id) => {
      triggered.push(id)
      return { ok: true, runId: 'auto-run-1' }
    },
    history: async (query = {}) => {
      historyQueries.push(query)
      return runs
    },
    catalog: () => CATALOG,
  }
  return { port, saved, deleted, triggered, historyQueries, user, builtin, runs }
}

describe('automation_list', () => {
  it('空清单回「暂无」提示', async () => {
    const h = createHarness()
    const result = await createAutomationListTool(h.port).execute({}, { sessionId: 's' })
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('没有任何自动化')
  })

  it('列出用户定义与内置定义，内置带 [内置] 标记', async () => {
    const h = createHarness({
      user: [definition()],
      builtin: [
        definition({
          id: 'builtin.pre-class-notify',
          name: '课前提醒',
          trigger: { kind: 'pre-class', params: { leadMinutes: 5 } },
        }),
      ],
    })
    const result = await createAutomationListTool(h.port).execute({}, { sessionId: 's' })
    expect(result.content).toContain('am-1')
    expect(result.content).toContain('每天 07:30')
    expect(result.content).toContain('[内置] 课前提醒')
    expect(result.content).toContain('距上课 ≤ 5 分钟')
  })

  it('工具元数据：safe 级、可在只读档保留', async () => {
    const tool = createAutomationListTool(createHarness().port)
    expect(tool.name).toBe(AUTOMATION_LIST_TOOL_NAME)
    expect(tool.sensitivity).toBe('safe')
    expect((AUTOMATION_WRITE_TOOL_NAMES as readonly string[]).includes(tool.name)).toBe(false)
  })
})

describe('automation_create', () => {
  it('成功时把入参转交 port.save 并回 id', async () => {
    const h = createHarness()
    const tool = createAutomationCreateTool(h.port)
    expect(tool.sensitivity).toBe('confirm')
    const result = await tool.execute(
      {
        name: '整理笔记',
        mode: 'agent',
        trigger: { kind: 'interval', params: { everyMinutes: 60 } },
        prompt: '整理笔记',
      },
      { sessionId: 's' },
    )
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('am-new')
    expect(h.saved).toHaveLength(1)
  })

  it('port.save 拒绝时回 isError 并带原因', async () => {
    const h = createHarness()
    h.port.save = async () => ({ ok: false, error: '触发器参数不合法' })
    const result = await createAutomationCreateTool(h.port).execute(
      { name: 'x', mode: 'normal', trigger: { kind: 'daily', params: {} } },
      { sessionId: 's' },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('触发器参数不合法')
  })

  it('入参不是对象时如实报缺参', async () => {
    const result = await createAutomationCreateTool(createHarness().port).execute('nope', {
      sessionId: 's',
    })
    expect(result.isError).toBe(true)
  })
})

describe('automation_update', () => {
  it('局部字段与已有定义合并：只改 enabled 时保留其余字段', async () => {
    const h = createHarness({ user: [definition()] })
    const result = await createAutomationUpdateTool(h.port).execute(
      { id: 'am-1', enabled: false },
      { sessionId: 's' },
    )
    expect(result.isError).toBeUndefined()
    expect(h.saved).toHaveLength(1)
    const merged = h.saved[0] as AutomationDefinition
    expect(merged.id).toBe('am-1')
    expect(merged.name).toBe('早读提醒')
    expect(merged.enabled).toBe(false)
    expect(merged.trigger.kind).toBe('daily')
  })

  it('给 prompt 时切到 agent 模式；给 actions 时切到 normal 模式', async () => {
    const h = createHarness({ user: [definition()] })
    await createAutomationUpdateTool(h.port).execute(
      { id: 'am-1', prompt: '整理今天的笔记' },
      { sessionId: 's' },
    )
    expect((h.saved[0] as AutomationDefinition).mode).toBe('agent')

    const h2 = createHarness({
      user: [definition({ mode: 'agent', prompt: 'x', actions: undefined })],
    })
    await createAutomationUpdateTool(h2.port).execute(
      { id: 'am-1', actions: [{ kind: 'system-notify', params: { title: 'y' } }] },
      { sessionId: 's' },
    )
    expect((h2.saved[0] as AutomationDefinition).mode).toBe('normal')
  })

  it('内置自动化被拒且不调用 save', async () => {
    const h = createHarness({
      builtin: [definition({ id: 'builtin.pre-class-notify', name: '课前提醒' })],
    })
    const result = await createAutomationUpdateTool(h.port).execute(
      { id: 'builtin.pre-class-notify', enabled: false },
      { sessionId: 's' },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('内置自动化不可直接修改')
    expect(h.saved).toHaveLength(0)
  })

  it('id 不存在时报错且不调用 save', async () => {
    const h = createHarness()
    const result = await createAutomationUpdateTool(h.port).execute(
      { id: 'am-ghost', enabled: true },
      { sessionId: 's' },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('不存在')
    expect(h.saved).toHaveLength(0)
  })

  it('缺 id 时报缺参', async () => {
    const result = await createAutomationUpdateTool(createHarness().port).execute(
      {},
      { sessionId: 's' },
    )
    expect(result.isError).toBe(true)
  })
})

describe('automation_delete / automation_run', () => {
  it('delete 成功与失败两路', async () => {
    const h = createHarness()
    const okResult = await createAutomationDeleteTool(h.port).execute(
      { id: 'am-1' },
      { sessionId: 's' },
    )
    expect(okResult.isError).toBeUndefined()
    expect(h.deleted).toEqual(['am-1'])

    h.port.delete = async () => ({ ok: false, error: '内置自动化不可删除' })
    const failed = await createAutomationDeleteTool(h.port).execute(
      { id: 'builtin.x' },
      { sessionId: 's' },
    )
    expect(failed.isError).toBe(true)
    expect(failed.content).toContain('不可删除')
  })

  it('run 触发成功回 runId；失败回 isError', async () => {
    const h = createHarness()
    const tool = createAutomationRunTool(h.port)
    expect(tool.name).toBe(AUTOMATION_RUN_TOOL_NAME)
    const okResult = await tool.execute({ id: 'am-1' }, { sessionId: 's' })
    expect(okResult.content).toContain('auto-run-1')
    expect(h.triggered).toEqual(['am-1'])

    h.port.run = async () => ({ ok: false, error: '自动化已停用，请先开启' })
    const failed = await tool.execute({ id: 'am-1' }, { sessionId: 's' })
    expect(failed.isError).toBe(true)
    expect(failed.content).toContain('已停用')
  })
})

describe('automation_history', () => {
  it('格式化输出含状态与用时；limit 收敛到上限 200 与下限 1', async () => {
    const h = createHarness({ runs: [run()] })
    const tool = createAutomationHistoryTool(h.port)
    expect(tool.name).toBe(AUTOMATION_HISTORY_TOOL_NAME)
    const result = await tool.execute({ limit: 250 }, { sessionId: 's' })
    expect(result.content).toContain('成功')
    expect(result.content).toContain('早读提醒')
    expect(h.historyQueries[0]?.limit).toBe(200)

    await tool.execute({ limit: 0 }, { sessionId: 's' })
    expect(h.historyQueries[1]?.limit).toBe(1)
  })

  it('Agent 记录带会话 id；空历史回「暂无」', async () => {
    const h = createHarness({
      runs: [
        run({ mode: 'agent', sessionId: 'auto-9', durationMs: 12_000, automationName: '整理笔记' }),
      ],
    })
    const result = await createAutomationHistoryTool(h.port).execute(
      { automationId: 'am-1' },
      { sessionId: 's' },
    )
    expect(result.content).toContain('auto-9')
    expect(result.content).toContain('用时 12s')
    expect(h.historyQueries[0]?.automationId).toBe('am-1')

    const empty = await createAutomationHistoryTool(createHarness().port).execute(
      {},
      { sessionId: 's' },
    )
    expect(empty.content).toContain('暂无运行记录')
  })

  it('工具元数据：safe 级', async () => {
    const tool = createAutomationHistoryTool(createHarness().port)
    expect(tool.sensitivity).toBe('safe')
    expect((AUTOMATION_WRITE_TOOL_NAMES as readonly string[]).includes(tool.name)).toBe(false)
  })
})

describe('工具名与只读档口径', () => {
  it('六个工具名与常量一致，写类四个进 AUTOMATION_WRITE_TOOL_NAMES', () => {
    const tools = [
      createAutomationListTool(createHarness().port),
      createAutomationCreateTool(createHarness().port),
      createAutomationUpdateTool(createHarness().port),
      createAutomationDeleteTool(createHarness().port),
      createAutomationRunTool(createHarness().port),
      createAutomationHistoryTool(createHarness().port),
    ]
    expect(tools.map((tool) => tool.name)).toEqual([
      AUTOMATION_LIST_TOOL_NAME,
      AUTOMATION_CREATE_TOOL_NAME,
      AUTOMATION_UPDATE_TOOL_NAME,
      AUTOMATION_DELETE_TOOL_NAME,
      AUTOMATION_RUN_TOOL_NAME,
      AUTOMATION_HISTORY_TOOL_NAME,
    ])
    const writeNames = new Set<string>(AUTOMATION_WRITE_TOOL_NAMES)
    expect(writeNames.has(AUTOMATION_LIST_TOOL_NAME)).toBe(false)
    expect(writeNames.has(AUTOMATION_HISTORY_TOOL_NAME)).toBe(false)
    expect(writeNames.size).toBe(4)
  })
})

describe('describeTrigger', () => {
  it('各 kind 的中文描述（含 weekdays 与缺省）', () => {
    expect(describeTrigger({ kind: 'daily', params: { at: '08:00' } }, CATALOG)).toBe('每天 08:00')
    expect(
      describeTrigger({ kind: 'daily', params: { at: '07:50', weekdays: [1, 3] } }, CATALOG),
    ).toBe('周一、周三 07:50')
    expect(describeTrigger({ kind: 'interval', params: { everyMinutes: 30 } }, CATALOG)).toBe(
      '每 30 分钟',
    )
    expect(describeTrigger({ kind: 'pre-class', params: { leadMinutes: 5 } }, CATALOG)).toBe(
      '距上课 ≤ 5 分钟',
    )
    expect(describeTrigger({ kind: 'pre-end', params: { leadMinutes: 2 } }, CATALOG)).toBe(
      '距下课 ≤ 2 分钟',
    )
    expect(describeTrigger({ kind: 'next-lesson', params: { subject: '数学' } }, CATALOG)).toBe(
      '下节课是 数学',
    )
    expect(describeTrigger({ kind: 'class-start', params: {} }, CATALOG)).toBe('上课时')
    expect(describeTrigger({ kind: 'class-end', params: {} }, CATALOG)).toBe('下课时')
  })
})

// ───────────────────────── 自动化会话的边界（v0.2.8，docs/13 §7.1） ─────────────────────────

describe('自动化会话不得管理 / 触发自动化', () => {
  const AUTO_SESSION = { sessionId: 'auto-m1a2b3-1' }

  it('四个写类工具在 auto- 会话里一律拒绝（端口不被触碰）', async () => {
    const h = createHarness({ user: [definition()] })
    const create = await createAutomationCreateTool(h.port).execute(
      {
        name: 'x',
        mode: 'normal',
        trigger: { kind: 'daily', params: { at: '08:00' } },
        actions: [{ kind: 'system-notify', params: { title: 't' } }],
      },
      AUTO_SESSION,
    )
    const update = await createAutomationUpdateTool(h.port).execute(
      { id: 'am-1', enabled: true },
      AUTO_SESSION,
    )
    const remove = await createAutomationDeleteTool(h.port).execute({ id: 'am-1' }, AUTO_SESSION)
    const trigger = await createAutomationRunTool(h.port).execute({ id: 'am-1' }, AUTO_SESSION)

    for (const result of [create, update, remove, trigger]) {
      expect(result.isError).toBe(true)
      expect(result.content).toContain('不能管理或触发自动化')
    }
    // 「做不到」而不是「做了但报错」：端口一次都没被调用
    expect(h.saved).toEqual([])
    expect(h.deleted).toEqual([])
    expect(h.triggered).toEqual([])
  })

  it('只读的 list / history 在 auto- 会话里照常可用（看得到，改不了）', async () => {
    const h = createHarness({ user: [definition()], runs: [run()] })
    const listed = await createAutomationListTool(h.port).execute({}, AUTO_SESSION)
    const history = await createAutomationHistoryTool(h.port).execute({}, AUTO_SESSION)
    expect(listed.isError).toBeUndefined()
    expect(history.isError).toBeUndefined()
  })

  it('普通会话与它的子代理（-sub）照常放行', async () => {
    const h = createHarness({ user: [definition()] })
    const chat = await createAutomationRunTool(h.port).execute(
      { id: 'am-1' },
      { sessionId: 'chat-1' },
    )
    const sub = await createAutomationRunTool(h.port).execute(
      { id: 'am-1' },
      { sessionId: 'chat-1-sub' },
    )
    expect(chat.isError).toBeUndefined()
    expect(sub.isError).toBeUndefined()
    expect(h.triggered).toEqual(['am-1', 'am-1'])
  })

  it('auto- 会话的子代理（-sub 后缀）同样被拒（继承父会话边界）', async () => {
    const h = createHarness({ user: [definition()] })
    const result = await createAutomationRunTool(h.port).execute(
      { id: 'am-1' },
      { sessionId: 'auto-m1a2b3-1-sub' },
    )
    expect(result.isError).toBe(true)
    expect(h.triggered).toEqual([])
  })
})

describe('调用次数（v0.2.8，docs/13 §3.1）', () => {
  it('automation_list 显示已调用 / 上限，用尽时点明「已用尽，自动停用」', async () => {
    const h = createHarness({
      user: [
        definition({ id: 'am-a', maxRuns: 10, runCount: 3 }),
        definition({ id: 'am-b', name: '整理', maxRuns: 5, runCount: 5, enabled: false }),
      ],
    })
    const result = await createAutomationListTool(h.port).execute({}, { sessionId: 's' })
    expect(result.content).toContain('已调用 3/10')
    expect(result.content).toContain('已调用 5/5（已用尽，自动停用）')
  })

  it('automation_create 转交合法 maxRuns；非法值直接拒绝（不落半份定义）', async () => {
    const h = createHarness()
    const tool = createAutomationCreateTool(h.port)
    const ok = await tool.execute(
      {
        name: 'x',
        mode: 'normal',
        trigger: { kind: 'daily', params: { at: '08:00' } },
        actions: [{ kind: 'system-notify', params: { title: 't' } }],
        maxRuns: 12,
      },
      { sessionId: 's' },
    )
    expect(ok.isError).toBeUndefined()
    expect((h.saved[0] as Record<string, unknown>)['maxRuns']).toBe(12)

    const bad = await tool.execute(
      {
        name: 'y',
        mode: 'normal',
        trigger: { kind: 'daily', params: { at: '08:00' } },
        actions: [{ kind: 'system-notify', params: { title: 't' } }],
        maxRuns: -3,
      },
      { sessionId: 's' },
    )
    expect(bad.isError).toBe(true)
    expect(bad.content).toContain('调用次数上限')
    expect(h.saved).toHaveLength(1)
  })

  it('automation_update 可改上限、可重置计数（resetRunCount）', async () => {
    const h = createHarness({ user: [definition({ maxRuns: 5, runCount: 5 })] })
    const tool = createAutomationUpdateTool(h.port)
    const result = await tool.execute(
      { id: 'am-1', maxRuns: 0, resetRunCount: true },
      { sessionId: 's' },
    )
    expect(result.isError).toBeUndefined()
    const merged = h.saved[0] as Record<string, unknown>
    expect(merged['maxRuns']).toBe(0)
    expect(merged['runCount']).toBe(0)
  })
})
