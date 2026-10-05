/**
 * 请求级 Agent 工作分组（桌面 MessageList 与 Center MessageStream 共用）。
 *
 * 一次用户请求会留下多条助手消息（工具轮正文、工具卡、最终结论）。本模块只做
 * **纯分组**，不改消息、不决定展示状态：
 * - 相邻助手消息只要 `requestId` 相同（任一侧缺省时按相邻关系兼容旧历史）归为一组；
 * - 用户 / 系统 / 其它条目保持原位，并切断助手分组；
 * - 同一请求被用户消息隔开时绝不跨边界合并。
 */

export interface AgentTurnItemLike {
  id: string
  role?: string
  kind?: string
  requestId?: string
}

export type AgentTurnRow<T> =
  | { kind: 'message'; message: T }
  | {
      kind: 'turn'
      key: string
      requestId?: string
      messages: readonly T[]
    }

function itemRole(item: AgentTurnItemLike): string {
  return item.role ?? item.kind ?? ''
}

/**
 * 把消息列表切成「普通条目 + 请求级助手组」。
 *
 * `key` 对新请求使用 `request:<requestId>`；旧历史没有 requestId 时使用
 * `legacy:<首条 id>:<条数>`，同一份历史重复渲染时保持稳定。
 */
export function groupAgentTurns<T extends AgentTurnItemLike>(
  items: readonly T[],
): AgentTurnRow<T>[] {
  const rows: AgentTurnRow<T>[] = []
  let current: T[] = []

  const flush = (): void => {
    if (current.length === 0) return
    const requestId = current[0]?.requestId
    const first = current[0]
    rows.push({
      kind: 'turn',
      key:
        requestId === undefined
          ? `legacy:${first?.id ?? ''}:${current.length}`
          : `request:${requestId}`,
      ...(requestId === undefined ? {} : { requestId }),
      messages: current,
    })
    current = []
  }

  for (const item of items) {
    if (itemRole(item) !== 'assistant') {
      flush()
      rows.push({ kind: 'message', message: item })
      continue
    }
    const headRequestId = current[0]?.requestId
    const nextRequestId = item.requestId
    if (
      headRequestId !== undefined &&
      nextRequestId !== undefined &&
      headRequestId !== nextRequestId
    ) {
      flush()
    }
    current.push(item)
  }
  flush()
  return rows
}

/** 最终结论：请求内最后一条正文非空的助手消息；没有正文时返回 undefined。 */
export function selectFinalAssistant<T extends { content: string }>(
  messages: readonly T[],
): T | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== undefined && message.content.trim() !== '') return message
  }
  return undefined
}

/** 请求级总用时文案；非法 / 负值返回空串，由调用方决定省略。 */
export function formatTurnDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return ''
  const seconds = durationMs / 1000
  return seconds < 0.1 ? '<0.1s' : `${seconds.toFixed(1)}s`
}
