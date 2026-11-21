/**
 * `submit_plan` 装配器（docs/06 §29）。
 *
 * 与 `set_setting` / 扩展工具同级：**不受 `agent.tools.enabled` 门控**（它写的是会话计划，
 * 不是本机文件）。工具注册是进程级的，普通会话靠 `planModeRunProfile` 的
 * `hiddenTools` 把它摘出请求工具面；计划模式再经白名单放回来。
 *
 * 不参与 `syncToolRegistries()`：没有设置开关可热改，注册一次即可；其它装配器的
 * `sync()` 只 `unregister` 自己的名字，不会把它顺手摘掉。
 */
import type { Logger } from '@aurora/shared'
import {
  SUBMIT_PLAN_TOOL_NAME,
  createSubmitPlanTool,
  type SubmitPlanPort,
  type ToolRegistry,
} from '@aurora/agent-core'

export const PLAN_TOOL_NAMES = [SUBMIT_PLAN_TOOL_NAME] as const

export interface PlanToolDeps {
  tools: ToolRegistry
  logger: Logger
  port: SubmitPlanPort
}

export function registerPlanTool(deps: PlanToolDeps): void {
  // 幂等：重复装配（热重载 / 单测）时先摘再注册，避免同一工具出现两条
  for (const name of PLAN_TOOL_NAMES) deps.tools.unregister(name)
  deps.tools.register(createSubmitPlanTool(deps.port))
  deps.logger.info('已注册计划工具', { names: [...PLAN_TOOL_NAMES] })
}
