/**
 * 会话历史 → LLM 消息转换与截断（docs/06 §4）。
 *
 * 截断规则：按字符上限从**最旧**开始丢弃，但必须保证
 * 「assistant(toolCalls) + 其全部 tool 结果」成对保留 ——
 * 只留一半会让 OpenAI 兼容服务直接拒绝请求（tool_call_id 无对应调用）。
 */
import type { ChatRequestMessage } from '../llm/types.js'
import type { StoredMessage } from './types.js'

/** 默认上下文预算（字符数，v1 用字符而非真实 token 计数，见 docs/06 §4） */
export const DEFAULT_MAX_CHARS = 60_000

/** 默认保留的最大消息条数（防单文件无限增长） */
export const DEFAULT_MAX_MESSAGES = 2_000

export interface TruncateOptions {
  /** 字符预算；<= 0 表示不截断 */
  maxChars?: number
  /** 条数上限；<= 0 表示不限制 */
  maxMessages?: number
}

export interface TruncateResult {
  messages: StoredMessage[]
  /** 被丢弃的消息条数 */
  dropped: number
  /** 是否发生了截断 */
  truncated: boolean
}

/** 消息在上下文里的粗算长度（content + 工具参数） */
function messageWeight(message: StoredMessage): number {
  return message.content.length
}

/**
 * 找到工具调用组的**宿主**下标。
 *
 * 返回 `null` 表示这条 `tool` 消息是孤儿（没有对应的 assistant 调用），
 * 这类消息必须整条丢弃：只留工具结果而丢了发起它的调用，
 * OpenAI 兼容服务会直接拒绝请求。
 */
function toolCallOwner(messages: readonly StoredMessage[], index: number): number | null {
  const message = messages[index]
  if (message === undefined || message.role !== 'tool') return null
  if (message.toolCallId === undefined) return null
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = messages[cursor]
    if (candidate === undefined) break
    if (candidate.role === 'user') break
    if (candidate.role !== 'assistant') continue
    const calls = candidate.toolCalls ?? []
    if (calls.some((item) => item.id === message.toolCallId)) return cursor
  }
  return null
}

/** 一条消息所属工具组的起始下标（非工具消息即其自身） */
function groupHead(messages: readonly StoredMessage[], index: number): number {
  const owner = toolCallOwner(messages, index)
  return owner ?? index
}

/**
 * 截断历史：先按条数，再按字符预算；从最旧开始丢，
 * 且 `tool` 结果必须保留其宿主 assistant 消息（孤儿结果直接丢弃）。
 * 始终保留最后一条消息（即本次用户输入）。
 */
export function truncateHistory(
  messages: readonly StoredMessage[],
  options: TruncateOptions = {},
): TruncateResult {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES
  if (messages.length === 0) return { messages: [], dropped: 0, truncated: false }

  let start = 0

  if (maxMessages > 0 && messages.length > maxMessages) {
    start = Math.max(0, messages.length - maxMessages)
    while (start > 0 && start < messages.length && messages[start]?.role === 'tool') {
      start = groupHead(messages, start)
    }
  }

  if (maxChars > 0) {
    let total = 0
    let cut = start
    for (let index = messages.length - 1; index >= start; index -= 1) {
      const message = messages[index]
      if (message === undefined) continue
      const weight = messageWeight(message)
      if (total + weight > maxChars) break
      total += weight
      cut = message.role === 'tool' ? groupHead(messages, index) : index
    }
    start = cut
  }

  // 至少保留最后一条（即本次用户输入）
  if (start > messages.length - 1) start = messages.length - 1

  // 防御：起点不能落在 tool 结果上，否则整条丢弃该孤儿（或回退到其宿主）
  while (start < messages.length - 1 && messages[start]?.role === 'tool') {
    start = groupHead(messages, start) === start ? start + 1 : groupHead(messages, start)
  }

  const kept = messages.slice(start)
  const dropped = messages.length - kept.length
  return { messages: kept, dropped, truncated: dropped > 0 }
}

/**
 * 转换为 LLM 消息。
 * - `system`：跳过（系统提示词由 context 层每次重新组装，不参与历史）
 * - `tool`：还原为 `role:'tool'` + `toolCallId`
 * - `assistant`：带 `toolCalls` 时一并还原（`content` 为空也合法）
 */
export function toChatRequestMessages(
  messages: readonly StoredMessage[],
  options: { excludeTail?: number } = {},
): ChatRequestMessage[] {
  const excludeTail = options.excludeTail ?? 0
  const slice =
    excludeTail > 0 ? messages.slice(0, Math.max(0, messages.length - excludeTail)) : messages
  const out: ChatRequestMessage[] = []

  for (const message of slice) {
    switch (message.role) {
      case 'system':
        continue
      case 'user':
        out.push({ role: 'user', content: message.content })
        continue
      case 'tool':
        out.push({
          role: 'tool',
          content: message.content,
          ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
        })
        continue
      case 'assistant': {
        const calls = message.toolCalls ?? []
        out.push({
          role: 'assistant',
          content: message.content,
          ...(calls.length === 0
            ? {}
            : {
                toolCalls: calls.map((call) => ({
                  id: call.id,
                  name: call.name,
                  arguments: call.arguments,
                })),
              }),
        })
        continue
      }
      default:
        continue
    }
  }

  return out
}
