import { describe, expect, it, vi } from 'vitest'
import { SessionBridge, toAskRequest, toConfirmRequest, type AgentLike } from './session-bridge.js'
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

describe('toConfirmRequest · 确认卡上行消息', () => {
  it('SensitiveToolRequest → ConfirmRequestPayload：补 createdAt，其余字段原样对齐', () => {
    const message = toConfirmRequest({
      confirmId: 'confirm-abc-1',
      toolName: 'run_command',
      input: { command: 'npm test', cwd: 'D:/repo' },
      sessionId: 'center-abc',
      expiresAt: '2026-09-27T00:01:00.000Z',
    })
    expect(message.type).toBe('confirm.request')
    expect(message.request).toMatchObject({
      confirmId: 'confirm-abc-1',
      sessionId: 'center-abc',
      toolName: 'run_command',
      input: { command: 'npm test', cwd: 'D:/repo' },
      expiresAt: '2026-09-27T00:01:00.000Z',
    })
    // createdAt 是发送时刻：合法的 ISO 时间戳即可
    expect(Number.isNaN(Date.parse(message.request.createdAt))).toBe(false)
  })
})

describe('toAskRequest · 提问上行消息（v0.3.3）', () => {
  it('AskUserRequest → ask.request：逐字段照搬，expiresAt 保持毫秒数（不是 ISO 串）', () => {
    const expiresAt = Date.now() + 180_000
    const message = toAskRequest({
      requestId: 'ask-abc-1',
      sessionId: 'center-abc',
      question: '把产物放哪个目录？',
      header: '目标目录',
      options: [{ label: 'dist' }, { label: 'out', description: '自定义' }],
      multiSelect: true,
      expiresAt,
    })
    expect(message.type).toBe('ask.request')
    expect(message.request).toEqual({
      requestId: 'ask-abc-1',
      sessionId: 'center-abc',
      question: '把产物放哪个目录？',
      header: '目标目录',
      options: [{ label: 'dist' }, { label: 'out', description: '自定义' }],
      multiSelect: true,
      expiresAt,
    })
  })

  it('可选字段缺省时不补 undefined 键（自由填写 / 无标题的卡片），且可 JSON 往返', () => {
    const message = toAskRequest({
      requestId: 'ask-abc-2',
      sessionId: 'center-abc',
      question: '继续吗？',
      multiSelect: false,
      expiresAt: 1_800_000_000_000,
    })
    expect(message.request).toEqual({
      requestId: 'ask-abc-2',
      sessionId: 'center-abc',
      question: '继续吗？',
      multiSelect: false,
      expiresAt: 1_800_000_000_000,
    })
    expect('header' in message.request).toBe(false)
    expect('options' in message.request).toBe(false)
    expect(JSON.parse(JSON.stringify(message))).toEqual(message)
  })
})
