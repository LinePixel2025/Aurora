/**
 * 自动化会话的「运行档」（v20，docs/13 §7.1、docs/06 §5.2）。
 *
 * 自动化触发的 Agent 会话与交互式会话有两条**硬差别**，都在这里表达：
 *
 * ① **没人在旁边回答** —— 交互式人设（`BASE_PERSONA`）的第一条应对策略是
 *    「缺少信息时先问一个最关键的问题」，而那在无人值守场景下等于把任务挂死
 *    （提问会超时按跳过继续，用户第二天才看到）。因此人设整个替换掉，
 *    并注入「## 本次运行」小节说清"现在是什么场景、该怎么收尾"。
 * ② **它不得再管理 / 触发自动化** —— 否则「自动化 → 会话 → 自动化」是可自我延续的
 *    闭环（AI 给自己排程）。工具面按运行来源摘掉写类工具（`hiddenTools`），
 *    执行层另有一道拒绝（`tools/automation-tools.ts`）——两道都在，缺一不可：
 *    摘除让模型**看不见**（不浪费轮次反复试），拒绝保证**即使被绕过也执行不了**。
 *
 * 只读的 `automation_list` / `automation_history` 保留：它们是纯读元数据、没有副作用，
 * 而且"看看我这次属于哪条自动化"对模型理解任务有帮助（同只读档保留这两个工具的口径）。
 */
import type { RunProfile } from '@aurora/agent-core'
import { isAutomationSession } from './session-id.js'
import { AUTOMATION_WRITE_TOOL_NAMES } from '../tools/automation-tools.js'

/**
 * 自动化会话的人设：替换 `BASE_PERSONA`（不是追加）。
 *
 * 保留"你是 Aurora / 用中文回复 / 不编造未执行的步骤"这三条身份与诚实性约定 ——
 * 变的只有交互模型：从"问清楚再动手"改成"自己查证、自己决定、做完汇报"。
 */
export const AUTOMATION_PERSONA = [
  '你是 Aurora 的后台执行体：由一条自动化任务在无人值守时唤醒，独立完成它交代的事。',
  '直接动手：用工具查证、执行、验证；不要反问、不要等用户回话（触发者此刻不在场）。',
  '用中文汇报结果；不要编造未执行的步骤，没做成的部分要如实说明。',
].join('\n')

/** 「## 本次运行」小节正文：无人值守场景下的行为约束（与工具面摘除互为呼应）。 */
export const AUTOMATION_RUN_CONTEXT = [
  '本次运行由自动化触发，没有人在对话框前等你回话，因此：',
  '- 任务指令就是全部需求，能自己决定的就自己决定，不要问「你希望我怎么做」。',
  '- 不要新建 / 修改 / 删除 / 触发任何自动化 —— 自动化不能自我延续；需要改自动化请留给用户。',
  '- 破坏性操作仍走确认卡片；无人应答会按拒绝处理，那就改走安全路径，或如实说明本次没做成。',
  '- 收尾时用一段话讲清：做了什么、结果如何、哪些没做成。',
].join('\n')

/**
 * 判断一个会话是不是自动化会话。
 *
 * 判据在 `session-id.ts`（前缀 `auto-`）：前缀标记在会话数据里是持久的 ——
 * 进程重启后自动化会话仍然是自动化会话，而"这次请求带没带 origin"只在当次 `send` 里
 * 成立（历史消息回放、续跑都可能不带）。这里只做转发，不复制第二份判据。
 */
export { isAutomationSession }

/**
 * 本次请求要不要按自动化档跑：`origin` 或会话 id 任一命中即算。
 *
 * 为什么要两个判据：`origin` 是引擎在 `send` 时明确声明的（当次请求最权威），
 * 会话 id 是持久的兜底（续跑 / 远程补发 / 将来别的入口用同一个会话再发消息时，
 * `origin` 可能不再是 `'automation'`，但那条会话依然不能碰自动化）。
 */
export function isAutomationRun(context: { sessionId: string; origin: string }): boolean {
  return context.origin === 'automation' || isAutomationSession(context.sessionId)
}

/** 自动化运行档（非自动化会话返回 `undefined` = 与普通会话逐字一致）。 */
export function automationRunProfile(context: {
  sessionId: string
  origin: string
}): RunProfile | undefined {
  if (!isAutomationRun(context)) return undefined
  return {
    persona: AUTOMATION_PERSONA,
    runContext: AUTOMATION_RUN_CONTEXT,
    hiddenTools: AUTOMATION_WRITE_TOOL_NAMES,
  }
}
