/**
 * MCP stdio 分帧解码器（docs/06 §7）。
 *
 * 协议规定用 `Content-Length: N\r\n\r\n<JSON>` 分帧，但：
 * - 帧尾常带多余换行，帧间也允许空白；
 * - 有的实现按"一行一个 JSON"发送；
 * - 数据会按任意 chunk 边界到达（包括 CRLF 中间）。
 *
 * 实现：逐行读取 + 显式游标，**行终止符（\r\n / \n）必须作为一个整体消费**，
 * 否则空行判定的位置会错位（把 body 起点算错）。只有确定性的前进才推进游标，
 * 因此 body 未收全时重复提交同一 buffer 仍然安全（幂等）。
 *
 * 纯函数 + 显式状态，彻底单测见 `frames.test.ts`。
 */

const LF = 0x0a
const SP = 0x20
const TAB = 0x09
const CR = 0x0d

export interface FrameMessage {
  text: string
  /** 无法解析为协议帧时的原始文本（调用方转成日志） */
  error?: string
}

export interface FrameState {
  /**
   * 已**完整消费**的字节数。永远只指向某个完整帧的结尾或 buffer 起点，
   * 绝不指向半个帧内部 —— 否则调用方裁剪 buffer 后游标就失去意义。
   * body 未收全时游标保留，重复提交（累积后的）buffer 是幂等的。
   */
  cursor: number
  /** 最近一次已知的 body 长度（诊断用） */
  expectedLength?: number
}

export function createFrameState(): FrameState {
  return { cursor: 0 }
}

export interface FrameResult {
  messages: FrameMessage[]
  /** 已消费到的位置（调用方可据此裁剪 buffer 并把游标归零） */
  cursor: number
  /** 仍有未完成的数据（未收到完整帧） */
  pending: boolean
}

export function decodeFrames(buffer: Buffer, state: FrameState): FrameResult {
  const messages: FrameMessage[] = []
  const frameStart = state.cursor
  let index = frameStart

  while (index < buffer.length) {
    // 帧间空白（上一条报文遗留的换行 / 缩进）
    if (isWhitespace(buffer[index])) {
      index += 1
      continue
    }

    // 本帧起点：从「干净位置」开始逐行读取头部
    const parsed = readHeader(buffer, index)
    if (parsed.kind === 'partial') {
      // 行未收全：游标停在帧起点，等更多数据
      state.cursor = frameStart
      return { messages, cursor: frameStart, pending: true }
    }
    if (parsed.kind === 'line') {
      index = parsed.next
      state.expectedLength = undefined
      try {
        JSON.parse(parsed.line)
        messages.push({ text: parsed.line })
      } catch {
        messages.push({ text: parsed.line, error: parsed.line })
      }
      continue
    }

    // framed：等 body 收全
    if (buffer.length - parsed.bodyStart < parsed.length) {
      state.cursor = frameStart
      state.expectedLength = parsed.length
      return { messages, cursor: frameStart, pending: true }
    }
    const body = buffer
      .subarray(parsed.bodyStart, parsed.bodyStart + parsed.length)
      .toString('utf8')
    messages.push(isJson(body) ? { text: body } : { text: body, error: body })
    index = parsed.bodyStart + parsed.length
    state.expectedLength = undefined
  }

  state.cursor = index
  state.expectedLength = undefined
  return { messages, cursor: index, pending: false }
}

type HeaderParse =
  | { kind: 'framed'; length: number; bodyStart: number }
  | { kind: 'line'; line: string; next: number }
  | { kind: 'partial' }

/**
 * 从 `start` 开始读取一个"单元"：
 * - `framed`：读到完整头部（`Content-Length` + 空行），返回 body 起点与长度；
 * - `line`：遇到非头部行（"一行一个 JSON" / 垃圾报文）；
 * - `partial`：行还没收全（含 CRLF 被 chunk 截断）。
 */
function readHeader(buffer: Buffer, start: number): HeaderParse {
  let index = start
  let length: number | undefined

  for (;;) {
    const line = readLine(buffer, index)
    if (line === undefined) return { kind: 'partial' }
    index = line.next

    if (line.text === '') {
      if (length === undefined) continue // 空头部：跳过空行继续
      return { kind: 'framed', length, bodyStart: index }
    }

    const matched = /^content-length:\s*(\d+)$/i.exec(line.text)
    if (matched) {
      length = Number(matched[1])
      continue
    }

    // 非头部行：本单元按整行处理
    return { kind: 'line', line: line.text, next: index }
  }
}

interface Line {
  text: string
  /** 下一行的起始位置（已消费行终止符） */
  next: number
}

/** 读取一行（不含行终止符）；没有完整行时返回 undefined */
function readLine(buffer: Buffer, start: number): Line | undefined {
  const newline = buffer.indexOf(LF, start)
  if (newline < 0) return undefined
  let end = newline
  if (end > start && buffer[end - 1] === CR) end -= 1
  return { text: buffer.subarray(start, end).toString('utf8').trim(), next: newline + 1 }
}

function isWhitespace(value: number | undefined): boolean {
  return value === SP || value === TAB || value === LF || value === CR
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}
