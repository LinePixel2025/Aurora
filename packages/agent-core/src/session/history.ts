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
 * quick 会话滑动窗口（docs/06 §4）：只保留 `createdAt` 落在 `[now - windowMs, …]` 内的消息。
 *
 * 由调用方在 `compressHistory` **之前**过滤 —— 更早的消息仅留在存储 / 界面历史，
 * 不进 LLM 组装。时间戳解析失败的消息视为窗外（宁缺勿污）；返回新数组，不改入参。
 * `now` 可注入，单测不必对着真实时钟写断言。
 *
 * **配对口径（P1-11）**：与 `truncateHistory` 的孤儿防御一致 —— 工具组按**原子单位**判定。
 * `assistant(toolCalls)` 及其全部 `tool` 结果是一组：组内任一条落在窗内就**整组保留**
 * （宿主因此被"强制保留"，窗口起点可能被向前回拉一条 assistant），整组都在窗外才整组丢弃。
 * 只按 `createdAt` 逐条过筛会在窗口边界上把工具配对切两半（宿主在窗外、结果在窗内 →
 * 请求里出现没有宿主的 `role:'tool'`，或反过来的悬空 toolCalls），OpenAI 兼容服务一律 400。
 * 找不到宿主的**真孤儿**（宿主从未落盘）一律丢弃：这是整条链唯一的合法处置。
 */
export function filterMessagesWithinWindow(
  messages: readonly StoredMessage[],
  windowMs: number,
  now: number = Date.now(),
): StoredMessage[] {
  if (windowMs <= 0) return [...messages]
  const cutoff = now - windowMs

  // 组归属：tool 结果归其宿主 assistant 下标，其余消息各自成组。
  // `null` = 找不到宿主的真孤儿（整条丢弃，同 `truncateHistory` 的处置）。
  const headOf: Array<number | null> = messages.map((message, index) =>
    message.role === 'tool' ? toolCallOwner(messages, index) : index,
  )

  // 组内任一条落在窗内 → 整组保留（含早于 cutoff 的宿主，属刻意的边界回拉）
  const retainedGroups = new Set<number>()
  for (let index = 0; index < messages.length; index += 1) {
    const head = headOf[index]
    if (head === null || head === undefined) continue
    const timestamp = Date.parse(messages[index]?.createdAt ?? '')
    if (Number.isFinite(timestamp) && timestamp >= cutoff) retainedGroups.add(head)
  }

  const kept: StoredMessage[] = []
  for (let index = 0; index < messages.length; index += 1) {
    const head = headOf[index]
    if (head === null || head === undefined || !retainedGroups.has(head)) continue
    const message = messages[index]
    if (message !== undefined) kept.push(message)
  }
  return kept
}

/** 生成 / 更新摘要的注入点（由装配层用当前 provider 实现，内核不引入网络耦合） */
export type SummarizeFn = (input: {
  /** 本次被截断丢弃的消息（已按时间升序） */
  dropped: StoredMessage[]
  /** 上一次的累计摘要；首次压缩时为 undefined */
  previousSummary?: string
}) => Promise<string>

export interface CompressOptions extends TruncateOptions {
  summarize?: SummarizeFn
  /** 上一次的累计摘要（调用方持有，跨轮次复用） */
  previousSummary?: string
}

export interface CompressResult extends TruncateResult {
  /** 累计摘要；`undefined` 表示尚未压缩过 */
  summary?: string
  /** 本次是否真的调用了 summarizer 并拿到可用摘要 */
  compressed: boolean
}

/** 喂给 summarizer 的原始文本预算（超出部分从最旧开始截断） */
const MAX_SUMMARY_INPUT_CHARS = 20_000

/**
 * 带摘要的上下文压缩（docs/06 §4「长上下文」）。
 *
 * 与纯截断的关系：**截断永远是兜底**。没有 `summarize`、summarizer 抛错、
 * 或返回空串时，行为与 `truncateHistory` 完全一致（丢弃的部分直接消失），
 * 因此调用方可以无条件改用本函数而不引入新的失败模式。
 *
 * 摘要由调用方持有（`previousSummary` 入参 / `summary` 出参）：本模块保持无状态，
 * 便于单测；跨轮次的累计与注入位置由装配层决定。
 * 摘要文本刻意**不进入 messages**：它是模型侧的提示，不该出现在会话文件或渲染层历史里。
 */
export async function compressHistory(
  messages: readonly StoredMessage[],
  options: CompressOptions = {},
): Promise<CompressResult> {
  const truncated = truncateHistory(messages, options)
  if (!truncated.truncated) {
    return {
      ...truncated,
      compressed: false,
      ...(options.previousSummary === undefined ? {} : { summary: options.previousSummary }),
    }
  }

  const summarize = options.summarize
  if (summarize === undefined) {
    return {
      ...truncated,
      compressed: false,
      ...(options.previousSummary === undefined ? {} : { summary: options.previousSummary }),
    }
  }

  const dropped = messages.slice(0, truncated.dropped)
  try {
    const text = await summarize({
      dropped: trimForSummary(dropped),
      ...(options.previousSummary === undefined
        ? {}
        : { previousSummary: options.previousSummary }),
    })
    const summary = text.trim()
    if (summary === '') {
      return {
        ...truncated,
        compressed: false,
        ...(options.previousSummary === undefined ? {} : { summary: options.previousSummary }),
      }
    }
    return { ...truncated, summary, compressed: true }
  } catch {
    // 摘要失败不放大为请求失败：退回纯截断，并保留已有摘要
    return {
      ...truncated,
      compressed: false,
      ...(options.previousSummary === undefined ? {} : { summary: options.previousSummary }),
    }
  }
}

/** 从最新开始保留，直到达到文本预算（丢弃部分越旧越先被舍弃）。 */
function trimForSummary(messages: readonly StoredMessage[]): StoredMessage[] {
  const kept: StoredMessage[] = []
  let total = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined) continue
    const weight = message.content.length
    if (total + weight > MAX_SUMMARY_INPUT_CHARS && kept.length > 0) break
    total += weight
    kept.unshift(message)
  }
  return kept
}

/**
 * 转换为 LLM 消息。
 * - `system`：跳过（系统提示词由 context 层每次重新组装，不参与历史）
 * - `tool`：还原为 `role:'tool'` + `toolCallId`
 * - `assistant`：带 `toolCalls` 时一并还原（`content` 为空也合法）
 */ export function toChatRequestMessages(
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
        // 注意：`message.reasoning`（思考链全文）刻意**不**进 ChatRequestMessage ——
        // 它只供渲染层展示，回传给 API 既是浪费上下文也可能被部分服务拒绝。
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
