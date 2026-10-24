import { describe, expect, it } from 'vitest'
import {
  buildCatalog,
  isRunsExhausted,
  normalizeDefinition,
  validateDefinition,
} from './catalog.js'

/** ClassIsland 未配置的 catalog（classisland-remind 不可用） */
const CATALOG = buildCatalog(false)
const CATALOG_WITH_ISLAND = buildCatalog(true)

function agentDefinition(): Record<string, unknown> {
  return {
    name: '早读助手',
    mode: 'agent',
    trigger: { kind: 'daily', params: { at: '08:00' } },
    prompt: '播报今日安排',
  }
}

function normalDefinition(
  actions: unknown = [{ kind: 'system-notify', params: { title: '提醒' } }],
) {
  return { name: '上课提醒', mode: 'normal', trigger: { kind: 'class-start', params: {} }, actions }
}

describe('validateDefinition · 合法定义', () => {
  it('agent 模式（name / mode / trigger / prompt）通过', () => {
    expect(validateDefinition(agentDefinition(), CATALOG)).toEqual({ ok: true })
  })

  it('normal 模式：actions 含 system-notify 合法', () => {
    expect(validateDefinition(normalDefinition(), CATALOG)).toEqual({ ok: true })
  })

  it('open-url 合法网址通过；open-app 填路径即合法', () => {
    expect(
      validateDefinition(
        normalDefinition([{ kind: 'open-url', params: { url: 'https://example.com' } }]),
        CATALOG,
      ),
    ).toEqual({ ok: true })
    expect(
      validateDefinition(
        normalDefinition([{ kind: 'open-app', params: { path: 'C:\\app.exe' } }]),
        CATALOG,
      ),
    ).toEqual({ ok: true })
  })

  it('open-folder 两种目标类型（subject / path）填齐即合法', () => {
    expect(
      validateDefinition(
        normalDefinition([{ kind: 'open-folder', params: { target: 'subject', subject: '数学' } }]),
        CATALOG,
      ),
    ).toEqual({ ok: true })
    expect(
      validateDefinition(
        normalDefinition([{ kind: 'open-folder', params: { target: 'path', path: 'D:\\科目' } }]),
        CATALOG,
      ),
    ).toEqual({ ok: true })
  })
})

describe('validateDefinition · 非法定义', () => {
  it('名称为空（含纯空白）拒绝', () => {
    for (const name of ['', '   ']) {
      expect(validateDefinition({ ...agentDefinition(), name }, CATALOG).ok).toBe(false)
    }
  })

  it('mode 不在 agent / normal 之内拒绝', () => {
    const result = validateDefinition({ ...agentDefinition(), mode: 'workflow' }, CATALOG)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('mode')
  })

  it('trigger.kind 不在 catalog 内拒绝', () => {
    const result = validateDefinition(
      { ...agentDefinition(), trigger: { kind: 'cron', params: {} } },
      CATALOG,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('触发器')
  })

  it('daily.at 非法时刻拒绝', () => {
    const result = validateDefinition(
      { ...agentDefinition(), trigger: { kind: 'daily', params: { at: '8点' } } },
      CATALOG,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('HH:mm')
  })

  it('interval.everyMinutes 超界（3 或 2000，合法 5–1440）拒绝', () => {
    for (const everyMinutes of [3, 2000]) {
      const result = validateDefinition(
        { ...agentDefinition(), trigger: { kind: 'interval', params: { everyMinutes } } },
        CATALOG,
      )
      expect(result.ok, String(everyMinutes)).toBe(false)
      expect(result.error).toContain('不能')
    }
  })

  it('agent 模式缺 prompt（或纯空白）拒绝', () => {
    for (const prompt of [undefined, '   ']) {
      const input: Record<string, unknown> = { ...agentDefinition() }
      if (prompt === undefined) delete input['prompt']
      else input['prompt'] = prompt
      expect(validateDefinition(input, CATALOG).ok).toBe(false)
    }
  })

  it('normal 模式缺 actions（缺字段 / 空数组）拒绝', () => {
    const missing = {
      name: '上课提醒',
      mode: 'normal',
      trigger: { kind: 'class-start', params: {} },
    }
    expect(validateDefinition(missing, CATALOG).ok).toBe(false)
    expect(validateDefinition(normalDefinition([]), CATALOG).ok).toBe(false)
  })

  it('actions 超过 10 个拒绝', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      kind: 'system-notify',
      params: { title: `通知 ${i}` },
    }))
    const result = validateDefinition(normalDefinition(many), CATALOG)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('10')
  })

  it('open-folder 缺 subject / path（按 target 二选一）拒绝；target 非法也拒绝', () => {
    const missingSubject = validateDefinition(
      normalDefinition([{ kind: 'open-folder', params: { target: 'subject' } }]),
      CATALOG,
    )
    expect(missingSubject.ok).toBe(false)
    expect(missingSubject.error).toContain('科目名')

    const missingPath = validateDefinition(
      normalDefinition([{ kind: 'open-folder', params: { target: 'path' } }]),
      CATALOG,
    )
    expect(missingPath.ok).toBe(false)
    expect(missingPath.error).toContain('路径')

    const badTarget = validateDefinition(
      normalDefinition([{ kind: 'open-folder', params: { target: 'both' } }]),
      CATALOG,
    )
    expect(badTarget.ok).toBe(false)
    // 非法取值由 select 字段校验先拦下（错误文案带字段名「目标类型」）
    expect(badTarget.error).toContain('目标类型')
  })

  it('open-url 缺网址 / 非 http(s) 协议拒绝；open-app 缺路径拒绝', () => {
    const missingUrl = validateDefinition(
      normalDefinition([{ kind: 'open-url', params: {} }]),
      CATALOG,
    )
    expect(missingUrl.ok).toBe(false)
    expect(missingUrl.error).toContain('网址')

    const badProtocol = validateDefinition(
      normalDefinition([{ kind: 'open-url', params: { url: 'file://C:/calc.exe' } }]),
      CATALOG,
    )
    expect(badProtocol.ok).toBe(false)
    expect(badProtocol.error).toContain('http(s)')

    const missingAppPath = validateDefinition(
      normalDefinition([{ kind: 'open-app', params: {} }]),
      CATALOG,
    )
    expect(missingAppPath.ok).toBe(false)
    expect(missingAppPath.error).toContain('应用路径')
  })

  it('select 字段非法取值拒绝（classisland-remind 的 channel）', () => {
    const result = validateDefinition(
      normalDefinition([{ kind: 'classisland-remind', params: { channel: 'bogus' } }]),
      CATALOG_WITH_ISLAND,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('取值无效')
  })

  it('weekdays 含 7（合法 0–6）拒绝', () => {
    const result = validateDefinition(
      { ...agentDefinition(), trigger: { kind: 'daily', params: { at: '08:00', weekdays: [7] } } },
      CATALOG,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('0–6')
  })
})

describe('validateDefinition · ClassIsland 可用性门控', () => {
  it('buildCatalog(false) 时 classisland-remind available=false 且校验拒绝该 action', () => {
    const descriptor = CATALOG.actions.find((item) => item.kind === 'classisland-remind')
    expect(descriptor?.available).toBe(false)

    const result = validateDefinition(
      normalDefinition([{ kind: 'classisland-remind', params: { title: '提醒' } }]),
      CATALOG,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('ClassIsland')
  })

  it('buildCatalog(true) 时 classisland-remind 通过校验', () => {
    const descriptor = CATALOG_WITH_ISLAND.actions.find(
      (item) => item.kind === 'classisland-remind',
    )
    expect(descriptor?.available).toBe(true)

    const result = validateDefinition(
      normalDefinition([{ kind: 'classisland-remind', params: { title: '提醒' } }]),
      CATALOG_WITH_ISLAND,
    )
    expect(result).toEqual({ ok: true })
  })
})

describe('插件组件（v36，docs/14 §3.5）', () => {
  it('catalog 含 plugin-event 触发器与 plugin-action 操作组件', () => {
    const condition = CATALOG.conditions.find((item) => item.kind === 'plugin-event')
    const action = CATALOG.actions.find((item) => item.kind === 'plugin-action')
    expect(condition?.requiresSchedule).toBe(false)
    expect(condition?.fields.map((field) => field.key)).toEqual(['pluginId', 'event'])
    expect(action?.available).toBe(true)
    expect(action?.fields.map((field) => field.key)).toEqual(['pluginId', 'action', 'params'])
    expect(action?.fields.find((field) => field.key === 'params')?.type).toBe('json')
  })

  it('plugin-event：插件 id 与事件名填齐即合法，缺任一拒绝', () => {
    const definition = (params: Record<string, unknown>) => ({
      name: '待办联动',
      mode: 'agent',
      trigger: { kind: 'plugin-event', params },
      prompt: '整理待办',
    })
    expect(
      validateDefinition(
        definition({ pluginId: 'com.example.todo', event: 'todo-added' }),
        CATALOG,
      ),
    ).toEqual({ ok: true })
    expect(validateDefinition(definition({ event: 'todo-added' }), CATALOG).ok).toBe(false)
    expect(
      validateDefinition(definition({ pluginId: 'com.example.todo', event: '  ' }), CATALOG).ok,
    ).toBe(false)
  })

  it('plugin-action：JSON 参数合法通过；缺字段 / 非 JSON / 非对象 / 超 8 KB 拒绝', () => {
    const definition = (params: Record<string, unknown>) =>
      normalDefinition([{ kind: 'plugin-action', params }])
    expect(
      validateDefinition(
        definition({ pluginId: 'com.example.todo', action: 'add', params: '{"text":"买牛奶"}' }),
        CATALOG,
      ),
    ).toEqual({ ok: true })
    // 参数可留空（缺省 / 空对象都是合法形状）
    expect(
      validateDefinition(definition({ pluginId: 'com.example.todo', action: 'add' }), CATALOG),
    ).toEqual({ ok: true })
    expect(
      validateDefinition(
        definition({ pluginId: 'com.example.todo', action: 'add', params: '{}' }),
        CATALOG,
      ),
    ).toEqual({ ok: true })

    for (const params of [
      { action: 'add' },
      { pluginId: 'com.example.todo' },
      { pluginId: 'com.example.todo', action: 'add', params: '{oops' },
      { pluginId: 'com.example.todo', action: 'add', params: '[]' },
      { pluginId: 'com.example.todo', action: 'add', params: `{"x":"${'a'.repeat(9000)}"}` },
    ]) {
      expect(validateDefinition(definition(params), CATALOG).ok).toBe(false)
    }
  })
})

describe('normalizeDefinition', () => {
  it('裁剪 name 空白、enabled 缺省 true、params 拷贝', () => {
    const normalized = normalizeDefinition({
      name: '  早读助手  ',
      mode: 'agent',
      trigger: { kind: 'daily', params: { at: '08:00' } },
      prompt: '播报今日安排',
    })
    expect(normalized.name).toBe('早读助手')
    expect(normalized.enabled).toBe(true)
    expect(normalized.mode).toBe('agent')
    expect(normalized.prompt).toBe('播报今日安排')
    expect(normalized.id).toBe('')
    expect(normalized.trigger).toEqual({ kind: 'daily', params: { at: '08:00' } })
    expect(normalized.createdAt).toBe('')
    expect(normalized.updatedAt).toBe('')
  })

  it('enabled 显式 false 保留；mode 非法回落 normal；normal 模式产出 actions、不带 prompt', () => {
    const disabled = normalizeDefinition({ ...agentDefinition(), enabled: false })
    expect(disabled.enabled).toBe(false)

    const normal = normalizeDefinition({
      name: 'x',
      mode: 'workflow',
      trigger: { kind: 'class-start', params: {} },
      actions: [{ kind: 'system-notify', params: { title: 't' } }],
    })
    expect(normal.mode).toBe('normal')
    expect(normal.actions).toEqual([{ kind: 'system-notify', params: { title: 't' } }])
    expect(normal.prompt).toBeUndefined()
  })

  it('trigger.params 非对象时兜底为空对象', () => {
    const normalized = normalizeDefinition({
      name: 'x',
      mode: 'agent',
      trigger: { kind: 'daily', params: 'oops' },
      prompt: 'p',
    })
    expect(normalized.trigger.params).toEqual({})
  })

  it('调用次数：缺省补 0（= 不限 / 未计），合法值取整保留，非法值回落 0', () => {
    const absent = normalizeDefinition({ ...agentDefinition() })
    expect(absent.maxRuns).toBe(0)
    expect(absent.runCount).toBe(0)

    const given = normalizeDefinition({ ...agentDefinition(), maxRuns: 8, runCount: 3 })
    expect(given.maxRuns).toBe(8)
    expect(given.runCount).toBe(3)

    // 非法值（小数 / 负 / 非数字）不抛错 —— 校验层已经拦过，这里只保证不写出脏数据
    expect(normalizeDefinition({ ...agentDefinition(), maxRuns: 2.5 }).maxRuns).toBe(0)
    expect(normalizeDefinition({ ...agentDefinition(), runCount: -1 }).runCount).toBe(0)
    expect(normalizeDefinition({ ...agentDefinition(), maxRuns: 'x' }).maxRuns).toBe(0)
  })
})

describe('validateDefinition · 调用次数（v0.2.8）', () => {
  it('合法取值：0（不限）、正整数、缺省', () => {
    expect(validateDefinition({ ...agentDefinition(), maxRuns: 0 }, CATALOG)).toEqual({ ok: true })
    expect(validateDefinition({ ...agentDefinition(), maxRuns: 100 }, CATALOG)).toEqual({
      ok: true,
    })
    expect(validateDefinition({ ...agentDefinition(), runCount: 12 }, CATALOG)).toEqual({
      ok: true,
    })
    expect(validateDefinition(agentDefinition(), CATALOG)).toEqual({ ok: true })
  })

  it('非法取值：小数 / 负数 / 超上限 / 非数字 / runCount 为负', () => {
    for (const maxRuns of [1.5, -1, 100_001, '10', true]) {
      const result = validateDefinition({ ...agentDefinition(), maxRuns }, CATALOG)
      expect(result.ok).toBe(false)
      expect(result.error).toContain('调用次数上限')
    }
    const negativeCount = validateDefinition({ ...agentDefinition(), runCount: -2 }, CATALOG)
    expect(negativeCount.ok).toBe(false)
    expect(negativeCount.error).toContain('已调用次数')
  })
})

describe('isRunsExhausted', () => {
  it('未设上限（缺省 / 0）永不用尽；达到或超过上限即用尽', () => {
    expect(isRunsExhausted({ maxRuns: 0, runCount: 99 })).toBe(false)
    expect(isRunsExhausted({ runCount: 99 })).toBe(false)
    expect(isRunsExhausted({ maxRuns: 5, runCount: 4 })).toBe(false)
    expect(isRunsExhausted({ maxRuns: 5, runCount: 5 })).toBe(true)
    expect(isRunsExhausted({ maxRuns: 5, runCount: 6 })).toBe(true)
    expect(isRunsExhausted({ maxRuns: 5 })).toBe(false)
  })
})
