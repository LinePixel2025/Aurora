import { describe, expect, it } from 'vitest'
import { CONFIG_VERSION, SETTINGS_READONLY_PREFIXES } from './schema.js'
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
    // 版本更高 → 原样保留（不应用任何迁移，因此不会补上 requireAdmin 这类新字段）
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
      // v1 → v2 → … → 当前版本：链式执行，每一版迁移都会跑
      expect(outcome.applied).toHaveLength(CONFIG_VERSION - 1)
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
      // v2 → v3 → … → 当前版本：链式执行
      expect(outcome.applied).toHaveLength(CONFIG_VERSION - 2)

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
      expect(outcome.data['version']).toBe(CONFIG_VERSION)
    })
  })

  describe('v3 → v4（移除 AI 悬浮窗 service-dock）', () => {
    const CHAT_GEOMETRY = { x: 1480, y: 200, width: 420, height: 640 }
    const DOCK_GEOMETRY = { x: 900, y: 960, width: 56, height: 56 }
    const loadWindowState = (raw: Record<string, unknown>): Record<string, unknown> => {
      const general = raw['general'] as Record<string, unknown>
      return general['windowState'] as Record<string, unknown>
    }

    it('删掉 service-dock 键，保留其它窗口几何原样', () => {
      const outcome = migrate({
        version: 3,
        general: {
          language: 'zh-CN',
          windowState: { 'service-dock': DOCK_GEOMETRY, chat: CHAT_GEOMETRY },
        },
      })
      expect(outcome.fromVersion).toBe(3)
      // v3 → v4 → … → 当前版本：链式执行
      expect(outcome.applied).toHaveLength(CONFIG_VERSION - 3)
      expect(outcome.data['version']).toBe(CONFIG_VERSION)

      const windowState = loadWindowState(outcome.data)
      expect(windowState['service-dock']).toBeUndefined()
      expect(windowState['chat']).toEqual(CHAT_GEOMETRY)
      expect(Object.keys(windowState)).toEqual(['chat'])
      // 其它 general 字段不受影响
      expect((outcome.data['general'] as Record<string, unknown>)['language']).toBe('zh-CN')
    })

    it('重复执行结果一致（幂等）', () => {
      const once = migrate({
        version: 3,
        general: { windowState: { 'service-dock': DOCK_GEOMETRY, chat: CHAT_GEOMETRY } },
      })
      const twice = migrate({ ...once.data, version: 3 })
      expect(loadWindowState(twice.data)).toEqual(loadWindowState(once.data))
      expect(loadWindowState(twice.data)['chat']).toEqual(CHAT_GEOMETRY)
    })

    it('缺少 general / windowState 分组时不抛错', () => {
      const outcome = migrate({ version: 3 })
      expect(outcome.warnings).toEqual([])
      expect(outcome.data['version']).toBe(CONFIG_VERSION)
      expect(loadWindowState(outcome.data)).toEqual({})
    })
  })

  describe('v4 → v5（思考等级与电脑操控工具）', () => {
    /** 一份「完整 v4 配置」：自定义 provider + 用户改过的 advanced / 上限值 */
    const V4_CONFIG: Record<string, unknown> = {
      version: 4,
      general: { language: 'en-US', hotkey: 'Ctrl+Alt+A' },
      llm: {
        active: 'custom',
        providers: {
          custom: {
            type: 'openai-compat',
            baseUrl: 'http://127.0.0.1:11434/v1',
            apiKeyEnc: 'cipher',
            model: 'qwen2.5:7b',
            temperature: 1.4,
          },
        },
      },
      modes: { current: 'work' },
      advanced: { proxy: 'http://127.0.0.1:7890', logLevel: 'debug', confirmSensitiveTools: false },
    }

    it('补齐 reasoningEffort 与 agent.tools，且用户已写入的其它字段原样保留', () => {
      const outcome = migrate(V4_CONFIG)
      expect(outcome.fromVersion).toBe(4)
      expect(outcome.applied).toHaveLength(CONFIG_VERSION - 4)
      expect(outcome.data['version']).toBe(CONFIG_VERSION)

      const llm = outcome.data['llm'] as Record<string, unknown>
      expect(llm['active']).toBe('custom')
      const provider = (llm['providers'] as Record<string, Record<string, unknown>>)['custom']!
      expect(provider['reasoningEffort']).toBe('auto')
      // 其它 provider 字段一个不动
      expect(provider['baseUrl']).toBe('http://127.0.0.1:11434/v1')
      expect(provider['model']).toBe('qwen2.5:7b')
      expect(provider['temperature']).toBe(1.4)
      expect(provider['apiKeyEnc']).toBe('cipher')

      // advanced 只被 v5 → v6 补上 readonlyPrefixes，用户改过的值原样保留；general 迁移不碰
      expect(outcome.data['advanced']).toEqual({
        proxy: 'http://127.0.0.1:7890',
        logLevel: 'debug',
        confirmSensitiveTools: false,
        readonlyPrefixes: [...SETTINGS_READONLY_PREFIXES],
      })
      expect(outcome.data['general']).toEqual({
        language: 'en-US',
        hotkey: 'Ctrl+Alt+A',
        chat: { showThinking: true },
        // v19 → v20 补的出厂档（要求管理员身份启动，docs/08 §1）
        requireAdmin: true,
      })

      // agent.tools 为默认值（含 v12 起补出的 search.* 与 terminal.allowPatterns）；
      // permissionMode 由 v12 → v13 补成默认档 `confirm`（本步只验证"补缺不覆盖"）
      // 用 toMatchObject 而不是 toEqual：`agent` 组会随版本持续长字段（v14 起还有 snapshots），
      // 这里要守的是"这些键的值对不对"，不是"没有别的键"
      expect(outcome.data['agent']).toMatchObject({
        tools: {
          enabled: true,
          workspaceDir: '',
          terminal: {
            enabled: true,
            timeoutMs: 60_000,
            maxOutputChars: 8000,
            allowPatterns: [],
          },
          files: { enabled: true, maxReadBytes: 262_144 },
          search: { enabled: true, maxResults: 200 },
          open: { enabled: true },
        },
        permissionMode: 'confirm',
      })
    })

    it('幂等：对已迁移结果再跑一次，结果与第一次一致', () => {
      const once = migrate(V4_CONFIG)
      const twice = migrate({ ...once.data, version: 4 })
      expect(twice.data).toEqual(once.data)
    })

    it('用户已写 reasoningEffort: high 时不被覆盖', () => {
      const config = structuredClone(V4_CONFIG)
      ;((config['llm'] as Record<string, unknown>)['providers'] as Record<string, unknown>)[
        'custom'
      ] = {
        ...(((config['llm'] as Record<string, unknown>)['providers'] as Record<string, unknown>)[
          'custom'
        ] as Record<string, unknown>),
        reasoningEffort: 'high',
      }
      const outcome = migrate(config)
      const provider = (
        (outcome.data['llm'] as Record<string, unknown>)['providers'] as Record<
          string,
          Record<string, unknown>
        >
      )['custom']!
      expect(provider['reasoningEffort']).toBe('high')
    })

    it('非法 reasoningEffort（手改配置写错）回落 auto', () => {
      const config = structuredClone(V4_CONFIG)
      ;((config['llm'] as Record<string, unknown>)['providers'] as Record<string, unknown>)[
        'custom'
      ] = {
        ...(((config['llm'] as Record<string, unknown>)['providers'] as Record<string, unknown>)[
          'custom'
        ] as Record<string, unknown>),
        reasoningEffort: 'ultra',
      }
      const outcome = migrate(config)
      const provider = (
        (outcome.data['llm'] as Record<string, unknown>)['providers'] as Record<
          string,
          Record<string, unknown>
        >
      )['custom']!
      expect(provider['reasoningEffort']).toBe('auto')
    })

    it('已存在的 agent.tools 上限值保留，只补缺失字段', () => {
      const config = structuredClone(V4_CONFIG)
      config['agent'] = { tools: { terminal: { timeoutMs: 5_000 }, enabled: false } }
      const outcome = migrate(config)
      // 同上一处：只断言本用例关心的键（agent 组会随版本长字段）
      expect(outcome.data['agent']).toMatchObject({
        tools: {
          enabled: false,
          workspaceDir: '',
          terminal: {
            enabled: true,
            timeoutMs: 5_000,
            maxOutputChars: 8000,
            allowPatterns: [],
          },
          files: { enabled: true, maxReadBytes: 262_144 },
          search: { enabled: true, maxResults: 200 },
          open: { enabled: true },
        },
        // v12 → v13 补出的新键（缺失即补默认，已写过的值不覆盖）
        permissionMode: 'confirm',
      })
    })

    it('缺少 llm / agent 分组时不抛错', () => {
      const outcome = migrate({ version: 4 })
      expect(outcome.warnings).toEqual([])
      expect(outcome.data['version']).toBe(CONFIG_VERSION)
      // 没有 providers 就不凭空造 llm.providers（既有的「空 llm 迁移后仍为空」语义）
      expect(outcome.data['llm']).toBeUndefined()
      expect((outcome.data['agent'] as Record<string, unknown>)['tools']).toEqual({
        enabled: true,
        workspaceDir: '',
        terminal: {
          enabled: true,
          timeoutMs: 60_000,
          maxOutputChars: 8000,
          allowPatterns: [],
        },
        files: { enabled: true, maxReadBytes: 262_144 },
        search: { enabled: true, maxResults: 200 },
        open: { enabled: true },
      })
    })
  })

  describe('v5 → v6（移除独立小窗 mini-chat；补齐 readonlyPrefixes 与 modelList）', () => {
    const CHAT_GEOMETRY = { x: 1480, y: 200, width: 420, height: 640 }
    const MINI_GEOMETRY = { x: 1500, y: 260, width: 320, height: 480 }
    const SETTINGS_GEOMETRY = { x: 700, y: 120, width: 900, height: 700 }
    const loadWindowState = (raw: Record<string, unknown>): Record<string, unknown> => {
      const general = raw['general'] as Record<string, unknown>
      return general['windowState'] as Record<string, unknown>
    }
    const loadReadonlyPrefixes = (raw: Record<string, unknown>): unknown =>
      (raw['advanced'] as Record<string, unknown>)['readonlyPrefixes']
    const loadProviders = (raw: Record<string, unknown>): Record<string, Record<string, unknown>> =>
      (raw['llm'] as Record<string, unknown>)['providers'] as Record<
        string,
        Record<string, unknown>
      >

    it('删掉 mini-chat 键，chat / settings 几何原样保留，version 升到 6', () => {
      const outcome = migrate({
        version: 5,
        general: {
          language: 'zh-CN',
          windowState: {
            'mini-chat': MINI_GEOMETRY,
            chat: CHAT_GEOMETRY,
            settings: SETTINGS_GEOMETRY,
          },
        },
      })
      expect(outcome.fromVersion).toBe(5)
      expect(outcome.applied).toHaveLength(CONFIG_VERSION - 5)
      expect(outcome.data['version']).toBe(CONFIG_VERSION)
      // describe 变更（补了 modelList 字样）不影响既有断言：仍是一条 v5 → v6 迁移
      expect(outcome.applied[0]).toContain('v5 → v6')
      expect(outcome.applied[0]).toContain('readonlyPrefixes')

      const windowState = loadWindowState(outcome.data)
      expect(windowState['mini-chat']).toBeUndefined()
      expect(windowState['chat']).toEqual(CHAT_GEOMETRY)
      expect(windowState['settings']).toEqual(SETTINGS_GEOMETRY)
      expect(Object.keys(windowState)).toEqual(['chat', 'settings'])
      // 其它 general 字段不受影响
      expect((outcome.data['general'] as Record<string, unknown>)['language']).toBe('zh-CN')
    })

    it('补齐 advanced.readonlyPrefixes 默认值，且不覆盖用户已写入的黑名单', () => {
      const added = migrate({ version: 5, advanced: { logLevel: 'warn' } })
      expect((added.data['advanced'] as Record<string, unknown>)['logLevel']).toBe('warn')
      expect(loadReadonlyPrefixes(added.data)).toEqual([...SETTINGS_READONLY_PREFIXES])

      // 用户（高级逃生阀）自定义的黑名单原样保留，包括故意清空
      const kept = migrate({ version: 5, advanced: { readonlyPrefixes: ['custom.path'] } })
      expect(loadReadonlyPrefixes(kept.data)).toEqual(['custom.path'])

      const emptied = migrate({ version: 5, advanced: { readonlyPrefixes: [] } })
      expect(loadReadonlyPrefixes(emptied.data)).toEqual([])
    })

    it('补齐每个已有 provider 的 modelList，且已有列表与其它字段原样保留', () => {
      const outcome = migrate({
        version: 5,
        llm: {
          active: 'custom',
          providers: {
            custom: {
              type: 'openai-compat',
              baseUrl: 'http://127.0.0.1:11434/v1',
              apiKeyEnc: 'cipher',
              model: 'qwen2.5:7b',
              temperature: 1.4,
              reasoningEffort: 'high',
              // 已有候选列表（如手改配置文件写入）在迁移中不得被覆盖
              modelList: ['x'],
            },
            fresh: {
              type: 'openai-compat',
              baseUrl: 'https://api.deepseek.com',
              apiKeyEnc: 'cipher',
              model: 'deepseek-chat',
              temperature: 0.7,
              reasoningEffort: 'auto',
            },
          },
        },
      })
      expect(outcome.fromVersion).toBe(5)
      expect(outcome.applied).toHaveLength(CONFIG_VERSION - 5)
      expect(outcome.data['version']).toBe(CONFIG_VERSION)
      expect(outcome.applied[0]).toContain('modelList')

      const providers = loadProviders(outcome.data)
      // 缺的补成空数组：「列表为空」与「没有这个字段」对消费方必须是同一件事
      expect(providers['fresh']?.['modelList']).toEqual([])
      // 已有的原样保留（只补缺失键，不覆盖）
      expect(providers['custom']?.['modelList']).toEqual(['x'])
      // 其它 provider 字段一个不动
      expect(providers['custom']?.['model']).toBe('qwen2.5:7b')
      expect(providers['custom']?.['temperature']).toBe(1.4)
      expect(providers['custom']?.['reasoningEffort']).toBe('high')
      expect(providers['fresh']?.['model']).toBe('deepseek-chat')
      expect((outcome.data['llm'] as Record<string, unknown>)['active']).toBe('custom')
      // advanced 半边不受影响：同一次迁移里仍无条件补默认黑名单
      expect(loadReadonlyPrefixes(outcome.data)).toEqual([...SETTINGS_READONLY_PREFIXES])
    })

    it('非数组的 modelList（手改配置写错）归零，而不是把整份配置判成损坏', () => {
      const outcome = migrate({
        version: 5,
        llm: {
          active: 'custom',
          providers: {
            custom: {
              type: 'openai-compat',
              baseUrl: 'https://api.deepseek.com',
              apiKeyEnc: 'cipher',
              model: 'deepseek-chat',
              temperature: 0.7,
              reasoningEffort: 'auto',
              modelList: 'deepseek-chat',
            },
          },
        },
      })
      // `llm.providers.*` 是 z.record：逐字段回退管不到它，非法值会一路活到 SettingsSchema.parse，
      // 把整份配置判成损坏（备份 + 重建）。所以迁移里像 reasoningEffort 那样主动回落。
      expect(loadProviders(outcome.data)['custom']?.['modelList']).toEqual([])
      // 其它字段不受牵连
      expect(loadProviders(outcome.data)['custom']?.['model']).toBe('deepseek-chat')
    })

    it('重复执行结果一致（幂等）', () => {
      const once = migrate({
        version: 5,
        general: { windowState: { 'mini-chat': MINI_GEOMETRY, chat: CHAT_GEOMETRY } },
        llm: { active: 'custom', providers: { custom: { model: 'qwen2.5:7b' } } },
      })
      const twice = migrate({ ...once.data, version: 5 })
      expect(loadWindowState(twice.data)).toEqual(loadWindowState(once.data))
      expect(loadWindowState(twice.data)['chat']).toEqual(CHAT_GEOMETRY)
      expect(loadReadonlyPrefixes(twice.data)).toEqual(loadReadonlyPrefixes(once.data))
      expect(loadProviders(twice.data)).toEqual(loadProviders(once.data))
      expect(loadProviders(once.data)['custom']?.['modelList']).toEqual([])
    })

    it('缺少 general / windowState 时不抛错，也不凭空造出 windowState / llm.providers', () => {
      const outcome = migrate({ version: 5 })
      expect(outcome.warnings).toEqual([])
      expect(outcome.data['version']).toBe(CONFIG_VERSION)
      expect(outcome.data['general']).toBeUndefined()
      // 没有 providers 就不凭空造出 llm.providers（与 v4 → v5 对 llm 的语义一致）
      expect(outcome.data['llm']).toBeUndefined()
      // advanced 半边是**无条件**补默认值（与 general 的「有则改」不对称，见迁移注释）
      expect(loadReadonlyPrefixes(outcome.data)).toEqual([...SETTINGS_READONLY_PREFIXES])
    })
  })

  describe('v6 → v7（补齐 tts.*：语音合成配置）', () => {
    /** 一份「完整 v6 配置」：用户改过的黑名单 + 已有 llm provider（v6 → v7 都不该动） */
    const V6_CONFIG: Record<string, unknown> = {
      version: 6,
      general: { language: 'zh-CN', hotkey: 'Ctrl+Alt+A' },
      llm: {
        active: 'deepseek',
        providers: { deepseek: { model: 'deepseek-chat', modelList: ['deepseek-chat'] } },
      },
      advanced: { readonlyPrefixes: ['custom.path'] },
    }
    const loadTts = (raw: Record<string, unknown>): Record<string, unknown> =>
      raw['tts'] as Record<string, unknown>

    it('补齐 tts 段默认值，且用户已写值（readonlyPrefixes / llm）原样保留', () => {
      const outcome = migrate(V6_CONFIG)
      expect(outcome.fromVersion).toBe(6)
      expect(outcome.applied).toHaveLength(CONFIG_VERSION - 6)
      expect(outcome.applied[0]).toContain('v6 → v7')
      expect(outcome.data['version']).toBe(CONFIG_VERSION)

      const tts = loadTts(outcome.data)
      expect(tts['enabled']).toBe(true)
      expect(tts['active']).toBe('')
      expect(tts['autoRead']).toBe(false)
      expect(tts['maxChars']).toBe(2000)
      expect(tts['providers']).toEqual({})

      // 只碰 tts 与 version：其它分组一个字不改
      expect(outcome.data['advanced']).toEqual({ readonlyPrefixes: ['custom.path'] })
      expect(outcome.data['general']).toEqual({
        language: 'zh-CN',
        hotkey: 'Ctrl+Alt+A',
        chat: { showThinking: true },
        // v19 → v20 补的出厂档（docs/08 §1）
        requireAdmin: true,
      })
      // llm 段除了**后续版本**（v10 → v11）按既定规则补的 `contextWindow: 0`，其余一字不改
      expect(outcome.data['llm']).toEqual({
        active: 'deepseek',
        providers: {
          deepseek: { model: 'deepseek-chat', modelList: ['deepseek-chat'], contextWindow: 0 },
        },
      })
    })

    it('用户已写过的 tts 值（含 provider 条目）不被覆盖', () => {
      const provider = {
        type: 'openai-compat',
        baseUrl: 'https://api.siliconflow.cn/v1',
        apiKeyEnc: 'cipher',
        model: 'FunAudioLLM/CosyVoice2-0.5B',
        voice: 'alex',
        speed: 1.25,
        format: 'opus',
      }
      const outcome = migrate({
        version: 6,
        tts: {
          enabled: false,
          active: 'sf',
          autoRead: true,
          maxChars: 800,
          providers: { sf: provider },
        },
      })
      const tts = loadTts(outcome.data)
      expect(tts['enabled']).toBe(false)
      expect(tts['active']).toBe('sf')
      expect(tts['autoRead']).toBe(true)
      expect(tts['maxChars']).toBe(800)
      expect((tts['providers'] as Record<string, unknown>)['sf']).toEqual(provider)
    })

    it('重复执行结果一致（幂等）', () => {
      const once = migrate(V6_CONFIG)
      const twice = migrate({ ...once.data, version: 6 })
      expect(twice.data).toEqual(once.data)
      // providers 每轮都是新对象，不与 DEFAULT_TTS 共享引用（否则后续写入会串味）
      expect(twice.data['tts']).not.toBe(once.data['tts'])
      expect(loadTts(twice.data)['providers']).not.toBe(loadTts(once.data)['providers'])
    })

    it('缺少 tts 分组时补出完整默认段，不抛错也不留 undefined', () => {
      const outcome = migrate({ version: 6 })
      expect(outcome.warnings).toEqual([])
      expect(outcome.data['version']).toBe(CONFIG_VERSION)
      expect(loadTts(outcome.data)).toEqual({
        enabled: true,
        active: '',
        autoRead: false,
        maxChars: 2000,
        providers: {},
      })
    })
  })

  describe('v8 → v9（MCP HTTP 自定义请求头 headersEnc）', () => {
    const loadServers = (raw: Record<string, unknown>): Array<Record<string, unknown>> =>
      ((raw['mcp'] as Record<string, unknown>)['servers'] as Array<Record<string, unknown>>) ?? []

    it('为每个已有 mcp.servers 条目补 headersEnc: {}，其余字段原样保留', () => {
      const server = {
        name: 'remote',
        transport: 'http',
        url: 'https://example.com/mcp',
        envEnc: {},
        enabled: true,
      }
      const outcome = migrate({ version: 8, mcp: { lazyConnect: false, servers: [server] } })
      expect(outcome.fromVersion).toBe(8)
      expect(outcome.applied).toHaveLength(CONFIG_VERSION - 8)
      expect(outcome.applied[0]).toContain('headersEnc')
      expect(outcome.data['version']).toBe(CONFIG_VERSION)

      const servers = loadServers(outcome.data)
      expect(servers[0]?.['headersEnc']).toEqual({})
      // 其余字段一个不动
      expect(servers[0]).toEqual({ ...server, headersEnc: {} })
    })

    it('已有 headersEnc 的条目原样保留（幂等）', () => {
      const server = {
        name: 'remote',
        transport: 'http',
        url: 'https://example.com/mcp',
        envEnc: {},
        headersEnc: { Authorization: 'cipher' },
        enabled: true,
      }
      const once = migrate({ version: 8, mcp: { servers: [server] } })
      expect(loadServers(once.data)[0]?.['headersEnc']).toEqual({ Authorization: 'cipher' })

      const twice = migrate({ ...once.data, version: 8 })
      expect(twice.data).toEqual(once.data)
    })

    it('mcp 分组不存在时不凭空造对象；servers 不是数组时不抛错', () => {
      const noMcp = migrate({ version: 8, general: {} })
      expect(noMcp.warnings).toEqual([])
      expect(noMcp.data['version']).toBe(CONFIG_VERSION)
      expect(noMcp.data['mcp']).toBeUndefined()

      const badServers = migrate({ version: 8, mcp: { servers: 'oops' } })
      expect(badServers.warnings).toEqual([])
      expect((badServers.data['mcp'] as Record<string, unknown>)['servers']).toBe('oops')
      expect(badServers.data['version']).toBe(CONFIG_VERSION)
    })

    it('数组里的非对象条目原样跳过，不抛错', () => {
      const outcome = migrate({ version: 8, mcp: { servers: ['oops', null] } })
      expect(outcome.warnings).toEqual([])
      expect(loadServers(outcome.data)).toEqual(['oops', null])
    })
  })

  describe('v9 → v10（课前提前分钟数 preClassLeadMinutes）', () => {
    const loadClassroom = (raw: Record<string, unknown>): Record<string, unknown> =>
      (raw['modes'] as Record<string, unknown>)['classroom'] as Record<string, unknown>

    it('为已存在的 modes.classroom 补 preClassLeadMinutes: 5，其余字段原样保留', () => {
      const outcome = migrate({
        version: 9,
        modes: {
          current: 'classroom',
          classroom: {
            watchDir: 'D:\\感知',
            preClassReminder: false,
            preClassOpenFolder: false,
            subjects: [{ name: '数学', folder: '分类/数学', keywords: [] }],
          },
        },
      })
      expect(outcome.fromVersion).toBe(9)
      expect(outcome.applied).toHaveLength(CONFIG_VERSION - 9)
      expect(outcome.applied[0]).toContain('v9 → v10')
      expect(outcome.applied[0]).toContain('preClassLeadMinutes')
      expect(outcome.data['version']).toBe(CONFIG_VERSION)

      const classroom = loadClassroom(outcome.data)
      expect(classroom['preClassLeadMinutes']).toBe(5)
      // 用户写过的值一个不动（含两个布尔开关的 false）
      expect(classroom['watchDir']).toBe('D:\\感知')
      expect(classroom['preClassReminder']).toBe(false)
      expect(classroom['preClassOpenFolder']).toBe(false)
      expect(classroom['subjects']).toEqual([{ name: '数学', folder: '分类/数学', keywords: [] }])
    })

    it('用户已写过的 preClassLeadMinutes 不被覆盖（幂等）', () => {
      const once = migrate({
        version: 9,
        modes: { classroom: { preClassLeadMinutes: 12, watchDir: 'D:\\x' } },
      })
      expect(loadClassroom(once.data)['preClassLeadMinutes']).toBe(12)

      const twice = migrate({ ...once.data, version: 9 })
      expect(twice.data).toEqual(once.data)
      expect(loadClassroom(twice.data)['preClassLeadMinutes']).toBe(12)
    })

    it('modes / classroom 分组不存在时不凭空造对象，不抛错', () => {
      const noModes = migrate({ version: 9, general: {} })
      expect(noModes.warnings).toEqual([])
      expect(noModes.data['version']).toBe(CONFIG_VERSION)
      expect(noModes.data['modes']).toBeUndefined()

      const noClassroom = migrate({ version: 9, modes: { current: 'work' } })
      expect(noClassroom.warnings).toEqual([])
      expect((noClassroom.data['modes'] as Record<string, unknown>)['classroom']).toBeUndefined()
      expect(noClassroom.data['version']).toBe(CONFIG_VERSION)
    })
  })

  describe('v10 → v11（上下文窗口 contextWindow）', () => {
    const loadProviders = (raw: Record<string, unknown>): Record<string, Record<string, unknown>> =>
      (raw['llm'] as Record<string, unknown>)['providers'] as Record<
        string,
        Record<string, unknown>
      >

    it('为每个已有 provider 补 contextWindow: 0（0 = 未知），其余字段原样保留', () => {
      const outcome = migrate({
        version: 10,
        llm: {
          active: 'deepseek',
          providers: {
            deepseek: { model: 'deepseek-chat', modelList: ['deepseek-chat'], temperature: 0.7 },
            qwen: { model: 'qwen3.8-flash' },
          },
        },
      })
      expect(outcome.fromVersion).toBe(10)
      expect(outcome.applied).toHaveLength(CONFIG_VERSION - 10)
      expect(outcome.applied[0]).toContain('v10 → v11')
      expect(outcome.applied[0]).toContain('contextWindow')
      expect(outcome.data['version']).toBe(CONFIG_VERSION)

      const providers = loadProviders(outcome.data)
      expect(providers['deepseek']?.['contextWindow']).toBe(0)
      expect(providers['qwen']?.['contextWindow']).toBe(0)
      // 用户写过的值一个不动
      expect(providers['deepseek']?.['model']).toBe('deepseek-chat')
      expect(providers['deepseek']?.['temperature']).toBe(0.7)
      expect((outcome.data['llm'] as Record<string, unknown>)['active']).toBe('deepseek')
    })

    it('用户已写过的 contextWindow 不被覆盖（幂等）', () => {
      const once = migrate({
        version: 10,
        llm: { providers: { deepseek: { contextWindow: 128000 } } },
      })
      expect(loadProviders(once.data)['deepseek']?.['contextWindow']).toBe(128000)

      const twice = migrate({ ...once.data, version: 10 })
      expect(twice.data).toEqual(once.data)
      expect(loadProviders(twice.data)['deepseek']?.['contextWindow']).toBe(128000)
    })

    it('llm / providers 分组不存在或不合法时不凭空造对象，不抛错', () => {
      const noLlm = migrate({ version: 10, general: {} })
      expect(noLlm.warnings).toEqual([])
      expect(noLlm.data['llm']).toBeUndefined()
      expect(noLlm.data['version']).toBe(CONFIG_VERSION)

      const noProviders = migrate({ version: 10, llm: { active: 'x' } })
      expect(noProviders.warnings).toEqual([])
      expect(noProviders.data['llm']).toEqual({ active: 'x' })

      const badProviders = migrate({ version: 10, llm: { providers: 'oops' } })
      expect(badProviders.warnings).toEqual([])
      expect((badProviders.data['llm'] as Record<string, unknown>)['providers']).toBe('oops')
    })
  })

  describe('v11 → v12（文件检索 search.* 与免确认命令模式 allowPatterns）', () => {
    const loadTools = (raw: Record<string, unknown>): Record<string, unknown> =>
      (raw['agent'] as Record<string, unknown>)['tools'] as Record<string, unknown>
    const loadTerminal = (raw: Record<string, unknown>): Record<string, unknown> =>
      loadTools(raw)['terminal'] as Record<string, unknown>

    /** 一份 v11 配置：已有 agent.tools，但缺 v12 才有的 `search.*` 与 `allowPatterns`。 */
    const V11_CONFIG: Record<string, unknown> = {
      version: 11,
      general: { language: 'zh-CN' },
      agent: {
        tools: {
          enabled: true,
          workspaceDir: 'D:\\工作',
          terminal: { enabled: true, timeoutMs: 30_000, maxOutputChars: 4_000 },
          files: { enabled: false, maxReadBytes: 131_072 },
          open: { enabled: true },
        },
      },
    }

    it('为已存在的 agent.tools 补 search.* 与 terminal.allowPatterns，version 升到 12', () => {
      const outcome = migrate(V11_CONFIG)
      expect(outcome.fromVersion).toBe(11)
      // v11 → v12 补 search / allowPatterns，v12 → v13 补 projects / permissionMode
      expect(outcome.applied).toHaveLength(CONFIG_VERSION - 11)
      expect(outcome.applied[0]).toContain('v11 → v12')
      expect(outcome.applied[0]).toContain('allowPatterns')
      expect(outcome.data['version']).toBe(CONFIG_VERSION)
      expect(outcome.warnings).toEqual([])

      // 缺失的两处补成默认值
      expect(loadTools(outcome.data)['search']).toEqual({ enabled: true, maxResults: 200 })
      expect(loadTerminal(outcome.data)['allowPatterns']).toEqual([])
      // 只补缺不覆盖：用户已写过的值一个不动
      expect(loadTools(outcome.data)['workspaceDir']).toBe('D:\\工作')
      expect(loadTools(outcome.data)['files']).toEqual({ enabled: false, maxReadBytes: 131_072 })
      expect(loadTerminal(outcome.data)['timeoutMs']).toBe(30_000)
      expect(loadTerminal(outcome.data)['maxOutputChars']).toBe(4_000)
      expect(outcome.data['general']).toEqual({
        language: 'zh-CN',
        // v19 → v20 补的出厂档（docs/08 §1）
        requireAdmin: true,
      })
    })

    it('重复执行结果一致（幂等）', () => {
      const once = migrate(V11_CONFIG)
      const twice = migrate({ ...once.data, version: 11 })
      expect(twice.data).toEqual(once.data)
      expect(loadTools(twice.data)).toEqual(loadTools(once.data))
      expect(loadTerminal(twice.data)['allowPatterns']).toEqual([])
    })

    it('用户已写过的 allowPatterns 与 search.maxResults 原样保留，不被默认值覆盖', () => {
      const config = structuredClone(V11_CONFIG)
      const tools = (config['agent'] as Record<string, unknown>)['tools'] as Record<string, unknown>
      ;(tools['terminal'] as Record<string, unknown>)['allowPatterns'] = ['git status*']
      tools['search'] = { enabled: false, maxResults: 42 }

      const outcome = migrate(config)
      expect(loadTerminal(outcome.data)['allowPatterns']).toEqual(['git status*'])
      expect(loadTools(outcome.data)['search']).toEqual({ enabled: false, maxResults: 42 })

      const twice = migrate({ ...outcome.data, version: 11 })
      expect(loadTerminal(twice.data)['allowPatterns']).toEqual(['git status*'])
    })

    it('agent / agent.tools 分组不存在时不凭空造对象，不抛错', () => {
      const noAgent = migrate({ version: 11, general: {} })
      expect(noAgent.warnings).toEqual([])
      expect(noAgent.data['agent']).toBeUndefined()
      expect(noAgent.data['version']).toBe(CONFIG_VERSION)

      const noTools = migrate({ version: 11, agent: { other: 1 } })
      expect(noTools.warnings).toEqual([])
      // v12 → v13 / v13 → v14 只补新键，不认得的键原样保留（用 toMatchObject：agent 组会长字段）
      expect(noTools.data['agent']).toMatchObject({ other: 1, permissionMode: 'confirm' })
      expect(noTools.data['version']).toBe(CONFIG_VERSION)

      // terminal 缺失时只补 search，不凭空造出半截 terminal
      const noTerminal = migrate({ version: 11, agent: { tools: { enabled: true } } })
      expect(noTerminal.warnings).toEqual([])
      expect(loadTools(noTerminal.data)).toEqual({
        enabled: true,
        search: { enabled: true, maxResults: 200 },
      })
    })
  })

  describe('v12 → v13（新增 projects 项目机制与 agent.permissionMode 三档权限）', () => {
    const V12_CONFIG: Record<string, unknown> = {
      version: 12,
      general: { language: 'zh-CN' },
      agent: { tools: { enabled: true } },
    }

    const loadProjects = (data: Record<string, unknown>): Record<string, unknown> =>
      data['projects'] as Record<string, unknown>

    it('为已存在的 projects / agent 补默认值，version 升到 13', () => {
      const config = structuredClone(V12_CONFIG)
      config['projects'] = { current: '' }
      const outcome = migrate(config)
      expect(outcome.fromVersion).toBe(12)
      // 相对算术：后续新增迁移（step 3/4 的 v14 / v15）不会打红这条
      expect(outcome.applied).toHaveLength(CONFIG_VERSION - 12)
      expect(outcome.applied[0]).toContain('v12 → v13')
      expect(outcome.data['version']).toBe(CONFIG_VERSION)
      expect(outcome.warnings).toEqual([])

      // projects 已存在时只补缺键
      expect(loadProjects(outcome.data)).toEqual({ current: '', list: [], maxAgentsBytes: 32768 })
      // agent 已存在时只补 permissionMode
      expect((outcome.data['agent'] as Record<string, unknown>)['permissionMode']).toBe('confirm')
    })

    it('用户已写过的 current / list / permissionMode 原样保留，不被默认值覆盖', () => {
      const config = structuredClone(V12_CONFIG)
      config['projects'] = {
        current: 'proj-1',
        list: [{ id: 'proj-1', name: '演示', root: 'D:\\demo' }],
        maxAgentsBytes: 4096,
      }
      ;(config['agent'] as Record<string, unknown>)['permissionMode'] = 'readonly'

      const outcome = migrate(config)
      const projects = loadProjects(outcome.data)
      expect(projects['current']).toBe('proj-1')
      expect(projects['maxAgentsBytes']).toBe(4096)
      expect(projects['list']).toEqual([{ id: 'proj-1', name: '演示', root: 'D:\\demo' }])
      expect((outcome.data['agent'] as Record<string, unknown>)['permissionMode']).toBe('readonly')
    })

    it('重复执行结果一致（幂等）', () => {
      const config = structuredClone(V12_CONFIG)
      config['projects'] = { current: '' }
      const once = migrate(config)
      const twice = migrate({ ...once.data, version: 12 })
      expect(twice.data).toEqual(once.data)
    })

    it('projects / agent 分组不存在时不凭空造对象，不抛错', () => {
      const noProjects = migrate({ version: 12, general: {} })
      expect(noProjects.warnings).toEqual([])
      expect(noProjects.data['projects']).toBeUndefined()
      expect(noProjects.data['agent']).toBeUndefined()
      expect(noProjects.data['version']).toBe(CONFIG_VERSION)

      // agent 存在但不是对象（手改配置写坏）时同样不抛错
      const badAgent = migrate({ version: 12, agent: 'broken' })
      expect(badAgent.warnings).toEqual([])
      expect(badAgent.data['agent']).toBe('broken')
      expect(badAgent.data['version']).toBe(CONFIG_VERSION)
    })
  })

  describe('v13 → v14（为 agent 补 snapshots.* 写前快照配置）', () => {
    const V13_CONFIG: Record<string, unknown> = {
      version: 13,
      general: { language: 'zh-CN' },
      agent: { tools: { enabled: true }, permissionMode: 'confirm' },
    }

    it('为已存在的 agent 补 snapshots 默认值，version 升到 14', () => {
      const outcome = migrate(structuredClone(V13_CONFIG))
      expect(outcome.fromVersion).toBe(13)
      expect(outcome.applied).toHaveLength(CONFIG_VERSION - 13)
      expect(outcome.applied[0]).toContain('v13 → v14')
      expect(outcome.data['version']).toBe(CONFIG_VERSION)
      expect(outcome.warnings).toEqual([])

      const agent = outcome.data['agent'] as Record<string, unknown>
      expect(agent['snapshots']).toEqual({
        enabled: true,
        keepPerFile: 20,
        maxSnapshotBytes: 524288,
        totalBudgetBytes: 200 * 1024 * 1024,
      })
      // 只补缺：同组的 permissionMode / tools 原样保留
      expect(agent['permissionMode']).toBe('confirm')
    })

    it('用户已写过的 snapshots 值原样保留，不被默认值覆盖', () => {
      const config = structuredClone(V13_CONFIG)
      config['agent'] = {
        tools: { enabled: true },
        permissionMode: 'readonly',
        snapshots: {
          enabled: false,
          keepPerFile: 3,
          maxSnapshotBytes: 4096,
          totalBudgetBytes: 1048576,
        },
      }
      const outcome = migrate(config)
      const agent = outcome.data['agent'] as Record<string, unknown>
      expect(agent['snapshots']).toEqual({
        enabled: false,
        keepPerFile: 3,
        maxSnapshotBytes: 4096,
        totalBudgetBytes: 1048576,
      })
      expect(agent['permissionMode']).toBe('readonly')
    })

    it('幂等：连跑两次结果一致；缺 agent 分组时不凭空造对象', () => {
      const once = migrate(structuredClone(V13_CONFIG))
      const twice = migrate({ ...once.data, version: 13 })
      expect(twice.data).toEqual(once.data)

      const noAgent = migrate({ version: 13, general: {} })
      expect(noAgent.warnings).toEqual([])
      expect(noAgent.data['agent']).toBeUndefined()
      expect(noAgent.data['version']).toBe(CONFIG_VERSION)
    })

    it('v14 配置只补 loop（不覆盖已写的 snapshots），并随版本继续前移', () => {
      const outcome = migrate({
        version: 14,
        general: { language: 'zh-CN' },
        agent: {
          snapshots: {
            enabled: false,
            keepPerFile: 3,
            maxSnapshotBytes: 4096,
            totalBudgetBytes: 1048576,
          },
        },
      })
      // 恒等指的是「不重复应用同一条迁移」：从 14 出发会依次应用 v14 → v19 的每条迁移
      expect(outcome.applied).toEqual([
        'v14 → v15：v14 → v15：为 agent 补 loop.*（轮次上限、token 预算与自动续轮）',
        'v15 → v16：v15 → v16：新增 center 分组（Aurora Center 连接，docs/12）',
        'v16 → v17：v16 → v17：center 补 account（账号登录记住的账号名，docs/12 §7）',
        'v17 → v18：v17 → v18：放宽 agent.loop 轮次上限（maxRounds 8→32，autoContinueRounds 2→8）',
        'v18 → v19：v18 → v19：新增 automations 分组（自动化总开关，默认开启）',
        'v19 → v20：v19 → v20：新增 general.requireAdmin（要求管理员身份启动，默认开启）',
      ])
      expect(outcome.data['version']).toBe(CONFIG_VERSION)
      const agent = outcome.data['agent'] as Record<string, unknown>
      expect(agent['snapshots']).toEqual({
        enabled: false,
        keepPerFile: 3,
        maxSnapshotBytes: 4096,
        totalBudgetBytes: 1048576,
      })
      // 新版本配置则一条迁移都不应用
      const current = migrate({ version: CONFIG_VERSION, general: {} })
      expect(current.applied).toEqual([])
      expect(current.data['version']).toBe(CONFIG_VERSION)
    })
  })

  describe('v15 → v16（新增 center 分组，Aurora Center 连接）', () => {
    it('为已存在的 center 补默认值，用户已写的 serverUrl / tokenEnc 原样保留', () => {
      const outcome = migrate({
        version: 15,
        center: {
          enabled: true,
          serverUrl: 'wss://center.example.com',
          tokenEnc: 'fakestorage:v1:tok',
        },
      })
      expect(outcome.applied).toEqual([
        'v15 → v16：v15 → v16：新增 center 分组（Aurora Center 连接，docs/12）',
        'v16 → v17：v16 → v17：center 补 account（账号登录记住的账号名，docs/12 §7）',
        'v17 → v18：v17 → v18：放宽 agent.loop 轮次上限（maxRounds 8→32，autoContinueRounds 2→8）',
        'v18 → v19：v18 → v19：新增 automations 分组（自动化总开关，默认开启）',
        'v19 → v20：v19 → v20：新增 general.requireAdmin（要求管理员身份启动，默认开启）',
      ])
      expect(outcome.data['version']).toBe(CONFIG_VERSION)
      expect(outcome.data['center']).toEqual({
        enabled: true,
        serverUrl: 'wss://center.example.com',
        tokenEnc: 'fakestorage:v1:tok',
        account: '',
        clientId: '',
        displayName: '',
        allowRemoteSession: true,
        allowRemoteConfig: true,
        allowFileTransfer: true,
        maxFileMb: 64,
      })
    })

    it('已填 account（防手改）原样保留；重复迁移幂等', () => {
      const raw = { version: 16, center: { enabled: true, account: 'alice', tokenEnc: 'x' } }
      const first = migrate(raw)
      expect((first.data['center'] as Record<string, unknown>)['account']).toBe('alice')
      expect(first.data['version']).toBe(CONFIG_VERSION)
      const second = migrate(first.data as Record<string, unknown>)
      expect((second.data['center'] as Record<string, unknown>)['account']).toBe('alice')
      expect(second.applied).toEqual([])
    })

    it('center 分组不存在时不凭空造对象，交给默认配置兜底', () => {
      const outcome = migrate({ version: 15, general: {} })
      expect(outcome.warnings).toEqual([])
      expect(outcome.data['center']).toBeUndefined()
      expect(outcome.data['version']).toBe(CONFIG_VERSION)
    })

    it('重复执行结果一致（幂等）', () => {
      const raw = { version: 15, center: { enabled: true, serverUrl: 'ws://x' } }
      const once = migrate(raw)
      const twice = migrate(once.data as Record<string, unknown>)
      expect(twice.data).toEqual(once.data)
    })
  })

  describe('v17 → v18（放宽 agent.loop 轮次上限，docs/06 §5）', () => {
    it('旧默认哨兵（maxRounds 8 / autoContinueRounds 2）抬升为新默认值', () => {
      const outcome = migrate({
        version: 17,
        general: {},
        agent: { loop: { maxRounds: 8, maxTotalTokens: 0, autoContinueRounds: 2 } },
      })
      const loop = (outcome.data['agent'] as Record<string, unknown>)['loop'] as Record<
        string,
        unknown
      >
      expect(loop).toEqual({ maxRounds: 32, maxTotalTokens: 0, autoContinueRounds: 8 })
      expect(outcome.data['version']).toBe(CONFIG_VERSION)
    })

    it('用户显式改过的值原样保留；幂等', () => {
      const raw = {
        version: 17,
        general: {},
        agent: { loop: { maxRounds: 16, maxTotalTokens: 1000, autoContinueRounds: 0 } },
      }
      const outcome = migrate(raw)
      const loop = (outcome.data['agent'] as Record<string, unknown>)['loop'] as Record<
        string,
        unknown
      >
      expect(loop).toEqual({ maxRounds: 16, maxTotalTokens: 1000, autoContinueRounds: 0 })

      const again = migrate(outcome.data as Record<string, unknown>)
      const loopAgain = (again.data['agent'] as Record<string, unknown>)['loop'] as Record<
        string,
        unknown
      >
      expect(loopAgain).toEqual(loop)
    })

    it('agent.loop 缺失时不造对象，交给默认配置兜底', () => {
      const outcome = migrate({ version: 17, general: {}, agent: {} })
      expect((outcome.data['agent'] as Record<string, unknown>)['loop']).toBeUndefined()
      expect(outcome.data['version']).toBe(CONFIG_VERSION)
    })
  })

  describe('v18 → v19（新增 automations 分组，docs/13）', () => {
    it('缺分组时补上默认值（enabled: true）', () => {
      const outcome = migrate({ version: 18, general: {} })
      expect(outcome.data['automations']).toEqual({ enabled: true })
      expect(outcome.data['version']).toBe(CONFIG_VERSION)
    })

    it('用户已写的关闭态原样保留（不覆盖）；重复迁移幂等', () => {
      const raw = { version: 18, general: {}, automations: { enabled: false } }
      const outcome = migrate(raw)
      expect(outcome.data['automations']).toEqual({ enabled: false })

      const again = migrate(outcome.data as Record<string, unknown>)
      expect(again.data['automations']).toEqual({ enabled: false })
      expect(again.data).toEqual(outcome.data)
    })

    it('不触碰其它分组（缺分组不造对象）', () => {
      const outcome = migrate({ version: 18, general: {} })
      expect(outcome.data['agent']).toBeUndefined()
      expect(outcome.data['center']).toBeUndefined()
      expect(outcome.data['projects']).toBeUndefined()
    })

    it('v0 → 当前版本：链式执行条数等于 CONFIG_VERSION，末态含 automations', () => {
      const outcome = migrate({ version: 0, general: {} })
      expect(outcome.applied).toHaveLength(CONFIG_VERSION)
      expect(outcome.data['automations']).toEqual({ enabled: true })
    })
  })

  describe('v19 → v20（新增 general.requireAdmin，docs/08 §1）', () => {
    it('缺字段时补 true（出厂档：要求管理员身份启动）', () => {
      const outcome = migrate({ version: 19, general: { language: 'zh-CN' } })
      const general = outcome.data['general'] as Record<string, unknown>
      expect(general['requireAdmin']).toBe(true)
      expect(general['language']).toBe('zh-CN')
      expect(outcome.data['version']).toBe(CONFIG_VERSION)
    })

    it('用户已写的关闭态原样保留（不覆盖）；重复迁移幂等', () => {
      const raw = { version: 19, general: { requireAdmin: false } }
      const outcome = migrate(raw)
      expect((outcome.data['general'] as Record<string, unknown>)['requireAdmin']).toBe(false)

      const again = migrate(outcome.data as Record<string, unknown>)
      expect(again.data).toEqual(outcome.data)
    })

    it('general 整组缺失时不凭空造分组（Schema 兜底路径）', () => {
      const outcome = migrate({ version: 19 })
      expect(outcome.data['general']).toBeUndefined()
      expect(outcome.data['version']).toBe(CONFIG_VERSION)
    })

    it('v0 → 当前版本：链式执行条数等于 CONFIG_VERSION，末态含 requireAdmin', () => {
      const outcome = migrate({ version: 0, general: {} })
      expect(outcome.applied).toHaveLength(CONFIG_VERSION)
      expect((outcome.data['general'] as Record<string, unknown>)['requireAdmin']).toBe(true)
    })
  })
})
