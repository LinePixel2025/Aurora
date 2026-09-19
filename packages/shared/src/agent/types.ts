/** Agent 内核对外接口（主进程装配 agent-core 时实现；真实循环见 loop/agentLoop.ts）。 */
import type { AgentEvent, SendMessageRequest } from '../ipc/types.js'

export interface AgentHost {
  /** 提交一条用户消息，事件通过 `onEvent` 推送。 */
  send(request: SendMessageRequest): Promise<{ requestId: string }>
  abort(requestId: string): boolean
  onEvent(listener: (event: AgentEvent) => void): () => void
  /** 当前装配是否已接真实内核（P1 为 false：窗口可输入但无对话能力）。 */
  isReady(): boolean
}
