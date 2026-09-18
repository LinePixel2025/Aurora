import { describe, expect, it } from 'vitest'
import { runAgentLoop, type AgentLoopEvent } from './agentLoop.js'
import { ToolRegistry } from '../tools/registry.js'
import { createFakeProvider } from '../testing/fakeProvider.js'
import type { NewMessage, StoredMessage } from '../session/types.js'

/** 极简内存会话：记录落盘顺序，等价于 SessionStore 的可观察行为 */
function createRecorder() {
  const messages: StoredMessage[] = []
  let counter = 0
  return {
    messages,
    append: (message: NewMessage): Promise<StoredMessage> => {
      counter += 1
      const stored: StoredMessage = {
        id: `msg-${counter}`,
        role: message.role,
        content: message.content,
        createdAt: '2025-01-01T00:00:00.000Z',
        ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls }),
        ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
      }
      messages.push(stored)
      return Promise.resolve(stored)
    },
    updateToolCall: (
      messageId: string,
      call: StoredMessage['toolCalls'] extends undefined
        ? never
        : NonNullable<StoredMessage['toolCalls']>[number],
    ): Promise<void> => {
      const target = messages.find((item) => item.id === messageId)
      if (target === undefined) return Promise.resolve()
      const calls = target.toolCalls ?? []
      const index = calls.findIndex((item) => item.id === call.id)
      if (index >= 0) calls[index] = { ...call }
      else calls.push({ ...call })
      target.toolCalls = calls
      return Promise.resolve()
    },
    toolLog: [] as Array<{ name: string; sensitivity: string; isError: boolean }>,
  }
}

function registryWithEcho(): ToolRegistry {
  const tools = new ToolRegistry()
  tools.register({
    name: 'echo',
    description: '回显输入',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    execute: async (input) => {
      const text = (input as { text?: string }).text ?? ''
      return { content: `echo:${text}`, summary: `echo ${text}` }
    },
  })
  return tools
}

async function drain(iterable: AsyncIterable<AgentLoopEvent>): Promise<AgentLoopEvent[]> {
  const events: AgentLoopEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

describe('runAgentLoop', () => {
  it('无工具调用：一轮结束并落盘用户 + 助手消息', async () => {
    const rec = createRecorder()
    const provider = createFakeProvider([{ text: '你好' }])
    const events = await drain(
      runAgentLoop({
        provider,
        model: 'm',
        systemPrompt: 'sys',
        userInput: '在吗',
        history: [],
        tools: new ToolRegistry(),
        sessionId: 'quick',
        append: rec.append,
        updateToolCall: rec.updateToolCall,
      }),
    )

    expect(events.map((event) => event.type)).toEqual(['text', 'done'])
    expect(rec.messages.map((item) => item.role)).toEqual(['user', 'assistant'])
    expect(rec.messages[1]?.content).toBe('你好')
    // 系统提示词 + 用户消息
    expect(provider.calls[0]?.messages.map((item) => item.role)).toEqual(['system', 'user'])
  })

  it('单工具调用：执行 → 回填 tool 结果 → 第二轮产出最终回复', async () => {
    const rec = createRecorder()
    const provider = createFakeProvider([
      { toolCalls: [{ id: 'c1', name: 'echo', arguments: '{"text":"hi"}' }] },
      { text: '完成' },
    ])
    const events = await drain(
      runAgentLoop({
        provider,
        model: 'm',
        systemPrompt: 'sys',
        userInput: 'echo hi',
        history: [],
        tools: registryWithEcho(),
        sessionId: 'quick',
        append: rec.append,
        updateToolCall: rec.updateToolCall,
      }),
    )

    const toolEvents = events.filter((event) => event.type === 'tool')
    expect(toolEvents.map((event) => event.call.state)).toEqual(['running', 'success'])
    expect(toolEvents[1]?.call.outputSummary).toBe('echo hi')
    expect(events.at(-1)?.type).toBe('done')

    // 落盘顺序：user → assistant(toolCalls) → tool → assistant(最终文本)
    expect(rec.messages.map((item) => item.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ])
    expect(rec.messages[1]?.toolCalls?.[0]?.state).toBe('success')
    expect(rec.messages[2]?.toolCallId).toBe('c1')
    // 第二轮请求必须带 tool 结果与 assistant toolCalls
    expect(provider.calls[1]?.messages.map((item) => item.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ])
  })

  it('同轮多工具按顺序执行', async () => {
    const rec = createRecorder()
    const provider = createFakeProvider([
      {
        toolCalls: [
          { id: 'a', name: 'echo', arguments: '{"text":"1"}' },
          { id: 'b', name: 'echo', arguments: '{"text":"2"}' },
        ],
      },
      { text: '好' },
    ])
    const events = await drain(
      runAgentLoop({
        provider,
        model: 'm',
        systemPrompt: 'sys',
        userInput: 'x',
        history: [],
        tools: registryWithEcho(),
        sessionId: 'quick',
        append: rec.append,
        updateToolCall: rec.updateToolCall,
      }),
    )
    const toolEvents = events.filter((event) => event.type === 'tool')
    expect(toolEvents.map((event) => event.call.id)).toEqual(['a', 'a', 'b', 'b'])
    expect(toolEvents.map((event) => event.call.state)).toEqual([
      'running',
      'success',
      'running',
      'success',
    ])
    expect(toolEvents.map((event) => event.call.outputSummary)).toEqual([
      undefined,
      'echo 1',
      undefined,
      'echo 2',
    ])
  })

  it('未知工具：以错误文本回填且不中断循环', async () => {
    const rec = createRecorder()
    const provider = createFakeProvider([
      { toolCalls: [{ id: 'x', name: 'nope' }] },
      { text: '知道了' },
    ])
    const events = await drain(
      runAgentLoop({
        provider,
        model: 'm',
        systemPrompt: 'sys',
        userInput: 'x',
        history: [],
        tools: registryWithEcho(),
        sessionId: 'quick',
        append: rec.append,
        updateToolCall: rec.updateToolCall,
      }),
    )
    const states = events.filter((event) => event.type === 'tool').map((event) => event.call.state)
    expect(states).toEqual(['running', 'error'])
    expect(rec.messages.find((item) => item.role === 'tool')?.content).toContain('不存在')
    expect(events.at(-1)?.type).toBe('done')
  })

  it('工具抛错被捕获为 error 结果', async () => {
    const rec = createRecorder()
    const tools = new ToolRegistry()
    tools.register({
      name: 'boom',
      description: 'throw',
      parameters: { type: 'object' },
      execute: async () => {
        throw new Error('内部错误')
      },
    })
    const provider = createFakeProvider([
      { toolCalls: [{ id: 'b', name: 'boom' }] },
      { text: 'ok' },
    ])
    const events = await drain(
      runAgentLoop({
        provider,
        model: 'm',
        systemPrompt: 'sys',
        userInput: 'x',
        history: [],
        tools,
        sessionId: 'quick',
        append: rec.append,
        updateToolCall: rec.updateToolCall,
      }),
    )
    const last = events.filter((event) => event.type === 'tool').at(-1)
    expect(last?.call.state).toBe('error')
    expect(last?.call.outputSummary).toContain('内部错误')
  })

  it('参数不是合法 JSON：直接判错，不执行工具', async () => {
    const rec = createRecorder()
    let executed = false
    const tools = new ToolRegistry()
    tools.register({
      name: 'echo',
      description: 'echo',
      parameters: { type: 'object' },
      execute: async () => {
        executed = true
        return { content: 'x' }
      },
    })
    const provider = createFakeProvider([
      { toolCalls: [{ id: 'c', name: 'echo', arguments: '{bad json' }] },
      { text: 'ok' },
    ])
    const events = await drain(
      runAgentLoop({
        provider,
        model: 'm',
        systemPrompt: 'sys',
        userInput: 'x',
        history: [],
        tools,
        sessionId: 'quick',
        append: rec.append,
        updateToolCall: rec.updateToolCall,
      }),
    )
    expect(executed).toBe(false)
    expect(events.filter((event) => event.type === 'tool').at(-1)?.call.state).toBe('error')
  })

  it('LLM 抛错：已产出文本先落盘，再上报 error', async () => {
    const rec = createRecorder()
    const provider = createFakeProvider([
      { text: '部分输出', error: { code: 'E_RATE_LIMIT', message: '限流' } },
    ])
    const events = await drain(
      runAgentLoop({
        provider,
        model: 'm',
        systemPrompt: 'sys',
        userInput: 'x',
        history: [],
        tools: new ToolRegistry(),
        sessionId: 'quick',
        append: rec.append,
        updateToolCall: rec.updateToolCall,
      }),
    )
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'E_RATE_LIMIT' })
    expect(rec.messages.map((item) => item.role)).toEqual(['user', 'assistant'])
    expect(rec.messages[1]?.content).toBe('部分输出')
  })

  it('轮次用尽：done 带 pending，且不丢已产出文本', async () => {
    const rec = createRecorder()
    const rounds = Array.from({ length: 8 }, (_item, index) => ({
      text: `第${index}轮`,
      toolCalls: [{ id: `c${index}`, name: 'echo', arguments: '{"text":"x"}' }],
    }))
    const provider = createFakeProvider(rounds)
    const events = await drain(
      runAgentLoop({
        provider,
        model: 'm',
        systemPrompt: 'sys',
        userInput: 'x',
        history: [],
        tools: registryWithEcho(),
        sessionId: 'quick',
        append: rec.append,
        updateToolCall: rec.updateToolCall,
      }),
    )
    expect(events.at(-1)).toMatchObject({ type: 'done', pending: true })
    expect(provider.calls).toHaveLength(8)
  })

  it('maxRounds=1 时不会继续第二轮', async () => {
    const rec = createRecorder()
    const provider = createFakeProvider([
      { toolCalls: [{ id: 'c', name: 'echo', arguments: '{"text":"x"}' }] },
      { text: '不该出现' },
    ])
    const events = await drain(
      runAgentLoop({
        provider,
        model: 'm',
        systemPrompt: 'sys',
        userInput: 'x',
        history: [],
        tools: registryWithEcho(),
        sessionId: 'quick',
        maxRounds: 1,
        append: rec.append,
        updateToolCall: rec.updateToolCall,
      }),
    )
    expect(provider.calls).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'done', pending: true })
  })

  it('abort：立刻以 done 收尾', async () => {
    const rec = createRecorder()
    const controller = new AbortController()
    controller.abort()
    const provider = createFakeProvider([{ text: '不会走' }])
    const events = await drain(
      runAgentLoop({
        provider,
        model: 'm',
        systemPrompt: 'sys',
        userInput: 'x',
        history: [],
        tools: new ToolRegistry(),
        sessionId: 'quick',
        signal: controller.signal,
        append: rec.append,
        updateToolCall: rec.updateToolCall,
      }),
    )
    expect(events.map((event) => event.type)).toEqual(['done'])
    expect(provider.calls).toHaveLength(0)
  })

  it('extraContext 作为 system 消息插在用户消息之后，且不进历史', async () => {
    const rec = createRecorder()
    const provider = createFakeProvider([{ text: 'ok' }])
    await drain(
      runAgentLoop({
        provider,
        model: 'm',
        systemPrompt: 'sys',
        userInput: '问题',
        extraContext: '技能正文',
        history: [],
        tools: new ToolRegistry(),
        sessionId: 'quick',
        append: rec.append,
        updateToolCall: rec.updateToolCall,
      }),
    )
    expect(provider.calls[0]?.messages.map((item) => item.content)).toEqual([
      'sys',
      '问题',
      '技能正文',
    ])
    expect(rec.messages.map((item) => item.role)).toEqual(['user', 'assistant'])
  })

  it('历史消息按角色还原（含工具调用对）', async () => {
    const rec = createRecorder()
    const provider = createFakeProvider([{ text: 'ok' }])
    const history: StoredMessage[] = [
      { id: 'h1', role: 'system', content: '旧系统提示词', createdAt: '' },
      { id: 'h2', role: 'user', content: '旧提问', createdAt: '' },
      {
        id: 'h3',
        role: 'assistant',
        content: '',
        createdAt: '',
        toolCalls: [{ id: 'c9', name: 'echo', arguments: '{}', state: 'success' }],
      },
      { id: 'h4', role: 'tool', content: '旧工具结果', createdAt: '', toolCallId: 'c9' },
    ]
    await drain(
      runAgentLoop({
        provider,
        model: 'm',
        systemPrompt: 'sys',
        userInput: '新提问',
        history,
        tools: registryWithEcho(),
        sessionId: 'quick',
        append: rec.append,
        updateToolCall: rec.updateToolCall,
      }),
    )
    const sent = provider.calls[0]?.messages ?? []
    expect(sent.map((item) => item.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user'])
    expect(sent[2]?.toolCalls?.[0]?.id).toBe('c9')
    expect(sent[3]?.toolCallId).toBe('c9')
  })

  it('onToolCall 留痕（名称 / 敏感级 / 是否失败）', async () => {
    const rec = createRecorder()
    const provider = createFakeProvider([
      { toolCalls: [{ id: 'c', name: 'echo', arguments: '{}' }] },
      { text: 'ok' },
    ])
    await drain(
      runAgentLoop({
        provider,
        model: 'm',
        systemPrompt: 'sys',
        userInput: 'x',
        history: [],
        tools: registryWithEcho(),
        sessionId: 'quick',
        append: rec.append,
        updateToolCall: rec.updateToolCall,
        onToolCall: (info) => rec.toolLog.push(info),
      }),
    )
    expect(rec.toolLog).toEqual([{ name: 'echo', sensitivity: 'safe', isError: false }])
  })
})
