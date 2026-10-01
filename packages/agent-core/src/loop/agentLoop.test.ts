import { describe, expect, it } from 'vitest'
import {
  runAgentLoop,
  type AgentLoopEvent,
  type ConfirmDecision,
  type LoopProvider,
} from './agentLoop.js'
import { ToolRegistry } from '../tools/registry.js'
import { createFakeProvider } from '../testing/fakeProvider.js'
import type { ChatEvent } from '../llm/types.js'
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
        ...(message.reasoning === undefined ? {} : { reasoning: message.reasoning }),
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
        maxRounds: 8,
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

  /**
   * 请求形状回归（docs/06 §21）：
   * 系统提示词稳居首位、历史依次紧随、本轮输入与易变上下文都在尾部，
   * 且发给 provider 的 `tools` 数组已按工具名字典序 —— 这四条合起来就是「前缀可缓存」。
   */
  describe('请求形状：系统提示词与 tools 数组的顺序稳定性（docs/06 §21）', () => {
    /** 按给定顺序注册一组工具（名字刻意非字典序，用来暴露「按注册序返回」的旧行为） */
    function registryWithTools(names: readonly string[]): ToolRegistry {
      const tools = new ToolRegistry()
      for (const name of names) {
        tools.register({
          name,
          description: `tool ${name}`,
          parameters: { type: 'object', properties: {} },
          execute: async () => ({ content: 'ok' }),
        })
      }
      return tools
    }

    it('messages[0] 是 system 且内容就是传入的 systemPrompt', async () => {
      const rec = createRecorder()
      const provider = createFakeProvider([{ text: 'ok' }])
      await drain(
        runAgentLoop({
          provider,
          model: 'm',
          systemPrompt: '完整系统提示词',
          userInput: '在吗',
          history: [],
          tools: new ToolRegistry(),
          sessionId: 'quick',
          append: rec.append,
          updateToolCall: rec.updateToolCall,
        }),
      )
      const sent = provider.calls[0]?.messages ?? []
      expect(sent[0]?.role).toBe('system')
      expect(sent[0]?.content).toBe('完整系统提示词')
    })

    it('有历史时 messages[1..n-1] 依次是历史，最后一条是本轮输入', async () => {
      const rec = createRecorder()
      const provider = createFakeProvider([{ text: 'ok' }])
      const history: StoredMessage[] = [
        { id: 'h1', role: 'user', content: '旧提问', createdAt: '' },
        { id: 'h2', role: 'assistant', content: '旧回复', createdAt: '' },
      ]
      await drain(
        runAgentLoop({
          provider,
          model: 'm',
          systemPrompt: 'sys',
          userInput: '新提问',
          history,
          tools: new ToolRegistry(),
          sessionId: 'quick',
          append: rec.append,
          updateToolCall: rec.updateToolCall,
        }),
      )
      const sent = provider.calls[0]?.messages ?? []
      expect(sent.map((item) => item.role)).toEqual(['system', 'user', 'assistant', 'user'])
      expect(sent.slice(1, -1).map((item) => item.content)).toEqual(['旧提问', '旧回复'])
      expect(sent.at(-1)).toMatchObject({ role: 'user', content: '新提问' })
    })

    it('extraContext 是最后一条（易变内容靠尾部）', async () => {
      const rec = createRecorder()
      const provider = createFakeProvider([{ text: 'ok' }])
      await drain(
        runAgentLoop({
          provider,
          model: 'm',
          systemPrompt: 'sys',
          userInput: '问题',
          extraContext: '技能正文',
          history: [{ id: 'h1', role: 'user', content: '旧提问', createdAt: '' }],
          tools: new ToolRegistry(),
          sessionId: 'quick',
          append: rec.append,
          updateToolCall: rec.updateToolCall,
        }),
      )
      const sent = provider.calls[0]?.messages ?? []
      expect(sent.map((item) => item.content)).toEqual(['sys', '旧提问', '问题', '技能正文'])
      expect(sent.at(-1)).toMatchObject({ role: 'system', content: '技能正文' })
    })

    it('tools 数组已按工具名字典序（排序的生效点在循环里，不在注册表之外）', async () => {
      const rec = createRecorder()
      const provider = createFakeProvider([{ text: 'ok' }])
      await drain(
        runAgentLoop({
          provider,
          model: 'm',
          systemPrompt: 'sys',
          userInput: 'x',
          history: [],
          tools: registryWithTools(['read_file', 'grep', 'glob', 'edit_file']),
          sessionId: 'quick',
          append: rec.append,
          updateToolCall: rec.updateToolCall,
        }),
      )
      expect(provider.calls[0]?.tools?.map((tool) => tool.name)).toEqual([
        'edit_file',
        'glob',
        'grep',
        'read_file',
      ])
    })
  })

  describe('思考链（reasoning，Design/betav2-spec.md §6）', () => {
    it('增量边到边转发，并累积持久化到当条 assistant 消息', async () => {
      const rec = createRecorder()
      const provider = createFakeProvider([{ reasoning: ['让我', '想想'], text: '答案是 4' }])
      const events = await drain(
        runAgentLoop({
          provider,
          model: 'm',
          systemPrompt: 'sys',
          userInput: '2+2',
          history: [],
          tools: new ToolRegistry(),
          sessionId: 'quick',
          append: rec.append,
          updateToolCall: rec.updateToolCall,
        }),
      )

      // 每个增量一条事件，且先于 text 事件
      expect(events.map((event) => event.type)).toEqual(['reasoning', 'reasoning', 'text', 'done'])
      expect(
        events
          .filter(
            (event): event is Extract<AgentLoopEvent, { type: 'reasoning' }> =>
              event.type === 'reasoning',
          )
          .map((event) => event.delta),
      ).toEqual(['让我', '想想'])

      const assistant = rec.messages.find((message) => message.role === 'assistant')
      expect(assistant?.reasoning).toBe('让我想想')
      expect(assistant?.content).toBe('答案是 4')
    })

    it('没有思考链时 assistant 消息不落 reasoning 字段', async () => {
      const rec = createRecorder()
      const provider = createFakeProvider([{ text: '你好' }])
      await drain(
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
      const assistant = rec.messages.find((message) => message.role === 'assistant')
      expect(assistant?.reasoning).toBeUndefined()
      expect('reasoning' in (assistant ?? {})).toBe(false)
    })

    it('reasoning 绝不回传给 API（含历史还原路径）', async () => {
      const rec = createRecorder()
      const provider = createFakeProvider([
        { reasoning: ['第一轮思考'], toolCalls: [{ id: 'c1', name: 'nope' }] },
        { reasoning: ['第二轮思考'], text: '最终回答' },
      ])
      // 历史里也种一条带 reasoning 的旧助手消息，模拟上一轮留下的痕迹
      const history: StoredMessage[] = [
        {
          id: 'h1',
          role: 'assistant',
          content: '旧回复',
          createdAt: '',
          reasoning: '旧思考过程，绝不能出门',
        },
      ]
      await drain(
        runAgentLoop({
          provider,
          model: 'm',
          systemPrompt: 'sys',
          userInput: '继续',
          history,
          tools: registryWithEcho(),
          sessionId: 'quick',
          append: rec.append,
          updateToolCall: rec.updateToolCall,
        }),
      )

      // 每一轮请求里的全部消息都不允许出现 reasoning 字段
      expect(provider.calls.length).toBe(2)
      for (const call of provider.calls) {
        for (const message of call.messages) {
          expect('reasoning' in message).toBe(false)
        }
      }
      // 第一轮：历史里的 assistant 按角色还原（reasoning 被丢弃）
      expect(provider.calls[0]?.messages.map((message) => message.role)).toEqual([
        'system',
        'assistant',
        'user',
      ])
      // 第二轮：首轮助手消息（带工具调用）同样不带 reasoning
      expect(provider.calls[1]?.messages.map((message) => message.role)).toEqual([
        'system',
        'assistant',
        'user',
        'assistant',
        'tool',
      ])
      // 但落盘的 assistant 消息必须保留 reasoning（只用于展示）
      const persisted = rec.messages.filter((message) => message.role === 'assistant')
      expect(persisted[0]?.reasoning).toBe('第一轮思考')
      expect(persisted[1]?.reasoning).toBe('第二轮思考')
    })

    it('LLM 中途报错：已产出的思考链随文本一起落盘', async () => {
      const rec = createRecorder()
      const provider = createFakeProvider([
        {
          reasoning: [' partial'],
          text: '部分输出',
          error: { code: 'E_RATE_LIMIT', message: '限流' },
        },
      ])
      await drain(
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
      const assistant = rec.messages.find((message) => message.role === 'assistant')
      expect(assistant?.reasoning).toBe(' partial')
      expect(assistant?.content).toBe('部分输出')
    })
  })

  describe('流中途失败：未执行的 tool_call 收敛为 error（P2-03）', () => {
    /** 注册一个会记录执行次数的工具（用来证明「从未执行」这条语义） */
    function registryWithCounter(counter: { count: number }): ToolRegistry {
      const tools = new ToolRegistry()
      tools.register({
        name: 'echo',
        description: '回显输入',
        parameters: { type: 'object', properties: { text: { type: 'string' } } },
        execute: async (input) => {
          counter.count += 1
          return { content: `echo:${(input as { text?: string }).text ?? ''}` }
        },
      })
      return tools
    }

    it('工具调用增量已产出后流断开：落盘 tool_call 为 error 且从未执行', async () => {
      const rec = createRecorder()
      const executed = { count: 0 }
      const provider = createFakeProvider([
        {
          toolCalls: [{ id: 'c1', name: 'echo', arguments: '{"text":"hi"}' }],
          error: { code: 'E_NETWORK', message: '连接中断' },
        },
      ])
      const events = await drain(
        runAgentLoop({
          provider,
          model: 'm',
          systemPrompt: 'sys',
          userInput: 'x',
          history: [],
          tools: registryWithCounter(executed),
          sessionId: 'quick',
          append: rec.append,
          updateToolCall: rec.updateToolCall,
        }),
      )

      expect(events.at(-1)).toMatchObject({ type: 'error', code: 'E_NETWORK' })
      expect(executed.count).toBe(0)
      // 落盘的卡片必须是终态 error（旧行为留 `running`：界面与「子代理」页永远显示运行中）
      const assistant = rec.messages.find((message) => message.role === 'assistant')
      expect(assistant?.toolCalls?.[0]).toMatchObject({
        id: 'c1',
        name: 'echo',
        state: 'error',
        outputSummary: '流中断未执行',
      })
    })

    it('流中断时已产出的正文照旧落盘，且不会再发起工具执行', async () => {
      const rec = createRecorder()
      const executed = { count: 0 }
      const provider = createFakeProvider([
        {
          text: '部分正文',
          toolCalls: [{ id: 'c1', name: 'echo', arguments: '{}' }],
          error: { code: 'E_SERVER', message: '网关掐流' },
        },
      ])
      await drain(
        runAgentLoop({
          provider,
          model: 'm',
          systemPrompt: 'sys',
          userInput: 'x',
          history: [],
          tools: registryWithCounter(executed),
          sessionId: 'quick',
          append: rec.append,
          updateToolCall: rec.updateToolCall,
        }),
      )

      expect(executed.count).toBe(0)
      expect(rec.messages.some((message) => message.role === 'tool')).toBe(false)
      const assistant = rec.messages.find((message) => message.role === 'assistant')
      expect(assistant?.content).toBe('部分正文')
      expect(assistant?.toolCalls?.[0]?.state).toBe('error')
    })

    it('流中断且 signal 已 abort（用户点停止）：按 aborted 暂停收尾，不是 error', async () => {
      const rec = createRecorder()
      const executed = { count: 0 }
      const controller = new AbortController()
      // 桩：正文之后由 provider 自己触发 abort（等价于「流读到一半用户点了停止」）
      const provider: LoopProvider = {
        id: 'aborting',
        async *chat(): AsyncIterable<ChatEvent> {
          yield { type: 'text', delta: '部分' }
          controller.abort()
          yield { type: 'error', code: 'E_ABORTED', message: '请求已取消' }
        },
      }
      const events = await drain(
        runAgentLoop({
          provider,
          model: 'm',
          systemPrompt: 'sys',
          userInput: 'x',
          history: [],
          tools: registryWithCounter(executed),
          sessionId: 'quick',
          signal: controller.signal,
          append: rec.append,
          updateToolCall: rec.updateToolCall,
        }),
      )

      // 终态是「暂停」而不是「错误」：装配层据此把 job 落成 aborted（点停止的 job
      // 不能被 finishJob 改写成 error / done）
      expect(events.at(-1)).toMatchObject({
        type: 'done',
        pending: true,
        pendingReason: 'aborted',
      })
      expect(events.some((event) => event.type === 'error')).toBe(false)
      // 已产出的正文照旧留在历史里
      expect(rec.messages.find((message) => message.role === 'assistant')?.content).toBe('部分')
    })

    it('同轮多工具中途停止：未执行的那个以 error 落盘，已执行的保留真实终态（P2-03）', async () => {
      const rec = createRecorder()
      const controller = new AbortController()
      const executed: string[] = []
      const tools = new ToolRegistry()
      const register = (name: string): void => {
        tools.register({
          name,
          description: name,
          parameters: { type: 'object', properties: {} },
          execute: async () => {
            executed.push(name)
            // 第 1 个工具执行期间用户点了「停止」——检查点在第 2 个开跑前命中
            if (name === 'first') controller.abort()
            return { content: `${name} ok`, summary: `${name} ok` }
          },
        })
      }
      register('first')
      register('second')

      const provider = createFakeProvider([
        {
          toolCalls: [
            { id: 'c1', name: 'first', arguments: '{}' },
            { id: 'c2', name: 'second', arguments: '{}' },
          ],
        },
        { text: '不该跑到这里' },
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
          signal: controller.signal,
          append: rec.append,
          updateToolCall: rec.updateToolCall,
        }),
      )

      // 终态是「暂停」；第 2 个工具从未开跑
      expect(events.at(-1)).toMatchObject({ type: 'done', pending: true, pendingReason: 'aborted' })
      expect(executed).toEqual(['first'])
      const assistant = rec.messages.find(
        (message) => message.role === 'assistant' && message.toolCalls !== undefined,
      )
      const byId = new Map((assistant?.toolCalls ?? []).map((call) => [call.id, call]))
      // 已执行的保留真实终态；未执行的**不能**停在 running（那会让工具卡永远显示「运行中」）
      expect(byId.get('c1')?.state).toBe('success')
      expect(byId.get('c2')?.state).toBe('error')
      expect(byId.get('c2')?.outputSummary).toBe('已取消未执行')
      // 第 2 个没有产生 tool 结果消息（没有半组配对之外的伪结果）
      expect(rec.messages.filter((message) => message.role === 'tool')).toHaveLength(1)
    })
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

  describe('confirmTool（敏感工具确认，docs/06 §5）', () => {
    /**
     * 注册一个 sensitivity=confirm 的工具，并记录它是否真的被执行、
     * 以及执行时拿到的 `ctx.approvedByUser`（三档权限透传的唯一观察点）。
     */
    function registryWithSensitive(
      executed: { count: number },
      approvals?: Array<boolean | undefined>,
    ): ToolRegistry {
      const tools = new ToolRegistry()
      tools.register({
        name: 'danger',
        description: '危险操作',
        parameters: { type: 'object', properties: {} },
        sensitivity: 'confirm',
        execute: async (_input, ctx) => {
          executed.count += 1
          approvals?.push(ctx.approvedByUser)
          return { content: '已执行危险操作', summary: '已执行' }
        },
      })
      return tools
    }

    async function runWithConfirm(options: {
      executed: { count: number }
      confirmTool?: (info: {
        name: string
        input: unknown
        sessionId: string
        sensitivity: 'confirm'
      }) => Promise<ConfirmDecision>
      /** 收集工具执行时拿到的 `ctx.approvedByUser` */
      approvals?: Array<boolean | undefined>
    }): Promise<{ events: AgentLoopEvent[]; rec: ReturnType<typeof createRecorder> }> {
      const rec = createRecorder()
      const provider = createFakeProvider([
        { toolCalls: [{ id: 'c1', name: 'danger', arguments: '{"path":"D:\\\\x"}' }] },
        { text: '收到' },
      ])
      const events = await drain(
        runAgentLoop({
          provider,
          model: 'm',
          systemPrompt: 'sys',
          userInput: '删掉它',
          history: [],
          tools: registryWithSensitive(options.executed, options.approvals),
          sessionId: 'quick',
          append: rec.append,
          updateToolCall: rec.updateToolCall,
          onToolCall: (info) => rec.toolLog.push(info),
          ...(options.confirmTool === undefined ? {} : { confirmTool: options.confirmTool }),
        }),
      )
      return { events, rec }
    }

    it('用户允许 → 工具真的执行', async () => {
      const executed = { count: 0 }
      const seen: Array<{ name: string; sessionId: string; sensitivity: string }> = []
      const { events } = await runWithConfirm({
        executed,
        confirmTool: async (info) => {
          seen.push({ name: info.name, sessionId: info.sessionId, sensitivity: info.sensitivity })
          return true
        },
      })

      expect(executed.count).toBe(1)
      expect(seen).toEqual([{ name: 'danger', sessionId: 'quick', sensitivity: 'confirm' }])
      const states = events
        .filter((event) => event.type === 'tool')
        .map((event) => event.call.state)
      expect(states).toEqual(['running', 'success'])
      expect(events.at(-1)?.type).toBe('done')
    })

    it('用户拒绝 → 工具不执行，卡片 error，且循环继续让模型收尾', async () => {
      const executed = { count: 0 }
      const { events, rec } = await runWithConfirm({
        executed,
        confirmTool: async () => false,
      })

      expect(executed.count).toBe(0)
      const states = events
        .filter((event) => event.type === 'tool')
        .map((event) => event.call.state)
      expect(states).toEqual(['running', 'error'])
      // 拒绝文本回填给模型，而不是直接中断（逐字断言：只有 `false` 才是拒绝）
      const toolMessage = rec.messages.find((message) => message.role === 'tool')
      expect(toolMessage?.content).toBe(
        '用户拒绝执行工具 "danger"，请勿重复调用；如确有必要，请先向用户说明原因并征得同意。',
      )
      expect(events.at(-1)?.type).toBe('done')
      // 工具留痕标记为失败
      expect(rec.toolLog).toEqual([{ name: 'danger', sensitivity: 'confirm', isError: true }])
    })

    it("用户选「本会话不再询问」（'always'）→ 本次照常执行，不是拒绝", async () => {
      const executed = { count: 0 }
      const { events, rec } = await runWithConfirm({
        executed,
        confirmTool: async () => 'always',
      })

      expect(executed.count).toBe(1)
      const states = events
        .filter((event) => event.type === 'tool')
        .map((event) => event.call.state)
      expect(states).toEqual(['running', 'success'])
      expect(rec.messages.find((message) => message.role === 'tool')?.content).toBe(
        '已执行危险操作',
      )
      expect(events.at(-1)?.type).toBe('done')
    })

    it('放行时把 approvedByUser 透传给工具；未注入确认钩子时保持 undefined', async () => {
      // ① 确认卡片放行（true）→ true
      const approved: Array<boolean | undefined> = []
      await runWithConfirm({
        executed: { count: 0 },
        confirmTool: async () => true,
        approvals: approved,
      })
      // ② 'always' 同样算"已获批准"
      const always: Array<boolean | undefined> = []
      await runWithConfirm({
        executed: { count: 0 },
        confirmTool: async () => 'always',
        approvals: always,
      })
      // ③ 没接确认钩子时并没有"用户批准"这回事 → 字段整个不出现（保持今天的行为）
      const none: Array<boolean | undefined> = []
      await runWithConfirm({ executed: { count: 0 }, approvals: none })

      expect(approved).toEqual([true])
      expect(always).toEqual([true])
      expect(none).toEqual([undefined])
    })

    it("confirmTool 返回 'machine'（机器放行）→ 工具照常执行，但 ctx 不带 approvedByUser", async () => {
      const executed = { count: 0 }
      const approvals: Array<boolean | undefined> = []
      const { events, rec } = await runWithConfirm({
        executed,
        confirmTool: async () => 'machine',
        approvals,
      })

      // 机器放行不是拒绝：工具照常执行（auto 根内 / 免确认模式 / 会话授权短路都走这里）
      expect(executed.count).toBe(1)
      const states = events
        .filter((event) => event.type === 'tool')
        .map((event) => event.call.state)
      expect(states).toEqual(['running', 'success'])
      expect(rec.messages.find((message) => message.role === 'tool')?.content).toBe(
        '已执行危险操作',
      )
      expect(events.at(-1)?.type).toBe('done')
      // 但出处不是用户当次看卡片 → 不置 approvedByUser，端口层项目根 realpath 兜底保留
      expect(approvals).toEqual([undefined])
    })

    it('确认链路抛错 → 按拒绝处理（不越权执行）', async () => {
      const executed = { count: 0 }
      const { events } = await runWithConfirm({
        executed,
        confirmTool: async () => {
          throw new Error('确认通道断了')
        },
      })

      expect(executed.count).toBe(0)
      const states = events
        .filter((event) => event.type === 'tool')
        .map((event) => event.call.state)
      expect(states).toEqual(['running', 'error'])
    })

    it('未注入 confirmTool → 保持 v0.3.0 行为（不拦截，直接执行）', async () => {
      const executed = { count: 0 }
      const { events } = await runWithConfirm({ executed })

      expect(executed.count).toBe(1)
      const states = events
        .filter((event) => event.type === 'tool')
        .map((event) => event.call.state)
      expect(states).toEqual(['running', 'success'])
    })

    it('confirmTool 收到解析后的参数对象（不是原始字符串）', async () => {
      const executed = { count: 0 }
      let received: unknown
      await runWithConfirm({
        executed,
        confirmTool: async (info) => {
          received = info.input
          return true
        },
      })
      expect(received).toEqual({ path: 'D:\\x' })
    })

    it('safe 级工具不触发确认', async () => {
      const rec = createRecorder()
      const provider = createFakeProvider([
        { toolCalls: [{ id: 'c', name: 'echo', arguments: '{"text":"hi"}' }] },
        { text: 'ok' },
      ])
      let confirmCalls = 0
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
          confirmTool: async () => {
            confirmCalls += 1
            return false
          },
        }),
      )
      expect(confirmCalls).toBe(0)
      expect(rec.messages.find((m) => m.role === 'tool')?.content).toBe('echo:hi')
    })

    it('参数不是合法 JSON 时先报错，不触发确认', async () => {
      const executed = { count: 0 }
      const rec = createRecorder()
      const provider = createFakeProvider([
        { toolCalls: [{ id: 'c1', name: 'danger', arguments: '{坏 JSON' }] },
        { text: '收到' },
      ])
      let confirmCalls = 0
      const events = await drain(
        runAgentLoop({
          provider,
          model: 'm',
          systemPrompt: 'sys',
          userInput: 'x',
          history: [],
          tools: registryWithSensitive(executed),
          sessionId: 'quick',
          append: rec.append,
          updateToolCall: rec.updateToolCall,
          confirmTool: async () => {
            confirmCalls += 1
            return true
          },
        }),
      )
      expect(confirmCalls).toBe(0)
      expect(executed.count).toBe(0)
      expect(
        events.filter((event) => event.type === 'tool').map((event) => event.call.state),
      ).toEqual(['running', 'error'])
    })
  })
})

/**
 * 续跑、预算与暂停原因（docs/06 §4.1，v15）。
 *
 * 这一组钉的是"长任务停下来时有说法、能接着跑"：
 * - `resume.nextRound` 从游标继续，且**不重复落盘用户消息**（续跑最经典的 bug）；
 * - 轮次用尽 / 预算用尽 / 被中断分别给 `pendingReason = 'max-rounds' | 'budget' | 'aborted'`；
 * - `onRoundComplete` 每轮被调用一次且带本轮工具，让调用方能在"决定继续之前"落游标。
 */
describe('runAgentLoop · 续跑与预算（v15）', () => {
  /** 每轮都发起一次工具调用的桩：rd-1 → rd-2 → … → 最后一段纯文本 */
  function toolRounds(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      toolCalls: [
        {
          id: `call-${index + 1}`,
          name: 'echo',
          arguments: JSON.stringify({ text: `r${index + 1}` }),
        },
      ],
      // 每轮 100 token：预算用例据此在**第一轮结束之后**触顶
      usage: { promptTokens: 60, completionTokens: 40, totalTokens: 100 },
    }))
  }

  it('resume.nextRound：从游标轮次继续，且不重复落盘用户消息', async () => {
    const rec = createRecorder()
    const provider = createFakeProvider([{ text: '收尾' }])
    const events = await drain(
      runAgentLoop({
        provider,
        model: 'm',
        systemPrompt: 'sys',
        userInput: '原始提问',
        history: [{ id: 'msg-0', role: 'user', content: '原始提问', createdAt: 't' }],
        tools: registryWithEcho(),
        sessionId: 's1',
        resume: { nextRound: 3, stepsDone: 3 },
        appendUserMessage: false,
        append: rec.append,
        updateToolCall: rec.updateToolCall,
      }),
    )

    // 没落盘任何用户消息：续跑的那条提问在上一个 job 里已经写过了
    expect(rec.messages.filter((item) => item.role === 'user')).toHaveLength(0)
    // 轮次是**绝对**轮次（续跑不把它当成第 0 轮）
    const text = events.find((event) => event.type === 'text')
    expect(text).toMatchObject({ type: 'text', round: 3 })
    // 历史里那条用户消息仍作为上下文送出（不重复 push，也不丢）
    const sent = provider.calls[0]?.messages ?? []
    expect(sent.filter((item) => item.role === 'user')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'done', round: 3 })
  })

  it('轮次用尽：done 带 pending + pendingReason=max-rounds，且已产出的输出不丢', async () => {
    const rec = createRecorder()
    const provider = createFakeProvider(toolRounds(2))
    const events = await drain(
      runAgentLoop({
        provider,
        model: 'm',
        systemPrompt: 'sys',
        userInput: '干活',
        history: [],
        tools: registryWithEcho(),
        sessionId: 's1',
        maxRounds: 2,
        append: rec.append,
        updateToolCall: rec.updateToolCall,
      }),
    )

    expect(events.at(-1)).toMatchObject({
      type: 'done',
      pending: true,
      pendingReason: 'max-rounds',
      round: 1,
    })
    // 两轮的工具结果都回了填（不是"到点直接掐断"）
    expect(rec.messages.filter((item) => item.role === 'tool')).toHaveLength(2)
  })

  it('预算触顶：done 带 pendingReason=budget，且不再进入下一轮', async () => {
    const rec = createRecorder()
    // 桩的 usage 固定：每轮 100 token
    const provider = createFakeProvider(toolRounds(3))
    const events = await drain(
      runAgentLoop({
        provider,
        model: 'm',
        systemPrompt: 'sys',
        userInput: '干活',
        history: [],
        tools: registryWithEcho(),
        sessionId: 's1',
        maxRounds: 8,
        budget: { maxTotalTokens: 100 },
        append: rec.append,
        updateToolCall: rec.updateToolCall,
      }),
    )

    const done = events.at(-1)
    expect(done).toMatchObject({ type: 'done', pending: true, pendingReason: 'budget' })
    // 触顶发生在**第一轮结束之后**：只跑了一轮，不再进第二轮
    expect(provider.calls).toHaveLength(1)
    expect((done as { usedTokens?: number }).usedTokens).toBeGreaterThanOrEqual(100)
  })

  it('中断：done 带 pendingReason=aborted', async () => {
    const rec = createRecorder()
    const controller = new AbortController()
    controller.abort()
    const provider = createFakeProvider([{ text: '不该发出去' }])
    const events = await drain(
      runAgentLoop({
        provider,
        model: 'm',
        systemPrompt: 'sys',
        userInput: '干活',
        history: [],
        tools: registryWithEcho(),
        sessionId: 's1',
        signal: controller.signal,
        append: rec.append,
        updateToolCall: rec.updateToolCall,
      }),
    )

    expect(events.at(-1)).toMatchObject({ type: 'done', pending: true, pendingReason: 'aborted' })
    expect(provider.calls).toHaveLength(0)
  })

  it('onRoundComplete 每轮调一次，带轮次、用量与本轮工具（调用方据此落游标）', async () => {
    const rec = createRecorder()
    const provider = createFakeProvider(toolRounds(2))
    const rounds: Array<{ round: number; tools: string[]; usedTokens: number }> = []
    await drain(
      runAgentLoop({
        provider,
        model: 'm',
        systemPrompt: 'sys',
        userInput: '干活',
        history: [],
        tools: registryWithEcho(),
        sessionId: 's1',
        maxRounds: 2,
        append: rec.append,
        updateToolCall: rec.updateToolCall,
        onRoundComplete: (info) => {
          rounds.push({
            round: info.round,
            tools: info.pendingCalls.map((call) => call.name),
            usedTokens: info.usedTokens,
          })
        },
      }),
    )

    expect(rounds.map((item) => item.round)).toEqual([0, 1])
    expect(rounds.every((item) => item.tools.includes('echo'))).toBe(true)
    // 游标数据在"决定继续之前"就已就绪（最后一轮同样回调过）
    expect(rounds[1]?.usedTokens).toBeGreaterThan(0)
  })
})
