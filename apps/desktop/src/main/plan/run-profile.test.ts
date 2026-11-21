import { describe, expect, it } from 'vitest'
import { SUBMIT_PLAN_TOOL_NAME } from '@aurora/agent-core'
import { composeRunProfiles, computerUseRunProfile } from '../computer-use/run-profile.js'
import { planModeRunProfile } from './run-profile.js'
import { PLAN_DENIED_TOOL_NAMES, PLAN_READONLY_TOOL_NAMES } from './policy.js'

describe('planModeRunProfile（docs/06 §29 只读工具面）', () => {
  it('未进入计划模式：只隐藏 submit_plan，不裁剪工具集', () => {
    const profile = planModeRunProfile({ active: false })
    expect(profile.hiddenTools).toEqual([SUBMIT_PLAN_TOOL_NAME])
    expect(profile.allowedTools).toBeUndefined()
    expect(profile.runContext).toBeUndefined()
  })

  it('进入计划模式：白名单 = 只读名单 + submit_plan，且带运行说明', () => {
    const profile = planModeRunProfile({ active: true })
    expect(profile.allowedTools).toEqual([...PLAN_READONLY_TOOL_NAMES, SUBMIT_PLAN_TOOL_NAME])
    expect(profile.runContext).toContain('Plan Mode')
    expect(profile.runContext).toContain('submit_plan')
  })

  it('禁止工具一个都不在白名单里（含 task / run_command / 写盘 / Computer Use）', () => {
    const allowed = new Set(planModeRunProfile({ active: true }).allowedTools ?? [])
    for (const name of PLAN_DENIED_TOOL_NAMES) expect(allowed.has(name)).toBe(false)
    for (const name of [
      'task',
      'run_command',
      'write_file',
      'edit_file',
      'set_setting',
      'browser_act',
      'mcp.foo.bar',
      'plugin.x.y',
    ]) {
      expect(allowed.has(name)).toBe(false)
    }
  })

  it('与 Computer Use 档位合成：allowedTools 取交集，计划模式压过新增动作工具', () => {
    const composed = composeRunProfiles(
      planModeRunProfile({ active: true }),
      computerUseRunProfile({
        enabled: true,
        vision: true,
        authorized: true,
        eligible: true,
      }),
    )
    expect(composed?.allowedTools).toBeDefined()
    expect(composed?.allowedTools).toContain('read_file')
    expect(composed?.allowedTools).toContain(SUBMIT_PLAN_TOOL_NAME)
    expect(composed?.allowedTools).not.toContain('computer_mouse')
    expect(composed?.runContext).toContain('Plan Mode')
  })
})
