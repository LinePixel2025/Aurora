import { describe, expect, it } from 'vitest'
import { createMemoryLogger } from '@aurora/shared'
import { KernelAgentHost, ERROR_BUSY, ERROR_JOB_STATE, ERROR_NO_MODEL } from './agentHost.js'
import type { AgentHostDeps } from './agentHost.js'
import { createFileJobStore, type JobStore } from '../jobs/store.js'
import type { AgentJob } from '../jobs/types.js'
import { SessionStore } from '../session/store.js'
import type { NewMessage } from '../session/types.js'
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
  /** 内存日志器（断言"必须留痕"的行为，如自动续轮） */
  logger: ReturnType<typeof createMemoryLogger>
  send(
    text: string,
    sessionId?: string,
    options?: { resumeJobId?: string; images?: readonly string[] },
  ): Promise<{ requestId: string }>
  waitForDone(timeoutMs?: number): Promise<void>
}

async function createHarness(options: {
  rounds: ScriptRound[]
  /** 复用同一份内存 fs（跨 host 实例模拟"重启"时必须传） */
  fs?: TestFileSystem
  /**
   * Job 存储（v15）。**不注入时行为与 v15 之前完全一致**：不落 job、不发 `job` 事件 ——
   * 既有用例的断言（精确的事件序列）因此不受本轮改动影响。
   */
  jobs?: JobStore
  withProvider?: boolean
  /** 轮次上限 **getter**（v15：热改即生效，不是构造时常量） */
  maxRounds?: () => number
  /** 累计 token 预算 getter（0 = 不限） */
  maxTotalTokens?: () => number
  /** 自动续轮额度 getter（0 = 不自动续，落 paused 等用户点继续） */
  autoContinueRounds?: () => number
  /** 时钟注入（v15） */
  clock?: () => Date
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
  /** 敏感工具确认钩子（docs/06 §5）；缺省不注入 = 不拦截 */
  confirmTool?: AgentHostDeps['confirmTool']
  /** 按运行来源定制的运行档（v0.2.8，docs/06 §5.2） */
  runProfileFor?: AgentHostDeps['runProfileFor']
  /** provider 是否声明支持图片输入（v22，docs/06 §3.1）：缺省 undefined = 不支持 */
  vision?: boolean
  /**
   * 同 `vision`，但**每次请求现取**（v22）：用来验证「同一个 host 实例里中途关掉开关」——
   * 图片缓存是进程级不淘汰的，只判「要不要读盘」会漏掉「缓存里已经有的图照样被下发」。
   */
  visionGetter?: () => boolean
  /** 图片读盘端口（v22）：缺省不注入 = 图片只落盘不重放 */
  loadImages?: AgentHostDeps['loadImages']
  /**
   * 观察 `provider.create()` 的入参（docs/06 §3 会话级模型）：
   * 内核必须把发起会话的 id 传下去，否则装配层永远解析不到会话覆盖。
   */
  onCreate?: (options: { allowFallback?: boolean; sessionId?: string } | undefined) => void
}): Promise<Harness> {
  const fs = options.fs ?? new TestFileSystem()
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
      create: (createOptions) => {
        options.onCreate?.(createOptions)
        return options.withProvider === false
          ? undefined
          : {
              provider,
              model: 'fake-model',
              temperature: 0.3,
              // `visionGetter` 优先：getter 形式让「同一个 host 中途关开关」可测
              ...(options.visionGetter !== undefined
                ? {
                    get vision(): boolean {
                      return options.visionGetter!()
                    },
                  }
                : options.vision === undefined
                  ? {}
                  : { vision: options.vision }),
              ...(options.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: options.reasoningEffort }),
            }
      },
    },
    tools,
    skills,
    logger,
    ...(options.jobs === undefined ? {} : { jobs: options.jobs }),
    ...(options.maxRounds === undefined ? {} : { maxRounds: options.maxRounds }),
    ...(options.maxTotalTokens === undefined ? {} : { maxTotalTokens: options.maxTotalTokens }),
    ...(options.autoContinueRounds === undefined
      ? {}
      : { autoContinueRounds: options.autoContinueRounds }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.settingsHint === undefined ? {} : { settingsHint: options.settingsHint }),
    ...(options.todoSummary === undefined ? {} : { todoSummary: options.todoSummary }),
    ...(options.projectInstructions === undefined
      ? {}
      : { projectInstructions: options.projectInstructions }),
    ...(options.quickContextWindowMs === undefined
      ? {}
      : { quickContextWindowMs: options.quickContextWindowMs }),
    ...(options.confirmTool === undefined ? {} : { confirmTool: options.confirmTool }),
    ...(options.runProfileFor === undefined ? {} : { runProfileFor: options.runProfileFor }),
    ...(options.loadImages === undefined ? {} : { loadImages: options.loadImages }),
  })
  host.onEvent((event) => events.push(event))

  return {
    host,
    events,
    sessions,
    tools,
    provider,
    logger,
    send: (text, sessionId = 'quick', sendOptions) =>
      host.send({
        sessionId,
        text,
        origin: 'chat',
        ...(sendOptions?.resumeJobId === undefined ? {} : { resumeJobId: sendOptions.resumeJobId }),
        ...(sendOptions?.images === undefined ? {} : { images: sendOptions.images }),
      }),
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
    const harness = await createHarness({ rounds, maxRounds: () => 2 })
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

/**
 * 会话级模型（docs/06 §3，本轮）：内核只负责把 `sessionId` **传给装配层**，
 * 覆盖怎么解析（读会话 meta、失效回落）全在装配层 —— 这里钉住「传对了 id」这一环，
 * 因为它是唯一一处「不传就永远退回全局档」而不会报错的静默失效。
 */
describe('KernelAgentHost · 会话级模型（provider.create 收到 sessionId）', () => {
  it('send() 把发起会话的 id 交给 provider.create', async () => {
    const seen: Array<string | undefined> = []
    const harness = await createHarness({
      rounds: [{ text: 'ok' }],
      onCreate: (createOptions) => seen.push(createOptions?.sessionId),
    })
    await harness.send('hi', 'center-abc')
    await harness.waitForDone()
    expect(seen).toContain('center-abc')
  })

  it('未传 sessionId 的调用（isReady 探测）不带上会话 id', async () => {
    const seen: Array<string | undefined> = []
    const harness = await createHarness({
      rounds: [{ text: 'ok' }],
      onCreate: (createOptions) => seen.push(createOptions?.sessionId),
    })
    expect(harness.host.isReady()).toBe(true)
    expect(seen).toEqual([undefined])
  })
})

/**
 * 会话级「本会话不再询问」（docs/06 §5、docs/06 §11.2）。
 *
 * `'always'` 的记忆必须落在**内核的 AgentHost**：循环一趟请求一个实例，记住它等于没记住。
 * 授权表的键就是 `sessionId` —— 因此"换会话要重新问"是天然行为，不需要额外判断。
 */
describe('KernelAgentHost · 会话级 always 授权（docs/06 §5）', () => {
  /** 注册一个 confirm 级工具，并记录它真的被执行过几次；可选地捕获每次执行的工具上下文 */
  function registerDanger(
    harness: Harness,
    executed: { count: number },
    contexts?: Array<{ approvedByUser?: boolean }>,
  ): void {
    harness.tools.register({
      name: 'danger',
      description: '危险操作',
      parameters: { type: 'object' },
      sensitivity: 'confirm',
      execute: async (_input, ctx) => {
        executed.count += 1
        contexts?.push({ approvedByUser: ctx.approvedByUser })
        return { content: '已执行危险操作', summary: '已执行' }
      },
    })
  }

  /** 两次「问 danger 然后收尾」的脚本：跨两次 send 依次消费（假 provider 的轮次是全局序号） */
  const twoCalls: ScriptRound[] = [
    { toolCalls: [{ id: 'c1', name: 'danger', arguments: '{}' }] },
    { text: '第一次完成' },
    { toolCalls: [{ id: 'c2', name: 'danger', arguments: '{}' }] },
    { text: '第二次完成' },
  ]

  it("confirmTool 返回 'always' → 工具真的被执行（不是拒绝）", async () => {
    const executed = { count: 0 }
    const harness = await createHarness({
      rounds: [{ toolCalls: [{ id: 'c1', name: 'danger', arguments: '{}' }] }, { text: '完成' }],
      confirmTool: async () => 'always',
    })
    registerDanger(harness, executed)

    await harness.send('删掉它')
    await harness.waitForDone()

    expect(executed.count).toBe(1)
    const states = harness.events
      .filter((event) => event.type === 'tool')
      .map((event) => event.call.state)
    expect(states).toEqual(['running', 'success'])
  })

  it("首次 'always' 是用户当次批准（ctx 带 approvedByUser），记住后的二次短路不再带（出处 = 'machine'）", async () => {
    const executed = { count: 0 }
    const contexts: Array<{ approvedByUser?: boolean }> = []
    const harness = await createHarness({
      rounds: twoCalls,
      confirmTool: async () => 'always',
    })
    registerDanger(harness, executed, contexts)

    await harness.send('第一次')
    await harness.waitForDone()
    harness.events.length = 0
    await harness.send('第二次')
    await harness.waitForDone()

    expect(executed.count).toBe(2)
    // 首次：用户在卡片上点了「总是允许」→ 属于当次批准，免项目根边界的特权成立
    expect(contexts[0]?.approvedByUser).toBe(true)
    // 第二次：会话授权表短路返回 'machine'（历史授权，不是当次看卡片）→ 不再免边界
    expect(contexts[1]?.approvedByUser).toBeUndefined()
  })

  it('同一会话同名工具的第二次调用不再询问（confirmTool 只被调用 1 次）', async () => {
    const executed = { count: 0 }
    const asked: string[] = []
    const harness = await createHarness({
      rounds: twoCalls,
      confirmTool: async (info) => {
        asked.push(info.name)
        return 'always'
      },
    })
    registerDanger(harness, executed)

    await harness.send('第一次')
    await harness.waitForDone()
    harness.events.length = 0
    await harness.send('第二次')
    await harness.waitForDone()

    // 授权表命中：第二次**根本不调用** deps.confirmTool（否则等于又弹了一张卡）
    expect(asked).toEqual(['danger'])
    expect(executed.count).toBe(2)
  })

  it('换一个会话要重新询问（授权按 sessionId 隔离）', async () => {
    const executed = { count: 0 }
    let asked = 0
    const harness = await createHarness({
      rounds: twoCalls,
      confirmTool: async () => {
        asked += 1
        return 'always'
      },
    })
    registerDanger(harness, executed)

    await harness.send('第一次', 'session-a')
    await harness.waitForDone()
    harness.events.length = 0
    await harness.send('第二次', 'session-b')
    await harness.waitForDone()

    expect(asked).toBe(2)
    expect(executed.count).toBe(2)
  })

  it('clearSessionApprovals 之后重新询问（会话删除 / 重建时不继承旧授权）', async () => {
    const executed = { count: 0 }
    let asked = 0
    const harness = await createHarness({
      rounds: twoCalls,
      confirmTool: async () => {
        asked += 1
        return 'always'
      },
    })
    registerDanger(harness, executed)

    await harness.send('第一次')
    await harness.waitForDone()
    harness.host.clearSessionApprovals('quick')
    harness.events.length = 0
    await harness.send('第二次')
    await harness.waitForDone()

    expect(asked).toBe(2)
  })

  it('confirmTool 返回 false 的行为与从前一字不差：不执行、拒绝文本回填', async () => {
    const executed = { count: 0 }
    const harness = await createHarness({
      rounds: [{ toolCalls: [{ id: 'c1', name: 'danger', arguments: '{}' }] }, { text: '收尾' }],
      confirmTool: async () => false,
    })
    registerDanger(harness, executed)

    await harness.send('删掉它')
    await harness.waitForDone()

    expect(executed.count).toBe(0)
    const states = harness.events
      .filter((event) => event.type === 'tool')
      .map((event) => event.call.state)
    expect(states).toEqual(['running', 'error'])
    const stored = await harness.sessions.get('quick')
    expect(stored.find((message) => message.role === 'tool')?.content).toContain('用户拒绝执行')
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

/**
 * Job 生命周期（v15，docs/06 §4.1）：一次请求 = 一条可查询、可续跑的 job。
 *
 * 这里覆盖的是**装配层**的口径 —— 什么时候建 job、每轮怎么落游标、什么时候
 * paused / done / aborted / error、续跑从哪里接上、自动续轮额度怎么算。
 * 循环自身的行为由 `loop/agentLoop.test.ts` 覆盖（那边一行存储都不碰）。
 *
 * JobStore 用 `createFileJobStore` + 内存 `TestFileSystem`：真实落盘路径、零磁盘 IO。
 */
describe('job 生命周期（v15）', () => {
  const JOBS_DIR = 'C:\\aurora-test\\jobs'

  function createJobs(fs: TestFileSystem, clock?: () => Date): JobStore {
    return createFileJobStore({
      dir: JOBS_DIR,
      fs,
      writeDebounceMs: 0,
      ...(clock === undefined ? {} : { clock }),
    })
  }

  /** 单调递增的注入时钟：`updatedAt` 可预期，存储的排序也不会抖 */
  function tickingClock(): () => Date {
    let tick = 0
    return () => new Date(Date.UTC(2026, 0, 2, 3, 4, 5) + (tick += 1_000))
  }

  /**
   * 等某条 job 落盘到满足条件的那个状态。
   *
   * 为什么必须轮询：`done` / `error` **事件**先到，job 的终态更新是紧随其后的一次异步落盘 ——
   * 收到事件的瞬间去读存储，读到的还是上一个状态。
   */
  async function waitForJob(
    jobs: JobStore,
    predicate: (job: AgentJob) => boolean,
    timeoutMs = 2_000,
  ): Promise<AgentJob> {
    const deadline = Date.now() + timeoutMs
    let seen: string[] = []
    while (Date.now() < deadline) {
      // limit 0 = 不限制：测试要看全部会话的 job
      const all = await jobs.list({ limit: 0 })
      seen = all.map((job) => `${job.id}:${job.status}`)
      const found = all.find(predicate)
      if (found !== undefined) return found
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`等 job 落盘超时（当前：${seen.join(', ') || '空'}）`)
  }

  /** 可控闸门：让工具停在执行中，用来制造"会话正在跑"与"跑到一半被中断"两种时序 */
  function createGate(): { promise: Promise<void>; open: () => void } {
    let open: () => void = () => {}
    const promise = new Promise<void>((resolve) => {
      open = resolve
    })
    return { promise, open }
  }

  /** 注册一个会挂起的工具；`started` 在 execute 真正进来时打开 */
  function registerHangingTool(harness: Harness, started: () => void, gate: Promise<void>): void {
    harness.tools.register({
      name: 'hang',
      description: '挂起直到被放行',
      parameters: { type: 'object' },
      execute: async () => {
        started()
        await gate
        return { content: '已放行', summary: '已放行' }
      },
    })
  }

  it('一次普通 send：建 job、落 done，stepsDone 记下工具步，事件流里有 job 事件', async () => {
    const fs = new TestFileSystem()
    const jobs = createJobs(fs, tickingClock())
    const harness = await createHarness({
      fs,
      jobs,
      rounds: [
        { toolCalls: [{ id: 'c1', name: 'echo', arguments: '{"text":"q"}' }] },
        { text: '完成' },
      ],
    })

    await harness.send('帮我回显')
    await harness.waitForDone()

    const job = await waitForJob(jobs, (item) => item.status === 'done')
    expect(job.status).toBe('done')
    expect(job.pendingReason).toBeUndefined()
    expect(job.sessionId).toBe('quick')
    expect(job.text).toBe('帮我回显')
    // 第 0 轮跑完把游标推到 1；第 1 轮正常收敛（没有工具调用，不经过 onRoundComplete）
    expect(job.cursor.nextRound).toBe(1)
    expect(job.stepsDone).toHaveLength(1)
    expect(job.stepsDone[0]).toMatchObject({ round: 0, tool: 'echo', ok: true })

    const summaries = harness.events.filter(
      (event): event is AgentEvent & { type: 'job' } => event.type === 'job',
    )
    // 建档一条 + 每轮结束一条 + 终态一条
    expect(summaries.length).toBeGreaterThanOrEqual(3)
    expect(summaries[0]?.job.status).toBe('running')
    expect(summaries.at(-1)?.job.status).toBe('done')
    expect(summaries.at(-1)?.job.stepCount).toBe(1)
    expect(summaries.at(-1)?.job.lastStep).toBe('echo ✓')
  })

  it('轮次用尽且没有自动续轮额度 → job 落 paused / pendingReason max-rounds', async () => {
    const fs = new TestFileSystem()
    const jobs = createJobs(fs, tickingClock())
    const harness = await createHarness({
      fs,
      jobs,
      maxRounds: () => 2,
      autoContinueRounds: () => 0,
      rounds: [
        { toolCalls: [{ id: 'c1', name: 'echo', arguments: '{}' }] },
        { toolCalls: [{ id: 'c2', name: 'echo', arguments: '{}' }] },
        { text: '本来还能继续' },
      ],
    })

    await harness.send('一直循环')
    await harness.waitForDone()

    const job = await waitForJob(jobs, (item) => item.status === 'paused')
    expect(job.pendingReason).toBe('max-rounds')
    expect(job.round).toBe(1)
    expect(job.cursor.nextRound).toBe(2)
    expect(harness.provider.calls).toHaveLength(2)
    // `done` 事件把原因原样带出去：渲染层据此给出「继续」入口而不是静默收尾
    expect(harness.events.find((event) => event.type === 'done')).toMatchObject({
      pending: true,
      pendingReason: 'max-rounds',
      round: 1,
    })
  })

  it('续跑 paused 的 job：接上游标、不重复落盘用户消息、最终 done', async () => {
    const fs = new TestFileSystem()
    const jobs = createJobs(fs, tickingClock())
    const harness = await createHarness({
      fs,
      jobs,
      maxRounds: () => 2,
      autoContinueRounds: () => 0,
      rounds: [
        { toolCalls: [{ id: 'c1', name: 'echo', arguments: '{}' }] },
        { toolCalls: [{ id: 'c2', name: 'echo', arguments: '{}' }] },
        { text: '续跑完成' },
      ],
    })
    // 桩：统计真正落盘的 user 消息（续跑最经典的 bug 就是又问一遍）
    const appended: string[] = []
    const append = harness.sessions.append.bind(harness.sessions)
    harness.sessions.append = async (sessionId: string, message: NewMessage) => {
      if (message.role === 'user') appended.push(message.content)
      return append(sessionId, message)
    }

    await harness.send('第一问')
    await harness.waitForDone()
    const paused = await waitForJob(jobs, (item) => item.status === 'paused')
    expect(appended).toEqual(['第一问'])

    harness.events.length = 0
    await harness.send('继续', 'quick', { resumeJobId: paused.id })
    await harness.waitForDone()

    const resumed = await waitForJob(
      jobs,
      (item) => item.id === paused.id && item.status === 'done',
    )
    // 同一条 job，不是新建的一条：origin / createdAt / 已完成的步都原样保留
    expect(resumed.id).toBe(paused.id)
    expect(resumed.origin).toBe('chat')
    expect(resumed.createdAt).toBe(paused.createdAt)
    expect(resumed.stepsDone).toHaveLength(2)
    expect(resumed.cursor.nextRound).toBe(2)
    // **续跑不重复落盘**：落盘过的 user 消息始终只有那一条
    expect(appended).toEqual(['第一问'])
    const stored = await harness.sessions.get('quick')
    expect(stored.filter((message) => message.role === 'user')).toHaveLength(1)
    // 但那条提问必须在上下文里（靠 history 带进去，而不是重新 push）
    const lastCall = harness.provider.calls.at(-1)
    expect(lastCall?.messages.filter((item) => item.role === 'user')).toHaveLength(1)
  })

  it('续跑一条已完成的 job → E_JOB_STATE，且一次 provider 都不再调', async () => {
    const fs = new TestFileSystem()
    const jobs = createJobs(fs, tickingClock())
    const harness = await createHarness({ fs, jobs, rounds: [{ text: '答' }] })

    await harness.send('第一问')
    await harness.waitForDone()
    const finished = await waitForJob(jobs, (item) => item.status === 'done')
    const callsBefore = harness.provider.calls.length

    harness.events.length = 0
    const first = await harness.send('继续', 'quick', { resumeJobId: finished.id })
    expect(harness.events.find((event) => event.type === 'error')).toMatchObject({
      requestId: first.requestId,
      code: ERROR_JOB_STATE,
    })
    expect(harness.provider.calls).toHaveLength(callsBefore)

    // 不存在的 job id 同款拒绝（不给"假装续跑、实际从头再来一遍"留缝隙）
    harness.events.length = 0
    await harness.send('继续', 'quick', { resumeJobId: 'job-not-exist' })
    expect(harness.events.find((event) => event.type === 'error')).toMatchObject({
      code: ERROR_JOB_STATE,
    })
    expect(harness.provider.calls).toHaveLength(callsBefore)
    // 被拒的续跑不占用会话：紧接着还能正常发新消息
    expect(harness.host.isBusy('quick')).toBe(false)
  })

  it('续跑时同会话已有请求在跑 → E_BUSY（不会两条一起跑）', async () => {
    const fs = new TestFileSystem()
    const jobs = createJobs(fs, tickingClock())
    const harness = await createHarness({
      fs,
      jobs,
      maxRounds: () => 1,
      autoContinueRounds: () => 0,
      rounds: [
        { toolCalls: [{ id: 'c1', name: 'echo', arguments: '{}' }] },
        { toolCalls: [{ id: 'c2', name: 'hang', arguments: '{}' }] },
      ],
    })
    const started = createGate()
    const gate = createGate()
    registerHangingTool(harness, started.open, gate.promise)

    await harness.send('第一问')
    await harness.waitForDone()
    const paused = await waitForJob(jobs, (item) => item.status === 'paused')

    // 第二条请求挂在 hang 工具上：会话此刻确实"正在跑"
    await harness.send('占住会话', 'quick')
    await started.promise

    harness.events.length = 0
    const { requestId } = await harness.send('继续', 'quick', { resumeJobId: paused.id })
    expect(harness.events.find((event) => event.type === 'error')).toMatchObject({
      requestId,
      code: ERROR_BUSY,
    })
    // E_BUSY 优先于续跑校验：那条 paused job 原样躺在那里，没被改坏
    expect((await jobs.get(paused.id))?.status).toBe('paused')

    gate.open()
    await waitForJob(jobs, (item) => item.text === '占住会话' && item.status === 'paused')
  })

  it('连点两次「继续」：第二次 E_BUSY，同会话不会跑起两条循环', async () => {
    const fs = new TestFileSystem()
    const jobs = createJobs(fs, tickingClock())
    const harness = await createHarness({
      fs,
      jobs,
      maxRounds: () => 1,
      autoContinueRounds: () => 0,
      rounds: [
        { toolCalls: [{ id: 'c1', name: 'hang', arguments: '{}' }] },
        // 续跑那次（第 2 次 provider 调用）同样要一次工具：这样"续跑正在跑"有一个**可控的**
        // 停留点，第二次发送必然撞上 active（否则桩会瞬间跑完，测的就成了调度运气）
        { toolCalls: [{ id: 'c2', name: 'hang', arguments: '{}' }] },
        { text: '续跑收敛' },
      ],
    })
    // 两道闸门：第 1 次 hang 立刻放行（首发要能跑完并落到 paused），第 2 次 hang 挂在第二道闸门上，
    // 等我们打完"连点"再放行。
    const firstGate = createGate()
    const secondGate = createGate()
    const gates = [firstGate.promise, secondGate.promise]
    let hangCalls = 0
    harness.tools.register({
      name: 'hang',
      description: '挂起直到被放行',
      parameters: { type: 'object' },
      execute: async () => {
        const index = Math.min(hangCalls, gates.length - 1)
        hangCalls += 1
        await gates[index]
        return { content: '已放行', summary: '已放行' }
      },
    })
    firstGate.open()

    await harness.send('第一问')
    await harness.waitForDone()
    const paused = await waitForJob(jobs, (item) => item.status === 'paused')

    harness.events.length = 0
    const hangBefore = hangCalls
    const first = harness.send('继续', 'quick', { resumeJobId: paused.id })
    // 等续跑真的进到工具执行（此刻 `active` 里一定有这条会话）
    for (let attempt = 0; attempt < 200 && hangCalls === hangBefore; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const second = await harness.send('继续', 'quick', { resumeJobId: paused.id })
    secondGate.open()
    await Promise.all([first, second])

    expect(
      harness.events.filter((event) => event.type === 'error' && event.code === ERROR_BUSY),
    ).toHaveLength(1)
    // 续跑只推进了一轮就又停下（maxRounds=1 且没有自动续轮额度）：游标恰好多 1 ——
    // 既证明"它真的接着上一轮的游标跑"，也证明"第二次发送没有另起一条循环"
    const resumed = await waitForJob(
      jobs,
      (item) => item.id === paused.id && item.cursor.nextRound === paused.cursor.nextRound + 1,
    )
    expect(resumed.status).toBe('paused')
    // 只有一条真的跑了：首发 1 次 + 续跑 1 次（被 E_BUSY 挡下的那次没有打 provider）
    expect(harness.provider.calls).toHaveLength(2)
    const stored = await harness.sessions.get('quick')
    expect(stored.filter((message) => message.role === 'user')).toHaveLength(1)
  })

  it('续跑判定等完 `jobs.get` 会再确认一次会话空闲（否则连点会跑两条循环）', async () => {
    const fs = new TestFileSystem()
    const jobs = createJobs(fs, tickingClock())
    const harness = await createHarness({
      fs,
      jobs,
      maxRounds: () => 1,
      autoContinueRounds: () => 0,
      rounds: [
        { toolCalls: [{ id: 'c1', name: 'echo', arguments: '{}' }] },
        { toolCalls: [{ id: 'c2', name: 'hang', arguments: '{}' }] },
      ],
    })
    const started = createGate()
    const gate = createGate()
    registerHangingTool(harness, started.open, gate.promise)

    await harness.send('第一问')
    await harness.waitForDone()
    const paused = await waitForJob(jobs, (item) => item.status === 'paused')

    /** 轮询等条件成立（只用来把并发交错**钉成**确定时序，不赌调度） */
    const waitUntil = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (predicate()) return
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      throw new Error(
        `等条件成立超时 DEBUG reads=${reads} busy=${String(
          harness.host.isBusy('quick'),
        )} agents=${harness.provider.calls.length} trace=${trace.join(',')} logs=${harness.logger.entries.join(
          '|',
        )}`,
      )
    }

    // 把交错钉死：让**第二次**的续跑校验读到"第一次已把它置成 running 之前"的快照
    //（两次 `jobs.get` 都在第一次落盘之前取到，真实并发下本就可能），并等第一条真的
    // 占住会话之后再返回 —— 于是第二个请求必然走过"是不是 paused"这一关、撞上
    // 等待之后的二次确认；少了那道确认，两个请求会各跑一条循环（provider 会被调 3 次）
    const trace: string[] = []
    const read = jobs.get.bind(jobs)
    let reads = 0
    jobs.get = async (id: string) => {
      const mine = (reads += 1)
      trace.push(`g${mine}:in`)
      const snapshot = await read(id)
      trace.push(`g${mine}:out=${snapshot?.status ?? 'none'}`)
      if (mine === 2) await waitUntil(() => harness.host.isBusy('quick'))
      return snapshot
    }

    harness.events.length = 0
    const first = harness.send('继续', 'quick', { resumeJobId: paused.id })
    const second = harness.send('继续', 'quick', { resumeJobId: paused.id })
    await Promise.all([first, second])
    await started.promise

    // 交错确实走到了"读到 paused 快照 + 会话已忙"这一支
    expect(reads).toBe(2)
    expect(
      harness.events.filter((event) => event.type === 'error' && event.code === ERROR_BUSY),
    ).toHaveLength(1)
    expect(harness.provider.calls).toHaveLength(2)

    gate.open()
    await waitForJob(jobs, (item) => item.id === paused.id && item.cursor.nextRound === 2)
    expect(harness.provider.calls).toHaveLength(2)
  })

  it('maxRounds 是 getter：热改后新 job 用新上限，不是构造时常量', async () => {
    const fs = new TestFileSystem()
    const jobs = createJobs(fs, tickingClock())
    let limit = 2
    const harness = await createHarness({
      fs,
      jobs,
      maxRounds: () => limit,
      autoContinueRounds: () => 0,
      rounds: [
        { toolCalls: [{ id: 'c1', name: 'echo', arguments: '{}' }] },
        { toolCalls: [{ id: 'c2', name: 'echo', arguments: '{}' }] },
        { text: '完成' },
      ],
    })

    await harness.send('第一问')
    await harness.waitForDone()
    const first = await waitForJob(jobs, (item) => item.status === 'paused')
    expect(first.maxRounds).toBe(2)

    // 像用户在设置页把轮次上限改成 5：下一次请求就该用 5（v15 之前这里必须重启）
    limit = 5
    harness.events.length = 0
    await harness.send('第二问')
    await harness.waitForDone()
    const second = await waitForJob(jobs, (item) => item.id !== first.id && item.status === 'done')
    expect(second.maxRounds).toBe(5)
  })

  it('自动续轮：maxRounds=1 + 额度 2 → 跑满 3 轮才 paused，autoContinued=2', async () => {
    const fs = new TestFileSystem()
    const jobs = createJobs(fs, tickingClock())
    const harness = await createHarness({
      fs,
      jobs,
      maxRounds: () => 1,
      autoContinueRounds: () => 2,
      rounds: [
        { toolCalls: [{ id: 'c1', name: 'echo', arguments: '{}' }] },
        { toolCalls: [{ id: 'c2', name: 'echo', arguments: '{}' }] },
        { toolCalls: [{ id: 'c3', name: 'echo', arguments: '{}' }] },
      ],
    })

    await harness.send('长任务')
    await harness.waitForDone()

    const job = await waitForJob(jobs, (item) => item.status === 'paused')
    // 首发 1 轮 + 自动续 2 轮
    expect(harness.provider.calls).toHaveLength(3)
    expect(job.budget.autoContinued).toBe(2)
    expect(job.pendingReason).toBe('max-rounds')
    // 续轮是"接着跑"而不是从头来：三轮各占一个**绝对**轮次
    expect(job.stepsDone.map((step) => step.round)).toEqual([0, 1, 2])
    expect(job.cursor.nextRound).toBe(3)
    // 自动续轮必须留痕：用户没盯着也继续跑，日志是唯一的审计点
    expect(harness.logger.entries.filter((entry) => entry.includes('自动续轮额度'))).toHaveLength(2)
    // 用户消息只落一次：续轮同样不能把提问重复写进历史
    const stored = await harness.sessions.get('quick')
    expect(stored.filter((message) => message.role === 'user')).toHaveLength(1)
  })

  it('自动续轮的请求带本轮提问与上一轮工具结果（每 attempt 重读会话组装历史）', async () => {
    // 报障现场：历史与系统提示曾在 attempt 循环**之外**只算一次，续轮拿着"请求前"的旧快照
    // 新建循环，而 `appendUserMessage = false` 又不补提问 —— 第二轮既没有本轮提问、
    // 也没有上一轮的工具结果，模型会重复已执行的操作。修复 = 每个 attempt 重读会话。
    const fs = new TestFileSystem()
    const jobs = createJobs(fs, tickingClock())
    // 每次读取都变一个版本号：钉住「systemPrompt 每 attempt 重组」——块若退回循环外，
    // 三个请求的 system 会全是 `…-1`（2026-09 独立审查：该不变量此前只有注释宣称、无测试钉）
    let instructionsReads = 0
    const harness = await createHarness({
      fs,
      jobs,
      maxRounds: () => 1,
      autoContinueRounds: () => 2,
      projectInstructions: async () => `续轮注入验证-${(instructionsReads += 1)}`,
      rounds: [
        { toolCalls: [{ id: 'c1', name: 'echo', arguments: '{"text":"q"}' }] },
        { toolCalls: [{ id: 'c2', name: 'echo', arguments: '{"text":"r"}' }] },
        { text: '完成' },
      ],
    })

    await harness.send('问题X')
    await harness.waitForDone()
    await waitForJob(jobs, (item) => item.status === 'done')

    expect(harness.provider.calls).toHaveLength(3)
    // 三个请求的系统提示各带自己 attempt 注入的版本（重算的直接证据，同时证明不是"整体重放"）
    expect(harness.provider.calls[0]?.messages[0]?.content).toContain('续轮注入验证-1')
    expect(harness.provider.calls[1]?.messages[0]?.content).toContain('续轮注入验证-2')
    expect(harness.provider.calls[2]?.messages[0]?.content).toContain('续轮注入验证-3')
    const serialized = harness.provider.calls.map((call) => JSON.stringify(call.messages))
    // bug 现场就在续轮的首请求（calls[1]）：必须同时看到本轮提问与上一 attempt 的工具结果
    expect(serialized[1]).toContain('问题X')
    expect(serialized[1]).toContain('echo:q')
    // 第二次续轮同理带上前一轮的结果
    expect(serialized[2]).toContain('问题X')
    expect(serialized[2]).toContain('echo:r')
    // 防"重读后又重复 push"：每个请求里带提问的 user 消息恰好一条
    for (const [index, call] of harness.provider.calls.entries()) {
      const userAsks = call.messages.filter(
        (message) => message.role === 'user' && JSON.stringify(message).includes('问题X'),
      )
      expect(userAsks, `第 ${index} 次请求的 user 提问条数`).toHaveLength(1)
    }
    // 会话侧同样只有一条提问：重读会话不等于重复落盘
    const stored = await harness.sessions.get('quick')
    expect(
      stored.filter((message) => message.role === 'user' && message.content.includes('问题X')),
    ).toHaveLength(1)
  })

  it('用量按差值累加：每个 attempt 的累计值不会被重复计入总额', async () => {
    const fs = new TestFileSystem()
    const jobs = createJobs(fs, tickingClock())
    const usage = { promptTokens: 40, completionTokens: 10, totalTokens: 50 }
    const harness = await createHarness({
      fs,
      jobs,
      maxRounds: () => 3,
      maxTotalTokens: () => 150,
      autoContinueRounds: () => 0,
      rounds: [
        { toolCalls: [{ id: 'c1', name: 'echo', arguments: '{}' }], usage },
        { toolCalls: [{ id: 'c2', name: 'echo', arguments: '{}' }], usage },
        { text: '完成' },
      ],
    })

    await harness.send('两轮工具')
    await harness.waitForDone()

    const job = await waitForJob(jobs, (item) => item.status === 'done')
    // 循环给的 `usedTokens` 是**本次 attempt** 的累计（50 → 100），只有按差值累加才是
    // 真实总量；直接相加会得到 150（第 0 轮的 50 被计了两遍）
    expect(job.budget.usedTokens).toBe(100)
    expect(job.budget.maxTotalTokens).toBe(150)
    expect(job.stepsDone).toHaveLength(2)
  })

  it('预算触顶 → job 落 paused / pendingReason budget，且不再自动续轮', async () => {
    const fs = new TestFileSystem()
    const jobs = createJobs(fs, tickingClock())
    const harness = await createHarness({
      fs,
      jobs,
      maxRounds: () => 3,
      maxTotalTokens: () => 50,
      autoContinueRounds: () => 2,
      rounds: [
        {
          toolCalls: [{ id: 'c1', name: 'echo', arguments: '{}' }],
          usage: { promptTokens: 40, completionTokens: 10, totalTokens: 50 },
        },
        { text: '不该跑到这里' },
      ],
    })

    await harness.send('很贵的任务')
    await harness.waitForDone()

    const job = await waitForJob(jobs, (item) => item.status === 'paused')
    expect(job.pendingReason).toBe('budget')
    expect(job.budget.usedTokens).toBe(50)
    // 预算触顶**不**走自动续轮（额度还在也不续）：那正是预算存在的意义
    expect(job.budget.autoContinued).toBe(0)
    expect(harness.provider.calls).toHaveLength(1)
    expect(harness.events.find((event) => event.type === 'done')).toMatchObject({
      pending: true,
      pendingReason: 'budget',
    })
  })

  it('重启后 autoContinued 不重置：额度用尽即 paused，不会重新发一份', async () => {
    const fs = new TestFileSystem()
    const rounds: ScriptRound[] = [
      { toolCalls: [{ id: 'c1', name: 'echo', arguments: '{}' }] },
      { toolCalls: [{ id: 'c2', name: 'echo', arguments: '{}' }] },
      { toolCalls: [{ id: 'c3', name: 'echo', arguments: '{}' }] },
    ]

    // 第一个"进程"：额度 1，跑光后落 paused（autoContinued = 1）
    const firstStore = createJobs(fs, tickingClock())
    const first = await createHarness({
      fs,
      jobs: firstStore,
      rounds,
      maxRounds: () => 1,
      autoContinueRounds: () => 1,
    })
    await first.send('长任务')
    await first.waitForDone()
    const paused = await waitForJob(firstStore, (item) => item.status === 'paused')
    expect(paused.budget.autoContinued).toBe(1)
    await firstStore.flush()

    // 第二个"进程"：新的 store 实例读同一份磁盘（内存 fs）
    const secondStore = createJobs(fs, tickingClock())
    expect((await secondStore.get(paused.id))?.budget.autoContinued).toBe(1)

    const second = await createHarness({
      fs,
      jobs: secondStore,
      rounds,
      maxRounds: () => 1,
      autoContinueRounds: () => 1,
    })
    await second.send('继续', 'quick', { resumeJobId: paused.id })
    await second.waitForDone()

    const again = await waitForJob(
      secondStore,
      (item) => item.id === paused.id && item.status === 'paused',
    )
    // 额度已经在上一个进程里用掉了：再续跑只跑 1 轮就停，**不会**重新拿到额度
    expect(again.budget.autoContinued).toBe(1)
    expect(second.provider.calls).toHaveLength(1)
    expect(again.cursor.nextRound).toBe(3)
  })

  it('abort → job 落 aborted，已完成的那几步不丢', async () => {
    const fs = new TestFileSystem()
    const jobs = createJobs(fs, tickingClock())
    const harness = await createHarness({
      fs,
      jobs,
      rounds: [
        { toolCalls: [{ id: 'c1', name: 'echo', arguments: '{}' }] },
        { toolCalls: [{ id: 'c2', name: 'hang', arguments: '{}' }] },
      ],
    })
    const started = createGate()
    const gate = createGate()
    registerHangingTool(harness, started.open, gate.promise)

    const { requestId } = await harness.send('长任务')
    await started.promise
    expect(harness.host.abort(requestId)).toBe(true)

    // abort 立刻把 job 乐观落 aborted（不等循环收尾）
    const aborted = await waitForJob(jobs, (item) => item.status === 'aborted')
    expect(aborted.pendingReason).toBe('aborted')
    expect(aborted.stepsDone).toHaveLength(1)

    // 放掉挂起的工具，循环这一趟才真正收尾
    gate.open()
    await waitForJob(jobs, (item) => item.id === aborted.id && item.pendingReason === 'aborted')
    await harness.waitForDone()
    expect(harness.host.isBusy('quick')).toBe(false)
    // 中断后那条 job 不能被改回 running / paused
    expect((await jobs.get(aborted.id))?.status).toBe('aborted')
  })

  it('循环报 error 事件 → job 落 error / 原文入 error 字段（不是 done）', async () => {
    const fs = new TestFileSystem()
    const jobs = createJobs(fs, tickingClock())
    const harness = await createHarness({
      fs,
      jobs,
      rounds: [{ error: { code: 'E_LLM', message: '上游 500' } }],
    })

    await harness.send('会失败的一问')
    await harness.waitForDone()

    const job = await waitForJob(jobs, (item) => item.status === 'error')
    expect(job.error).toBe('上游 500')
    expect(job.pendingReason).toBeUndefined()
    expect(job.stepsDone).toHaveLength(0)
  })

  it('请求途中抛错 → job 同样落 error（不会永远停在 running）', async () => {
    const fs = new TestFileSystem()
    const jobs = createJobs(fs, tickingClock())
    const harness = await createHarness({ fs, jobs, rounds: [{ text: '答' }] })
    // 组装历史时炸掉（此刻 job 已经建档）：异常路径也必须落终态，
    // 否则界面上这条任务"一直在跑"，而续跑入口只认 paused —— 既看不到结束也接不上
    harness.sessions.get = async () => {
      throw new Error('会话读取失败')
    }

    await harness.send('会失败的一问')
    await harness.waitForDone()

    const job = await waitForJob(jobs, (item) => item.status === 'error')
    expect(job.error).toBe('会话读取失败')
    expect(
      harness.events.some((event) => event.type === 'error' && event.code === 'E_UNKNOWN'),
    ).toBe(true)
    expect(harness.provider.calls).toHaveLength(0)
  })
})

/**
 * 运行档（v0.2.8，docs/06 §5.2、docs/13 §7.1）：自动化触发的会话换人设、加「本次运行」小节、
 * 并按运行来源摘掉若干工具。这里是装配层的接线回归 —— 三条消费（提示词人设 / 工具清单 / 循环
 * 执行用的工具表）必须都走同一份过滤视图，漏一处都会让模型看到"清单里有、调了却说工具不存在"。
 */
describe('KernelAgentHost · 运行档（自动化会话）', () => {
  const profileFor = (context: { sessionId: string; origin: string }) =>
    context.origin === 'automation' || context.sessionId.startsWith('auto-')
      ? {
          persona: '你是后台执行体：无人值守，自己决定，做完汇报。',
          runContext: '本次运行由自动化触发，没有人在旁边回话。',
          hiddenTools: ['echo'],
        }
      : undefined

  it('origin=automation：换人设 + 本次运行小节 + 摘掉的工具在提示词与请求体里都不在', async () => {
    const harness = await createHarness({ rounds: [{ text: '做完了' }], runProfileFor: profileFor })
    await harness.host.send({ sessionId: 'auto-1', text: '整理笔记', origin: 'automation' })
    await harness.waitForDone()

    const request = harness.provider.calls[0]
    const systemPrompt = request?.messages[0]?.content ?? ''
    expect(systemPrompt.startsWith('你是后台执行体')).toBe(true)
    expect(systemPrompt).toContain('## 本次运行')
    expect(systemPrompt).toContain('没有人在旁边回话')
    // 被摘掉的工具三处同时消失：人设替换（非追加）也一并成立
    expect(systemPrompt).not.toContain('- echo：回显')
    const toolNames = (request?.tools ?? []).map((tool) => tool.name)
    expect(toolNames).not.toContain('echo')

    // 真调用它 → 循环按"工具不存在"回填（模型拿到的是可解释的拒绝，而不是静默失败）
    const result = await harness.tools.get('echo')!.execute({ text: 'x' }, { sessionId: 'auto-1' })
    expect(result.content).toBe('echo:x')
  })

  it('会话 id 命中 auto-（origin 仍是 chat，如续跑）按同一档跑', async () => {
    const harness = await createHarness({ rounds: [{ text: 'ok' }], runProfileFor: profileFor })
    await harness.host.send({ sessionId: 'auto-2', text: '继续', origin: 'chat' })
    await harness.waitForDone()
    expect(harness.provider.calls[0]?.messages[0]?.content).toContain('## 本次运行')
  })

  it('普通会话不受影响：默认人设、无「本次运行」、工具照旧齐全', async () => {
    const harness = await createHarness({ rounds: [{ text: 'ok' }], runProfileFor: profileFor })
    await harness.send('你好')
    await harness.waitForDone()
    const request = harness.provider.calls[0]
    const systemPrompt = request?.messages[0]?.content ?? ''
    expect(systemPrompt).not.toContain('## 本次运行')
    expect(systemPrompt).toContain('- echo：回显')
    expect((request?.tools ?? []).map((tool) => tool.name)).toContain('echo')
  })

  it('运行档解析抛错 → 降级为默认档（提示词问题不拖垮请求）并留痕', async () => {
    const harness = await createHarness({
      rounds: [{ text: 'ok' }],
      runProfileFor: () => {
        throw new Error('装配层炸了')
      },
    })
    await harness.send('你好')
    await harness.waitForDone()
    expect(harness.provider.calls[0]?.messages[0]?.content).not.toContain('## 本次运行')
    expect(harness.events.some((event) => event.type === 'done')).toBe(true)
    expect(harness.logger.entries.some((entry) => entry.includes('运行档解析失败'))).toBe(true)
  })
})

describe('KernelAgentHost · 多模态输入（docs/06 §3.1，v22）', () => {
  /** 读盘端口假实现：登记过的路径读得出，其余读不出（带 note） */
  const loader =
    (files: Record<string, string>): NonNullable<AgentHostDeps['loadImages']> =>
    async (paths) =>
      paths.map((path) =>
        files[path] === undefined
          ? { path }
          : { path, image: { mimeType: 'image/png', dataBase64: files[path]!, name: 'a.png' } },
      )

  it('vision 开：本轮图片作为图片分片进请求，路径落进会话历史', async () => {
    const harness = await createHarness({
      rounds: [{ text: '看到了' }],
      vision: true,
      loadImages: loader({ 'C:\\pic.png': 'AAAA' }),
    })
    await harness.send('这是什么', 'quick', { images: ['C:\\pic.png'] })
    await harness.waitForDone()

    const sent = harness.provider.calls[0]?.messages.at(-1)
    expect(sent).toMatchObject({
      role: 'user',
      content: '这是什么',
      images: [{ mimeType: 'image/png', dataBase64: 'AAAA', name: 'a.png' }],
    })
    // 会话里存的是**路径**（不是 base64）：文件不因图片膨胀，重放时按路径重读
    const stored = await harness.sessions.get('quick')
    const user = stored.find((message) => message.role === 'user')
    expect(user?.images).toEqual(['C:\\pic.png'])
    expect(user?.content).toBe('这是什么')
  })

  it('vision 开：跨轮次重放历史里的图片（用户追问「刚才那张图」时模型仍看得到）', async () => {
    const fs = new TestFileSystem()
    const loadImages = loader({ 'C:\\pic.png': 'AAAA' })
    const first = await createHarness({
      rounds: [{ text: '第一轮' }],
      fs,
      vision: true,
      loadImages,
    })
    await first.send('看这张', 'quick', { images: ['C:\\pic.png'] })
    await first.waitForDone()

    // 换一个 host 实例（模拟重启后新的一轮）：历史从磁盘读回，图片按路径重新读盘
    const second = await createHarness({
      rounds: [{ text: '第二轮' }],
      fs,
      vision: true,
      loadImages,
    })
    await second.send('图里有什么', 'quick')
    await second.waitForDone()

    const messages = second.provider.calls[0]?.messages ?? []
    const withImage = messages.find((message) => message.content === '看这张')
    expect(withImage?.images).toEqual([
      { mimeType: 'image/png', dataBase64: 'AAAA', name: 'a.png' },
    ])
  })

  it('vision 关：路径照样落盘，但请求里**没有**图片分片', async () => {
    const harness = await createHarness({
      rounds: [{ text: '好的' }],
      vision: false,
      loadImages: loader({ 'C:\\pic.png': 'AAAA' }),
    })
    await harness.send('这是什么', 'quick', { images: ['C:\\pic.png'] })
    await harness.waitForDone()

    const sent = harness.provider.calls[0]?.messages.at(-1)
    expect(sent?.images).toBeUndefined()
    // 落盘与下发是两件事：开关关着也写路径 —— 用户之后打开开关，历史里那张图立刻能重放
    const stored = await harness.sessions.get('quick')
    expect(stored.find((message) => message.role === 'user')?.images).toEqual(['C:\\pic.png'])
  })

  it('vision 开但读盘失败：该图跳过并记 warn，请求照常发出（不阻断）', async () => {
    const harness = await createHarness({
      rounds: [{ text: '好的' }],
      vision: true,
      loadImages: loader({}),
    })
    await harness.send('这是什么', 'quick', { images: ['C:\\gone.png'] })
    await harness.waitForDone()

    const sent = harness.provider.calls[0]?.messages.at(-1)
    expect(sent?.images).toBeUndefined()
    expect(harness.logger.entries.some((entry) => entry.includes('图片附件读取失败'))).toBe(true)
    expect(harness.events.some((event) => event.type === 'done')).toBe(true)
  })

  it('未注入读盘端口：图片不重放（与 v22 之前的行为一致）', async () => {
    const harness = await createHarness({ rounds: [{ text: '好的' }], vision: true })
    await harness.send('这是什么', 'quick', { images: ['C:\\pic.png'] })
    await harness.waitForDone()
    expect(harness.provider.calls[0]?.messages.at(-1)?.images).toBeUndefined()
  })

  /**
   * 回归：**同一个 host 实例里中途关掉开关**。
   *
   * `imageCache` 是进程级、不淘汰的，所以「先开着跑一轮（图进缓存）→ 再关掉」时，
   * 光判断「要不要读盘」是拦不住的 —— 缓存里那几张图照样会被解析出来下发。
   * 这条真实路径是 smoke 实测踩到的（同进程连续两次发送，第二次仍有 `image_url` 分片）。
   *
   * 断言前**必须等到第二次请求真的发出去**：`waitForDone()` 看的是累积事件数组，
   * 第一次发送留下的 `done` 会让它立刻返回，于是 `calls[1]` 还是 undefined ——
   * 那种写法下「图片泄漏」这条断言在调用根本没发生时也恒真（反向复核实测：
   * 拿掉修复代码它照样 PASS）。
   */
  it('中途关闭开关：缓存里已有的图也不得再下发', async () => {
    let vision = true
    const harness = await createHarness({
      rounds: [{ text: '第一轮' }, { text: '第二轮' }],
      visionGetter: () => vision,
      loadImages: loader({ 'C:\\pic.png': 'AAAA' }),
    })
    /** 等第 `count` 次请求真的落到 provider 上（带超时，超时即算失败） */
    const waitForCall = async (count: number): Promise<void> => {
      const deadline = Date.now() + 2_000
      while (harness.provider.calls.length < count && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }

    await harness.send('看这张', 's1', { images: ['C:\\pic.png'] })
    await waitForCall(1)
    expect(harness.provider.calls[0]?.messages.at(-1)?.images).toBeDefined()

    // 关掉开关，换一个**全新会话**（历史里没有图片）再发一次：请求里不得有任何图片分片
    vision = false
    await harness.send('还看得见吗', 's2', { images: ['C:\\pic.png'] })
    await waitForCall(2)
    expect(harness.provider.calls[1]?.messages.at(-1)?.content).toBe('还看得见吗')
    expect(harness.provider.calls[1]?.messages.at(-1)?.images).toBeUndefined()
  })
})
