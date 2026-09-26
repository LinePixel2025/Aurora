import { describe, expect, it, vi } from 'vitest'
import { SessionBridge, type AgentLike } from './session-bridge.js'
import type { AgentEvent, Logger } from '@aurora/shared'

function makeAgent(): AgentLike & { events: AgentEvent[]; emit(event: AgentEvent): void } {
  const listeners = new Set<(event: AgentEvent) => void>()
  return {
    events: [],
    send: vi.fn(async (_request) => {
      return { requestId: 'req-from-agent' }
    }),
    abort: vi.fn(() => true),
    onEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit(event: AgentEvent): void {
      for (const listener of listeners) listener(event)
    },
  }
}

const logger = { warn: () => {} } as unknown as Logger

describe('SessionBridge · 远程会话', () => {
  it('handleInput 走 agent.send（origin: center）并回 agentRequestId', async () => {
    const agent = makeAgent()
    const bridge = new SessionBridge({ agent, logger })
    const result = await bridge.handleInput({
      requestId: 'c-1',
      sessionId: 'center-abc',
      text: '帮我查一下',
    })
    expect(agent.send).toHaveBeenCalledWith({
      sessionId: 'center-abc',
      text: '帮我查一下',
      origin: 'center',
    })
    expect(result).toEqual({ ok: true, data: { agentRequestId: 'req-from-agent' } })
  })

  it('非 center- 前缀的会话拒绝（E_BAD_SESSION），绝不把本地会话暴露给远程', async () => {
    const agent = makeAgent()
    const bridge = new SessionBridge({ agent, logger })
    const result = await bridge.handleInput({ requestId: 'c-1', sessionId: 'quick', text: '你好' })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('E_BAD_SESSION')
    expect(agent.send).not.toHaveBeenCalled()
  })

  it('handleAbort 转发 agent.abort；未在跑的请求回 E_NOT_RUNNING', () => {
    const agent = makeAgent()
    const bridge = new SessionBridge({ agent, logger })
    const ok = bridge.handleAbort({
      requestId: 'c-2',
      sessionId: 'center-x',
      agentRequestId: 'req-9',
    })
    expect(ok.ok).toBe(true)
    expect(agent.abort).toHaveBeenCalledWith('req-9')
    ;(agent.abort as ReturnType<typeof vi.fn>).mockReturnValue(false)
    const miss = bridge.handleAbort({
      requestId: 'c-3',
      sessionId: 'center-x',
      agentRequestId: 'req-10',
    })
    expect(miss.ok).toBe(false)
    expect(miss.error).toBe('E_NOT_RUNNING')
  })

  it('只转发 center- 前缀会话的事件；未绑定 emit 时事件丢弃', () => {
    const agent = makeAgent()
    const bridge = new SessionBridge({ agent, logger })
    const seen: unknown[] = []
    bridge.bindEmit((message) => seen.push(message))

    agent.emit({
      seq: 1,
      type: 'user-message',
      sessionId: 'quick',
      requestId: 'r',
      content: 'x',
      createdAt: 0,
    } as AgentEvent)
    agent.emit({
      seq: 2,
      type: 'user-message',
      sessionId: 'center-abc',
      requestId: 'r',
      content: 'y',
      createdAt: 0,
    } as AgentEvent)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ type: 'session.event', sessionId: 'center-abc' })

    bridge.bindEmit(undefined)
    agent.emit({
      seq: 3,
      type: 'user-message',
      sessionId: 'center-abc',
      requestId: 'r',
      content: 'z',
      createdAt: 0,
    } as AgentEvent)
    expect(seen).toHaveLength(1)
  })
})
