/** Agent 内核对外接口（主进程装配 agent-core 时实现；真实循环见 loop/agentLoop.ts）。 */
import type { AgentEvent, SendMessageRequest } from '../ipc/types.js'

/**
 * 手动压缩（`/compact`，2026-10-03，docs/06 §4）的结局：**不抛错**——压缩失败不是
 * 异常路径，渲染层要把原因原样展示给用户，做成带 `ok` 标记的结果更诚实。
 */
export type AgentCompactOutcome =
  { ok: true; summaryChars: number; coveredMessages: number } | { ok: false; error: string }

export interface AgentHost {
  /** 提交一条用户消息，事件通过 `onEvent` 推送。 */
  send(request: SendMessageRequest): Promise<{ requestId: string }>
  abort(requestId: string): boolean
  onEvent(listener: (event: AgentEvent) => void): () => void
  /** 当前装配是否已接真实内核（P1 为 false：窗口可输入但无对话能力）。 */
  isReady(): boolean
  /** 该会话是否正在跑请求（`/compact` 的 E_BUSY 判定；`KernelAgentHost.isBusy`）。 */
  isBusy(sessionId: string): boolean
  /**
   * 手动压缩会话上下文（`/compact`，docs/06 §4）：把全部消息压成摘要写进 `meta.compact`，
   * 此后组装请求只取压缩点之后的消息。**不抛错**：结局用 `AgentCompactOutcome` 表达。
   */
  compact(sessionId: string): Promise<AgentCompactOutcome>
}
