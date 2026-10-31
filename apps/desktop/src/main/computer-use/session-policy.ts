/**
 * 会话资格判定（docs/06 §28）：哪些会话能持有 Computer Use 授权。
 *
 * 唯一口径，同时被两处消费：
 * - `ComputerUseService.start()` 的执行级校验；
 * - `computerUseRunProfile()` 的请求级隐藏（不合格会话连 Agent 入口工具都看不到）。
 *
 * 不合格的三类：
 * - `auto-` 自动化触发的会话：无人值守，不能把真实桌面交给它；
 * - `awareness-` 文件自感知会话：后台分析，不产生用户可见的操控任务；
 * - `-sub` 子代理会话：并行运行，桌面同一时刻只能有一个指针 / 焦点。
 *
 * 注意这里**不**排除 `center-` 远程会话：设备属主通过 Center 发起的会话与本地会话
 * 同属用户本人，是否允许 Agent 使用 Computer Use 由设置里的总开关决定。
 */
const EXCLUDED_PREFIXES = ['auto-', 'awareness-'] as const

export function canHoldComputerUseSession(sessionId: string): boolean {
  const trimmed = sessionId.trim()
  if (trimmed === '') return false
  if (trimmed.endsWith('-sub')) return false
  return !EXCLUDED_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}
