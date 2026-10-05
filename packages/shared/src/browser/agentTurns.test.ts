import { describe, expect, it } from 'vitest'
import { formatTurnDuration, groupAgentTurns, selectFinalAssistant } from './agentTurns.js'

interface Item {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  requestId?: string
}

describe('groupAgentTurns', () => {
  it('把同一 requestId 的连续助手消息合成一组，并保留用户边界', () => {
    const rows = groupAgentTurns<Item>([
      { id: 'u1', role: 'user', content: 'q1', requestId: 'r1' },
      { id: 'a1', role: 'assistant', content: 'work 1', requestId: 'r1' },
      { id: 'a2', role: 'assistant', content: 'final 1', requestId: 'r1' },
      { id: 'u2', role: 'user', content: 'q2', requestId: 'r2' },
      { id: 'a3', role: 'assistant', content: 'final 2', requestId: 'r2' },
    ])

    expect(rows.map((row) => row.kind)).toEqual(['message', 'turn', 'message', 'turn'])
    expect(rows[1]).toMatchObject({ key: 'request:r1', requestId: 'r1' })
    if (rows[1]?.kind === 'turn')
      expect(rows[1].messages.map((item) => item.id)).toEqual(['a1', 'a2'])
  })

  it('不同 requestId 的相邻助手消息分成两组', () => {
    const rows = groupAgentTurns<Item>([
      { id: 'a1', role: 'assistant', content: 'first', requestId: 'r1' },
      { id: 'a2', role: 'assistant', content: 'second', requestId: 'r2' },
    ])

    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.kind === 'turn')).toBe(true)
  })

  it('旧历史缺 requestId 时按相邻助手消息回退分组', () => {
    const rows = groupAgentTurns<Item>([
      { id: 'a1', role: 'assistant', content: 'work' },
      { id: 'a2', role: 'assistant', content: 'final' },
      { id: 's1', role: 'system', content: 'compact' },
      { id: 'a3', role: 'assistant', content: 'next' },
    ])

    expect(rows.map((row) => row.kind)).toEqual(['turn', 'message', 'turn'])
    expect(rows[0]).toMatchObject({ key: 'legacy:a1:2' })
    expect(rows[2]).toMatchObject({ key: 'legacy:a3:1' })
  })

  it('一侧缺 requestId 时保持相邻兼容，不把新消息从旧请求中切开', () => {
    const rows = groupAgentTurns<Item>([
      { id: 'a1', role: 'assistant', content: 'first', requestId: 'r1' },
      { id: 'a2', role: 'assistant', content: 'compat' },
    ])

    expect(rows).toHaveLength(1)
    if (rows[0]?.kind === 'turn') expect(rows[0].messages).toHaveLength(2)
  })
})

describe('selectFinalAssistant', () => {
  it('选择最后一条正文非空的助手消息，跳过纯工具轮', () => {
    expect(
      selectFinalAssistant([
        { id: 'a1', role: 'assistant', content: '工作中' },
        { id: 'a2', role: 'assistant', content: '' },
        { id: 'a3', role: 'assistant', content: '最终结论' },
      ])?.id,
    ).toBe('a3')
  })

  it('没有正文时返回 undefined', () => {
    expect(selectFinalAssistant([{ id: 'a1', role: 'assistant', content: '   ' }])).toBeUndefined()
  })
})

describe('formatTurnDuration', () => {
  it('使用与工具耗时一致的紧凑秒数口径', () => {
    expect(formatTurnDuration(50)).toBe('<0.1s')
    expect(formatTurnDuration(12_340)).toBe('12.3s')
    expect(formatTurnDuration(-1)).toBe('')
  })
})
