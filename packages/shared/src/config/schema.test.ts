import { describe, expect, it } from 'vitest'
import {
  createDefaultSettings,
  DEFAULT_TOOLCHAIN_CONFIG,
  DEFAULT_TTS,
  PROVIDER_PRESETS,
  TTS_PRESETS,
} from './defaults.js'
import {
  COMPUTER_TOOL_NAMES,
  CONFIG_VERSION,
  DEFAULT_SUBJECT_NAMES,
  LLM_MODEL_PARAM_DEFAULTS,
  MODE_IDS,
  McpServerSchema,
  RESOURCE_NAME_PATTERN,
  RESOURCE_NAME_RULE,
  SETTINGS_READONLY_PREFIXES,
  SettingsSchema,
  TTS_FORMATS,
  canWriteSettingPath,
  debugSchemaSpecs,
  fieldAccepts,
  resolveModelParams,
  schemaPathCount,
  settingsReadonlyReason,
  type LlmProviderConfig,
} from './schema.js'

/** 造一个 v23 形态的 provider：生成参数在 `modelParams.<modelId>` 下，provider 级不再有
 * `temperature` / `reasoningEffort` / `contextWindow` / `vision`（已删 / 已下沉）。 */
function providerWith(modelId: string, params: Record<string, unknown>): LlmProviderConfig {
  return {
    type: 'openai-compat',
    baseUrl: 'https://api.deepseek.com',
    apiKeyEnc: 'enc',
    model: modelId,
    modelParams: { [modelId]: params } as LlmProviderConfig['modelParams'],
  }
}

/** `providerWith` 的判定版：拿一份模型参数跑一次整份配置的 Schema 校验。 */
function acceptsModelParams(params: Record<string, unknown>): boolean {
  const settings = createDefaultSettings()
  settings.llm.providers['deepseek'] = providerWith('deepseek-chat', params)
  return SettingsSchema.safeParse(settings).success
}

/** `resolveModelParams` 的入参构造（用例要造缺字段 / 非法条目，故允许 unknown 表）。 */
function paramsFor(model: string, table: Record<string, unknown>) {
  return { model, modelParams: table as LlmProviderConfig['modelParams'] }
}

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

  it('游戏模式默认开启且是布尔开关（v30）', () => {
    expect(createDefaultSettings().general.gameMode).toEqual({ enabled: true })
    expect(fieldAccepts('general.gameMode.enabled', false)).toBe(true)
    expect(fieldAccepts('general.gameMode.enabled', 'no')).toBe(false)
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
    // 数字字段接受数字、拒绝字符串（v23 起 provider 级 `temperature` 已删除 —— 生成参数下沉到
    // `modelParams.<modelId>`，该路径的取值闸门见本 describe 里的越界用例与缺口用例）
    expect(fieldAccepts('general.edgeBar.opacity', 0.7)).toBe(true)
    expect(fieldAccepts('general.edgeBar.opacity', 'dim')).toBe(false)
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
    // v23：模型参数在 `modelParams.<modelId>` 下。
    // ⚠️ 这条**不是**在验证「类型闸门」—— 该路径是双动态段、`lookupSpec` 查不到登记，
    // `fieldAccepts` 落到「未登记路径默认接受」分支，对**任何**候选值都返回 true
    //（下面两条用例正是把这个缺口钉成了探针）。真正的闸门是 `SettingsSchema`，
    // 见本文件「modelParams 的越界 / 类型错 / 非法枚举值会被 Schema 拒绝」那条。
    // 这里改成断言「路径确实登记在通配表里」，别再拿它当类型校验读。
    expect(debugSchemaSpecs()['llm.providers.*.modelParams.*.contextWindow']).toEqual(['number'])
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

  it('v13 新增字段的逐字段校验（projects / agent.permissionMode）', () => {
    // ⚠️ 上一条对**顶层分组**只做形状层面的校验：`walk()` 对 ZodObject 只递归子键、
    // 不给分组自身登记**类型**（分组路径只进 `objectPaths` —— 标量 / 数组会被形状校验拒掉，P2-26），
    // `lookupSpec('projects')` 仍返回 undefined，所以**值**层面的校验必须断言子路径
    // （否则「配置写坏只剩备份重建」这类问题不会被这层拦到）。
    // `projects.current` 已于 v25 从 Schema 删除（该 helper 对未登记路径默认放行，不在此断言）
    expect(fieldAccepts('projects.list', [])).toBe(true)
    expect(fieldAccepts('projects.list', {})).toBe(false)
    expect(fieldAccepts('projects.maxAgentsBytes', 32768)).toBe(true)
    expect(fieldAccepts('projects.maxAgentsBytes', '32768')).toBe(false)
    // 枚举按值校验：类型对不代表值合法
    expect(fieldAccepts('agent.permissionMode', 'auto')).toBe(true)
    expect(fieldAccepts('agent.permissionMode', 'readonly')).toBe(true)
    expect(fieldAccepts('agent.permissionMode', 'full')).toBe(false)
    expect(fieldAccepts('agent.permissionMode', 42)).toBe(false)
    // v14 写前快照（docs/06 §11.8）
    expect(fieldAccepts('agent.snapshots.enabled', false)).toBe(true)
    expect(fieldAccepts('agent.snapshots.enabled', 'no')).toBe(false)
    expect(fieldAccepts('agent.snapshots.keepPerFile', 5)).toBe(true)
    expect(fieldAccepts('agent.snapshots.keepPerFile', '5')).toBe(false)
    expect(fieldAccepts('agent.snapshots.maxSnapshotBytes', 1024)).toBe(true)
    expect(fieldAccepts('agent.snapshots.totalBudgetBytes', 1048576)).toBe(true)
    // 默认值：够用不夸张，且**默认开启**（用户第一次改文件就该能回滚）
    expect(createDefaultSettings().agent.snapshots).toEqual({
      enabled: true,
      keepPerFile: 20,
      maxSnapshotBytes: 524288,
      totalBudgetBytes: 200 * 1024 * 1024,
    })
    // 越界由 Schema 拒绝（不是"存下来再回退"）
    const bad = createDefaultSettings()
    bad.agent.snapshots.keepPerFile = 0
    expect(SettingsSchema.safeParse(bad).success).toBe(false)
  })

  it('非法字段被识别为非法（供 sanitize 回退默认值）', () => {
    expect(fieldAccepts('general.language', 12)).toBe(false)
    expect(fieldAccepts('general.language', 'x')).toBe(true)
    expect(fieldAccepts('advanced.quietHours', null)).toBe(true)
    expect(fieldAccepts('general.windowState', {})).toBe(true)
  })

  it('modelParams 的越界 / 类型错 / 非法枚举值会被 Schema 拒绝（v23）', () => {
    // 边界值本身合法（上限 2_000_000）
    expect(
      acceptsModelParams({ reasoningEffort: 'auto', contextWindow: 2_000_000, vision: true }),
    ).toBe(true)
    // 越界：contextWindow 上限 2_000_000
    expect(
      acceptsModelParams({ reasoningEffort: 'auto', contextWindow: 9_000_000, vision: false }),
    ).toBe(false)
    expect(acceptsModelParams({ reasoningEffort: 'auto', contextWindow: -1, vision: false })).toBe(
      false,
    )
    // 类型：contextWindow 是数字、vision 是布尔
    expect(
      acceptsModelParams({ reasoningEffort: 'auto', contextWindow: '128k', vision: false }),
    ).toBe(false)
    expect(acceptsModelParams({ reasoningEffort: 'auto', contextWindow: 0, vision: 'yes' })).toBe(
      false,
    )
    // 枚举：reasoningEffort 只认四个等级
    expect(acceptsModelParams({ reasoningEffort: 'ultra', contextWindow: 0, vision: false })).toBe(
      false,
    )
    // 三个子字段**都有默认值**（`auto` / `0` / `false`），所以条目缺字段是合法的、按默认补齐 ——
    // 这点很要紧：`modelParams` 落在 `llm.providers`（`z.record`）之下、字段级回退**不下钻**
    // 这棵子树，一旦有一项是「必填」，手改配置漏写它就会让 `SettingsSchema.parse` 抛错，
    // 走「备份 + 重建出厂配置」（provider / 凭据 / 项目配置一起丢）。宁可回落默认。
    expect(acceptsModelParams({ contextWindow: 0, vision: false })).toBe(true)
    expect(acceptsModelParams({})).toBe(true)
    // 值非法仍然判非法（默认值兜的是"缺"，不是"错"）
    expect(acceptsModelParams({ reasoningEffort: 'ultra' })).toBe(false)
  })

  it('provider 级 temperature 已从 Schema 删除：写进去既不报错也不落库（v23）', () => {
    // 旧字段不是"换了个校验"而是**真的没了**：`LlmProviderSchema` 是非 strict 的 z.object，
    // parse 时未知键被 strip，于是带 temperature 的旧配置不会把整份配置判为损坏。
    const settings = createDefaultSettings()
    const withTemperature = {
      ...providerWith('deepseek-chat', { reasoningEffort: 'auto' }),
      temperature: 9,
    }
    settings.llm.providers['deepseek'] = withTemperature as unknown as LlmProviderConfig
    expect(SettingsSchema.safeParse(settings).success).toBe(true)
    const parsed = SettingsSchema.parse(settings).llm.providers['deepseek']
    expect(parsed).not.toHaveProperty('temperature')
    expect(parsed?.modelParams['deepseek-chat']).toEqual({
      reasoningEffort: 'auto',
      contextWindow: 0,
      vision: false,
    })
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

  it('敏感工具确认开关是布尔，且默认与默认权限档镜像（默认档 auto ⇒ false，P5）', () => {
    // 默认档 2026-09-29 起是 `auto`（完全权限），镜像的老开关因此必须是 false ——
    // 出厂配置自己不能处在「两个字段互相矛盾」的状态（见 defaults.ts 的注释）
    expect(createDefaultSettings().advanced.confirmSensitiveTools).toBe(false)
    expect(createDefaultSettings().agent.permissionMode).toBe('auto')
    expect(fieldAccepts('advanced.confirmSensitiveTools', false)).toBe(true)
    expect(fieldAccepts('advanced.confirmSensitiveTools', 'no')).toBe(false)
  })

  it('思考等级：只接受四个枚举值（枚举按值校验，而非"类型对就放行"）（v5；v23 起在 modelParams 下）', () => {
    const settings = createDefaultSettings()
    settings.llm.providers['deepseek'] = providerWith('deepseek-chat', {
      reasoningEffort: 'high',
      contextWindow: 0,
      vision: false,
    })
    expect(SettingsSchema.safeParse(settings).success).toBe(true)

    for (const level of ['auto', 'low', 'medium', 'high']) {
      expect(
        acceptsModelParams({ reasoningEffort: level, contextWindow: 0, vision: false }),
        level,
      ).toBe(true)
    }
    // 类型对不代表值合法：枚举必须按值校验，否则非法值会活到 parse 把整份配置判为损坏
    expect(acceptsModelParams({ reasoningEffort: 'ultra', contextWindow: 0, vision: false })).toBe(
      false,
    )
    expect(acceptsModelParams({ reasoningEffort: 42, contextWindow: 0, vision: false })).toBe(false)
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
      ...providerWith('deepseek-chat', {
        reasoningEffort: 'auto',
        contextWindow: 0,
        vision: false,
      }),
      modelList: [],
    }
    expect(SettingsSchema.safeParse(settings).success).toBe(true)
    expect(SettingsSchema.parse(settings).llm.providers['deepseek']?.modelList).toEqual([])
  })

  it('电脑操控工具配置：默认值完整、字段路径可校验（v5；Office 工具已并入）', () => {
    expect([...COMPUTER_TOOL_NAMES]).toEqual([
      'run_command',
      'read_file',
      'write_file',
      'edit_file',
      'office_read',
      'office_help',
      'office_create',
      'office_edit',
      'office_render',
      'office_pdf',
      'office_raw_edit',
      'list_dir',
      'open_path',
      'grep',
      'glob',
    ])
    expect(createDefaultSettings().agent.tools).toEqual({
      enabled: true,
      workspaceDir: '',
      terminal: {
        enabled: true,
        timeoutMs: 60_000,
        maxOutputChars: 8000,
        // v12：默认空数组 = 全部逐次确认（不改变 v12 之前的行为）
        allowPatterns: [],
      },
      files: { enabled: true, maxReadBytes: 262_144 },
      // v12：文件检索（grep / glob）
      search: { enabled: true, maxResults: 200 },
      open: { enabled: true, urlMode: 'internal' },
    })

    expect(fieldAccepts('agent.tools.terminal.timeoutMs', 60_000)).toBe(true)
    expect(fieldAccepts('agent.tools.terminal.timeoutMs', 'x')).toBe(false)
    expect(fieldAccepts('agent.tools.enabled', false)).toBe(true)
    expect(fieldAccepts('agent.tools.workspaceDir', 'D:\\工作目录')).toBe(true)
    expect(fieldAccepts('agent.tools.workspaceDir', 123)).toBe(false)
    // v12 新字段：模式列表是字符串数组、检索上限是数字
    expect(fieldAccepts('agent.tools.terminal.allowPatterns', [])).toBe(true)
    expect(fieldAccepts('agent.tools.terminal.allowPatterns', ['git status*'])).toBe(true)
    expect(fieldAccepts('agent.tools.terminal.allowPatterns', 'git status*')).toBe(false)
    expect(fieldAccepts('agent.tools.search.enabled', true)).toBe(true)
    expect(fieldAccepts('agent.tools.search.enabled', 'yes')).toBe(false)
    expect(fieldAccepts('agent.tools.search.maxResults', 200)).toBe(true)
    expect(fieldAccepts('agent.tools.search.maxResults', '200')).toBe(false)
  })

  it('v12 新增字段：默认值本身能通过 Schema 校验（DEFAULT_TOOLCHAIN_CONFIG 即默认配置源）', () => {
    // 直接校验常量本身（而不是 createDefaultSettings 的深拷贝）：默认值漏字段时这里先红
    expect(SettingsSchema.safeParse(DEFAULT_TOOLCHAIN_CONFIG).success).toBe(true)
  })

  it('文件检索（grep / glob）上限越界被 Schema 拒绝（v12）', () => {
    const tooSmall = createDefaultSettings()
    tooSmall.agent.tools.search.maxResults = 0
    expect(SettingsSchema.safeParse(tooSmall).success).toBe(false)

    const tooLarge = createDefaultSettings()
    tooLarge.agent.tools.search.maxResults = 1_001
    expect(SettingsSchema.safeParse(tooLarge).success).toBe(false)

    const patternTooLong = createDefaultSettings()
    patternTooLong.agent.tools.terminal.allowPatterns = ['a'.repeat(201)]
    expect(SettingsSchema.safeParse(patternTooLong).success).toBe(false)

    const tooManyPatterns = createDefaultSettings()
    tooManyPatterns.agent.tools.terminal.allowPatterns = Array.from(
      { length: 101 },
      (_, i) => `cmd${i}`,
    )
    expect(SettingsSchema.safeParse(tooManyPatterns).success).toBe(false)

    // 边界值本身合法
    const ok = createDefaultSettings()
    ok.agent.tools.search.maxResults = 1
    ok.agent.tools.terminal.allowPatterns = ['git status*']
    expect(SettingsSchema.safeParse(ok).success).toBe(true)
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

  it('语音（TTS）配置：默认段与 DEFAULT_TTS 一致、默认无 provider（v7）', () => {
    const tts = createDefaultSettings().tts
    expect(tts).toEqual({
      enabled: true,
      active: '',
      autoRead: false,
      maxChars: 2000,
      providers: {},
    })
    expect(tts).toEqual({ ...DEFAULT_TTS })
    // `active` 为空 = 未配置：对话窗朗读入口不出现（docs/07 §2.3）
    expect(tts.active).toBe('')
    expect(tts.providers).toEqual({})
  })

  it('TTS 预设字段完整（设置页「添加 TTS 模型」的 chips）（v7）', () => {
    expect(TTS_PRESETS.length).toBeGreaterThan(0)
    for (const preset of TTS_PRESETS) {
      expect(preset.baseUrl.startsWith('https://')).toBe(true)
      expect(preset.model.length).toBeGreaterThan(0)
      expect(preset.voice.length).toBeGreaterThan(0)
    }
  })

  it('TTS provider 字段类型与枚举值校验（v7）', () => {
    expect([...TTS_FORMATS]).toEqual(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'])
    expect(fieldAccepts('tts.providers.sf.speed', 1)).toBe(true)
    expect(fieldAccepts('tts.providers.sf.speed', 'fast')).toBe(false)
    expect(fieldAccepts('tts.providers.sf.apiKeyEnc', 'cipher')).toBe(true)
    expect(fieldAccepts('tts.providers.sf.apiKeyEnc', 42)).toBe(false)
    // 枚举必须按值校验：非法格式若被放行，会一路活到 parse 把整份配置判为损坏
    expect(fieldAccepts('tts.providers.sf.format', 'mp3')).toBe(true)
    expect(fieldAccepts('tts.providers.sf.format', 'ogg')).toBe(false)
    expect(fieldAccepts('tts.providers.sf.type', 'openai-compat')).toBe(true)
    expect(fieldAccepts('tts.providers.sf.type', 'azure')).toBe(false)

    const settings = createDefaultSettings()
    settings.tts.providers['sf'] = {
      type: 'openai-compat',
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKeyEnc: 'cipher',
      model: 'FunAudioLLM/CosyVoice2-0.5B',
      voice: 'alex',
      speed: 1,
      format: 'mp3',
    }
    expect(SettingsSchema.safeParse(settings).success).toBe(true)
  })

  it('TTS 越界值被 Schema 拒绝：maxChars 50–4096、speed 0.25–4（v7）', () => {
    const provider = {
      type: 'openai-compat' as const,
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKeyEnc: 'cipher',
      model: 'FunAudioLLM/CosyVoice2-0.5B',
      voice: 'alex',
      speed: 1,
      format: 'mp3' as const,
    }

    const charTooSmall = createDefaultSettings()
    charTooSmall.tts.maxChars = 49
    expect(SettingsSchema.safeParse(charTooSmall).success).toBe(false)

    const charTooLarge = createDefaultSettings()
    charTooLarge.tts.maxChars = 4097
    expect(SettingsSchema.safeParse(charTooLarge).success).toBe(false)

    const speedTooSlow = createDefaultSettings()
    speedTooSlow.tts.providers['sf'] = { ...provider, speed: 0.2 }
    expect(SettingsSchema.safeParse(speedTooSlow).success).toBe(false)

    const speedTooFast = createDefaultSettings()
    speedTooFast.tts.providers['sf'] = { ...provider, speed: 4.5 }
    expect(SettingsSchema.safeParse(speedTooFast).success).toBe(false)

    const unknownFormat = createDefaultSettings()
    unknownFormat.tts.providers['sf'] = { ...provider, format: 'ogg' as unknown as 'mp3' }
    expect(SettingsSchema.safeParse(unknownFormat).success).toBe(false)

    // 边界值本身合法
    const ok = createDefaultSettings()
    ok.tts.maxChars = 50
    ok.tts.providers['sf'] = { ...provider, speed: 0.25, format: 'pcm' }
    expect(SettingsSchema.safeParse(ok).success).toBe(true)
  })

  it('TTS 与聊天 provider 解耦：tts 段独立存在，llm 段不受影响（v7）', () => {
    const settings = createDefaultSettings()
    expect(settings.llm.active).toBe('')
    expect(settings.llm.providers).toEqual({})
    expect(settings.tts.active).toBe('')
    expect(settings.tts.providers).toEqual({})

    settings.llm.providers['deepseek'] = providerWith('deepseek-chat', {
      reasoningEffort: 'auto',
      contextWindow: 0,
      vision: false,
    })
    // 只配了聊天模型时，语音仍然是「未配置」——两者不共用一份 provider
    expect(SettingsSchema.parse(settings).tts.active).toBe('')
    expect(SettingsSchema.parse(settings).tts.providers).toEqual({})
  })

  it('resolveModelParams 是三处消费方的唯一取值口径：命中 / 未命中 / 缺字段都按字段回落（v23）', () => {
    // 命中的模型 → 返回该条目的三项
    expect(
      resolveModelParams(
        paramsFor('deepseek-chat', {
          'deepseek-chat': { reasoningEffort: 'high', contextWindow: 128_000, vision: true },
        }),
      ),
    ).toEqual({ reasoningEffort: 'high', contextWindow: 128_000, vision: true })

    // 未命中（模型不在表里 / `modelParams` 为空）→ 回落默认值，**不是** undefined
    expect(resolveModelParams(paramsFor('ghost', {}))).toEqual(LLM_MODEL_PARAM_DEFAULTS)
    expect(resolveModelParams(paramsFor('ghost', {}))).toEqual({
      reasoningEffort: 'auto',
      contextWindow: 0,
      vision: false,
    })

    // 条目存在但缺字段 → 按字段回落（`reasoningEffort` 保留，另两项取默认），绝不返回 undefined
    const partial = resolveModelParams(paramsFor('a', { a: { reasoningEffort: 'high' } }))
    expect(partial).toEqual({ reasoningEffort: 'high', contextWindow: 0, vision: false })
    expect(partial.contextWindow).toBe(0)
    expect(partial.vision).toBe(false)

    // `modelId` 缺省取 `provider.model`；显式传入时按传入的 id 取
    expect(
      resolveModelParams(
        paramsFor('a', { a: { reasoningEffort: 'low', contextWindow: 1, vision: true } }),
      ),
    ).toEqual({ reasoningEffort: 'low', contextWindow: 1, vision: true })
    expect(
      resolveModelParams(
        paramsFor('a', { b: { reasoningEffort: 'low', contextWindow: 1, vision: true } }),
        'b',
      ),
    ).toEqual({ reasoningEffort: 'low', contextWindow: 1, vision: true })
    // 显式 id 未命中时同样回落（不会偷偷按 `provider.model` 再试一次）
    expect(resolveModelParams(paramsFor('a', { a: { reasoningEffort: 'high' } }), 'other')).toEqual(
      LLM_MODEL_PARAM_DEFAULTS,
    )

    // 手改配置留下的非法值按字段归一（老配置漏迁移的兜底）
    expect(
      resolveModelParams(
        paramsFor('a', { a: { reasoningEffort: 'ultra', contextWindow: '128k', vision: 'yes' } }),
      ),
    ).toEqual(LLM_MODEL_PARAM_DEFAULTS)
    // 默认值与 v22 及更早的 provider 级出厂值逐字相同（本次下沉不改变默认行为）
    expect(LLM_MODEL_PARAM_DEFAULTS).toEqual({
      reasoningEffort: 'auto',
      contextWindow: 0,
      vision: false,
    })
  })

  // v23 的双动态段路径（`llm.providers.*.modelParams.*.<字段>`）现在能被 `lookupSpec` /
  // `lookupEnum` 逐段解析 —— 老实现只会「把具体路径的某一段替换成 `*` / `[]` 再查表」，
  // 一次只替换一段，所以这类路径永远查不到登记项、`fieldAccepts` 一律放行。
  // 这里钉住修复后的行为：**非含点模型 id** 的非法值必须按 Schema 拒绝。
  it('双动态段路径的非法值会被 fieldAccepts 按 Schema 拒绝（lookupSpec 逐段匹配）', () => {
    expect(
      fieldAccepts('llm.providers.deepseek.modelParams.deepseek-chat.contextWindow', '128k'),
    ).toBe(false)
    expect(
      fieldAccepts('llm.providers.deepseek.modelParams.deepseek-chat.reasoningEffort', 'ultra'),
    ).toBe(false)
    // 正对照：合法值仍要放行（别修成「一律拒绝」）
    expect(
      fieldAccepts('llm.providers.deepseek.modelParams.deepseek-chat.contextWindow', 128_000),
    ).toBe(true)
    expect(
      fieldAccepts('llm.providers.deepseek.modelParams.deepseek-chat.reasoningEffort', 'high'),
    ).toBe(true)
    // ⚠️ **含点模型 id 仍是歧义路径**：`gpt-4.1` 在点分路径里会被拆成两段（`gpt-4` / `1`），
    // 段数对不上登记模式，于是仍走「未登记放行」。这是点分路径表示的固有歧义，不是漏修 ——
    // 影响仍然是**惰性**的（`fieldAccepts` 只被 `sanitizeWithDefaults` 使用，而它对
    // `llm.providers`（`z.record`）整体保留候选对象、不下钻这棵子树）。
    // 写入路径的歧义由 `tools/settings-port.ts` 的 `splitSettingPath` 按已知结构还原。
    expect(fieldAccepts('llm.providers.deepseek.modelParams.gpt-4.1.contextWindow', '128k')).toBe(
      true,
    )
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
      '凭据与模型能力事实字段不允许通过工具修改',
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

  it('llm.providers 只放行 model 与 modelParams.*.reasoningEffort：双 * 覆盖表不得退化成整组放行（v23）', () => {
    // 覆盖表是「逐段相等 + 段数一致」（`*` 匹配恰好一段），`llm.providers` 整组在只读前缀里 ——
    // 只有这两条显式放行（调模型行为不碰凭据）；一旦有人把模式写成 `llm.providers.*`，
    // baseUrl / apiKeyEnc / modelList / 整个 modelParams 子树会一起放开。
    expect(
      canWriteSettingPath('llm.providers.deepseek.modelParams.deepseek-chat.reasoningEffort'),
    ).toBe(true)
    expect(
      settingsReadonlyReason('llm.providers.deepseek.modelParams.deepseek-chat.reasoningEffort'),
    ).toBeUndefined()
    expect(canWriteSettingPath('llm.providers.deepseek.model')).toBe(true)

    // temperature 已随 v23 从 Schema 删除：它不再是可写路径（也不是任何路径）
    expect(canWriteSettingPath('llm.providers.deepseek.temperature')).toBe(false)
    // `modelParams` 下的 contextWindow / vision **刻意不登记**（模型能力事实，只读）
    expect(
      canWriteSettingPath('llm.providers.deepseek.modelParams.deepseek-chat.contextWindow'),
    ).toBe(false)
    expect(canWriteSettingPath('llm.providers.deepseek.modelParams.deepseek-chat.vision')).toBe(
      false,
    )
    // 凭据与连接字段仍被前缀拒绝
    expect(canWriteSettingPath('llm.providers.deepseek.baseUrl')).toBe(false)
    expect(canWriteSettingPath('llm.providers.deepseek.apiKeyEnc')).toBe(false)
    expect(canWriteSettingPath('llm.providers.deepseek.modelParams')).toBe(false)
    expect(canWriteSettingPath('llm.providers.deepseek')).toBe(false)

    // 防退化：段数少一段 / 段数对但不是 `modelParams` 这一段，都不得命中断言式前缀匹配
    expect(canWriteSettingPath('llm.providers.deepseek.modelParams.deepseek-chat')).toBe(false)
    expect(canWriteSettingPath('llm.providers.deepseek.other.deepseek-chat.reasoningEffort')).toBe(
      false,
    )
    // v23：**模型 id 里可以有点**（`gpt-4.1` / `claude-3.5-sonnet` 都是常见写法），而路径是按 `.`
    // 切段的 —— 覆盖表用 `**`（一个或多个段）+ 收尾的字面量 `reasoningEffort` 兜住这一类。
    // 用 `*` 的话这些模型的思考等级会变成「文档说可写、实际必被拒」（v22 是 provider 级路径，
    // 而 provider id 禁点，任何模型都能写）。
    expect(canWriteSettingPath('llm.providers.deepseek.modelParams.gpt-4.1.reasoningEffort')).toBe(
      true,
    )
    expect(
      canWriteSettingPath('llm.providers.deepseek.modelParams.claude-3.5-sonnet.reasoningEffort'),
    ).toBe(true)
    // `**` 只在收尾那个字面量段之前生效：含点模型也不能借此写到 contextWindow / vision
    expect(canWriteSettingPath('llm.providers.deepseek.modelParams.gpt-4.1.contextWindow')).toBe(
      false,
    )
    expect(canWriteSettingPath('llm.providers.deepseek.modelParams.gpt-4.1.vision')).toBe(false)
    // `**` 必须吃掉**至少一段**：`…modelParams.reasoningEffort`（少一个模型 id 段）不得命中
    expect(canWriteSettingPath('llm.providers.deepseek.modelParams.reasoningEffort')).toBe(false)

    // 拒绝来自黑名单（而不是「未知配置路径」那条兜底）：说明路径本身是识别的、只是不许写
    expect(
      settingsReadonlyReason('llm.providers.deepseek.modelParams.deepseek-chat.contextWindow'),
    ).toBe('凭据与模型能力事实字段不允许通过工具修改')
    expect(settingsReadonlyReason('llm.providers.deepseek.modelParams.deepseek-chat')).toBe(
      '凭据与模型能力事实字段不允许通过工具修改',
    )
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

  it('只读黑名单的配置自身不可由 AI 修改（自我收紧 / DoS，v15）', () => {
    // AI 往 `advanced.readonlyPrefixes` 里追加路径等于自己收紧自己的可写面（自我 DoS）；
    // 放宽本就不生效（判定从不读用户配置）→ 两个方向都不该让 AI 碰它。
    // 用户仍可在设置页改（settings:update 不经过本黑名单）。
    expect(canWriteSettingPath('advanced.readonlyPrefixes')).toBe(false)
    expect(settingsReadonlyReason('advanced.readonlyPrefixes')).toBe(
      '只读黑名单的配置自身不允许通过工具修改（防自我收紧；放宽本就不生效）',
    )
    expect(settingsReadonlyReason('advanced.readonlyPrefixes')).not.toBe('未知配置路径')
    // 护栏：别误伤同组可写字段与工具目录配置
    expect(canWriteSettingPath('advanced.logLevel')).toBe(true)
    expect(canWriteSettingPath('agent.tools.workspaceDir')).toBe(true)
  })

  it('免确认命令模式列表不可由 AI 读写（自我提权，v12）', () => {
    // 命中即跳过确认卡片：AI 若能自己加一条 `git*`，就等于永久摘掉自己的确认闸门，
    // 与 advanced.confirmSensitiveTools 同级封禁 → 只能由用户在设置页手加
    expect(canWriteSettingPath('agent.tools.terminal.allowPatterns')).toBe(false)
    const reason = settingsReadonlyReason('agent.tools.terminal.allowPatterns')
    expect(reason).toBeDefined()
    expect(reason).toContain('确认闸门')
    // 同一条原因也证明拒绝来自黑名单（而不是「未知配置路径」那条兜底）
    expect(reason).not.toBe('未知配置路径')
    // 同一 terminal 组里的其它字段仍可写（别把整个 terminal 分组一起封死）
    expect(canWriteSettingPath('agent.tools.terminal.enabled')).toBe(true)
    expect(canWriteSettingPath('agent.tools.terminal.timeoutMs')).toBe(true)
  })

  it('项目分组不可由 AI 读写（切项目 = 改指令面与权限面，v13）', () => {
    // 项目根同时决定「注入给模型的 AGENTS.md」与「权限层认定的边界」，
    // 让 AI 自己切项目等于让它改自己的指令面与权限面 → 整组封禁
    expect(canWriteSettingPath('projects')).toBe(false)
    expect(canWriteSettingPath('projects.current')).toBe(false)
    expect(canWriteSettingPath('projects.list')).toBe(false)
    expect(canWriteSettingPath('projects.maxAgentsBytes')).toBe(false)
    const reason = settingsReadonlyReason('projects.current')
    expect(reason).toContain('权限边界')
    // 拒绝来自黑名单，而不是「未知配置路径」那条兜底
    expect(reason).not.toBe('未知配置路径')
  })

  it('三档权限不可由 AI 读写（自我提权，v13）', () => {
    expect(canWriteSettingPath('agent.permissionMode')).toBe(false)
    const reason = settingsReadonlyReason('agent.permissionMode')
    expect(reason).toContain('确认闸门')
    expect(reason).not.toBe('未知配置路径')
    // 同一 agent 组里的工具字段仍可写（别把整个 agent 分组一起封死）
    expect(canWriteSettingPath('agent.tools.enabled')).toBe(true)
  })

  it('Work 工作目录不可由 AI 改写（权限边界根的一级，P1-01）', () => {
    // 它是 `boundaryRoot` 回落链的一级：AI 改写它 = 把 confirm 档「根内免确认」
    // 扩到任意目录（与 `projects` 整组拉黑同构的自我提权）。
    // 此前它登记在 `WRITABLE_PATH_OVERRIDES` 里（覆盖表判定先于黑名单 → 双重放行）；
    // 注意只删覆盖表登记**不够** —— 会落回「Schema 登记过即默认可写」。
    expect(canWriteSettingPath('modes.work.workspaceDir')).toBe(false)
    const reason = settingsReadonlyReason('modes.work.workspaceDir')
    expect(reason).toContain('权限边界')
    // 拒绝来自黑名单，而不是「未知配置路径」那条兜底
    expect(reason).not.toBe('未知配置路径')
    // 只收紧这一个路径：modes 组内其余字段仍可写
    expect(canWriteSettingPath('modes.current')).toBe(true)
    expect(canWriteSettingPath('modes.work.guideCompleted')).toBe(true)
    expect(canWriteSettingPath('modes.classroom.preClassLeadMinutes')).toBe(true)
  })

  it('tts / stt / imagegen 的非凭据叶子可写，凭据子树仍拒绝（P1-06 / AGENTS.md 口径）', () => {
    // 覆盖表登记了这些叶子（工具描述与 settingsHint 也向模型承诺可写），
    // 若它们被判不可写就是「说能改但不能改」；反过来凭据子树不能因新放行被带开。
    for (const path of [
      'tts.enabled',
      'tts.active',
      'tts.autoRead',
      'tts.maxChars',
      'stt.enabled',
      'stt.active',
      'imagegen.enabled',
      'imagegen.active',
    ]) {
      expect(canWriteSettingPath(path), path).toBe(true)
      expect(settingsReadonlyReason(path), path).toBeUndefined()
    }
    expect(canWriteSettingPath('tts.providers')).toBe(false)
    expect(canWriteSettingPath('tts.providers.siliconflow.apiKey')).toBe(false)
    expect(canWriteSettingPath('stt.providers')).toBe(false)
    expect(canWriteSettingPath('stt.providers.openai.apiKeyEnc')).toBe(false)
    expect(canWriteSettingPath('imagegen.providers')).toBe(false)
    expect(canWriteSettingPath('imagegen.providers.openai.baseUrl')).toBe(false)
    expect(settingsReadonlyReason('tts.providers.siliconflow.apiKey')).toBe(
      '凭据字段不允许通过工具修改',
    )
  })

  it('agent.loop / agent.snapshots 进黑名单（放大预算与关快照均系自我提权）', () => {
    // 循环预算：AI 给自己放大轮次 / token 上限 = 绕过"该停下来问用户"的闸门；
    // 写前快照：AI 关掉 enabled 或压低预算 = 拆掉写文件后的回滚保险。
    // 两者此前"不在黑名单也不在覆盖表"看似不可写，实际默认可写——本轮封进黑名单才对得上文档意图。
    for (const path of [
      'agent.loop',
      'agent.loop.maxRounds',
      'agent.loop.maxTotalTokens',
      'agent.loop.autoContinueRounds',
      'agent.snapshots',
      'agent.snapshots.enabled',
      'agent.snapshots.keepPerFile',
      'agent.snapshots.maxSnapshotBytes',
      'agent.snapshots.totalBudgetBytes',
    ]) {
      expect(canWriteSettingPath(path), path).toBe(false)
      const reason = settingsReadonlyReason(path)
      expect(reason, path).toMatch(/不允许/)
      // 拒绝来自黑名单，而不是「未知配置路径」那条兜底
      expect(reason).not.toBe('未知配置路径')
    }
    // 回归护栏：覆盖表内的 agent.tools.* 不受牵连（别误伤既定可写面）
    expect(canWriteSettingPath('agent.tools.enabled')).toBe(true)
    expect(canWriteSettingPath('agent.tools.workspaceDir')).toBe(true)
  })

  it('文件检索（grep / glob）的开关与上限对 AI 开放（v12）', () => {
    expect(canWriteSettingPath('agent.tools.search.enabled')).toBe(true)
    expect(settingsReadonlyReason('agent.tools.search.enabled')).toBeUndefined()
    expect(canWriteSettingPath('agent.tools.search.maxResults')).toBe(true)
    expect(settingsReadonlyReason('agent.tools.search.maxResults')).toBeUndefined()
  })

  it('外观四件套对 AI 开放（v32：主题 / 强调色 / 毛玻璃；v33：流光特效）', () => {
    // 覆盖表登记了这四条（`set_setting` 工具描述、settingsHint 与 `set_appearance` 都向模型
    // 承诺可写），任一条被判不可写就是「说能改但不能改」。
    for (const path of [
      'appearance.theme',
      'appearance.accent',
      'appearance.glass',
      'appearance.awarenessGlow',
    ]) {
      expect(canWriteSettingPath(path), path).toBe(true)
      expect(settingsReadonlyReason(path), path).toBeUndefined()
    }
    // 负对照：整组仍不是无差别放行 —— 不存在的子路径要落到「未知配置路径」那条兜底
    expect(canWriteSettingPath('appearance.unknown')).toBe(false)
    expect(settingsReadonlyReason('appearance.unknown')).toBe('未知配置路径')
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

  it('TTS 凭据路径不可由 AI 读写，且不牵连 tts 的其它字段（v7）', () => {
    // `tts.providers` 含 safeStorage 密文，与 llm.providers / mcp.servers 同级封禁
    expect(canWriteSettingPath('tts.providers.sf.apiKeyEnc')).toBe(false)
    expect(settingsReadonlyReason('tts.providers.sf.apiKeyEnc')).toBe('凭据字段不允许通过工具修改')
    expect(canWriteSettingPath('tts.providers')).toBe(false)
    expect(canWriteSettingPath('tts.providers.sf.model')).toBe(false)
    // 同段里的非凭据字段仍可写（别把整个 tts 分组一起封死）
    expect(canWriteSettingPath('tts.enabled')).toBe(true)
    expect(canWriteSettingPath('tts.active')).toBe(true)
    expect(canWriteSettingPath('tts.autoRead')).toBe(true)
    expect(canWriteSettingPath('tts.maxChars')).toBe(true)
    // 段名相近的字段不被误伤（`tts.providerSuffix` 不是 `tts.providers` 的子路径）
    expect(settingsReadonlyReason('tts.providerSuffix')).toBe('未知配置路径')
  })
})

describe('资源名称约定（P1-07，docs/08 §1.3）', () => {
  it('MCP 服务器名称禁用 `.`：含点被拒，字母数字下划线连字符通过', () => {
    // 名称是凭据路径的段（`mcp.servers.<name>.env.<KEY>`），`.` 是路径分隔符；
    // 放行含点名称 = 服务器行落库而 env 明文丢失（见 docs/08 §1.3）。
    const base = {
      transport: 'stdio' as const,
      command: 'npx',
      args: [],
      envEnc: {},
      headersEnc: {},
      enabled: true,
    }
    expect(McpServerSchema.safeParse({ ...base, name: 'my.server' }).success).toBe(false)
    expect(McpServerSchema.safeParse({ ...base, name: 'api.deepseek' }).success).toBe(false)
    expect(McpServerSchema.safeParse({ ...base, name: '' }).success).toBe(false)
    // 合法名称（连字符 / 下划线 / 数字；设置页预设与 smoke 夹具都是这种形态）
    for (const name of ['my-server', 'my_server', 'smoke-mcp-123', 'deepseek']) {
      expect(McpServerSchema.safeParse({ ...base, name }).success, name).toBe(true)
    }
    // 常量本身与提示文案是单一来源，且约定就是「禁点」
    expect(RESOURCE_NAME_PATTERN.test('a.b')).toBe(false)
    expect(RESOURCE_NAME_PATTERN.test('a-b_c1')).toBe(true)
    expect(RESOURCE_NAME_RULE).toContain('不能含')
  })
})
