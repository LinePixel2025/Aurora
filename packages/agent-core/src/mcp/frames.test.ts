import { describe, expect, it } from 'vitest'
import { createFrameState, decodeFrames } from './frames.js'

/**
 * 构造报文时**不使用字符串转义**：直接用 `String.fromCharCode` 拼出 CR / LF，
 * 避免源文件被某些写入路径改写转义序列后，测试与解析器对不上的问题。
 */
const CR = String.fromCharCode(13)
const LF = String.fromCharCode(10)
const CRLF = CR + LF
const SEP = CR + LF + CR + LF

function frame(payload: string): string {
  return `Content-Length: ${Buffer.byteLength(payload, 'utf8')}${SEP}${payload}${LF}`
}

/**
 * 模拟真实实现：持久 buffer + 游标，每次追加以 chunk，
 * 解析后按游标裁剪已消费部分并重置解析状态。
 */
function createFeeder() {
  let buffer = Buffer.alloc(0)
  let state = createFrameState()
  return (chunk: string): string[] => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk, 'utf8')])
    const result = decodeFrames(buffer, state)
    if (result.cursor > 0) {
      buffer = buffer.subarray(result.cursor)
      state = createFrameState()
    }
    return result.messages.map((message) => message.error ?? message.text)
  }
}

describe('decodeFrames', () => {
  it('解析单帧并忽略帧尾换行', () => {
    const feed = createFeeder()
    expect(feed(frame('{"id":1}'))).toEqual(['{"id":1}'])
  })

  it('连续两帧（帧间有换行）都能解出', () => {
    const feed = createFeeder()
    expect(feed(frame('{"id":1}') + frame('{"id":2}'))).toEqual(['{"id":1}', '{"id":2}'])
  })

  it('三帧分两次到达', () => {
    const feed = createFeeder()
    expect(feed(frame('{"a":1}') + frame('{"b":2}'))).toEqual(['{"a":1}', '{"b":2}'])
    expect(feed(frame('{"c":3}'))).toEqual(['{"c":3}'])
  })

  it('跨 chunk 边界：body 被截断', () => {
    const feed = createFeeder()
    const first = feed(`Content-Length: 8${SEP}{"id":1`)
    expect(first).toEqual([])
    expect(feed('}')).toEqual(['{"id":1}'])
  })

  it('跨 chunk 边界：头部本身被截断', () => {
    const feed = createFeeder()
    expect(feed(`Content-Length: 8${CRLF}`)).toEqual([])
    expect(feed(`${CRLF}{"id":1}`)).toEqual(['{"id":1}'])
  })

  it('兼容"一行一个 JSON"的实现', () => {
    const feed = createFeeder()
    expect(feed(`{"id":1}${LF}{"id":2}${LF}`)).toEqual(['{"id":1}', '{"id":2}'])
  })

  it('非协议垃圾记为报文且不阻塞后续帧', () => {
    const feed = createFeeder()
    expect(feed(`garbage line${LF}${frame('{"id":9}')}`)).toEqual(['garbage line', '{"id":9}'])
  })

  it('多字节 UTF-8 按字节长度取 body', () => {
    const feed = createFeeder()
    const payload = '{"text":"中文内容"}'
    expect(feed(frame(payload))).toEqual([payload])
  })

  it('空 buffer 不报错', () => {
    const state = createFrameState()
    const result = decodeFrames(Buffer.alloc(0), state)
    expect(result.messages).toEqual([])
    expect(result.pending).toBe(false)
  })

  it('LF-only 头部也能解析', () => {
    const feed = createFeeder()
    const payload = '{"id":7}'
    expect(feed(`Content-Length: ${payload.length}${LF}${LF}${payload}${LF}`)).toEqual([payload])
  })

  it('大报文分多块到达（含多字节字符跨块）', () => {
    const feed = createFeeder()
    const payload = JSON.stringify({ text: '中文'.repeat(200) })
    const raw = frame(payload)
    const collected: string[] = []
    for (let index = 0; index < raw.length; index += 7) {
      collected.push(...feed(raw.slice(index, index + 7)))
    }
    expect(collected).toEqual([payload])
  })
})
