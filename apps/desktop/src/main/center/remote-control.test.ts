import { describe, expect, it } from 'vitest'
import { buildClientStatus, checkRemotePatch, applyWhitelistedPaths } from './remote-control.js'
import { createDefaultSettings, SETTINGS_READONLY_PREFIXES, type Settings } from '@aurora/shared'

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
  it('映射 agent 开关与 center 能力位；confirmSensitiveTools=false 时档位按 auto 呈现', () => {
    const settings: Settings = createDefaultSettings()
    const status = buildClientStatus(settings, '0.1.6', 'win32')
    expect(status.mode).toBe(settings.modes.current)
    expect(status.agent.tools.enabled).toBe(true)
    expect(status.agent.permissionMode).toBe('confirm')
    settings.advanced.confirmSensitiveTools = false
    expect(buildClientStatus(settings, '0.1.6', 'win32').agent.permissionMode).toBe('auto')
  })
})
