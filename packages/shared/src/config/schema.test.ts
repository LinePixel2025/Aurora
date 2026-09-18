import { describe, expect, it } from 'vitest'
import { createDefaultSettings, PROVIDER_PRESETS } from './defaults.js'
import {
  CONFIG_VERSION,
  DEFAULT_SUBJECT_NAMES,
  MODE_IDS,
  SettingsSchema,
  fieldAccepts,
  schemaPathCount,
} from './schema.js'

describe('SettingsSchema / defaults 一致性', () => {
  it('MODE_IDS 顺序 ClassRoom 在前（docs/07 §2.5、docs/08 §3 推荐 ClassRoom）', () => {
    expect([...MODE_IDS]).toEqual(['classroom', 'work', 'code'])
  })

  it('默认配置必须通过 Schema 校验', () => {
    const parsed = SettingsSchema.safeParse(createDefaultSettings())
    expect(parsed.success).toBe(true)
  })

  it('默认版本与 Schema 版本一致', () => {
    expect(createDefaultSettings().version).toBe(CONFIG_VERSION)
  })

  it('默认科目为 05 §2 的九科模板，且 folder 指向 分类/<科目>', () => {
    const subjects = createDefaultSettings().modes.classroom.subjects
    expect(subjects.map((s) => s.name)).toEqual([...DEFAULT_SUBJECT_NAMES])
    expect(subjects[0]?.folder).toBe('分类/语文')
    expect(subjects.every((s) => s.keywords.length === 0)).toBe(true)
  })

  it('默认未配置模型（active 为空 → 需要首次引导）', () => {
    const settings = createDefaultSettings()
    expect(settings.llm.active).toBe('')
    expect(settings.llm.providers).toEqual({})
  })

  it('每个内置 provider 预设字段完整', () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.baseUrl.startsWith('http')).toBe(true)
      expect(preset.model.length).toBeGreaterThan(0)
    }
  })

  it('返回的默认配置是深拷贝，互不影响', () => {
    const a = createDefaultSettings()
    const b = createDefaultSettings()
    a.modes.classroom.subjects[0]!.name = '被改写'
    expect(b.modes.classroom.subjects[0]!.name).toBe(DEFAULT_SUBJECT_NAMES[0])
  })

  it('路径感知校验器：按字段类型判定，不做"只看 JSON 类型"的粗暴回退', () => {
    // 字符串字段拒绝数字
    expect(fieldAccepts('general.language', 42)).toBe(false)
    expect(fieldAccepts('general.language', 'en-US')).toBe(true)
    // 数字字段接受数字、拒绝字符串
    expect(fieldAccepts('llm.providers.deepseek.temperature', 0.7)).toBe(true)
    expect(fieldAccepts('llm.providers.deepseek.temperature', 'hot')).toBe(false)
    // 布尔与数组
    expect(fieldAccepts('modes.classroom.preClassReminder', true)).toBe(true)
    expect(fieldAccepts('modes.classroom.preClassReminder', 'yes')).toBe(false)
    expect(fieldAccepts('modes.classroom.subjects', [])).toBe(true)
    expect(fieldAccepts('modes.classroom.subjects', {})).toBe(false)
    // 可空联合字段（quietHours: {start,end} | null）
    expect(fieldAccepts('advanced.quietHours', null)).toBe(true)
    expect(fieldAccepts('advanced.quietHours', { start: '22:00', end: '07:00' })).toBe(true)
    // 动态键 record 字段
    expect(fieldAccepts('llm.providers', {})).toBe(true)
    expect(fieldAccepts('llm.providers.deepseek.apiKeyEnc', 'cipher')).toBe(true)
    expect(fieldAccepts('llm.providers.deepseek.temperature', 'hot')).toBe(false)
    // 未登记的路径默认接受（避免误杀）
    expect(fieldAccepts('some.future.field', 1)).toBe(true)
  })

  it('校验表覆盖全部顶层分组', () => {
    expect(schemaPathCount()).toBeGreaterThan(20)
    for (const key of Object.keys(createDefaultSettings())) {
      expect(fieldAccepts(key, (createDefaultSettings() as Record<string, unknown>)[key])).toBe(
        true,
      )
    }
  })

  it('非法字段被识别为非法（供 sanitize 回退默认值）', () => {
    expect(fieldAccepts('general.language', 12)).toBe(false)
    expect(fieldAccepts('general.language', 'x')).toBe(true)
    expect(fieldAccepts('advanced.quietHours', null)).toBe(true)
    expect(fieldAccepts('general.windowState', {})).toBe(true)
  })

  it('temperature 越界会被 Schema 拒绝', () => {
    const settings = createDefaultSettings()
    settings.llm.providers['deepseek'] = {
      type: 'openai-compat',
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnc: 'enc',
      model: 'deepseek-chat',
      temperature: 9,
    }
    expect(SettingsSchema.safeParse(settings).success).toBe(false)
  })

  it('未知模式 id 会被 Schema 拒绝', () => {
    const settings = createDefaultSettings() as unknown as Record<string, unknown>
    ;(settings['modes'] as Record<string, unknown>)['current'] = 'gaming'
    expect(SettingsSchema.safeParse(settings).success).toBe(false)
  })

  it('分类管线默认值与类型校验（P4）', () => {
    const classification = createDefaultSettings().modes.classroom.classification
    expect(classification).toEqual({
      autoMove: true,
      confidenceThreshold: 0.6,
      fallbackFolder: '待分类',
    })
    expect(fieldAccepts('modes.classroom.classification.autoMove', false)).toBe(true)
    expect(fieldAccepts('modes.classroom.classification.autoMove', 'yes')).toBe(false)
    expect(fieldAccepts('modes.classroom.classification.confidenceThreshold', 0.5)).toBe(true)
    expect(fieldAccepts('modes.classroom.classification.confidenceThreshold', '0.5')).toBe(false)
    expect(fieldAccepts('modes.classroom.classification.fallbackFolder', '待分类')).toBe(true)
  })

  it('confidenceThreshold 越界被 Schema 拒绝', () => {
    const settings = createDefaultSettings()
    settings.modes.classroom.classification.confidenceThreshold = 1.5
    expect(SettingsSchema.safeParse(settings).success).toBe(false)
    settings.modes.classroom.classification.confidenceThreshold = 0
    expect(SettingsSchema.safeParse(settings).success).toBe(true)
  })

  it('敏感工具确认开关默认开启且为布尔（P5）', () => {
    expect(createDefaultSettings().advanced.confirmSensitiveTools).toBe(true)
    expect(fieldAccepts('advanced.confirmSensitiveTools', false)).toBe(true)
    expect(fieldAccepts('advanced.confirmSensitiveTools', 'no')).toBe(false)
  })
})
