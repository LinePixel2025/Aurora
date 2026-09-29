/**
 * 自动化会话的 id 约定（v20；docs/13 §7）。
 *
 * 单独一个小模块而不放在 `engine.ts` 里：`run-profile.ts`（按来源定制提示词与工具面）
 * 与 `tools/automation-tools.ts`（执行层拒绝）都要用这个判据，而两者都不该为了一个
 * 字符串常量去 import 整个引擎（引擎 import 了 store / actions / conditions，
 * 反向依赖会绕成环）。
 */

/** Agent 会话 / 运行记录的 id 前缀（渲染层据此把 auto- 会话排除在左栏之外） */
export const AUTOMATION_SESSION_PREFIX = 'auto'

/**
 * 判断一个会话是不是自动化会话。
 *
 * 判据是**会话 id 前缀**（`auto-`，与引擎生成的 runId / sessionId 同源）：前缀标记在
 * 会话数据里是持久的 —— 进程重启后自动化会话仍然是自动化会话，而"这次请求带没带
 * origin"只在当次 `send` 里成立（历史回放、续跑、远程补发都可能不带）。
 * `-sub` 后缀（task 子代理会话）也命中：子代理继承父会话的边界（docs/06 §19）。
 *
 * 用户自建会话不会撞上这个前缀：id 由 `SessionStore.createSession`（`chat-<ts36>-<n>`）、
 * `quick`、`center-<…>`、`auto-<ts36>-<n>` 这四条路径产生。
 */
export function isAutomationSession(sessionId: string): boolean {
  return (
    sessionId === AUTOMATION_SESSION_PREFIX || sessionId.startsWith(`${AUTOMATION_SESSION_PREFIX}-`)
  )
}
