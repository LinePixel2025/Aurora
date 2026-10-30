import { COMPUTER_USE_TOOL_NAMES } from '@aurora/agent-core'
import { describe, expect, it } from 'vitest'
import {
  COMPUTER_USE_RUN_CONTEXT,
  COMPUTER_USE_UNAUTHORIZED_CONTEXT,
  composeRunProfiles,
  computerUseRunProfile,
} from './run-profile.js'

describe('Computer Use run profile', () => {
  it('总开关关闭时完全不介入', () => {
    expect(
      computerUseRunProfile({ enabled: false, vision: true, authorized: true }),
    ).toBeUndefined()
  })

  it('非视觉模型隐藏工具（即使全局 vision 开着）', () => {
    const profile = computerUseRunProfile({ enabled: true, vision: false, authorized: true })
    expect(profile?.hiddenTools).toEqual(COMPUTER_USE_TOOL_NAMES)
  })

  it('未授权隐藏工具并提示入口', () => {
    const profile = computerUseRunProfile({ enabled: true, vision: true, authorized: false })
    expect(profile?.hiddenTools).toEqual(COMPUTER_USE_TOOL_NAMES)
    expect(profile?.runContext).toBe(COMPUTER_USE_UNAUTHORIZED_CONTEXT)
  })

  it('授权后不隐藏并注入运行说明', () => {
    const profile = computerUseRunProfile({ enabled: true, vision: true, authorized: true })
    expect(profile?.hiddenTools).toBeUndefined()
    expect(profile?.runContext).toBe(COMPUTER_USE_RUN_CONTEXT)
  })

  it('组合运行档：上下文拼接、hiddenTools 并集、allowedTools 交集', () => {
    const merged = composeRunProfiles(
      { persona: 'auto', allowedTools: ['a', 'b'], hiddenTools: ['x'] },
      { runContext: 'ctx', allowedTools: ['b', 'c'], hiddenTools: ['y'] },
      { hiddenTools: ['x', 'z'] },
    )
    expect(merged?.persona).toBe('auto')
    expect(merged?.runContext).toBe('ctx')
    expect(merged?.allowedTools).toEqual(['b'])
    expect(merged?.hiddenTools).toEqual(['x', 'y', 'z'])
  })
})
