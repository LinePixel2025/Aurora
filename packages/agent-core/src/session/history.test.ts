import { describe, expect, it } from 'vitest'
import {
  compressHistory,
  filterMessagesWithinWindow,
  truncateHistory,
  toChatRequestMessages,
} from './history.js'
import type { StoredMessage } from './types.js'

function msg(
  partial: Partial<StoredMessage> & { id: string; role: StoredMessage['role'] },
): StoredMessage {
  return {
    content: '',
    createdAt: '2025-01-01T00:00:00.000Z',
    ...partial,
  }
}

describe('truncateHistory', () => {
  it('不超预算时原样返回', () => {
    const messages = [msg({ id: '1', role: 'user', content: 'a' })]
    const result = truncateHistory(messages, { maxChars: 100 })
    expect(result.messages).toHaveLength(1)
    expect(result.truncated).toBe(false)
  })

  it('按条数上限丢弃最旧消息', () => {
    const messages = Array.from({ length: 10 }, (_item, index) =>
      msg({ id: `${index}`, role: 'user', content: `m${index}` }),
    )
    const result = truncateHistory(messages, { maxMessages: 3 })
    expect(result.messages.map((item) => item.content)).toEqual(['m7', 'm8', 'm9'])
    expect(result.dropped).toBe(7)
  })

  it('按字符预算丢弃最旧消息，且至少保留最后一条', () => {
    const messages = [
      msg({ id: '1', role: 'user', content: 'x'.repeat(100) }),
      msg({ id: '2', role: 'assistant', content: 'y'.repeat(100) }),
      msg({ id: '3', role: 'user', content: 'z'.repeat(100) }),
    ]
    // 预算 150：最后一条 100 放得下，再加一条 100 就超了 → 只保留最后一条
    const result = truncateHistory(messages, { maxChars: 150 })
    expect(result.messages.map((item) => item.id)).toEqual(['3'])
    expect(result.dropped).toBe(2)

    // 预算 200：最后两条放得下
    const relaxed = truncateHistory(messages, { maxChars: 200 })
    expect(relaxed.messages.map((item) => item.id)).toEqual(['2', '3'])
  })

  it('工具组：结果保留时宿主也要保留', () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: 'q' }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'echo', arguments: '{}', state: 'success' }],
      }),
      msg({ id: 't1', role: 'tool', content: 'r', toolCallId: 'c1' }),
      msg({ id: 'u2', role: 'user', content: 'q2' }),
    ]
    // 预算容纳不下 t1（权重 1）时，整组一起丢
    const result = truncateHistory(messages, { maxChars: 2, maxMessages: 0 })
    expect(result.messages.map((item) => item.id)).toEqual(['u2'])
  })

  it('工具组：结果在预算内时宿主一起保留', () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: 'x'.repeat(50) }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'echo', arguments: '{}', state: 'success' }],
      }),
      msg({ id: 't1', role: 'tool', content: 'r', toolCallId: 'c1' }),
      msg({ id: 'u2', role: 'user', content: 'q2' }),
    ]
    const result = truncateHistory(messages, { maxChars: 10 })
    expect(result.messages.map((item) => item.id)).toEqual(['a1', 't1', 'u2'])
  })

  it('孤儿 tool 消息被丢弃', () => {
    const messages = [
      msg({ id: 't0', role: 'tool', content: 'orphan', toolCallId: 'missing' }),
      msg({ id: 'u1', role: 'user', content: 'q' }),
    ]
    const result = truncateHistory(messages, { maxChars: 10 })
    expect(result.messages.map((item) => item.id)).toEqual(['u1'])
  })

  it('maxChars<=0 表示不按字符截断', () => {
    const messages = [msg({ id: '1', role: 'user', content: 'x'.repeat(500) })]
    expect(truncateHistory(messages, { maxChars: 0 }).messages).toHaveLength(1)
  })
})

describe('toChatRequestMessages', () => {
  it('跳过 system、还原 tool 与 assistant toolCalls', () => {
    const messages: StoredMessage[] = [
      msg({ id: 's', role: 'system', content: 'sys' }),
      msg({ id: 'u', role: 'user', content: '问' }),
      msg({
        id: 'a',
        role: 'assistant',
        content: '答',
        toolCalls: [{ id: 'c1', name: 'echo', arguments: '{"a":1}', state: 'success' }],
      }),
      msg({ id: 't', role: 'tool', content: '结果', toolCallId: 'c1' }),
    ]
    const converted = toChatRequestMessages(messages)
    expect(converted.map((item) => item.role)).toEqual(['user', 'assistant', 'tool'])
    expect(converted[1]?.toolCalls).toEqual([{ id: 'c1', name: 'echo', arguments: '{"a":1}' }])
    expect(converted[2]?.toolCallId).toBe('c1')
  })

  it('excludeTail 可排除末尾消息', () => {
    const messages: StoredMessage[] = [
      msg({ id: '1', role: 'user', content: 'a' }),
      msg({ id: '2', role: 'user', content: 'b' }),
    ]
    expect(toChatRequestMessages(messages, { excludeTail: 1 })).toHaveLength(1)
  })

  it('reasoning（思考链）只用于展示，绝不进 API 请求消息', () => {
    const messages: StoredMessage[] = [
      msg({ id: 'a1', role: 'assistant', content: '上一轮回复', reasoning: '上一轮思考过程' }),
      msg({ id: 'u', role: 'user', content: '继续' }),
    ]
    const converted = toChatRequestMessages(messages)
    expect(converted).toHaveLength(2)
    for (const message of converted) {
      expect('reasoning' in message).toBe(false)
    }
    expect(converted[0]).toEqual({ role: 'assistant', content: '上一轮回复' })
  })
})

describe('compressHistory（docs/06 §4 长上下文摘要）', () => {
  const long = (n: number): StoredMessage[] =>
    Array.from({ length: n }, (_item, index) =>
      msg({ id: `${index}`, role: 'user', content: `第${index}轮问题` }),
    )

  it('未触发截断时不调用 summarizer', async () => {
    let called = 0
    const result = await compressHistory([msg({ id: '1', role: 'user', content: 'hi' })], {
      maxChars: 1000,
      summarize: async () => {
        called += 1
        return '摘要'
      },
    })
    expect(called).toBe(0)
    expect(result.compressed).toBe(false)
    expect(result.summary).toBeUndefined()
  })

  it('触发截断时把丢弃的消息交给 summarizer，并回传累计摘要', async () => {
    let received: string[] = []
    const result = await compressHistory(long(6), {
      maxChars: 12,
      summarize: async (input) => {
        received = input.dropped.map((item) => item.content)
        return '用户依次问了第0到第2轮'
      },
    })
    expect(result.compressed).toBe(true)
    expect(result.summary).toBe('用户依次问了第0到第2轮')
    // 丢弃的正是最旧那些消息
    expect(received[0]).toContain('第0轮')
    // 保留的消息仍是最后若干条
    expect(result.messages.at(-1)?.content).toContain('第5轮')
  })

  it('把上一次的累计摘要一并交给 summarizer（增量更新）', async () => {
    let previous: string | undefined
    const result = await compressHistory(long(6), {
      maxChars: 12,
      previousSummary: '更早的摘要',
      summarize: async (input) => {
        previous = input.previousSummary
        return '合并后的摘要'
      },
    })
    expect(previous).toBe('更早的摘要')
    expect(result.summary).toBe('合并后的摘要')
  })

  it('summarizer 抛错时回落纯截断，并保留已有摘要', async () => {
    const truncated = truncateHistory(long(6), { maxChars: 12 })
    const result = await compressHistory(long(6), {
      maxChars: 12,
      previousSummary: '旧摘要',
      summarize: async () => {
        throw new Error('模型不可用')
      },
    })
    expect(result.compressed).toBe(false)
    expect(result.summary).toBe('旧摘要')
    // 与纯截断的结果完全一致
    expect(result.messages.map((item) => item.id)).toEqual(
      truncated.messages.map((item) => item.id),
    )
  })

  it('summarizer 返回空串时视为失败（不写入空摘要）', async () => {
    const result = await compressHistory(long(6), {
      maxChars: 12,
      summarize: async () => '   ',
    })
    expect(result.compressed).toBe(false)
    expect(result.summary).toBeUndefined()
  })

  it('未提供 summarizer 时等同于纯截断（调用方可无条件改用本函数）', async () => {
    const truncated = truncateHistory(long(6), { maxChars: 12 })
    const result = await compressHistory(long(6), { maxChars: 12 })
    expect(result.compressed).toBe(false)
    expect(result.messages.map((item) => item.id)).toEqual(
      truncated.messages.map((item) => item.id),
    )
  })

  it('工具调用组不会被摘要流程拆散（保留原有不变量）', () => {
    const messages = [
      msg({ id: '1', role: 'user', content: 'x'.repeat(50) }),
      msg({
        id: '2',
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'use_skill', arguments: '{}', state: 'success' as const }],
      }),
      msg({ id: '3', role: 'tool', content: '结果', toolCallId: 'c1' }),
      msg({ id: '4', role: 'assistant', content: '最终答复' }),
    ]
    const result = truncateHistory(messages, { maxChars: 10 })
    // 保留区里不允许出现孤儿 tool 结果
    const keptIds = result.messages.map((item) => item.id)
    if (keptIds.includes('3')) expect(keptIds).toContain('2')
  })
})

/**
 * quick 会话滑动窗口（docs/06 §4，P1-11）。
 *
 * 判据只取**事实**：过滤结果里是否存在"没有宿主 assistant 的 tool 消息"，
 * 或"宿主 assistant 的结果缺失"。窗口边界按配对组整体判定。
 */
describe('filterMessagesWithinWindow', () => {
  const now = Date.parse('2025-01-01T00:10:00.000Z')
  const windowMs = 5 * 60_000 // 窗口 = [00:05:00, 00:10:00]

  /** 结果里不允许残留孤儿 tool 结果（没有宿主 assistant 携带它的 toolCallId） */
  const orphanToolIds = (kept: readonly StoredMessage[]): string[] =>
    kept
      .filter((message) => message.role === 'tool')
      .filter((message) => {
        const owner = kept.some(
          (candidate) =>
            candidate.role === 'assistant' &&
            (candidate.toolCalls ?? []).some((call) => call.id === message.toolCallId),
        )
        return !owner
      })
      .map((message) => message.id)

  const assistantWithCall = (id: string, createdAt: string, callId: string): StoredMessage =>
    msg({
      id,
      role: 'assistant',
      createdAt,
      toolCalls: [{ id: callId, name: 'task', arguments: '{}', state: 'success' }],
    })

  it('全部在窗内 → 原样保留；全部在窗外 → 整组丢弃', () => {
    const inside = [
      msg({ id: 'u1', role: 'user', createdAt: '2025-01-01T00:06:00.000Z' }),
      assistantWithCall('a1', '2025-01-01T00:06:10.000Z', 'c1'),
      msg({ id: 't1', role: 'tool', toolCallId: 'c1', createdAt: '2025-01-01T00:06:20.000Z' }),
    ]
    expect(filterMessagesWithinWindow(inside, windowMs, now).map((item) => item.id)).toEqual([
      'u1',
      'a1',
      't1',
    ])

    const outside = [
      msg({ id: 'u1', role: 'user', createdAt: '2025-01-01T00:01:00.000Z' }),
      assistantWithCall('a1', '2025-01-01T00:01:10.000Z', 'c1'),
      msg({ id: 't1', role: 'tool', toolCallId: 'c1', createdAt: '2025-01-01T00:01:20.000Z' }),
    ]
    expect(filterMessagesWithinWindow(outside, windowMs, now)).toEqual([])
  })

  it('窗口边界落在 assistant(toolCalls) 与 tool 结果之间 → 宿主被强制保留，无孤儿 tool', () => {
    // 触发条件（P1-11）：长工具从 assistant 落盘到结果落盘超过窗口
    const messages = [
      msg({ id: 'u1', role: 'user', content: 'q', createdAt: '2025-01-01T00:01:00.000Z' }),
      // 宿主在窗外（00:04 < cutoff 00:05）……
      assistantWithCall('a1', '2025-01-01T00:04:00.000Z', 'c1'),
      // ……结果在窗内
      msg({
        id: 't1',
        role: 'tool',
        content: 'r',
        toolCallId: 'c1',
        createdAt: '2025-01-01T00:06:00.000Z',
      }),
      msg({ id: 'u2', role: 'user', content: 'q2', createdAt: '2025-01-01T00:09:30.000Z' }),
    ]
    const kept = filterMessagesWithinWindow(messages, windowMs, now)
    // 宿主被向前回拉进来（与 truncateHistory 的孤儿防御同口径），整组原子保留
    expect(kept.map((item) => item.id)).toEqual(['a1', 't1', 'u2'])
    expect(orphanToolIds(kept)).toEqual([])
  })

  it('同一宿主的多个 tool 结果被边界切到两侧 → 整组保留（不会只留一半配对）', () => {
    const messages = [
      msg({
        id: 'a1',
        role: 'assistant',
        createdAt: '2025-01-01T00:04:00.000Z',
        toolCalls: [
          { id: 'c1', name: 'task', arguments: '{}', state: 'success' },
          { id: 'c2', name: 'task', arguments: '{}', state: 'success' },
        ],
      }),
      msg({ id: 't1', role: 'tool', toolCallId: 'c1', createdAt: '2025-01-01T00:04:30.000Z' }),
      msg({ id: 't2', role: 'tool', toolCallId: 'c2', createdAt: '2025-01-01T00:06:00.000Z' }),
    ]
    const kept = filterMessagesWithinWindow(messages, windowMs, now)
    expect(kept.map((item) => item.id)).toEqual(['a1', 't1', 't2'])
    expect(orphanToolIds(kept)).toEqual([])
  })

  it('找不到宿主的真孤儿 tool 消息一律丢弃（宿主从未落盘）', () => {
    const messages = [
      msg({
        id: 't0',
        role: 'tool',
        content: 'orphan',
        toolCallId: 'missing',
        createdAt: '2025-01-01T00:09:00.000Z',
      }),
      msg({ id: 'u1', role: 'user', content: 'q', createdAt: '2025-01-01T00:09:30.000Z' }),
    ]
    const kept = filterMessagesWithinWindow(messages, windowMs, now)
    expect(kept.map((item) => item.id)).toEqual(['u1'])
    expect(orphanToolIds(kept)).toEqual([])
  })

  it('时间戳非法按窗外处理；windowMs<=0 返回新数组且不改入参', () => {
    const messages = [
      msg({ id: 'bad', role: 'user', createdAt: '不是时间' }),
      msg({ id: 'ok', role: 'user', createdAt: '2025-01-01T00:09:00.000Z' }),
    ]
    expect(filterMessagesWithinWindow(messages, windowMs, now).map((item) => item.id)).toEqual([
      'ok',
    ])

    const disabled = filterMessagesWithinWindow(messages, 0, now)
    expect(disabled).toEqual(messages)
    expect(disabled).not.toBe(messages)
  })
})
