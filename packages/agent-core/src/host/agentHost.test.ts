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
  /** 「Agent 可修改的设置」清单注入（docs/06 §17 正式通道） */
  settingsHint?: () => string
  /** 任务清单摘要注入（docs/06 §18） */
  todoSummary?: (sessionId: string) => Promise<string>
  /** 项目级约定注入（docs/06 §5.1，v13） */
  projectInstructions?: () => Promise<string | undefined>
  /** quick 会话滑动窗口（docs/06 §4）；缺省 0 = 不启用 */
  quickContextWindowMs?: number
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
    ...(options.settingsHint === undefined ? {} : { settingsHint: options.settingsHint }),
    ...(options.todoSummary === undefined ? {} : { todoSummary: options.todoSummary }),
    ...(options.projectInstructions === undefined
      ? {}
      : { projectInstructions: options.projectInstructions }),
    ...(options.quickContextWindowMs === undefined
      ? {}
      : { quickContextWindowMs: options.quickContextWindowMs }),
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

/** 相对当前时刻的 ISO 时间戳（ageMs 之前），供 quick 滑动窗口用例构造 createdAt */
function ago(ageMs: number): string {
  return new Date(Date.now() - ageMs).toISOString()
}

describe('KernelAgentHost', () => {
  it('send 立即返回 requestId，并先推 queued', async () => {
    const harness = await createHarness({ rounds: [{ text: '你好' }] })
    const result = await harness.send('在吗')
    expect(result.requestId).toMatch(/^req-/)
    expect(harness.events[0]).toMatchObject({ type: 'queued', sessionId: 'quick' })
    await harness.waitForDone()
    expect(types(harness.events)).toEqual(['queued', 'user-message', 'text', 'done'])
  })

  it('事件携带 sessionId 与 messageId', async () => {
    const harness = await createHarness({ rounds: [{ text: 'hi' }] })
    await harness.send('x')
    await harness.waitForDone()
    const text = harness.events.find((event) => event.type === 'text')
    expect(text).toMatchObject({ sessionId: 'quick' })
    expect(text?.type === 'text' && text.messageId.length > 0).toBe(true)
  })

  // ── docs/06 §16.1：事件顺序、轮次归属与子代理进度 ─────────────────

  it('每个事件都带单调递增的 seq（渲染层据此排序）', async () => {
    const harness = await createHarness({
      rounds: [
        { reasoning: ['想', '一下'], text: '先看文件', toolCalls: [{ id: 'c1', name: 'echo' }] },
        { text: '好了' },
      ],
    })
    await harness.send('x')
    await harness.waitForDone()
    const seqs = harness.events.map((event) => event.seq)
    expect(seqs.length).toBeGreaterThan(3)
    for (let index = 1; index < seqs.length; index += 1) {
      expect(seqs[index]).toBeGreaterThan(seqs[index - 1] as number)
    }
  })

  it('事件带轮次 round：思考与同一轮的文本 / 工具卡同号', async () => {
    const harness = await createHarness({
      rounds: [
        { reasoning: ['第一轮思考'], text: '第一轮话', toolCalls: [{ id: 'c1', name: 'echo' }] },
        { reasoning: ['第二轮思考'], text: '第二轮话' },
      ],
    })
    await harness.send('x')
    await harness.waitForDone()
    const reasoning = harness.events.filter((event) => event.type === 'reasoning')
    const texts = harness.events.filter(
      (event): event is AgentEvent & { type: 'text' } => event.type === 'text',
    )
    expect(reasoning.map((event) => event.round)).toEqual([0, 1])
    expect(texts.map((event) => event.round)).toEqual([0, 1])
    expect(harness.events.find((event) => event.type === 'tool')?.round).toBe(0)
    // 每轮一条助手消息：渲染层靠 round ↔ messageId 绑定思考归属
    expect(texts[0]?.messageId).not.toBe(texts[1]?.messageId)
  })

  it('工具上报的进度转成 subagent 事件，最终快照随工具卡回传', async () => {
    const harness = await createHarness({
      rounds: [
        {
          toolCalls: [
            {
              id: 'call-1',
              name: 'fake-task',
              arguments: '{"description":"查资料","prompt":"..."}',
            },
          ],
        },
        { text: '完成' },
      ],
    })
    harness.tools.register({
      name: 'fake-task',
      description: '假子代理',
      parameters: { type: 'object' },
      execute: async (_input, ctx) => {
        ctx.emitProgress?.({
          kind: 'subagent',
          snapshot: {
            taskId: 'task-1',
            callId: ctx.toolCallId ?? '',
            description: '查资料',
            prompt: '...',
            status: 'running',
            startedAt: 1,
            steps: [{ id: 's1', kind: 'tool', name: 'echo', state: 'running' }],
            toolCalls: 1,
          },
        })
        return {
          content: '报告',
          summary: '子代理：查资料',
          subagent: {
            taskId: 'task-1',
            callId: ctx.toolCallId ?? '',
            description: '查资料',
            prompt: '...',
            status: 'success',
            startedAt: 1,
            endedAt: 2,
            steps: [{ id: 's1', kind: 'tool', name: 'echo', state: 'success' }],
            toolCalls: 1,
            report: '报告',
          },
        }
      },
    })
    await harness.send('x')
    await harness.waitForDone()

    const progress = harness.events.filter(
      (event): event is AgentEvent & { type: 'subagent' } => event.type === 'subagent',
    )
    expect(progress).toHaveLength(1)
    expect(progress[0]).toMatchObject({ round: 0, callId: 'call-1', sessionId: 'quick' })
    expect(progress[0]?.messageId.length).toBeGreaterThan(0)
    expect(progress[0]?.subagent.status).toBe('running')

    // 进度事件必须早于该工具的终态卡片（渲染层据此在卡片上就地长出进度）
    const finalTool = harness.events.find(
      (event): event is AgentEvent & { type: 'tool' } =>
        event.type === 'tool' && event.call.state === 'success',
    )
    expect(finalTool?.call.subagent?.status).toBe('success')
    expect(harness.events.indexOf(progress[0] as AgentEvent)).toBeLessThan(
      harness.events.indexOf(finalTool as AgentEvent),
    )
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
    expect(types(harness.events)).toEqual([
      'queued',
      'user-message',
      'tool',
      'tool',
      'text',
      'done',
    ])
    expect(harness.provider.calls).toHaveLength(2)
    expect(harness.provider.calls[1]?.messages.some((item) => item.role === 'tool')).toBe(true)
    // 会话落盘：user → assistant(toolCalls) → tool → assistant(最终文本)
    const stored = await harness.sessions.get('quick')
    expect(stored.map((item) => item.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
  })

  it('思考链与正文增量都带预领的 messageId，且与落盘的助手消息同 id', async () => {
    const harness = await createHarness({ rounds: [{ reasoning: ['思考', '中'], text: '答案' }] })
    await harness.send('问题')
    await harness.waitForDone()

    const reasoning = harness.events.filter((event) => event.type === 'reasoning')
    expect(reasoning.map((event) => event.delta)).toEqual(['思考', '中'])
    for (const event of reasoning) {
      expect(event.sessionId).toBe('quick')
      expect(event.requestId).toMatch(/^req-/)
      // 2026-09 流式轮：思考增量也带 messageId，界面才能在正文之前显示「正在思考」
      expect(event.messageId).toMatch(/^msg-/)
    }
    expect(types(harness.events)).toEqual([
      'queued',
      'user-message',
      'reasoning',
      'reasoning',
      'text',
      'done',
    ])

    const texts = harness.events.filter(
      (event): event is AgentEvent & { type: 'text' } => event.type === 'text',
    )
    // 同一轮的思考与正文指向同一条助手消息
    expect(
      new Set([...reasoning.map((event) => event.messageId), ...texts.map((e) => e.messageId)])
        .size,
    ).toBe(1)

    // 思考链随 assistant 消息持久化（全文累积）；messageId 与流式事件所用 id **完全相同** ——
    // 这正是「边流边渲染的那条消息不需要在落盘后被换掉」的依据（docs/06 §16.2）
    const stored = await harness.sessions.get('quick')
    const assistant = stored.find((message) => message.role === 'assistant')
    expect(assistant?.reasoning).toBe('思考中')
    expect(assistant?.content).toBe('答案')
    expect(assistant?.id).toBe(texts[0]?.messageId)
  })

  it('正文增量逐条转发（不等本轮结束）：多个 delta 合成同一条消息的全文', async () => {
    const harness = await createHarness({ rounds: [{ text: ['边', '流', '边', '渲染'] }] })
    await harness.send('问题')
    await harness.waitForDone()

    const texts = harness.events.filter(
      (event): event is AgentEvent & { type: 'text' } => event.type === 'text',
    )
    expect(texts.map((event) => event.delta)).toEqual(['边', '流', '边', '渲染'])
    expect(new Set(texts.map((event) => event.messageId)).size).toBe(1)

    const stored = await harness.sessions.get('quick')
    const assistant = stored.find((message) => message.role === 'assistant')
    expect(assistant?.content).toBe('边流边渲染')
    expect(assistant?.id).toBe(texts[0]?.messageId)
  })

  it('token 用量按轮转发为 usage 事件（promptTokens 即该轮上下文占用）', async () => {
    const harness = await createHarness({
      rounds: [{ text: '答', usage: { promptTokens: 120, completionTokens: 8, totalTokens: 128 } }],
    })
    await harness.send('问题')
    await harness.waitForDone()

    const usage = harness.events.filter((event) => event.type === 'usage')
    expect(usage).toHaveLength(1)
    expect(usage[0]?.round).toBe(0)
    expect(usage[0]?.usage).toEqual({ promptTokens: 120, completionTokens: 8, totalTokens: 128 })
  })

  it('run 开始时广播 user-message 事件（content 为 trim 后原文，先于流式事件）', async () => {
    const harness = await createHarness({ rounds: [{ text: '答' }] })
    await harness.send('  你好  ')
    await harness.waitForDone()
    // shared 的 AgentEvent 联合尚未收编 'user-message' 变体，测试侧用局部联合观察事件形状
    type UserMessageAgentEvent = {
      type: 'user-message'
      sessionId: string
      requestId: string
      content: string
      createdAt: number
    }
    const all = harness.events as ReadonlyArray<AgentEvent | UserMessageAgentEvent>
    const userMessage = all.find(
      (event): event is UserMessageAgentEvent => event.type === 'user-message',
    )
    expect(userMessage).toMatchObject({ type: 'user-message', sessionId: 'quick', content: '你好' })
    expect(typeof userMessage?.createdAt).toBe('number')
    expect(types(harness.events)).toEqual(['queued', 'user-message', 'text', 'done'])
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

  it('工具使用规范小节随工具表注入系统提示词', async () => {
    const harness = await createHarness({ rounds: [{ text: 'ok' }] })
    await harness.send('hi')
    await harness.waitForDone()
    const system = harness.provider.calls[0]?.messages[0]
    expect(system?.content).toContain('工具使用规范')
    // 工具表里没有 todo_write / task，相关条目不出现
    expect(system?.content).not.toContain('建立清单')
  })

  it('settingsHint 注入系统提示词的独立小节', async () => {
    const harness = await createHarness({
      rounds: [{ text: 'ok' }],
      settingsHint: () => '- tts.enabled',
    })
    await harness.send('hi')
    await harness.waitForDone()
    const system = harness.provider.calls[0]?.messages[0]
    expect(system?.content).toContain('Agent 可修改的设置')
    expect(system?.content).toContain('- tts.enabled')
  })

  it('settingsHint 抛错时降级省略该节，请求照常完成', async () => {
    const harness = await createHarness({
      rounds: [{ text: 'ok' }],
      settingsHint: () => {
        throw new Error('清单生成失败')
      },
    })
    await harness.send('hi')
    await harness.waitForDone()
    expect(harness.events.some((event) => event.type === 'error')).toBe(false)
    expect(harness.events.some((event) => event.type === 'done')).toBe(true)
    expect(harness.provider.calls[0]?.messages[0]?.content).not.toContain('Agent 可修改的设置')
  })

  it('todoSummary 注入系统提示词的「当前任务清单」小节', async () => {
    const harness = await createHarness({
      rounds: [{ text: 'ok' }],
      todoSummary: async (sessionId) => `1. [~] ${sessionId} 的任务`,
    })
    await harness.send('hi')
    await harness.waitForDone()
    const system = harness.provider.calls[0]?.messages[0]
    expect(system?.content).toContain('当前任务清单')
    expect(system?.content).toContain('1. [~] quick 的任务')
  })

  it('todoSummary 返回空串时整段省略', async () => {
    const harness = await createHarness({
      rounds: [{ text: 'ok' }],
      todoSummary: async () => '',
    })
    await harness.send('hi')
    await harness.waitForDone()
    expect(harness.provider.calls[0]?.messages[0]?.content).not.toContain('当前任务清单')
  })

  it('todoSummary 抛错时降级省略该节，请求照常完成', async () => {
    const harness = await createHarness({
      rounds: [{ text: 'ok' }],
      todoSummary: async () => {
        throw new Error('清单读取失败')
      },
    })
    await harness.send('hi')
    await harness.waitForDone()
    expect(harness.events.some((event) => event.type === 'error')).toBe(false)
    expect(harness.events.some((event) => event.type === 'done')).toBe(true)
    expect(harness.provider.calls[0]?.messages[0]?.content).not.toContain('当前任务清单')
  })

  it('projectInstructions 注入系统提示词的「项目约定」小节（v13，docs/06 §5.1）', async () => {
    const harness = await createHarness({
      rounds: [{ text: 'ok' }],
      projectInstructions: async () => '### AGENTS.md\n本项目用 pnpm workspace',
    })
    await harness.send('hi')
    await harness.waitForDone()
    const system = harness.provider.calls[0]?.messages[0]?.content ?? ''
    expect(system).toContain('## 项目约定')
    expect(system).toContain('本项目用 pnpm workspace')
    // 易变段必须在静态段之后（docs/06 §21.1）
    expect(system.indexOf('## 项目约定')).toBeGreaterThan(system.indexOf('## 安全规则'))
  })

  it('projectInstructions 未注入 / 返回空串时整段省略（无项目 = 现状不变）', async () => {
    const noDep = await createHarness({ rounds: [{ text: 'ok' }] })
    await noDep.send('hi')
    await noDep.waitForDone()
    expect(noDep.provider.calls[0]?.messages[0]?.content).not.toContain('## 项目约定')

    const empty = await createHarness({
      rounds: [{ text: 'ok' }],
      projectInstructions: async () => '',
    })
    await empty.send('hi')
    await empty.waitForDone()
    expect(empty.provider.calls[0]?.messages[0]?.content).not.toContain('## 项目约定')
  })

  it('projectInstructions 抛错时降级省略该节，请求照常完成', async () => {
    const harness = await createHarness({
      rounds: [{ text: 'ok' }],
      projectInstructions: async () => {
        throw new Error('AGENTS.md 读取失败')
      },
    })
    await harness.send('hi')
    await harness.waitForDone()
    expect(harness.events.some((event) => event.type === 'error')).toBe(false)
    expect(harness.events.some((event) => event.type === 'done')).toBe(true)
    expect(harness.provider.calls[0]?.messages[0]?.content).not.toContain('## 项目约定')
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
    options?: { quickContextWindowMs?: number },
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
      ...(options?.quickContextWindowMs === undefined
        ? {}
        : { quickContextWindowMs: options.quickContextWindowMs }),
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

  it('quick 窗口模式下 summaries 不注入、不跨轮次累计（docs/06 §4 滑动窗口）', async () => {
    const harness = await createSummaryHarness(async () => '不该出现的累计摘要', {
      quickContextWindowMs: 5 * 60_000,
    })
    // 窗口内的长消息撑爆 10 字符预算：若未跳过摘要，这里本应触发 summarizer
    await harness.sessions.append('quick', {
      role: 'user',
      content: '一段足够长的新历史内容用来撑爆字符预算触发截断',
      createdAt: ago(60_000),
    })
    await harness.sessions.append('quick', {
      role: 'assistant',
      content: '好的',
      createdAt: ago(59_000),
    })
    await harness.send('第一问')
    await harness.waitForDone()
    expect(harness.counter.summaryCalls).toBe(0)
    const firstSystem = harness.provider.calls[0]?.messages[0]?.content ?? ''
    expect(firstSystem).not.toContain('更早对话的摘要')
    expect(firstSystem).not.toContain('不该出现的累计摘要')

    harness.events.length = 0
    await harness.send('第二问')
    await harness.waitForDone()
    expect(harness.counter.summaryCalls).toBe(0)
    const secondSystem = harness.provider.calls[1]?.messages[0]?.content ?? ''
    expect(secondSystem).not.toContain('更早对话的摘要')
  })
})

describe('KernelAgentHost · quick 会话滑动窗口（docs/06 §4）', () => {
  /** 与装配层一致的窗口常量（5 分钟） */
  const WINDOW_MS = 5 * 60_000

  function sentContents(harness: Harness): string[] {
    return (harness.provider.calls[0]?.messages ?? []).map((item) => item.content)
  }

  it('quick 会话启用窗口：窗外消息不进上下文组装', async () => {
    const harness = await createHarness({
      rounds: [{ text: '答' }],
      quickContextWindowMs: WINDOW_MS,
    })
    await harness.sessions.append('quick', {
      role: 'user',
      content: '十分钟前的旧问题',
      createdAt: ago(WINDOW_MS + 5 * 60_000),
    })
    await harness.sessions.append('quick', {
      role: 'assistant',
      content: '很久之前的回答',
      createdAt: ago(WINDOW_MS + 5 * 60_000 - 1_000),
    })
    await harness.send('现在的问题')
    await harness.waitForDone()
    const contents = sentContents(harness)
    expect(contents).not.toContain('十分钟前的旧问题')
    expect(contents).not.toContain('很久之前的回答')
  })

  it('窗口内的历史保留', async () => {
    const harness = await createHarness({
      rounds: [{ text: '答' }],
      quickContextWindowMs: WINDOW_MS,
    })
    await harness.sessions.append('quick', {
      role: 'user',
      content: '一分钟前的旧问题',
      createdAt: ago(60_000),
    })
    await harness.sessions.append('quick', {
      role: 'assistant',
      content: '一分钟前的回答',
      createdAt: ago(59_000),
    })
    await harness.send('现在的问题')
    await harness.waitForDone()
    const contents = sentContents(harness)
    expect(contents).toContain('一分钟前的旧问题')
    expect(contents).toContain('一分钟前的回答')
  })

  it('全部消息都在窗外 → 空历史（仅本轮输入）', async () => {
    const harness = await createHarness({
      rounds: [{ text: '答' }],
      quickContextWindowMs: WINDOW_MS,
    })
    await harness.sessions.append('quick', {
      role: 'user',
      content: '十分钟前的旧问题',
      createdAt: ago(WINDOW_MS + 60_000),
    })
    await harness.send('现在的问题')
    await harness.waitForDone()
    const messages = harness.provider.calls[0]?.messages ?? []
    expect(messages.map((item) => item.role)).toEqual(['system', 'user'])
    expect(messages[1]?.content).toBe('现在的问题')
  })

  it('非 quick 会话不受窗口影响（全量进组装）', async () => {
    const harness = await createHarness({
      rounds: [{ text: '答' }],
      quickContextWindowMs: WINDOW_MS,
    })
    await harness.sessions.append('main', {
      role: 'user',
      content: '十分钟前的 main 旧问题',
      createdAt: ago(WINDOW_MS + 60_000),
    })
    await harness.send('现在的问题', 'main')
    await harness.waitForDone()
    expect(sentContents(harness)).toContain('十分钟前的 main 旧问题')
  })

  it('未启用窗口（缺省 0）时 quick 会话仍全量进组装，行为与从前一致', async () => {
    const harness = await createHarness({ rounds: [{ text: '答' }] })
    await harness.sessions.append('quick', {
      role: 'user',
      content: '十分钟前的 quick 旧问题',
      createdAt: ago(WINDOW_MS + 60_000),
    })
    await harness.send('现在的问题')
    await harness.waitForDone()
    expect(sentContents(harness)).toContain('十分钟前的 quick 旧问题')
  })
})
