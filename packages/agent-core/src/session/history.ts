/**
 * 会话历史 → LLM 消息转换与截断（docs/06 §4）。
 *
 * 截断规则：按字符上限从**最旧**开始丢弃，但必须保证
 * 「assistant(toolCalls) + 其全部 tool 结果」成对保留 ——
 * 只留一半会让 OpenAI 兼容服务直接拒绝请求（tool_call_id 无对应调用）。
 */
import type { ChatRequestMessage, LlmImageResolver } from '../llm/types.js'
import type { StoredMessage, StoredToolCall } from './types.js'

/**
 * 历史消息的图片分片（多模态输入，docs/06 §3.1）：`images` 是**路径**，解析成内容要有解析器。
 *
 * 缺失 / 解析器未注入 / 该路径解析不出来 → 这条消息按纯文本下发（`{}`，不写 `images` 键）。
 * 只认字符串数组：会话文件是磁盘数据，可能被手改过。
 */
function imagesOf(
  message: StoredMessage,
  options: { resolveImages?: LlmImageResolver },
): { images?: ChatRequestMessage['images'] } {
  const paths = message.images
  if (options.resolveImages === undefined || !Array.isArray(paths) || paths.length === 0) return {}
  const resolved = options.resolveImages(paths.filter((path) => typeof path === 'string'))
  return resolved.length === 0 ? {} : { images: [...resolved] }
}

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

/**
 * 消息在上下文里的粗算长度（content + 工具参数）。
 *
 * 工具调用参数必须计入：`edit_file` / `write_file` 这类工具的 `arguments` 可能远大于正文，
 * 漏算会让字符预算被系统性低估、上下文实际超出预期（2026-10-04 性能轮）。
 */
function messageWeight(message: StoredMessage): number {
  // 宽容磁盘 / 夹具里的历史数据：`content` 或工具卡 `arguments` 都可能是缺省 / 非字符串
  // （渲染层水合形状用 `input` 对象，截图夹具直接写 JSON 时可能没有 `arguments`），
  // 这里只按"实际能算出的字符串长度"计权，绝不让畸形历史把整次请求打挂。
  let weight = typeof message.content === 'string' ? message.content.length : 0
  for (const call of message.toolCalls ?? []) {
    if (typeof call.arguments === 'string') weight += call.arguments.length
  }
  return weight
}

/** 一次线性建立工具结果归属，避免截断时对每条 tool 结果反复向前扫描。 */
function toolCallOwners(messages: readonly StoredMessage[]): Array<number | null> {
  const owners = new Map<string, number>()
  const result: Array<number | null> = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message === undefined) {
      result.push(null)
      continue
    }
    if (message.role === 'user') {
      owners.clear()
      result.push(index)
      continue
    }
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) owners.set(call.id, index)
      result.push(index)
      continue
    }
    if (message.role === 'tool') {
      result.push(
        message.toolCallId === undefined ? null : (owners.get(message.toolCallId) ?? null),
      )
      continue
    }
    result.push(index)
  }
  return result
}

/**
 * 为缺失的工具结果合成一条失败结果（只在**组装请求**时用，不写回会话）。
 *
 * 文案要明确「没有结果」而不是编造内容：模型看到后可以决定重试或换方案；
 * 空内容 / 只写「error」都会让模型误以为工具真的返回过。`outputSummary` 是会话里
 * 已经记下的失败原因（流中断 / 用户取消 / 工具执行失败），优先用它。
 */
function syntheticToolResult(call: StoredToolCall, host: StoredMessage): StoredMessage {
  const reason = call.outputSummary?.trim()
  const detail =
    reason !== undefined && reason !== ''
      ? reason
      : call.state === 'running'
        ? '未执行'
        : call.state === 'error'
          ? '执行失败'
          : '结果未落盘'
  return {
    // 只用于本次请求的内存形状：加前缀避免与真实消息 id 撞车
    id: `repaired-tool-${host.id}-${call.id}`,
    role: 'tool',
    content: `工具 "${call.name}" 未返回结果（${detail}），已按失败处理。`,
    createdAt: host.createdAt,
    toolCallId: call.id,
  }
}

/**
 * 修复工具调用配对，保证可以安全地发给 OpenAI 兼容服务。
 *
 * 为什么需要：服务端要求「assistant(tool_calls) 之后必须紧跟每个 tool_call_id 各自的
 * tool 消息」。但会话历史在以下情形可能是半组：
 * - 流在 `[DONE]` 之前中断：`appendAssistant` 已落盘 toolCalls，工具却从未执行；
 * - 用户在工具轮次中途点「停止」：只执行了一部分调用（或一个都没跑）就结束；
 * - 进程被强杀 / 旧版本会话文件：assistant 与 tool 结果之间只落了前一半。
 * 直接重放会得到 HTTP 400「insufficient tool messages following tool_calls message」，
 * 也就是「执行过一次中断的任务后，再发任何消息都报错」。
 *
 * 处置口径：
 * - 有宿主 assistant 的调用：按 `toolCalls` 顺序补齐缺失结果（合成失败结果，见上）；
 * - 孤儿 tool 消息（没有宿主 / id 不在宿主的 toolCalls 里 / 重复结果）：直接丢弃；
 * - 其余消息原样保留（`system` 也保留，交给各转换函数自行过滤）。
 *
 * 这是**请求组装层的兜底**：循环在中断 / 流失败时已经会补落盘（见 `agentLoop`），
 * 这里再兜住崩溃 / 历史文件损坏与旧版本数据。不改写会话，不会让历史越修越长。
 */
export function repairToolCallPairs(messages: readonly StoredMessage[]): StoredMessage[] {
  const out: StoredMessage[] = []
  let index = 0
  while (index < messages.length) {
    const message = messages[index]
    if (message === undefined) {
      index += 1
      continue
    }

    // 孤儿 tool 结果：它前面没有携带对应 toolCallId 的 assistant，整条丢弃
    if (message.role !== 'assistant' || (message.toolCalls ?? []).length === 0) {
      if (message.role !== 'tool') out.push(message)
      index += 1
      continue
    }

    const calls = message.toolCalls ?? []
    out.push(message)

    // 收集紧跟其后的连续 tool 结果（按 id 归属；同 id 重复只保留第一条）
    const results = new Map<string, StoredMessage>()
    const unkeyed: StoredMessage[] = []
    let cursor = index + 1
    while (cursor < messages.length && messages[cursor]?.role === 'tool') {
      const tool = messages[cursor]
      if (tool !== undefined) {
        const callId = tool.toolCallId
        if (typeof callId === 'string' && callId !== '') {
          if (!results.has(callId)) results.set(callId, tool)
        } else {
          // 旧会话可能没有 toolCallId：按出现顺序补给缺少 id 的调用（仅作兼容）
          unkeyed.push(tool)
        }
      }
      cursor += 1
    }

    const used = new Set<StoredMessage>()
    for (const call of calls) {
      let result = results.get(call.id)
      if (result === undefined) {
        const fallback = unkeyed.find((item) => !used.has(item))
        if (fallback !== undefined) result = fallback
      }
      if (result === undefined) {
        out.push(syntheticToolResult(call, message))
        continue
      }
      used.add(result)
      // 旧会话的 tool 结果可能没有 toolCallId：补上归属，否则线上消息仍缺
      // `tool_call_id`，服务端同样会判配对不完整
      out.push(
        result.toolCallId === undefined || result.toolCallId === ''
          ? { ...result, toolCallId: call.id }
          : result,
      )
    }

    // 走到这里时 cursor 指向下一个非 tool 消息；被丢弃的 keyed / unkeyed 结果不再输出
    index = cursor
  }
  return out
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
  const owners = toolCallOwners(messages)

  if (maxMessages > 0 && messages.length > maxMessages) {
    start = Math.max(0, messages.length - maxMessages)
    while (start > 0 && start < messages.length && messages[start]?.role === 'tool') {
      start = owners[start] ?? start
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
      cut = message.role === 'tool' ? (owners[index] ?? index) : index
    }
    start = cut
  }

  // 至少保留最后一条（即本次用户输入）
  if (start > messages.length - 1) start = messages.length - 1

  // 防御：起点不能落在 tool 结果上，否则整条丢弃该孤儿（或回退到其宿主）
  while (start < messages.length - 1 && messages[start]?.role === 'tool') {
    const owner = owners[start] ?? start
    start = owner === start ? start + 1 : owner
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
  const headOf = toolCallOwners(messages)

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

/**
 * 从最新开始保留，直到达到文本预算（丢弃部分越旧越先被舍弃）。
 *
 * `compressHistory` 内部用；**手动压缩**（`KernelAgentHost.compact`，直接把全量消息
 * 交给 summarizer）也用它裁剪输入 —— 两条路共用同一份预算口径，别再抄第二份。
 */
export function trimForSummary(messages: readonly StoredMessage[]): StoredMessage[] {
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
 * - `user`：带图片路径（`images`）时经 `resolveImages` 还原成图片分片
 *   （多模态输入，docs/06 §3.1）；未注入解析器 = 按纯文本下发
 */ export function toChatRequestMessages(
  messages: readonly StoredMessage[],
  options: { excludeTail?: number; resolveImages?: LlmImageResolver } = {},
): ChatRequestMessage[] {
  const excludeTail = options.excludeTail ?? 0
  const slice =
    excludeTail > 0 ? messages.slice(0, Math.max(0, messages.length - excludeTail)) : messages
  // 请求组装层兜底：历史可能是半组（流中断 / 中途停止 / 进程被杀 / 旧会话文件），
  // 直接发给 OpenAI 兼容服务会 400；这里补齐缺失的 tool 结果并丢弃孤儿结果。
  const out: ChatRequestMessage[] = []

  for (const message of repairToolCallPairs(slice)) {
    switch (message.role) {
      case 'system':
        continue
      case 'user':
        out.push({ role: 'user', content: message.content, ...imagesOf(message, options) })
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
