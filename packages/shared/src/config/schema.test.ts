import { describe, expect, it } from 'vitest'
import { createDefaultSettings, PROVIDER_PRESETS } from './defaults.js'
import {
  COMPUTER_TOOL_NAMES,
  CONFIG_VERSION,
  DEFAULT_SUBJECT_NAMES,
  MODE_IDS,
  SETTINGS_READONLY_PREFIXES,
  SettingsSchema,
  canWriteSettingPath,
  fieldAccepts,
  schemaPathCount,
  settingsReadonlyReason,
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
      reasoningEffort: 'auto',
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

  it('思考等级：只接受四个枚举值（枚举按值校验，而非"类型对就放行"）（v5）', () => {
    const settings = createDefaultSettings()
    settings.llm.providers['deepseek'] = {
      type: 'openai-compat',
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnc: 'enc',
      model: 'deepseek-chat',
      temperature: 0.7,
      reasoningEffort: 'high',
    }
    expect(SettingsSchema.safeParse(settings).success).toBe(true)

    expect(fieldAccepts('llm.providers.deepseek.reasoningEffort', 'high')).toBe(true)
    expect(fieldAccepts('llm.providers.deepseek.reasoningEffort', 'auto')).toBe(true)
    // 类型对不代表值合法：枚举必须按值校验，否则非法值会活到 parse 把整份配置判为损坏
    expect(fieldAccepts('llm.providers.deepseek.reasoningEffort', 'ultra')).toBe(false)
    expect(fieldAccepts('llm.providers.deepseek.reasoningEffort', 42)).toBe(false)
  })

  it('模型候选列表：必须是数组，且默认值为空数组（v6）', () => {
    // 默认配置里没有 provider，逐字段回退用的校验器仍必须认识这条路径
    expect(fieldAccepts('llm.providers.deepseek.modelList', ['a', 'b'])).toBe(true)
    expect(fieldAccepts('llm.providers.deepseek.modelList', [])).toBe(true)
    // 「必须是数组」：单个字符串不能当成只有一项的列表（否则设置页会写进非数组值）
    expect(fieldAccepts('llm.providers.deepseek.modelList', 'a')).toBe(false)
    expect(fieldAccepts('llm.providers.deepseek.modelList', { 0: 'a' })).toBe(false)

    const settings = createDefaultSettings()
    settings.llm.providers['deepseek'] = {
      type: 'openai-compat',
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnc: 'enc',
      model: 'deepseek-chat',
      temperature: 0.7,
      reasoningEffort: 'auto',
      modelList: [],
    }
    expect(SettingsSchema.safeParse(settings).success).toBe(true)
    expect(SettingsSchema.parse(settings).llm.providers['deepseek']?.modelList).toEqual([])
  })

  it('电脑操控工具配置：默认值完整、字段路径可校验（v5）', () => {
    expect([...COMPUTER_TOOL_NAMES]).toEqual([
      'run_command',
      'read_file',
      'write_file',
      'list_dir',
      'open_path',
    ])
    expect(createDefaultSettings().agent.tools).toEqual({
      enabled: true,
      workspaceDir: '',
      terminal: { enabled: true, timeoutMs: 60_000, maxOutputChars: 8000 },
      files: { enabled: true, maxReadBytes: 262_144 },
      open: { enabled: true },
    })

    expect(fieldAccepts('agent.tools.terminal.timeoutMs', 60_000)).toBe(true)
    expect(fieldAccepts('agent.tools.terminal.timeoutMs', 'x')).toBe(false)
    expect(fieldAccepts('agent.tools.enabled', false)).toBe(true)
    expect(fieldAccepts('agent.tools.workspaceDir', 'D:\\工作目录')).toBe(true)
    expect(fieldAccepts('agent.tools.workspaceDir', 123)).toBe(false)
  })

  it('电脑操控工具上限越界会被 Schema 拒绝（v5）', () => {
    const tooSmall = createDefaultSettings()
    tooSmall.agent.tools.terminal.timeoutMs = 999
    expect(SettingsSchema.safeParse(tooSmall).success).toBe(false)

    const tooLarge = createDefaultSettings()
    tooLarge.agent.tools.terminal.timeoutMs = 400_000
    expect(SettingsSchema.safeParse(tooLarge).success).toBe(false)

    const outputTooSmall = createDefaultSettings()
    outputTooSmall.agent.tools.terminal.maxOutputChars = 499
    expect(SettingsSchema.safeParse(outputTooSmall).success).toBe(false)

    const readTooSmall = createDefaultSettings()
    readTooSmall.agent.tools.files.maxReadBytes = 1_023
    expect(SettingsSchema.safeParse(readTooSmall).success).toBe(false)

    const readTooLarge = createDefaultSettings()
    readTooLarge.agent.tools.files.maxReadBytes = 4_194_305
    expect(SettingsSchema.safeParse(readTooLarge).success).toBe(false)

    // 边界值本身合法
    const ok = createDefaultSettings()
    ok.agent.tools.terminal.timeoutMs = 300_000
    ok.agent.tools.terminal.maxOutputChars = 500
    ok.agent.tools.files.maxReadBytes = 4_194_304
    expect(SettingsSchema.safeParse(ok).success).toBe(true)
  })
})

describe('AI 改配置的路径黑名单（set_setting，docs/06 §12）', () => {
  it('默认黑名单即 SETTINGS_READONLY_PREFIXES，且是可变数组', () => {
    const settings = createDefaultSettings()
    expect(settings.advanced.readonlyPrefixes).toEqual([...SETTINGS_READONLY_PREFIXES])
    // 高级用户的逃生阀要能改：默认值必须是可变数组，不能是 `as const` 的只读元组
    settings.advanced.readonlyPrefixes.push('custom.path')
    expect(settings.advanced.readonlyPrefixes).toContain('custom.path')
    // 且不是与常量共享引用（默认配置每次都拿新副本）
    expect(createDefaultSettings().advanced.readonlyPrefixes).toEqual([
      ...SETTINGS_READONLY_PREFIXES,
    ])
  })

  it('可写路径：被 Schema 登记且不在黑名单里', () => {
    expect(canWriteSettingPath('agent.tools.terminal.enabled')).toBe(true)
    expect(settingsReadonlyReason('agent.tools.terminal.enabled')).toBeUndefined()
    expect(canWriteSettingPath('advanced.logLevel')).toBe(true)
    expect(canWriteSettingPath('agent.tools.workspaceDir')).toBe(true)
    // 工具实际要改的代表性字段：静态字段（含枚举 / 数组 / 数字 / 布尔）都不能被「未知路径」误杀
    for (const path of [
      'llm.active',
      'modes.classroom.classification.autoMove',
      'modes.classroom.schedule.lessons',
      'general.edgeBar.opacity',
      'skills.disabled',
      'mcp.lazyConnect',
      'advanced.logLevel',
    ]) {
      expect(settingsReadonlyReason(path), path).toBeUndefined()
    }
  })

  it('黑名单路径（含其子路径）一律拒绝，并给出中文原因', () => {
    expect(canWriteSettingPath('llm.providers.deepseek.apiKeyEnc')).toBe(false)
    expect(settingsReadonlyReason('llm.providers.deepseek.apiKeyEnc')).toBe(
      '凭据字段不允许通过工具修改',
    )
    expect(canWriteSettingPath('advanced.proxy')).toBe(false)
    expect(settingsReadonlyReason('advanced.proxy')).toContain('代理')
    expect(canWriteSettingPath('general.hotkey')).toBe(false)
    expect(settingsReadonlyReason('general.hotkey')).toContain('快捷键')
    // 前缀本身、以及窗口几何这类动态键路径
    expect(canWriteSettingPath('llm.providers')).toBe(false)
    expect(canWriteSettingPath('version')).toBe(false)
    expect(canWriteSettingPath('general.windowState.chat')).toBe(false)
    expect(canWriteSettingPath('mcp.servers')).toBe(false)
  })

  it('敏感工具确认总闸门不可由 AI 关闭（AI 自我提权，P1）', () => {
    // 它是 agent-host 每次调用即时判断的开关，关掉后 run_command / write_file /
    // 全部 MCP 工具与 set_setting 自身都不再弹确认卡片 → 必须只能由用户在设置页手改
    expect(canWriteSettingPath('advanced.confirmSensitiveTools')).toBe(false)
    expect(settingsReadonlyReason('advanced.confirmSensitiveTools')).toBe(
      '关闭它等于摘掉敏感工具的确认闸门，不允许通过工具修改',
    )
    // 同组其它字段不受影响（别把整个 advanced 分组一起封死）
    expect(canWriteSettingPath('advanced.logLevel')).toBe(true)
  })

  it('引导 / 首次运行 / 开机自启三个前缀不可被悄悄移出黑名单', () => {
    for (const path of ['general.launchAtLogin', 'general.onboarded', 'general.firstRun']) {
      expect(canWriteSettingPath(path), path).toBe(false)
      expect(settingsReadonlyReason(path), path).toBeDefined()
    }
  })

  it('通配 / 畸形路径不是具体路径：一律拒绝，避免「回报成功但配置没改」的假成功（P2）', () => {
    // 工具路径是**具体路径**，`[]` / `*` 只属于 lookupSpec / isDynamicPath 的内部模式语言。
    // 这些路径此前靠 isDynamicPath 的「剥掉尾部 []」被判为可写，实际 Zod 会把意外键 strip 掉。
    expect(canWriteSettingPath('llm.providers[]')).toBe(false)
    expect(settingsReadonlyReason('llm.providers[]')).toBe('未知配置路径')
    expect(canWriteSettingPath('mcp.servers[].envEnc')).toBe(false)
    expect(settingsReadonlyReason('mcp.servers[].envEnc')).toBe('未知配置路径')
    expect(canWriteSettingPath('general.windowState[]')).toBe(false)
    expect(canWriteSettingPath('mcp.servers[].name')).toBe(false)
    // 通配段与畸形段同样拒绝
    expect(canWriteSettingPath('llm.providers.*.model')).toBe(false)
    expect(canWriteSettingPath('llm..providers')).toBe(false)
    expect(canWriteSettingPath('.general.hotkey')).toBe(false)
    // 合法数组叶子路径不能被误伤（仍可写）
    expect(canWriteSettingPath('modes.classroom.schedule.lessons')).toBe(true)
    expect(settingsReadonlyReason('modes.classroom.schedule.lessons')).toBeUndefined()
  })

  it('前缀按路径段匹配，不误伤名字相近的字段', () => {
    // `llm.providerSuffix` 与前缀 `llm.providers` 只是字符级前缀相同、段名不同 → 不算黑名单命中；
    // 它同时也不是 Schema 登记的字段，所以理由是「未知配置路径」而非凭据类原因。
    expect(settingsReadonlyReason('llm.providerSuffix')).toBe('未知配置路径')
    expect(settingsReadonlyReason('versionXxx')).toBe('未知配置路径')
    expect(settingsReadonlyReason('general.windowStateBackup')).toBe('未知配置路径')
  })

  it('拼错路径必须拒绝（Schema 识别不了，防悄悄写进配置）', () => {
    expect(canWriteSettingPath('modes.classrom.typo')).toBe(false)
    expect(settingsReadonlyReason('modes.classrom.typo')).toBe('未知配置路径')
  })
})
