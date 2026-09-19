import { describe, expect, it } from 'vitest'
import { CONFIG_VERSION } from './schema.js'
import { MIGRATIONS, migrate, readVersion } from './migrations.js'
import { createMemoryLogger } from '../utils/logger.js'

describe('配置迁移链', () => {
  it('当前版本配置原样通过，不执行迁移', () => {
    const outcome = migrate({ version: CONFIG_VERSION, general: {} })
    expect(outcome.fromVersion).toBe(CONFIG_VERSION)
    expect(outcome.applied).toEqual([])
    expect(outcome.warnings).toEqual([])
  })

  it('缺少 version 字段视为 v0 并迁移到当前版本', () => {
    const outcome = migrate({ mode: 'classroom' })
    expect(outcome.fromVersion).toBe(0)
    expect(outcome.applied).toHaveLength(CONFIG_VERSION)
    expect(outcome.data['version']).toBe(CONFIG_VERSION)
    expect((outcome.data['modes'] as Record<string, unknown>)['current']).toBe('classroom')
    expect(outcome.data['mode']).toBeUndefined()
  })

  it('v0 的扁平 apiKey 迁移为 providers + apiKeyEnc，且不保留明文字段', () => {
    const outcome = migrate({
      llm: { apiKey: 'sk-plain-1234', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
    })
    const llm = outcome.data['llm'] as Record<string, unknown>
    expect(llm['active']).toBe('deepseek')
    expect(llm['apiKey']).toBeUndefined()
    expect(llm['baseUrl']).toBeUndefined()
    const providers = llm['providers'] as Record<string, Record<string, unknown>>
    expect(providers['deepseek']?.['apiKeyEnc']).toBe('sk-plain-1234')
    expect(providers['deepseek']?.['temperature']).toBe(0.7)
  })

  it('v0 的空 apiKey 不生成 provider', () => {
    const outcome = migrate({ llm: { apiKey: '' } })
    const llm = outcome.data['llm'] as Record<string, unknown>
    expect(llm['providers']).toBeUndefined()
  })

  it('版本高于程序支持版本时告警但不丢数据', () => {
    const logger = createMemoryLogger()
    const outcome = migrate({ version: 99, general: { language: 'zh-CN' } }, logger)
    expect(outcome.warnings).toHaveLength(1)
    expect(outcome.data['general']).toEqual({ language: 'zh-CN' })
    expect(logger.entries.some((line) => line.includes('[warn]'))).toBe(true)
  })

  it('迁移链连续且起点覆盖 0 → 当前版本', () => {
    const versions = MIGRATIONS.map((m) => m.from).sort((a, b) => a - b)
    expect(versions[0]).toBe(0)
    for (const migration of MIGRATIONS) expect(migration.to).toBe(migration.from + 1)
    expect(Math.max(...MIGRATIONS.map((m) => m.to))).toBe(CONFIG_VERSION)
  })

  it('readVersion 只接受非负整数', () => {
    expect(readVersion({ version: 1 })).toBe(1)
    expect(readVersion({ version: -1 })).toBe(0)
    expect(readVersion({ version: 1.5 })).toBe(0)
    expect(readVersion({ version: '1' })).toBe(0)
    expect(readVersion({})).toBe(0)
  })

  describe('v1 → v2（P4 分类管线 / P5 敏感工具确认）', () => {
    it('补齐 classification 默认值并保留原有 classroom 字段', () => {
      const outcome = migrate({
        version: 1,
        modes: { current: 'classroom', classroom: { watchDir: 'D:\\感知', subjects: [] } },
      })
      expect(outcome.fromVersion).toBe(1)
      // v1 → v2 → v3：链式执行，两版迁移都会跑
      expect(outcome.applied).toHaveLength(2)
      expect(outcome.data['version']).toBe(CONFIG_VERSION)

      const classroom = (outcome.data['modes'] as Record<string, unknown>)['classroom'] as Record<
        string,
        unknown
      >
      expect(classroom['watchDir']).toBe('D:\\感知')
      expect(classroom['subjects']).toEqual([])
      expect(classroom['classification']).toEqual({
        autoMove: true,
        confidenceThreshold: 0.6,
        fallbackFolder: '待分类',
      })
    })

    it('补齐 advanced.confirmSensitiveTools 且不覆盖已有值', () => {
      const added = migrate({ version: 1, advanced: { proxy: '' } })
      expect((added.data['advanced'] as Record<string, unknown>)['confirmSensitiveTools']).toBe(
        true,
      )

      const kept = migrate({ version: 1, advanced: { confirmSensitiveTools: false } })
      expect((kept.data['advanced'] as Record<string, unknown>)['confirmSensitiveTools']).toBe(
        false,
      )
    })

    it('不覆盖用户已写入的 classification（幂等）', () => {
      const custom = { autoMove: false, confidenceThreshold: 0.9, fallbackFolder: '其他' }
      const once = migrate({ version: 1, modes: { classroom: { classification: custom } } })
      const classroom = (once.data['modes'] as Record<string, unknown>)['classroom'] as Record<
        string,
        unknown
      >
      expect(classroom['classification']).toEqual(custom)

      const twice = migrate({ ...once.data, version: 1 })
      const again = (twice.data['modes'] as Record<string, unknown>)['classroom'] as Record<
        string,
        unknown
      >
      expect(again['classification']).toEqual(custom)
    })

    it('缺少 modes / advanced 分组时不抛错', () => {
      const outcome = migrate({ version: 1 })
      expect(outcome.warnings).toEqual([])
      expect(outcome.data['version']).toBe(CONFIG_VERSION)
    })
  })

  describe('v2 → v3（ClassIsland 桥接数据源）', () => {
    it('补齐 schedule.classisland 并保留手动课程表', () => {
      const lesson = { weekday: 1, startTime: '08:00', endTime: '08:45', subject: '数学' }
      const outcome = migrate({
        version: 2,
        modes: { classroom: { schedule: { provider: 'manual', lessons: [lesson] } } },
      })
      expect(outcome.fromVersion).toBe(2)
      expect(outcome.applied).toHaveLength(1)

      const classroom = (outcome.data['modes'] as Record<string, unknown>)['classroom'] as Record<
        string,
        unknown
      >
      const schedule = classroom['schedule'] as Record<string, unknown>
      expect(schedule['provider']).toBe('manual')
      expect(schedule['lessons']).toEqual([lesson])
      expect(schedule['classisland']).toEqual({ source: 'file', endpoint: '', timeoutMs: 3000 })
    })

    it('不覆盖用户已写入的 classisland 配置（幂等）', () => {
      const custom = {
        source: 'http',
        endpoint: 'http://127.0.0.1:17945/schedule',
        timeoutMs: 1500,
      }
      const load = (raw: Record<string, unknown>): unknown => {
        const classroom = (raw['modes'] as Record<string, unknown>)['classroom'] as Record<
          string,
          unknown
        >
        return (classroom['schedule'] as Record<string, unknown>)['classisland']
      }

      const once = migrate({
        version: 2,
        modes: { classroom: { schedule: { classisland: custom } } },
      })
      expect(load(once.data)).toEqual(custom)

      const twice = migrate({ ...once.data, version: 2 })
      expect(load(twice.data)).toEqual(custom)
    })

    it('缺少 modes 分组时不抛错', () => {
      const outcome = migrate({ version: 2 })
      expect(outcome.warnings).toEqual([])
      expect(outcome.data['version']).toBe(3)
    })
  })
})
