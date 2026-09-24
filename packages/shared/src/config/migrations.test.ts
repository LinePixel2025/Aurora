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
      // v1 → v2 → v3 → v4 → v5 → v6 → v7：链式执行，六版迁移都会跑
      expect(outcome.applied).toHaveLength(6)
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
      // v2 → v3 → v4 → v5 → v6 → v7：链式执行
      expect(outcome.applied).toHaveLength(5)

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
      // v3 → v4 → v5 → v6 → v7：链式执行
      expect(outcome.applied).toHaveLength(4)
      expect(outcome.data['version']).toBe(7)

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
      expect(outcome.data['version']).toBe(7)
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
      expect(outcome.applied).toHaveLength(3)
      expect(outcome.data['version']).toBe(7)

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
      expect(outcome.data['general']).toEqual({ language: 'en-US', hotkey: 'Ctrl+Alt+A' })

      // agent.tools 为默认值
      expect(outcome.data['agent']).toEqual({
        tools: {
          enabled: true,
          workspaceDir: '',
          terminal: { enabled: true, timeoutMs: 60_000, maxOutputChars: 8000 },
          files: { enabled: true, maxReadBytes: 262_144 },
          open: { enabled: true },
        },
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
      expect(outcome.data['agent']).toEqual({
        tools: {
          enabled: false,
          workspaceDir: '',
          terminal: { enabled: true, timeoutMs: 5_000, maxOutputChars: 8000 },
          files: { enabled: true, maxReadBytes: 262_144 },
          open: { enabled: true },
        },
      })
    })

    it('缺少 llm / agent 分组时不抛错', () => {
      const outcome = migrate({ version: 4 })
      expect(outcome.warnings).toEqual([])
      expect(outcome.data['version']).toBe(7)
      // 没有 providers 就不凭空造 llm.providers（既有的「空 llm 迁移后仍为空」语义）
      expect(outcome.data['llm']).toBeUndefined()
      expect((outcome.data['agent'] as Record<string, unknown>)['tools']).toEqual({
        enabled: true,
        workspaceDir: '',
        terminal: { enabled: true, timeoutMs: 60_000, maxOutputChars: 8000 },
        files: { enabled: true, maxReadBytes: 262_144 },
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
      expect(outcome.applied).toHaveLength(2)
      expect(outcome.data['version']).toBe(7)
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
      expect(outcome.applied).toHaveLength(2)
      expect(outcome.data['version']).toBe(7)
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
      expect(outcome.data['version']).toBe(7)
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
      expect(outcome.applied).toHaveLength(1)
      expect(outcome.applied[0]).toContain('v6 → v7')
      expect(outcome.data['version']).toBe(7)

      const tts = loadTts(outcome.data)
      expect(tts['enabled']).toBe(true)
      expect(tts['active']).toBe('')
      expect(tts['autoRead']).toBe(false)
      expect(tts['maxChars']).toBe(2000)
      expect(tts['providers']).toEqual({})

      // 只碰 tts 与 version：其它分组一个字不改
      expect(outcome.data['advanced']).toEqual({ readonlyPrefixes: ['custom.path'] })
      expect(outcome.data['general']).toEqual({ language: 'zh-CN', hotkey: 'Ctrl+Alt+A' })
      expect(outcome.data['llm']).toEqual(V6_CONFIG['llm'])
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
      expect(outcome.data['version']).toBe(7)
      expect(loadTts(outcome.data)).toEqual({
        enabled: true,
        active: '',
        autoRead: false,
        maxChars: 2000,
        providers: {},
      })
    })
  })
})
