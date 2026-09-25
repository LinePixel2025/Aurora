/**
 * 最小 SSE（Server-Sent Events）解析器。
 *
 * 只做一件事：把任意分片的 `text/event-stream` 文本切成一条条 data 负载。
 * 独立成纯函数便于单测（docs/06 §3 要求流式可靠）。
 */
export interface SseParseResult {
  /** 已完整解析出的 data 负载（多行 data 以 \n 连接） */
  events: string[]
  /** 尚未结束的残留缓冲，需与下一片拼接 */
  rest: string
}

export function parseSseChunk(buffer: string): SseParseResult {
  const events: string[] = []
  const normalized = buffer.replace(/\r\n/g, '\n')
  const blocks = normalized.split('\n\n')
  const rest = blocks.pop() ?? ''

  for (const block of blocks) {
    const dataLines: string[] = []
    for (const rawLine of block.split('\n')) {
      const line = rawLine.trimEnd()
      if (line === '' || line.startsWith(':')) continue
      if (!line.startsWith('data:')) continue
      dataLines.push(line.slice(5).replace(/^ /, ''))
    }
    if (dataLines.length > 0) events.push(dataLines.join('\n'))
  }

  return { events, rest }
}

/**
 * 把一行 `data:` 内容解析为 JSON。
 * 返回 `null` 表示这是流结束标记（`[DONE]`）。
 * 非法 JSON 返回 `undefined`（调用方决定是忽略还是报错）。
 */
export function parseSseData(data: string): unknown[] | null | undefined {
  if (data.trim() === '[DONE]') return null
  try {
    const parsed: unknown = JSON.parse(data)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return undefined
  }
}

/** 从 OpenAI 兼容分片里取出增量文本（兼容数组与单对象两种形态）。 */
export function extractDelta(payload: unknown): string {
  const choices = (payload as { choices?: unknown[] } | null)?.choices
  if (!Array.isArray(choices)) return ''
  let text = ''
  for (const choice of choices) {
    const delta = (choice as { delta?: { content?: unknown } }).delta
    if (delta && typeof delta.content === 'string') text += delta.content
  }
  return text
}

/**
 * 从 OpenAI 兼容分片里取出**思考链**增量（Design/betav2-spec.md §6）。
 *
 * 各家字段名不统一：DeepSeek / Kimi 用 `reasoning_content`，OpenRouter 等用 `reasoning`，
 * 两者都可为 null。取值口径：同一条 choice 里 `reasoning_content` 优先，缺省再看
 * `reasoning`；都不是字符串就当没有。content 内嵌的 `<think>...</think>` **不做**解析
 * （只认独立字段，避免误伤正文）。
 */
export function extractReasoningDelta(payload: unknown): string {
  const choices = (payload as { choices?: unknown[] } | null)?.choices
  if (!Array.isArray(choices)) return ''
  let text = ''
  for (const choice of choices) {
    const delta = (choice as { delta?: { reasoning_content?: unknown; reasoning?: unknown } }).delta
    if (!delta) continue
    if (typeof delta.reasoning_content === 'string') {
      text += delta.reasoning_content
      continue
    }
    if (typeof delta.reasoning === 'string') text += delta.reasoning
  }
  return text
}
