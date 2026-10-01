import { describe, expect, it } from 'vitest'
import {
  applyWhitelistedPaths,
  buildClientStatus,
  checkRemotePatch,
  voiceReadiness,
} from './remote-control.js'
import { createDefaultSettings, SETTINGS_READONLY_PREFIXES, type Settings } from '@aurora/shared'

describe('buildClientStatus · 语音能力位（docs/12 §6.4，v0.3.2）', () => {
  /** 给 settings 配一个齐全的 STT / TTS provider 并激活（再按需裁字段） */
  function withVoice(settings: Settings): Settings {
    settings.stt.enabled = true
    settings.stt.active = 's1'
    settings.stt.providers['s1'] = {
      type: 'openai-compat',
      baseUrl: 'https://stt.example.com/v1',
      apiKeyEnc: 'x',
      model: 'whisper-1',
      language: 'zh',
    }
    settings.tts.enabled = true
    settings.tts.active = 't1'
    settings.tts.providers['t1'] = {
      type: 'openai-compat',
      baseUrl: 'https://tts.example.com/v1',
      apiKeyEnc: 'x',
      model: 'tts-1',
      voice: 'alloy',
      speed: 1,
      format: 'mp3',
    }
    return settings
  }

  it('齐全的 provider：voice 两位都 true，快照携带 voice 字段', () => {
    const status = buildClientStatus(withVoice(createDefaultSettings()), '0.3.2', 'win32')
    expect(status.voice).toEqual({ stt: true, tts: true })
  })

  it('门控与渲染层同口径：开关 / active / provider 存在 / 字段齐全，缺一即 false（不查 API Key）', () => {
    // 出厂默认未配置语音：两位都 false
    expect(buildClientStatus(createDefaultSettings(), '0.3.2', 'win32').voice).toEqual({
      stt: false,
      tts: false,
    })

    const settings = withVoice(createDefaultSettings())
    expect(settings.stt.providers['s1']?.apiKeyEnc).not.toBe('') // 门控刻意不查密钥

    // STT 逐项拆：总开关 / active / provider 存在 / baseUrl / model
    const stt = settings.stt
    stt.enabled = false
    expect(voiceReadiness(settings).stt).toBe(false)
    stt.enabled = true
    stt.active = ''
    expect(voiceReadiness(settings).stt).toBe(false)
    stt.active = 'ghost'
    expect(voiceReadiness(settings).stt).toBe(false)
    stt.active = 's1'
    const savedBaseUrl = stt.providers['s1']!.baseUrl
    stt.providers['s1']!.baseUrl = ' '
    expect(voiceReadiness(settings).stt).toBe(false)
    stt.providers['s1']!.baseUrl = savedBaseUrl
    stt.providers['s1']!.model = ''
    expect(voiceReadiness(settings).stt).toBe(false)
    stt.providers['s1']!.model = 'whisper-1'
    expect(voiceReadiness(settings).stt).toBe(true)

    // TTS 同口径，多查 voice 字段
    const tts = settings.tts
    tts.providers['t1']!.voice = ''
    expect(voiceReadiness(settings).tts).toBe(false)
    tts.providers['t1']!.voice = 'alloy'
    expect(voiceReadiness(settings).tts).toBe(true)
  })
})

describe('checkRemotePatch · 远程配置白名单', () => {
  it('白名单内的路径放行（含 agent.tools 子路径）', () => {
    expect(checkRemotePatch({ 'modes.current': 'code' }).ok).toBe(true)
    expect(
      checkRemotePatch({ 'agent.tools.enabled': false, 'agent.tools.search.enabled': true }).ok,
    ).toBe(true)
  })

  it('白名单外整条拒绝并点名首个非法路径', () => {
    const check = checkRemotePatch({ 'modes.current': 'code', 'llm.active': 'evil' })
    expect(check.ok).toBe(false)
    expect(check.forbiddenPath).toBe('llm.active')

    // 远程改权限档位 / 免确认模式 / 快照 = 越权，白名单刻意不含
    expect(checkRemotePatch({ 'agent.permissionMode': 'auto' }).ok).toBe(false)
    expect(checkRemotePatch({ 'agent.tools.terminal.allowPatterns': ['git*'] }).ok).toBe(false)
    expect(checkRemotePatch({ 'center.enabled': true }).ok).toBe(false)
  })

  it('与 set_setting 的只读前缀不冲突：白名单路径必须真的是 AI 也可写的叶子', () => {
    // 一致性护栏：远程白名单里的路径如果哪天被塞进 AI 黑名单，说明两条通道语义漂了
    for (const path of ['modes.current', 'agent.tools.enabled']) {
      expect(SETTINGS_READONLY_PREFIXES.some((prefix) => path.startsWith(prefix))).toBe(false)
    }
  })
})

describe('applyWhitelistedPaths · 补丁落草稿', () => {
  it('逐段下钻写入叶子值', () => {
    const draft = createDefaultSettings()
    expect(
      applyWhitelistedPaths(draft, {
        'modes.current': 'code',
        'agent.tools.enabled': false,
        'agent.tools.terminal.enabled': false,
      }),
    ).toBe(true)
    expect(draft.modes.current).toBe('code')
    expect(draft.agent.tools.enabled).toBe(false)
    expect(draft.agent.tools.terminal.enabled).toBe(false)
  })

  it('非法结构返回 false（不静默半写）', () => {
    const draft = createDefaultSettings()
    expect(applyWhitelistedPaths(draft, { 'modes.current.nope': 'x' })).toBe(false)
  })
})

describe('buildClientStatus · 状态快照', () => {
  it('映射 agent 开关与 center 能力位；老开关 false 时档位按 auto 呈现', () => {
    const settings: Settings = createDefaultSettings()
    const status = buildClientStatus(settings, '0.1.6', 'win32')
    expect(status.mode).toBe(settings.modes.current)
    expect(status.agent.tools.enabled).toBe(true)
    // 出厂默认 = auto（完全权限，2026-09-29 起）
    expect(status.agent.permissionMode).toBe('auto')
    // 用户切回逐次确认：镜像的两条一起写
    settings.agent.permissionMode = 'confirm'
    settings.advanced.confirmSensitiveTools = true
    expect(buildClientStatus(settings, '0.1.6', 'win32').agent.permissionMode).toBe('confirm')
    // 老配置（只有老开关）仍按 auto 承接：这一档是"别再逐次问我"的老语义
    settings.agent.permissionMode = 'readonly'
    settings.advanced.confirmSensitiveTools = false
    expect(buildClientStatus(settings, '0.1.6', 'win32').agent.permissionMode).toBe('readonly')
    settings.agent.permissionMode = 'confirm'
    settings.advanced.confirmSensitiveTools = false
    expect(buildClientStatus(settings, '0.1.6', 'win32').agent.permissionMode).toBe('auto')
  })
})

describe('buildClientStatus · llm 快照（docs/12 §6.3，v0.2.3；v23 起思考等级取模型级）', () => {
  it('取激活 provider 的 model 与 modelParams[model].reasoningEffort；凭据字段绝不进快照', () => {
    const settings: Settings = createDefaultSettings()
    settings.llm.active = 'p1'
    settings.llm.providers['p1'] = {
      type: 'openai-compat',
      baseUrl: 'https://api.example.com/v1',
      apiKeyEnc: '***密文***',
      model: 'gpt-x',
      modelList: ['gpt-x', 'gpt-mini'],
      // v23：思考等级按**模型 id** 键；快照取的是当前 `model` 那一条
      modelParams: {
        'gpt-x': { reasoningEffort: 'high', contextWindow: 0, vision: false },
        'gpt-mini': { reasoningEffort: 'low', contextWindow: 0, vision: false },
      },
    }

    const status = buildClientStatus(settings, '0.2.3', 'win32')
    // 快照**形状不变**（仍只有三个展示字段），只是值来自模型级条目
    expect(status.llm).toEqual({ activeProviderId: 'p1', model: 'gpt-x', reasoningEffort: 'high' })
    // llm 快照只取三个展示字段：baseUrl / apiKeyEnc 不出现在状态快照任何地方
    expect(JSON.stringify(status)).not.toContain('https://api.example.com')
    expect(JSON.stringify(status)).not.toContain('apiKeyEnc')
  })

  it('当前模型在 modelParams 里没有条目时按字段回落 auto（不整条 undefined）', () => {
    const settings: Settings = createDefaultSettings()
    settings.llm.active = 'p1'
    settings.llm.providers['p1'] = {
      type: 'openai-compat',
      baseUrl: 'https://api.example.com/v1',
      apiKeyEnc: 'x',
      model: 'gpt-new',
      modelList: [],
      // 表里只有别的模型 —— 键未命中
      modelParams: { 'gpt-old': { reasoningEffort: 'high', contextWindow: 0, vision: false } },
    }
    expect(buildClientStatus(settings, '0.2.3', 'win32').llm).toEqual({
      activeProviderId: 'p1',
      model: 'gpt-new',
      reasoningEffort: 'auto',
    })
  })

  it('无激活 provider（active 为空 / 指向不存在的 id）时给安全缺省', () => {
    const settings: Settings = createDefaultSettings()
    expect(buildClientStatus(settings, '0.2.3', 'win32').llm).toEqual({
      activeProviderId: '',
      model: '',
      reasoningEffort: 'auto',
    })

    settings.llm.active = 'ghost'
    settings.llm.providers['other'] = {
      type: 'openai-compat',
      baseUrl: 'https://api.example.com/v1',
      apiKeyEnc: 'x',
      model: 'm',
      modelList: [],
      modelParams: { m: { reasoningEffort: 'low', contextWindow: 0, vision: false } },
    }
    expect(buildClientStatus(settings, '0.2.3', 'win32').llm).toEqual({
      activeProviderId: 'ghost',
      model: '',
      reasoningEffort: 'auto',
    })
  })
})
