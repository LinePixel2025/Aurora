import { describe, expect, it } from 'vitest'
import { buildCatalog, normalizeDefinition, validateDefinition } from './catalog.js'

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
})
