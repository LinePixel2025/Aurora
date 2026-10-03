import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@aurora/shared'
import { createEventBuffer } from './event-buffer.js'

/** 一条 text 增量（字段齐全，便于断言「合并后保留第一条的 seq / round」） */
function text(seq: number, delta: string, messageId = 'm1'): AgentEvent {
  return { type: 'text', sessionId: 's1', requestId: 'r1', seq, round: 0, messageId, delta }
}

/** 一条 reasoning 增量 */
function reasoning(seq: number, delta: string, messageId = 'm1'): AgentEvent {
  return { type: 'reasoning', sessionId: 's1', requestId: 'r1', seq, round: 0, messageId, delta }
}

function toolEvent(seq: number, messageId = 'm1'): AgentEvent {
  return {
    type: 'tool',
    sessionId: 's1',
    requestId: 'r1',
    seq,
    round: 0,
    messageId,
    call: { id: 'c1', name: 'list_dir', input: {}, state: 'running' },
  }
}

function doneEvent(seq: number): AgentEvent {
  return { type: 'done', sessionId: 's1', requestId: 'r1', seq }
}

function subagentEvent(seq: number, report: string): AgentEvent {
  return {
    type: 'subagent',
    sessionId: 's1',
    requestId: 'r1',
    seq,
    round: 0,
    messageId: 'm1',
    callId: 'call-1',
    subagent: {
      taskId: 'task-1',
      callId: 'call-1',
      description: '任务',
      prompt: '执行',
      status: 'running',
      startedAt: 1,
      steps: [],
      toolCalls: 0,
      ...(report === '' ? {} : { report }),
    },
  }
}

describe('createEventBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('同 messageId 的相邻 text 合并成一条：delta 拼接、seq 取首条', () => {
    const sent: AgentEvent[] = []
    const buffer = createEventBuffer((event) => sent.push(event))

    buffer.push(text(1, '你'))
    buffer.push(text(2, '好'))
    buffer.push(text(3, '呀'))
    expect(sent).toHaveLength(0)

    vi.advanceTimersByTime(16)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({
      type: 'text',
      sessionId: 's1',
      requestId: 'r1',
      seq: 1,
      round: 0,
      messageId: 'm1',
      delta: '你好呀',
    })
  })

  it('不同 messageId 不合并', () => {
    const sent: AgentEvent[] = []
    const buffer = createEventBuffer((event) => sent.push(event))

    buffer.push(text(1, 'A', 'm1'))
    buffer.push(text(2, 'B', 'm2'))
    vi.advanceTimersByTime(16)

    expect(sent).toHaveLength(2)
    expect(sent.map((event) => (event.type === 'text' ? event.delta : ''))).toEqual(['A', 'B'])
  })

  it('reasoning 与 text 不互相合并（同 messageId 也不行）', () => {
    const sent: AgentEvent[] = []
    const buffer = createEventBuffer((event) => sent.push(event))

    buffer.push(reasoning(1, '想'))
    buffer.push(text(2, '说'))
    vi.advanceTimersByTime(16)

    expect(sent).toHaveLength(2)
    expect(sent[0]?.type).toBe('reasoning')
    expect(sent[1]?.type).toBe('text')
  })

  it('中间夹一个 tool 事件时不跨它合并，且顺序保持', () => {
    const sent: AgentEvent[] = []
    const buffer = createEventBuffer((event) => sent.push(event))

    buffer.push(text(1, '前'))
    buffer.push(toolEvent(2))
    buffer.push(text(3, '后'))
    vi.advanceTimersByTime(16)

    expect(sent.map((event) => event.type)).toEqual(['text', 'tool', 'text'])
    expect(sent[0]).toMatchObject({ delta: '前' })
    expect(sent[2]).toMatchObject({ delta: '后' })
  })

  it('done 立即下发，且它之前的增量已经先发出去', () => {
    const sent: AgentEvent[] = []
    const buffer = createEventBuffer((event) => sent.push(event))

    buffer.push(text(1, '正'))
    buffer.push(text(2, '文'))
    buffer.push(doneEvent(3))

    // 不推进定时器：done 必须已经到达，且前面的增量已经合并发完
    expect(sent.map((event) => event.type)).toEqual(['text', 'done'])
    expect(sent[0]).toMatchObject({ delta: '正文', seq: 1 })
    expect(sent[1]).toEqual(doneEvent(3))
  })

  it('user-message / error 同样是「先 flush 再同步下发」', () => {
    const userMessage: AgentEvent = {
      type: 'user-message',
      sessionId: 's1',
      requestId: 'r1',
      seq: 9,
      content: '提问',
      createdAt: 1,
    }
    const error: AgentEvent = {
      type: 'error',
      sessionId: 's1',
      requestId: 'r1',
      seq: 8,
      code: 'E_UNKNOWN',
      message: '炸了',
    }
    const sent: AgentEvent[] = []
    const buffer = createEventBuffer((event) => sent.push(event))

    buffer.push(text(1, '甲'))
    buffer.push(userMessage)
    buffer.push(text(2, '乙'))
    buffer.push(error)

    expect(sent.map((event) => event.type)).toEqual(['text', 'user-message', 'text', 'error'])
  })

  it('定时器到点后按入队顺序一次性下发', () => {
    const sent: AgentEvent[] = []
    const buffer = createEventBuffer((event) => sent.push(event))

    buffer.push(reasoning(1, '想'))
    buffer.push(toolEvent(2))
    buffer.push(text(3, '说'))
    expect(sent).toHaveLength(0)

    vi.advanceTimersByTime(16)
    expect(sent.map((event) => event.type)).toEqual(['reasoning', 'tool', 'text'])
  })

  it('同一窗口内的多次入队只排一个定时器（不会每片一次 IPC）', () => {
    const sent: AgentEvent[] = []
    const buffer = createEventBuffer((event) => sent.push(event))

    for (let index = 0; index < 100; index += 1) buffer.push(text(index, 'x'))
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(16)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ seq: 0 })
    expect(sent[0]?.type === 'text' ? sent[0].delta.length : 0).toBe(100)
  })

  it('同一子代理在一个窗口内只保留最新快照', () => {
    const sent: AgentEvent[] = []
    const buffer = createEventBuffer((event) => sent.push(event))

    buffer.push(subagentEvent(1, '开始'))
    buffer.push(subagentEvent(2, '进行中'))
    buffer.push(subagentEvent(3, '最新'))
    vi.advanceTimersByTime(16)

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'subagent', seq: 3 })
    expect(sent[0]?.type === 'subagent' ? sent[0].subagent.report : undefined).toBe('最新')
  })

  it('windowMs 可注入（单测 / 需要更激进合并的调用方）', () => {
    const sent: AgentEvent[] = []
    const buffer = createEventBuffer((event) => sent.push(event), { windowMs: 0 })

    buffer.push(text(1, 'a'))
    vi.advanceTimersByTime(0)
    expect(sent).toHaveLength(1)
  })

  it('flush() 立即下发在途事件', () => {
    const sent: AgentEvent[] = []
    const buffer = createEventBuffer((event) => sent.push(event))

    buffer.push(text(1, 'a'))
    buffer.flush()
    expect(sent).toHaveLength(1)
    // 定时器已被取消：再推进时间也不会重复下发
    vi.advanceTimersByTime(100)
    expect(sent).toHaveLength(1)
  })

  it('dispose() 后不再下发任何在途事件', () => {
    const sent: AgentEvent[] = []
    const buffer = createEventBuffer((event) => sent.push(event))

    buffer.push(text(1, 'a'))
    buffer.push(toolEvent(2))
    buffer.dispose()

    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(100)
    expect(sent).toHaveLength(0)
    // dispose 之后 flush 也无法把它找回来（队列已被丢掉）
    buffer.flush()
    expect(sent).toHaveLength(0)
  })

  it('dispose() 之后仍可继续使用（新事件照常排窗口）', () => {
    const sent: AgentEvent[] = []
    const buffer = createEventBuffer((event) => sent.push(event))

    buffer.push(text(1, 'a'))
    buffer.dispose()
    buffer.push(text(2, 'b'))
    vi.advanceTimersByTime(16)

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ seq: 2 })
  })
})
