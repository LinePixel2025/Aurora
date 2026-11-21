/**
 * 计划模式运行档（docs/06 §29）。
 *
 * | 状态 | 工具面 | 运行说明 |
 * | --- | --- | --- |
 * | 未进入计划模式 | 只摘掉 `submit_plan` | 无（普通会话行为不变） |
 * | 已进入计划模式 | 只读白名单 + `submit_plan` | PLAN_MODE_CONTEXT |
 *
 * 与 Computer Use / 自动化档位通过 `composeRunProfiles` 合成：`allowedTools` 取交集，
 * 因此计划模式白名单会压过其它档位新增的工具（例如已授权 Computer Use 也拿不到动作工具）。
 */
import { SUBMIT_PLAN_TOOL_NAME, type RunProfile } from '@aurora/agent-core'
import { PLAN_MODE_CONTEXT } from './context.js'
import { PLAN_READONLY_TOOL_NAMES } from './policy.js'

export function planModeRunProfile(input: { active: boolean }): RunProfile {
  if (!input.active) {
    // 普通模式：提交入口永远不可见（工具仍注册在全局表里，供计划模式白名单取用）
    return { hiddenTools: [SUBMIT_PLAN_TOOL_NAME] }
  }
  return {
    allowedTools: [...PLAN_READONLY_TOOL_NAMES, SUBMIT_PLAN_TOOL_NAME],
    runContext: PLAN_MODE_CONTEXT,
  }
}
