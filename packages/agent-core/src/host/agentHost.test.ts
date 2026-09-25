import { describe, expect, it } from 'vitest'
import { createMemoryLogger } from '@aurora/shared'
import { KernelAgentHost, ERROR_BUSY, ERROR_NO_MODEL } from './agentHost.js'
import { SessionStore } from '../session/store.js'
import { SkillsBridge } from '../skills/bridge.js'
import { SkillsRegistry } from '../skills/registry.js'
import { ToolRegistry } from '../tools/registry.js'
import { createFakeProvider, type ScriptRound } from '../testing/fakeProvider.js'
import { SESSION_DIR, TestFileSystem } from '../testing/fileSystem.js'
import type { ReasoningEffortLevel } from '../llm/types.js'
import type { AgentEvent } from '@aurora/shared'

async function createSkills(): Promise<SkillsRegistry> {
  const { promises: nodeFs } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const base = await nodeFs.mkdtemp(join(tmpdir(), 'aurora-host-skills-'))
  await nodeFs.mkdir(join(base, 'system-status'), { recursive: true })
  await nodeFs.writeFile(
    join(base, 'system-status', 'SKILL.md'),
    ['---', 'name: system-status', 'description: 读取系统状态', '---', '', '按感知摘要回答。'].join(
      '\n',
    ),
    'utf8',
  )
  const registry = new SkillsRegistry({ builtinDir: base })
  await registry.scan()
  return registry
}

interface Harness {
  host: KernelAgentHost
  events: AgentEvent[]
  sessions: SessionStore
  tools: ToolRegistry
  provider: ReturnType<typeof createFakeProvider>
  send(text: string, sessionId?: string): Promise<{ requestId: string }>
  waitForDone(timeoutMs?: number): Promise<void>
}

async function createHarness(options: {
  rounds: ScriptRound[]
  withProvider?: boolean
  maxRounds?: number
  /** 装配层透传给内核的思考等级（`undefined` 代表用户选了 `auto`） */
  reasoningEffort?: ReasoningEffortLevel
}): Promise<Harness> {
  const fs = new TestFileSystem()
  const sessions = new SessionStore({ dir: SESSION_DIR, fs, writeDebounceMs: 0 })
  const logger = createMemoryLogger()
  const skills = new SkillsBridge(await createSkills())
  const tools = new ToolRegistry()
  skills.registerInto(tools)
  tools.register({
    name: 'echo',
    description: '回显',
    parameters: { type: 'object' },
    execute: async (input) => ({
      content: `echo:${(input as { text?: string }).text ?? ''}`,
      summary: '已回显',
    }),
  })

  const provider = createFakeProvider(options.rounds)
  const events: AgentEvent[] = []
  const host = new KernelAgentHost({
    sessions,
    provider: {
      create: () =>
        options.withProvider === false
          ? undefined
          : {
              provider,
              model: 'fake-model',
              temperature: 0.3,
              ...(options.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: options.reasoningEffort }),
            },
    },
    tools,
    skills,
    logger,
    ...(options.maxRounds === undefined ? {} : { maxRounds: options.maxRounds }),
  })
  host.onEvent((event) => events.push(event))

  return {
    host,
    events,
    sessions,
    tools,
    provider,
    send: (text, sessionId = 'quick') => host.send({ sessionId, text, origin: 'chat' }),
    async waitForDone(timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (events.some((event) => event.type === 'done' || event.type === 'error')) return
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    },
  }
}

function types(events: AgentEvent[]): string[] {
  return events.map((event) => event.type)
}

describe('KernelAgentHost', () => {
  it('send 立即返回 requestId，并先推 queued', async () => {
    const harness = await createHarness({ rounds: [{ text: '你好' }] })
    const result = await harness.send('在吗')
    expect(result.requestId).toMatch(/^req-/)
    expect(harness.events[0]).toMatchObject({ type: 'queued', sessionId: 'quick' })
    await harness.waitForDone()
    expect(types(harness.events)).toEqual(['queued', 'text', 'done'])
  })

  it('事件携带 sessionId 与 messageId', async () => {
    const harness = await createHarness({ rounds: [{ text: 'hi' }] })
    await harness.send('x')
    await harness.waitForDone()
    const text = harness.events.find((event) => event.type === 'text')
    expect(text).toMatchObject({ sessionId: 'quick' })
    expect(text?.type === 'text' && text.messageId.length > 0).toBe(true)
  })

  it('无可用模型 → E_NO_MODEL，且不发起任何请求', async () => {
    const harness = await createHarness({ rounds: [], withProvider: false })
    await harness.send('x')
    await harness.waitForDone()
    expect(harness.events.find((event) => event.type === 'error')).toMatchObject({
      code: ERROR_NO_MODEL,
    })
    expect(harness.provider.calls).toHaveLength(0)
    expect(harness.host.isReady()).toBe(false)
  })

  it('空消息 → 结构化错误', async () => {
    const harness = await createHarness({ rounds: [] })
    await harness.send('   ')
    await harness.waitForDone()
    expect(harness.events.find((event) => event.type === 'error')).toMatchObject({
      code: 'E_INVALID_ARGUMENT',
    })
  })

  it('工具循环：tool running→success 且两轮请求都带上工具清单', async () => {
    const harness = await createHarness({
      rounds: [
        { toolCalls: [{ id: 'c1', name: 'echo', arguments: '{"text":"q"}' }] },
        { text: '完成' },
      ],
    })
    await harness.send('帮我回显')
    await harness.waitForDone()

    const states = harness.events
      .filter((event) => event.type === 'tool')
      .map((event) => event.call.state)
    expect(states).toEqual(['running', 'success'])
    expect(types(harness.events)).toEqual(['queued', 'tool', 'tool', 'text', 'done'])
    expect(harness.provider.calls).toHaveLength(2)
    expect(harness.provider.calls[1]?.messages.some((item) => item.role === 'tool')).toBe(true)
    // 会话落盘：user → assistant(toolCalls) → tool → assistant(最终文本)
    const stored = await harness.sessions.get('quick')
    expect(stored.map((item) => item.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
  })

  it('思考链增量转发为 AgentEvent（sessionId / requestId / delta，无 messageId）', async () => {
    const harness = await createHarness({ rounds: [{ reasoning: ['思考', '中'], text: '答案' }] })
    await harness.send('问题')
    await harness.waitForDone()

    // shared 的 AgentEvent 联合尚未收编 'reasoning' 变体，测试侧用局部联合观察事件形状
    type ReasoningAgentEvent = {
      type: 'reasoning'
      sessionId: string
      requestId: string
      delta: string
    }
    const all = harness.events as ReadonlyArray<AgentEvent | ReasoningAgentEvent>
    const reasoning = all.filter(
      (event): event is ReasoningAgentEvent => event.type === 'reasoning',
    )
    expect(reasoning.map((event) => event.delta)).toEqual(['思考', '中'])
    for (const event of reasoning) {
      expect(event.sessionId).toBe('quick')
      expect(event.requestId).toMatch(/^req-/)
      expect('messageId' in event).toBe(false)
    }
    expect(types(harness.events)).toEqual(['queued', 'reasoning', 'reasoning', 'text', 'done'])

    // 思考链随 assistant 消息持久化（全文累积）
    const stored = await harness.sessions.get('quick')
    const assistant = stored.find((message) => message.role === 'assistant')
    expect(assistant?.reasoning).toBe('思考中')
    expect(assistant?.content).toBe('答案')
  })

  it('系统提示词包含模式片段、感知摘要与危险操作规则', async () => {
    const fs = new TestFileSystem()
    const sessions = new SessionStore({ dir: SESSION_DIR, fs, writeDebounceMs: 0 })
    const skills = new SkillsBridge(await createSkills())
    const tools = new ToolRegistry()
    skills.registerInto(tools)
    const provider = createFakeProvider([{ text: 'ok' }])
    const host = new KernelAgentHost({
      sessions,
      provider: { create: () => ({ provider, model: 'm' }) },
      tools,
      skills,
      modePrompt: () => '当前是 ClassRoom 模式',
      perceptionSummary: async () => '当前时间 08:00',
    })
    const events: AgentEvent[] = []
    host.onEvent((event) => events.push(event))
    await host.send({ sessionId: 'quick', text: 'hi', origin: 'chat' })
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && !events.some((event) => event.type === 'done')) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    const system = provider.calls[0]?.messages[0]
    expect(system?.role).toBe('system')
    expect(system?.content).toContain('ClassRoom')
    expect(system?.content).toContain('08:00')
    expect(system?.content).toContain('安全规则')
    expect(system?.content).toContain('use_skill')
  })

  it('显式 /skill 调用把技能正文注入本次请求，但不写入历史', async () => {
    const harness = await createHarness({ rounds: [{ text: 'ok' }] })
    await harness.send('/system-status 现在几点')
    await harness.waitForDone()

    const messages = harness.provider.calls[0]?.messages ?? []
    expect(messages.some((item) => item.content.includes('按感知摘要回答'))).toBe(true)
    const stored = await harness.sessions.get('quick')
    expect(stored.some((item) => item.content.includes('按感知摘要回答'))).toBe(false)
    expect(stored[0]?.content).toBe('现在几点')
  })

  it('未知 /skill 前缀按普通文本处理', async () => {
    const harness = await createHarness({ rounds: [{ text: 'ok' }] })
    await harness.send('/unknown-skill hi')
    await harness.waitForDone()
    const stored = await harness.sessions.get('quick')
    expect(stored[0]?.content).toBe('/unknown-skill hi')
  })

  it('同一会话并发请求 → E_BUSY', async () => {
    const harness = await createHarness({ rounds: [{ text: 'a' }, { text: 'b' }] })
    await harness.send('第一条')
    await harness.send('第二条')
    await harness.waitForDone()
    expect(
      harness.events.some((event) => event.type === 'error' && event.code === ERROR_BUSY),
    ).toBe(true)
  })

  it('不同会话互不阻塞', async () => {
    const harness = await createHarness({ rounds: [{ text: 'a' }, { text: 'b' }] })
    await harness.send('第一条', 'quick')
    await harness.send('第二条', 'main')
    const deadline = Date.now() + 2_000
    while (
      Date.now() < deadline &&
      harness.events.filter((event) => event.type === 'done').length < 2
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(harness.events.filter((event) => event.type === 'done')).toHaveLength(2)
    expect(harness.events.some((event) => event.type === 'error')).toBe(false)
  })

  it('abort 中断并推送 done；未知 requestId 返回 false', async () => {
    const harness = await createHarness({ rounds: [{ text: 'x'.repeat(500) }] })
    const { requestId } = await harness.send('长回答')
    expect(harness.host.abort('req-nope')).toBe(false)
    expect(harness.host.abort(requestId)).toBe(true)
    await harness.waitForDone()
    expect(harness.events.some((event) => event.type === 'done')).toBe(true)
    expect(harness.host.isBusy('quick')).toBe(false)
  })

  it('轮次用尽 → done 带 pending', async () => {
    const rounds: ScriptRound[] = Array.from({ length: 2 }, () => ({
      toolCalls: [{ id: 'c', name: 'echo', arguments: '{"text":"x"}' }],
    }))
    const harness = await createHarness({ rounds, maxRounds: 2 })
    await harness.send('循环')
    await harness.waitForDone()
    const done = harness.events.find((event) => event.type === 'done')
    expect(done).toMatchObject({ type: 'done', pending: true })
  })

  it('思考等级透传：provider.create() 给出 medium 时请求带上 reasoningEffort', async () => {
    const harness = await createHarness({ rounds: [{ text: 'ok' }], reasoningEffort: 'medium' })
    await harness.send('hi')
    await harness.waitForDone()
    expect(harness.provider.calls[0]?.reasoningEffort).toBe('medium')
  })

  it('未配置思考等级（auto）时请求对象里没有 reasoningEffort 字段', async () => {
    const harness = await createHarness({ rounds: [{ text: 'ok' }] })
    await harness.send('hi')
    await harness.waitForDone()
    expect('reasoningEffort' in (harness.provider.calls[0] ?? {})).toBe(false)
  })

  it('历史会进入后续请求（续接上下文）', async () => {
    const harness = await createHarness({ rounds: [{ text: '第一答' }, { text: '第二答' }] })
    await harness.send('第一问')
    await harness.waitForDone()
    harness.events.length = 0
    await harness.send('第二问')
    await harness.waitForDone()
    const roles = harness.provider.calls[1]?.messages.map((item) => item.role)
    expect(roles).toEqual(['system', 'user', 'assistant', 'user'])
  })
})

describe('KernelAgentHost · 历史摘要压缩（docs/06 §4）', () => {
  interface SummaryHarness extends Harness {
    /** 用对象承载计数（展开复制会丢掉更新，必须持有同一个引用） */
    counter: { summaryCalls: number }
  }

  async function createSummaryHarness(
    summarize: (input: {
      dropped: Array<{ role: string; content: string }>
      previousSummary?: string
    }) => Promise<string>,
  ): Promise<SummaryHarness> {
    const fs = new TestFileSystem()
    const sessions = new SessionStore({ dir: SESSION_DIR, fs, writeDebounceMs: 0 })
    const logger = createMemoryLogger()
    const skills = new SkillsBridge(await createSkills())
    const tools = new ToolRegistry()
    skills.registerInto(tools)

    const provider = createFakeProvider([{ text: '收到' }])
    const events: AgentEvent[] = []
    const counter = { summaryCalls: 0 }
    const host = new KernelAgentHost({
      sessions,
      provider: { create: () => ({ provider, model: 'fake-model' }) },
      tools,
      skills,
      logger,
      // 预算刻意设为：能放下最后一条短消息，但放不下更早的长消息 ——
      // 这样旧消息才会被真正丢弃（触发摘要），也不会因为"最后一条本身就超预算"
      // 而走 truncateHistory 的保守全保留分支
      maxChars: 10,
      summarize: async (input) => {
        counter.summaryCalls += 1
        return summarize({
          dropped: input.dropped.map((item) => ({ role: item.role, content: item.content })),
          ...(input.previousSummary === undefined
            ? {}
            : { previousSummary: input.previousSummary }),
        })
      },
    })
    host.onEvent((event) => events.push(event))

    return {
      host,
      events,
      sessions,
      tools,
      provider,
      counter,
      send: (text, sessionId = 'quick') => host.send({ sessionId, text, origin: 'chat' }),
      async waitForDone(timeoutMs = 2_000) {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          if (events.some((event) => event.type === 'done' || event.type === 'error')) return
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
      },
    }
  }

  it('超预算时压缩历史，并把摘要注入系统提示词', async () => {
    const harness = await createSummaryHarness(async () => '用户之前问过数学作业的事')
    const sessions = harness.sessions
    // 两条历史：第一条超预算会被丢弃（成为摘要素材），第二条留在上下文里
    await sessions.append('quick', { role: 'user', content: '这是很久以前的一段很长的对话内容' })
    await sessions.append('quick', { role: 'assistant', content: '好的' })

    await harness.send('现在呢')
    await harness.waitForDone()

    expect(harness.counter.summaryCalls).toBe(1)
    const systemPrompt = harness.provider.calls[0]?.messages[0]?.content ?? ''
    expect(systemPrompt).toContain('更早对话的摘要')
    expect(systemPrompt).toContain('用户之前问过数学作业的事')
  })

  it('summarizer 抛错时请求照常完成（退回纯截断，不让摘要拖垮对话）', async () => {
    const harness = await createSummaryHarness(async () => {
      throw new Error('摘要模型不可用')
    })
    await harness.sessions.append('quick', { role: 'user', content: '一段很长的历史内容占位说明' })
    await harness.sessions.append('quick', { role: 'assistant', content: '好的' })

    await harness.send('继续')
    await harness.waitForDone()

    expect(harness.events.some((event) => event.type === 'error')).toBe(false)
    expect(harness.events.some((event) => event.type === 'text')).toBe(true)
    const systemPrompt = harness.provider.calls[0]?.messages[0]?.content ?? ''
    expect(systemPrompt).not.toContain('更早对话的摘要')
  })
})
