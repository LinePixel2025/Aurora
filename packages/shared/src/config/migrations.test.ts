import { describe, expect, it } from 'vitest'
import { CONFIG_VERSION, SETTINGS_READONLY_PREFIXES, SettingsSchema } from './schema.js'
import { MIGRATIONS, migrate, readVersion } from './migrations.js'
import { createDefaultSettings } from './defaults.js'
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
    // v23 起 `temperature` 已从 Schema 删除：v0 → v1 不再写入它，链路走到 v23 也不会留下
    expect(providers['deepseek']?.['temperature']).toBeUndefined()
    // 三个生成参数一律落到 `modelParams[model]`（v23）；v0 夹具的 model 是 `deepseek-chat`
    expect(providers['deepseek']?.['modelParams']).toEqual({
      'deepseek-chat': { reasoningEffort: 'auto', contextWindow: 0, vision: false },
    })
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
    // 尺寸取 1400×900（≥ v25 → v26 抬底用的新默认 1280×800）：本组断言的是
    // 「删掉被退役的窗口、其它窗口几何原样」，用会被 v26 放大的小尺寸会串味
    const CHAT_GEOMETRY = { x: 1480, y: 200, width: 1400, height: 900 }
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
      // v4 → v5 补的是 provider 级 reasoningEffort，它随链路（v22 → v23）落进 `modelParams[model]`
      expect(provider['modelParams']).toEqual({
        'qwen2.5:7b': { reasoningEffort: 'auto', contextWindow: 0, vision: false },
      })
      // 其它 provider 字段一个不动（`temperature` 已从 Schema 删除，链路不再保留它）
      expect(provider['baseUrl']).toBe('http://127.0.0.1:11434/v1')
      expect(provider['model']).toBe('qwen2.5:7b')
      expect(provider['temperature']).toBeUndefined()
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
        gameMode: { enabled: true },
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
      const params = provider['modelParams'] as Record<string, Record<string, unknown>>
      expect(params['qwen2.5:7b']?.['reasoningEffort']).toBe('high')
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
      const params = provider['modelParams'] as Record<string, Record<string, unknown>>
      expect(params['qwen2.5:7b']?.['reasoningEffort']).toBe('auto')
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
        open: { enabled: true, urlMode: 'internal' },
      })
    })
  })

  describe('v5 → v6（移除独立小窗 mini-chat；补齐 readonlyPrefixes 与 modelList）', () => {
    // 尺寸取 1400×900（≥ v25 → v26 抬底用的新默认 1280×800）：本组断言的是
    // 「删掉被退役的窗口、其它窗口几何原样」，用会被 v26 放大的小尺寸会串味
    const CHAT_GEOMETRY = { x: 1480, y: 200, width: 1400, height: 900 }
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
      // 其它 provider 字段一个不动（`temperature` / provider 级 reasoningEffort 已被 v23 收进 modelParams）
      expect(providers['custom']?.['model']).toBe('qwen2.5:7b')
      expect(providers['custom']?.['temperature']).toBeUndefined()
      expect(providers['custom']?.['modelParams']).toEqual({
        'qwen2.5:7b': { reasoningEffort: 'high', contextWindow: 0, vision: false },
      })
      expect(providers['fresh']?.['model']).toBe('deepseek-chat')
      expect(providers['fresh']?.['modelParams']).toEqual({
        'deepseek-chat': { reasoningEffort: 'auto', contextWindow: 0, vision: false },
      })
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
        gameMode: { enabled: true },
      })
      // llm 段除了**后续版本**按既定规则补的 `type`（v21 → v22，缺 / 非法才补）与
      // v23 把三个 provider 级生成参数收进 `modelParams[model]`，其余一字不改
      expect(outcome.data['llm']).toEqual({
        active: 'deepseek',
        providers: {
          deepseek: {
            model: 'deepseek-chat',
            modelList: ['deepseek-chat'],
            type: 'openai-compat',
            modelParams: {
              'deepseek-chat': { reasoningEffort: 'auto', contextWindow: 0, vision: false },
            },
          },
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

    /** 取某个 provider 下某个模型的 `modelParams` 条目（v23 起参数按模型 id 键存放）。 */
    const loadParams = (
      raw: Record<string, unknown>,
      id: string,
      model: string,
    ): Record<string, unknown> =>
      (loadProviders(raw)[id]?.['modelParams'] as Record<string, Record<string, unknown>>)[model] ??
      {}

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
      // v10 → v11 补的是 provider 级 contextWindow，它随链路（v22 → v23）落进 `modelParams[model]`
      expect(providers['deepseek']?.['modelParams']).toEqual({
        'deepseek-chat': { reasoningEffort: 'auto', contextWindow: 0, vision: false },
      })
      expect(providers['qwen']?.['modelParams']).toEqual({
        'qwen3.8-flash': { reasoningEffort: 'auto', contextWindow: 0, vision: false },
      })
      // 用户写过的值一个不动（`temperature` 已从 Schema 删除，链路不再保留它）
      expect(providers['deepseek']?.['model']).toBe('deepseek-chat')
      expect(providers['deepseek']?.['temperature']).toBeUndefined()
      expect((outcome.data['llm'] as Record<string, unknown>)['active']).toBe('deepseek')
    })

    it('用户已写过的 contextWindow 不被覆盖（幂等）', () => {
      // 带 `model` 的 provider 才能把 provider 级 contextWindow 搬进 modelParams[model]（v23）
      const once = migrate({
        version: 10,
        llm: { providers: { deepseek: { model: 'deepseek-chat', contextWindow: 128000 } } },
      })
      expect(loadParams(once.data, 'deepseek', 'deepseek-chat')['contextWindow']).toBe(128000)

      const twice = migrate({ ...once.data, version: 10 })
      expect(twice.data).toEqual(once.data)
      expect(loadParams(twice.data, 'deepseek', 'deepseek-chat')['contextWindow']).toBe(128000)
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
        gameMode: { enabled: true },
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

      // projects 已存在时只补缺键（v25 迁移在链尾把 current 删掉）
      expect(loadProjects(outcome.data)).toEqual({ list: [], maxAgentsBytes: 32768 })
      // agent 已存在时只补 permissionMode
      expect((outcome.data['agent'] as Record<string, unknown>)['permissionMode']).toBe('confirm')
    })

    it('用户已写过的 list / maxAgentsBytes / permissionMode 原样保留，current 被 v25 删除', () => {
      const config = structuredClone(V12_CONFIG)
      config['projects'] = {
        current: 'proj-1',
        list: [{ id: 'proj-1', name: '演示', root: 'D:\\demo' }],
        maxAgentsBytes: 4096,
      }
      ;(config['agent'] as Record<string, unknown>)['permissionMode'] = 'readonly'

      const outcome = migrate(config)
      const projects = loadProjects(outcome.data)
      expect(projects['current']).toBeUndefined()
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
        'v20 → v21：v20 → v21：新增 general.edgeBar.display / position 与 appearance.accent',
        'v21 → v22：v21 → v22：为 llm.providers 各条目补 vision: false 并归一 type（多模态输入 / Responses API）',
        'v22 → v23：v22 → v23：把 provider 级 reasoningEffort / contextWindow / vision 搬进 modelParams[model]，删除 temperature',
        'v23 → v24：v23 → v24：归一 stt.providers 各条目的 type（语音输入新增阿里云百炼原生 ASR）',
        'v24 → v25：v24 → v25：退役全局 projects.current（项目改为按会话绑定，docs/06 §5.1）',
        'v25 → v26：v25 → v26：主界面默认尺寸上调到 1280×800（历史窗口几何只放大不缩小）',
        'v26 → v27：v26 → v27：agent.tools.open 补 urlMode（默认内置浏览器）',
        'v27 → v28：v27 → v28：补齐 fileAwareness（默认关闭，显式同意后才读取正文）',
        'v28 → v29：v28 → v29：补齐 fileAwareness 记忆过期与后台模型',
        'v29 → v30：v29 → v30：新增 general.gameMode（游戏模式联动，默认开启）',
        'v30 → v31：v30 → v31：新增 center.officialModels（Center 官方模型，默认全部关闭）',
        'v31 → v32：v31 → v32：新增 appearance.theme / glass（明暗档位与毛玻璃开关）',
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
        'v20 → v21：v20 → v21：新增 general.edgeBar.display / position 与 appearance.accent',
        'v21 → v22：v21 → v22：为 llm.providers 各条目补 vision: false 并归一 type（多模态输入 / Responses API）',
        'v22 → v23：v22 → v23：把 provider 级 reasoningEffort / contextWindow / vision 搬进 modelParams[model]，删除 temperature',
        'v23 → v24：v23 → v24：归一 stt.providers 各条目的 type（语音输入新增阿里云百炼原生 ASR）',
        'v24 → v25：v24 → v25：退役全局 projects.current（项目改为按会话绑定，docs/06 §5.1）',
        'v25 → v26：v25 → v26：主界面默认尺寸上调到 1280×800（历史窗口几何只放大不缩小）',
        'v26 → v27：v26 → v27：agent.tools.open 补 urlMode（默认内置浏览器）',
        'v27 → v28：v27 → v28：补齐 fileAwareness（默认关闭，显式同意后才读取正文）',
        'v28 → v29：v28 → v29：补齐 fileAwareness 记忆过期与后台模型',
        'v29 → v30：v29 → v30：新增 general.gameMode（游戏模式联动，默认开启）',
        'v30 → v31：v30 → v31：新增 center.officialModels（Center 官方模型，默认全部关闭）',
        'v31 → v32：v31 → v32：新增 appearance.theme / glass（明暗档位与毛玻璃开关）',
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
        officialModels: {
          llm: { enabled: false, model: '' },
          imagegen: { enabled: false, model: '' },
          tts: { enabled: false, model: '' },
          stt: { enabled: false, model: '' },
        },
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

  describe('v22 → v23（生成参数下沉 modelParams / 删除 temperature）', () => {
    const loadProvider = (raw: Record<string, unknown>, id: string): Record<string, unknown> =>
      (
        (raw['llm'] as Record<string, unknown>)['providers'] as Record<
          string,
          Record<string, unknown>
        >
      )[id]!

    /** 取某个 provider 下某个模型的 `modelParams` 条目（v23 起参数按模型 id 键存放）。 */
    const loadParams = (
      raw: Record<string, unknown>,
      id: string,
      model: string,
    ): Record<string, unknown> =>
      (loadProvider(raw, id)['modelParams'] as Record<string, Record<string, unknown>>)[model] ?? {}

    /**
     * 把迁移结果与默认配置拼成一份完整配置后交给 Schema。
     *
     * 这是本组最要紧的护栏：`llm.providers` 是 `z.record`，字段级回退对它**整体保留候选对象**，
     * 非法值只能靠迁移兜住 —— 归一漏一处，`SettingsSchema.parse` 就会抛错，整份配置被判损坏
     * （备份 + 重建出厂配置，用户的 provider / 凭据 / 项目配置一起消失）。
     */
    const parsesAsSettings = (data: Record<string, unknown>): boolean =>
      SettingsSchema.safeParse({ ...createDefaultSettings(), ...data }).success

    it('v22 旧配置 → v23：三个 provider 级值搬到 modelParams[model]，四个旧键全部消失', () => {
      const outcome = migrate({
        version: 22,
        llm: {
          active: 'deepseek',
          providers: {
            deepseek: {
              type: 'openai-compat',
              baseUrl: 'https://api.deepseek.com',
              apiKeyEnc: 'cipher',
              model: 'deepseek-chat',
              modelList: ['deepseek-chat', 'deepseek-reasoner'],
              temperature: 0.7,
              reasoningEffort: 'high',
              contextWindow: 128000,
              vision: true,
            },
          },
        },
      })
      expect(outcome.fromVersion).toBe(22)
      // 链此后每加一版就多一条：断言「从 v22 起逐条应用」（别写死 1，否则每次加迁移都要改这里）
      expect(outcome.applied).toHaveLength(CONFIG_VERSION - 22)
      expect(outcome.applied[0]).toContain('v22 → v23')
      expect(outcome.data['version']).toBe(CONFIG_VERSION)

      const provider = loadProvider(outcome.data, 'deepseek')
      // 三个值逐个相等 —— 搬的是值本身，不是"搬丢后落回默认"
      expect(provider['modelParams']).toEqual({
        'deepseek-chat': { reasoningEffort: 'high', contextWindow: 128000, vision: true },
      })
      // 四个旧键在 provider 级**都不存在**（`temperature` 直接丢弃）
      expect('temperature' in provider).toBe(false)
      expect('reasoningEffort' in provider).toBe(false)
      expect('contextWindow' in provider).toBe(false)
      expect('vision' in provider).toBe(false)
      // 其它字段一个不动
      expect(provider['model']).toBe('deepseek-chat')
      expect(provider['modelList']).toEqual(['deepseek-chat', 'deepseek-reasoner'])
      expect(provider['apiKeyEnc']).toBe('cipher')
      expect((outcome.data['llm'] as Record<string, unknown>)['active']).toBe('deepseek')
    })

    it('该模型在 modelParams 里已有（手改的）条目时：已写值原样保留、缺的键由旧值补上', () => {
      // 语义②「不覆盖已写值」+「旧值只补它缺的键」，两个方向都要成立。
      // ⚠️ 这条是回归护栏：实现若先归一已有条目再合并，归一出来的默认值会把旧值整个盖掉 ——
      // 症状是「手写过的 reasoningEffort: high 升级后静默变回 auto」，用户看不出是迁移干的。
      const outcome = migrate({
        version: 22,
        llm: {
          active: 'deepseek',
          providers: {
            deepseek: {
              type: 'openai-compat',
              baseUrl: 'https://api.deepseek.com',
              apiKeyEnc: 'cipher',
              model: 'deepseek-chat',
              modelList: ['deepseek-chat'],
              // 三个 provider 级旧值（待搬运）
              reasoningEffort: 'high',
              contextWindow: 128000,
              vision: true,
              // 该模型**已经**有一条手改出来的 modelParams 条目（只写了窗口）
              modelParams: { 'deepseek-chat': { contextWindow: 999 } },
            },
          },
        },
      })

      expect(loadParams(outcome.data, 'deepseek', 'deepseek-chat')).toEqual({
        // 已写值优先
        contextWindow: 999,
        // 缺的两个键由 provider 级旧值补上（不是落回 auto / false）
        reasoningEffort: 'high',
        vision: true,
      })
      expect(parsesAsSettings(outcome.data)).toBe(true)
    })

    it('model 为空串时不造模型条目，四个旧键照删', () => {
      const outcome = migrate({
        version: 22,
        llm: {
          active: 'custom',
          providers: {
            custom: {
              type: 'openai-compat',
              baseUrl: 'http://127.0.0.1:11434/v1',
              apiKeyEnc: 'cipher',
              model: '',
              temperature: 0.7,
              reasoningEffort: 'high',
              contextWindow: 128000,
              vision: true,
            },
          },
        },
      })
      expect(outcome.data['version']).toBe(CONFIG_VERSION)

      const provider = loadProvider(outcome.data, 'custom')
      // 没有一个生效模型就不凭它编条目：空表
      expect(provider['modelParams']).toEqual({})
      expect('temperature' in provider).toBe(false)
      expect('reasoningEffort' in provider).toBe(false)
      expect('contextWindow' in provider).toBe(false)
      expect('vision' in provider).toBe(false)
      expect(provider['model']).toBe('')
    })

    it('迁移幂等：对 v23 结果再迁一次，结果逐字相同', () => {
      const once = migrate({
        version: 22,
        llm: {
          providers: {
            deepseek: {
              type: 'openai-compat',
              baseUrl: 'https://api.deepseek.com',
              apiKeyEnc: 'cipher',
              model: 'deepseek-chat',
              reasoningEffort: 'high',
              contextWindow: 128000,
              vision: true,
            },
          },
        },
      })
      const again = migrate({ ...once.data, version: 22 })

      expect(again.data['version']).toBe(CONFIG_VERSION)
      expect(loadParams(again.data, 'deepseek', 'deepseek-chat')).toEqual(
        loadParams(once.data, 'deepseek', 'deepseek-chat'),
      )
      // 整份 llm 逐字相同：第二轮不会把 provider 级的四个键"补"回来，也不会改动已写的 modelParams
      expect(again.data['llm']).toEqual(once.data['llm'])
    })

    it('非法旧值被归一为默认（ultra / 128k / yes），且结果能通过 SettingsSchema.parse', () => {
      const outcome = migrate({
        version: 22,
        llm: {
          active: 'a',
          providers: {
            // 缺 reasoningEffort（一个合法值都没给）
            a: {
              type: 'openai-compat',
              baseUrl: 'https://a.example.com',
              apiKeyEnc: 'cipher',
              model: 'm-a',
              contextWindow: 128000,
              vision: true,
            },
            // 三个旧值全是非法字面量
            b: {
              type: 'openai-compat',
              baseUrl: 'https://b.example.com',
              apiKeyEnc: 'cipher',
              model: 'm-b',
              reasoningEffort: 'ultra',
              contextWindow: '128k',
              vision: 'yes',
            },
          },
        },
      })

      // 合法值原样搬，非法 / 缺失的按字段回落默认 —— 不是"原样继承"
      expect(loadParams(outcome.data, 'a', 'm-a')).toEqual({
        reasoningEffort: 'auto',
        contextWindow: 128000,
        vision: true,
      })
      expect(loadParams(outcome.data, 'b', 'm-b')).toEqual({
        reasoningEffort: 'auto',
        contextWindow: 0,
        vision: false,
      })

      // 手改配置里 `modelParams` 已经有一条非法条目：整张表逐条归一
      const handEdited = migrate({
        version: 22,
        llm: {
          active: 'hand',
          providers: {
            hand: {
              type: 'openai-compat',
              baseUrl: 'https://hand.example.com',
              apiKeyEnc: 'cipher',
              model: 'm-hand',
              modelParams: { other: { reasoningEffort: 'nope' } },
            },
          },
        },
      })
      expect(loadParams(handEdited.data, 'hand', 'other')).toEqual({
        reasoningEffort: 'auto',
        contextWindow: 0,
        vision: false,
      })
      expect(loadParams(handEdited.data, 'hand', 'm-hand')).toEqual({
        reasoningEffort: 'auto',
        contextWindow: 0,
        vision: false,
      })

      // 最要紧的护栏：归一漏一处，`z.record` 子树会把非法值原样带进 parse → 整份配置判损坏
      expect(parsesAsSettings(outcome.data)).toBe(true)
      expect(parsesAsSettings(handEdited.data)).toBe(true)
    })
  })
  describe('v23 → v24（stt.providers 的 type 归一，语音输入新增阿里云百炼原生 ASR）', () => {
    it('已有的 openai-compat 原样保留（不改正值），迁移后仍能通过 Schema', () => {
      const outcome = migrate({
        version: 23,
        stt: {
          enabled: true,
          active: 'st',
          providers: {
            st: {
              type: 'openai-compat',
              baseUrl: 'https://api.openai.com/v1',
              apiKeyEnc: '',
              model: 'whisper-1',
              language: 'zh',
            },
          },
        },
      })
      expect(outcome.applied).toEqual([
        'v23 → v24：v23 → v24：归一 stt.providers 各条目的 type（语音输入新增阿里云百炼原生 ASR）',
        'v24 → v25：v24 → v25：退役全局 projects.current（项目改为按会话绑定，docs/06 §5.1）',
        'v25 → v26：v25 → v26：主界面默认尺寸上调到 1280×800（历史窗口几何只放大不缩小）',
        'v26 → v27：v26 → v27：agent.tools.open 补 urlMode（默认内置浏览器）',
        'v27 → v28：v27 → v28：补齐 fileAwareness（默认关闭，显式同意后才读取正文）',
        'v28 → v29：v28 → v29：补齐 fileAwareness 记忆过期与后台模型',
        'v29 → v30：v29 → v30：新增 general.gameMode（游戏模式联动，默认开启）',
        'v30 → v31：v30 → v31：新增 center.officialModels（Center 官方模型，默认全部关闭）',
        'v31 → v32：v31 → v32：新增 appearance.theme / glass（明暗档位与毛玻璃开关）',
      ])
      expect(outcome.data['version']).toBe(CONFIG_VERSION)
      const provider = outcome.data['stt'] as Record<string, unknown> as Record<string, unknown>
      expect((provider['providers'] as Record<string, Record<string, unknown>>)['st']).toEqual({
        type: 'openai-compat',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyEnc: '',
        model: 'whisper-1',
        language: 'zh',
      })
      expect(
        SettingsSchema.safeParse({ ...createDefaultSettings(), ...outcome.data }).success,
      ).toBe(true)
    })

    it('缺 type / 非法 type 归一为 openai-compat，已是 dashscope-native 的不动', () => {
      const outcome = migrate({
        version: 23,
        stt: {
          enabled: true,
          active: 'aliyun',
          providers: {
            legacy: { baseUrl: 'https://api.openai.com/v1', apiKeyEnc: '', model: 'whisper-1' },
            broken: {
              type: 'whisper-ish',
              baseUrl: 'https://api.openai.com/v1',
              apiKeyEnc: '',
              model: 'whisper-1',
            },
            aliyun: {
              type: 'dashscope-native',
              baseUrl: 'https://dashscope.aliyuncs.com',
              apiKeyEnc: '',
              model: 'qwen3-asr-flash',
            },
          },
        },
      })
      const providers = (outcome.data['stt'] as Record<string, unknown>)['providers'] as Record<
        string,
        Record<string, unknown>
      >
      expect(providers['legacy']?.['type']).toBe('openai-compat')
      expect(providers['broken']?.['type']).toBe('openai-compat')
      // 迁移不替用户改协议
      expect(providers['aliyun']?.['type']).toBe('dashscope-native')
      expect(
        SettingsSchema.safeParse({ ...createDefaultSettings(), ...outcome.data }).success,
      ).toBe(true)
    })

    it('stt 分组缺失时不凭空造半截对象；重复迁移幂等', () => {
      const outcome = migrate({ version: 23, general: {} })
      expect(outcome.data['stt']).toBeUndefined()

      const once = migrate({
        version: 23,
        stt: {
          enabled: false,
          active: '',
          providers: { st: { type: 'dashscope-native', baseUrl: 'x', apiKeyEnc: '', model: 'm' } },
        },
      })
      const twice = migrate({ ...once.data, version: 23 })
      expect(twice.data['stt']).toEqual(once.data['stt'])
    })
  })

  describe('v25 → v26（主界面默认尺寸上调到 1280×800）', () => {
    const chatOf = (raw: Record<string, unknown>): Record<string, unknown> => {
      const general = raw['general'] as Record<string, unknown>
      const windowState = general['windowState'] as Record<string, unknown>
      return windowState['chat'] as Record<string, unknown>
    }

    it('小于新默认的 chat 几何被放大（只放大，x/y 原样）', () => {
      const outcome = migrate({
        version: 25,
        general: { windowState: { chat: { x: 10, y: 20, width: 1120, height: 720 } } },
      })
      expect(outcome.applied).toHaveLength(7)
      expect(outcome.applied[0]).toContain('v25 → v26')
      expect(outcome.applied[1]).toContain('v26 → v27')
      expect(outcome.applied[2]).toContain('v27 → v28')
      expect(outcome.applied[3]).toContain('v28 → v29')
      expect(outcome.applied[4]).toContain('v29 → v30')
      expect(outcome.applied[5]).toContain('v30 → v31')
      expect(outcome.applied[6]).toContain('v31 → v32')
      expect(outcome.data['version']).toBe(CONFIG_VERSION)
      expect(chatOf(outcome.data)).toEqual({ x: 10, y: 20, width: 1280, height: 800 })
    })

    it('用户自己拖得更大的尺寸原样保留（不缩小）；缺 chat 几何时不动 general', () => {
      const big = migrate({
        version: 25,
        general: { windowState: { chat: { x: 1, y: 2, width: 1920, height: 1080 } } },
      })
      expect(chatOf(big.data)).toEqual({ x: 1, y: 2, width: 1920, height: 1080 })

      const none = migrate({ version: 25, general: { language: 'zh-CN' } })
      expect(none.data['general']).toEqual({
        language: 'zh-CN',
        gameMode: { enabled: true },
      })
      expect(none.data['version']).toBe(CONFIG_VERSION)
    })
  })

  describe('v26 → v27（模型打开网址默认走内置浏览器）', () => {
    it('已有 open 分组只补缺字段，用户已选外部浏览器则原样保留', () => {
      const missing = migrate({
        version: 26,
        agent: { tools: { open: { enabled: true } } },
      })
      const missingAgent = missing.data['agent'] as Record<string, unknown>
      const missingTools = missingAgent['tools'] as Record<string, unknown>
      expect(missingTools['open']).toEqual({ enabled: true, urlMode: 'internal' })
      expect(missing.applied[0]).toContain('v26 → v27')

      const external = migrate({
        version: 26,
        agent: { tools: { open: { enabled: true, urlMode: 'external' } } },
      })
      const externalAgent = external.data['agent'] as Record<string, unknown>
      const externalTools = externalAgent['tools'] as Record<string, unknown>
      expect(externalTools['open']).toEqual({ enabled: true, urlMode: 'external' })
    })

    it('open 分组缺失时不凭空造对象；非法旧值回落 internal；重复迁移幂等', () => {
      const none = migrate({ version: 26, agent: { tools: { enabled: true } } })
      const noneAgent = none.data['agent'] as Record<string, unknown>
      const noneTools = noneAgent['tools'] as Record<string, unknown>
      expect(noneTools['open']).toBeUndefined()

      const once = migrate({
        version: 26,
        agent: { tools: { open: { enabled: true, urlMode: 'browser' } } },
      })
      const again = migrate({ ...once.data, version: 26 })
      expect(again.data['agent']).toEqual(once.data['agent'])
      expect(
        (
          ((again.data['agent'] as Record<string, unknown>)['tools'] as Record<string, unknown>)[
            'open'
          ] as Record<string, unknown>
        )['urlMode'],
      ).toBe('internal')
    })
  })

  describe('v27 → v28（文件自感知）', () => {
    it('补齐默认关闭的 fileAwareness，已有合法值原样保留', () => {
      const missing = migrate({ version: 27 })
      expect(missing.data['fileAwareness']).toEqual({
        enabled: false,
        contentConsentAccepted: false,
        watchedDirs: [],
        knowledgeDir: '',
        includeRecent: true,
        suggestionsEnabled: true,
        dailyAnalysisLimit: 20,
        maxFileMb: 100,
        defaultMemoryTtlDays: 0,
        backgroundModel: { providerId: '', model: '' },
      })
      expect(missing.applied).toHaveLength(5)
      expect(missing.applied[4]).toContain('v31 → v32')

      const existing = migrate({
        version: 27,
        fileAwareness: { enabled: true, watchedDirs: ['D:\\Docs'], dailyAnalysisLimit: 7 },
      })
      expect(existing.data['fileAwareness']).toEqual({
        enabled: true,
        contentConsentAccepted: false,
        watchedDirs: ['D:\\Docs'],
        knowledgeDir: '',
        includeRecent: true,
        suggestionsEnabled: true,
        dailyAnalysisLimit: 7,
        maxFileMb: 100,
        defaultMemoryTtlDays: 0,
        backgroundModel: { providerId: '', model: '' },
      })
      const twice = migrate({ ...existing.data, version: 27 })
      expect(twice.data['fileAwareness']).toEqual(existing.data['fileAwareness'])
    })
  })

  describe('v28 → v29（记忆过期与后台模型）', () => {
    it('补齐默认值，已有 fileAwareness 字段与后台模型原样保留', () => {
      const missing = migrate({
        version: 28,
        fileAwareness: {
          enabled: true,
          watchedDirs: ['D:\\Docs'],
          dailyAnalysisLimit: 7,
        },
      })
      expect(missing.applied).toHaveLength(4)
      expect(missing.applied[3]).toContain('v31 → v32')
      expect(missing.data['fileAwareness']).toEqual({
        enabled: true,
        contentConsentAccepted: false,
        watchedDirs: ['D:\\Docs'],
        knowledgeDir: '',
        includeRecent: true,
        suggestionsEnabled: true,
        dailyAnalysisLimit: 7,
        maxFileMb: 100,
        defaultMemoryTtlDays: 0,
        backgroundModel: { providerId: '', model: '' },
      })

      const existing = migrate({
        version: 28,
        fileAwareness: {
          defaultMemoryTtlDays: 30,
          backgroundModel: { providerId: 'deepseek', model: 'deepseek-reasoner' },
        },
      })
      expect(existing.data['fileAwareness']).toMatchObject({
        defaultMemoryTtlDays: 30,
        backgroundModel: { providerId: 'deepseek', model: 'deepseek-reasoner' },
      })
    })
  })

  describe('v29 → v30（游戏模式联动）', () => {
    it('为已有 general 补默认开启的游戏模式；已有显式关闭值原样保留', () => {
      const missing = migrate({
        version: 29,
        general: { language: 'zh-CN' },
      })
      expect(missing.applied).toHaveLength(3)
      expect(missing.applied[2]).toContain('v31 → v32')
      expect(missing.data['general']).toEqual({
        language: 'zh-CN',
        gameMode: { enabled: true },
      })

      const disabled = migrate({
        version: 29,
        general: { gameMode: { enabled: false } },
      })
      expect(disabled.data['general']).toMatchObject({
        gameMode: { enabled: false },
      })
    })

    it('general 整组缺失时不凭空造分组；重复迁移幂等', () => {
      const none = migrate({ version: 29 })
      expect(none.data['general']).toBeUndefined()

      const once = migrate({
        version: 29,
        general: { edgeBar: { enabled: true } },
      })
      const twice = migrate({ ...once.data, version: 29 })
      expect(twice.data['general']).toEqual(once.data['general'])
    })
  })

  describe('v30 → v31（Center 官方模型）', () => {
    it('为已有 center 补四类默认关闭选择，已有字段原样保留', () => {
      const missing = migrate({
        version: 30,
        center: { enabled: true, serverUrl: 'wss://center.example.com' },
      })
      expect(missing.applied).toHaveLength(2)
      expect(missing.applied[1]).toContain('v31 → v32')
      expect(missing.data['center']).toMatchObject({
        enabled: true,
        serverUrl: 'wss://center.example.com',
        officialModels: {
          llm: { enabled: false, model: '' },
          imagegen: { enabled: false, model: '' },
          tts: { enabled: false, model: '' },
          stt: { enabled: false, model: '' },
        },
      })

      const existing = migrate({
        version: 30,
        center: {
          officialModels: {
            llm: { enabled: true, model: 'model-a' },
          },
        },
      })
      expect(
        (existing.data['center'] as { officialModels: { llm: unknown } }).officialModels.llm,
      ).toEqual({ enabled: true, model: 'model-a' })
    })
  })

  describe('v31 → v32（外观：明暗档位与毛玻璃开关）', () => {
    const appearanceOf = (raw: Record<string, unknown>): Record<string, unknown> =>
      raw['appearance'] as Record<string, unknown>

    it('为已有 appearance 补 theme / glass，用户已写的 accent 原样保留', () => {
      const outcome = migrate({ version: 31, appearance: { accent: 'violet' } })
      expect(outcome.applied).toHaveLength(1)
      expect(outcome.applied[0]).toContain('v31 → v32')
      expect(appearanceOf(outcome.data)).toEqual({
        theme: 'system',
        accent: 'violet',
        glass: true,
      })
      // 两条默认值都是「保持 v32 之前的行为」：主题跟随系统、毛玻璃开着
      expect(outcome.data['version']).toBe(CONFIG_VERSION)
      expect(
        SettingsSchema.safeParse({ ...createDefaultSettings(), ...outcome.data }).success,
      ).toBe(true)
    })

    it('用户已写的 theme / glass 不被覆盖（幂等）', () => {
      const once = migrate({
        version: 31,
        appearance: { theme: 'dark', accent: 'teal', glass: false },
      })
      expect(appearanceOf(once.data)).toEqual({ theme: 'dark', accent: 'teal', glass: false })

      const twice = migrate({ ...once.data, version: 31 })
      expect(twice.data['appearance']).toEqual(once.data['appearance'])
      expect(appearanceOf(twice.data)['glass']).toBe(false)
    })

    it('appearance 整组缺失时补完整默认（与 v20 → v21 同一套路）', () => {
      const outcome = migrate({ version: 31, general: { language: 'zh-CN' } })
      expect(appearanceOf(outcome.data)).toEqual({ theme: 'system', accent: 'aurora', glass: true })
      expect(outcome.data['version']).toBe(CONFIG_VERSION)
    })
  })
})
