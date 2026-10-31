import {
  COMPUTER_USE_ALL_TOOL_NAMES,
  COMPUTER_USE_START_TOOL_NAME,
  COMPUTER_USE_TOOL_NAMES,
} from '@aurora/agent-core'
import { describe, expect, it } from 'vitest'
import {
  COMPUTER_USE_RUN_CONTEXT,
  COMPUTER_USE_UNAUTHORIZED_CONTEXT,
  composeRunProfiles,
  computerUseRunProfile,
} from './run-profile.js'

const base = { enabled: true, vision: true, authorized: false, eligible: true } as const

describe('Computer Use run profile', () => {
  it('总开关关闭时完全不介入', () => {
    expect(computerUseRunProfile({ ...base, enabled: false, authorized: true })).toBeUndefined()
  })

  it('非视觉模型隐藏整组工具（含 Agent 入口）', () => {
    const profile = computerUseRunProfile({ ...base, vision: false, authorized: true })
    expect(profile?.hiddenTools).toEqual(COMPUTER_USE_ALL_TOOL_NAMES)
  })

  it('不合格会话（自动化 / 自感知 / 子代理）隐藏整组工具（含入口）', () => {
    const profile = computerUseRunProfile({ ...base, eligible: false, authorized: false })
    expect(profile?.hiddenTools).toEqual(COMPUTER_USE_ALL_TOOL_NAMES)
  })

  it('未授权：只留 Agent 入口工具，并提示自行进入', () => {
    const profile = computerUseRunProfile(base)
    expect(profile?.hiddenTools).toEqual(COMPUTER_USE_TOOL_NAMES)
    expect(profile?.hiddenTools).not.toContain(COMPUTER_USE_START_TOOL_NAME)
    expect(profile?.runContext).toBe(COMPUTER_USE_UNAUTHORIZED_CONTEXT)
    expect(profile?.runContext).toContain('computer_start')
    // v39.1：进入后**同一次请求的下一轮**就可用，且不许与入口同轮批量
    expect(profile?.runContext).toContain('同一次请求的下一轮')
    expect(profile?.runContext).toContain('不要在同一轮')
  })

  it('已授权：动作工具 + 退出工具可见，入口摘掉，并注入退出约定', () => {
    const profile = computerUseRunProfile({ ...base, authorized: true })
    expect(profile?.hiddenTools).toEqual([COMPUTER_USE_START_TOOL_NAME])
    expect(profile?.runContext).toBe(COMPUTER_USE_RUN_CONTEXT)
    expect(profile?.runContext).toContain('computer_stop')
    // v39.1：批量执行 / 每步 next / 不逐动作等待
    expect(profile?.runContext).toContain('2–4 个动作')
    expect(profile?.runContext).toContain('`next`')
    expect(profile?.runContext).toContain('computer_wait')
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
