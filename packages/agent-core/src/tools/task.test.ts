/**
 * `task` 子代理工具的内核单测（docs/06 §19）。
 *
 * 用 createFakeProvider 编排子代理轮次，验证：子工具表过滤（拿不到 confirm
 * 工具与 task 自身）、报告回传与截断、abort 传导、todo 会话隔离（`-sub` 后缀）、
 * error / pending / 空报告等结果的组装口径。全程不发起真实网络请求。
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_TASK_RESULT_CHARS,
  SUBAGENT_SESSION_SUFFIX,
  TASK_TOOL_NAME,
  createTaskTool,
  parentSessionIdOf,
} from './task.js'
import { createTodoTools } from './todo.js'
import type { TodoItem, TodoPort } from './todo.js'
import { ToolRegistry } from './registry.js'
import type { ToolDefinition } from './registry.js'
import type { SubagentSnapshot } from '@aurora/shared'
import { createFakeProvider } from '../testing/fakeProvider.js'
import type { ScriptRound } from '../testing/fakeProvider.js'
import type { LoopProvider } from '../loop/agentLoop.js'
import type { ChatEvent } from '../llm/types.js'
import { createSubagentLimiter } from './subagent-limiter.js'

const DESCRIPTION = '调研资料'
const PROMPT = '整理 Aurora 项目的模块清单并汇总'

const CONTEXT = { sessionId: 'quick' }

function makeTool(
  name: string,
  sensitivity?: 'safe' | 'confirm',
  execute?: ToolDefinition['execute'],
): ToolDefinition {
  return {
    name,
    description: `${name} 的说明`,
    parameters: { type: 'object' },
    ...(sensitivity === undefined ? {} : { sensitivity }),
    execute: execute ?? (async () => ({ content: `${name} 结果`, summary: name })),
  }
}

interface Harness {
  tool: ToolDefinition
  provider: ReturnType<typeof createFakeProvider>
  parent: ToolRegistry
}

function createHarness(options: {
  rounds: ScriptRound[]
  /** 额外注册进父表的工具（task 自身在 harness 里统一注册） */
  extraTools?: ToolDefinition[]
  withProvider?: boolean
  /** 让 provider.create() 直接抛错（验证意外异常转 isError） */
  createThrows?: unknown
  maxRounds?: number
  /** 只读档下装配层注入的「子代理可见的工具名白名单」（docs/06 §11.2） */
  subagentToolNames?: () => readonly string[]
  /** 父会话的确认回调（`permission: 'write'` 的写入授权要靠它） */
  confirmTool?: (info: {
    name: string
    input: unknown
    sensitivity: 'confirm'
    sessionId: string
  }) => Promise<boolean | 'always' | 'machine'>
}): Harness {
  const provider = createFakeProvider(options.rounds)
  const parent = new ToolRegistry()
  for (const tool of options.extraTools ?? []) parent.register(tool)
  const tool = createTaskTool({
    provider: {
      create: () => {
        if (options.createThrows !== undefined) throw options.createThrows
        return options.withProvider === false
          ? undefined
          : { provider, model: 'fake-model', temperature: 0.2 }
      },
    },
    tools: parent,
    ...(options.maxRounds === undefined ? {} : { maxRounds: options.maxRounds }),
    ...(options.subagentToolNames === undefined
      ? {}
      : { subagentToolNames: options.subagentToolNames }),
    ...(options.confirmTool === undefined ? {} : { confirmTool: options.confirmTool }),
  })
  parent.register(tool)
  return { tool, provider, parent }
}

describe('parentSessionIdOf', () => {
  it('剥掉末尾的 -sub 后缀：quick-sub → quick（A2：工具 deps 按父会话解析工作目录）', () => {
    expect(parentSessionIdOf(`quick${SUBAGENT_SESSION_SUFFIX}`)).toBe('quick')
  })

  it('无后缀 / 非末尾后缀原样返回；幂等；裸 -sub 不剥（剥完为空串的不是合法会话 id）', () => {
    expect(parentSessionIdOf('quick')).toBe('quick')
    expect(parentSessionIdOf('center-abc-1')).toBe('center-abc-1')
    expect(parentSessionIdOf('a-sub-sub')).toBe('a-sub')
    expect(parentSessionIdOf(parentSessionIdOf('quick-sub'))).toBe('quick')
    expect(parentSessionIdOf(SUBAGENT_SESSION_SUFFIX)).toBe(SUBAGENT_SESSION_SUFFIX)
    expect(parentSessionIdOf('')).toBe('')
  })
})

describe('createTaskTool', () => {
  it('声明 task 名、safe 敏感级、可并发与必填参数', () => {
    const { tool } = createHarness({ rounds: [] })
    expect(tool.name).toBe(TASK_TOOL_NAME)
    expect(tool.sensitivity).toBe('safe')
    // 同轮多个 task 可入并发批（真正并发度由 subagent-limiter 按父会话限制，docs/06 §19.5）
    expect(tool.parallel).toBe(true)
    expect(tool.parameters.required).toEqual(['description', 'prompt'])
  })

  it('子代理只见过滤后的工具：confirm 工具与 task 自身被排除', async () => {
    const { tool, provider } = createHarness({
      rounds: [{ text: '报告内容' }],
      extraTools: [makeTool('probe'), makeTool('danger', 'confirm')],
    })
    const result = await tool.execute({ description: DESCRIPTION, prompt: PROMPT }, CONTEXT)

    expect(result.isError).toBeUndefined()
    expect(result.content).toBe('报告内容')
    expect(result.summary).toBe(`子代理：${DESCRIPTION}`)
    // 发给模型的 tools 清单只含 safe 的 probe（danger 被 confirm 过滤、task 被递归过滤）
    const tools = provider.calls[0]?.tools?.map((item) => item.name) ?? []
    expect(tools).toEqual(['probe'])
    // 子代理人设与过滤后的工具目录进入系统提示词
    const system = provider.calls[0]?.messages[0]
    expect(system?.role).toBe('system')
    expect(system?.content).toContain('子代理')
    expect(system?.content).toContain('probe')
  })

  it('注入白名单（只读档）→ 子代理工具表只剩白名单内的名字（交集）', async () => {
    const { tool, provider } = createHarness({
      rounds: [{ text: '报告内容' }],
      extraTools: [makeTool('read_file'), makeTool('list_dir'), makeTool('grep')],
      subagentToolNames: () => ['read_file', 'list_dir'],
    })
    const result = await tool.execute({ description: DESCRIPTION, prompt: PROMPT }, CONTEXT)

    expect(result.isError).toBeUndefined()
    const tools = provider.calls[0]?.tools?.map((item) => item.name) ?? []
    expect(tools).toEqual(['list_dir', 'read_file'])
    // 提示词里的工具目录与请求体的 tools 同源（都来自过滤后的子表）
    expect(provider.calls[0]?.messages[0]?.content).not.toContain('grep')
  })

  it('白名单含 confirm 级 / task / mcp 工具名时依然拿不到（白名单只做减法）', async () => {
    const { tool, provider } = createHarness({
      rounds: [{ text: '报告内容' }],
      extraTools: [
        makeTool('read_file'),
        makeTool('write_file', 'confirm'),
        makeTool('mcp.demo.tool'),
      ],
      // 装配层写错时也不能放开：白名单与既有三道过滤取交集
      subagentToolNames: () => ['read_file', 'write_file', 'mcp.demo.tool', TASK_TOOL_NAME],
    })
    const result = await tool.execute({ description: DESCRIPTION, prompt: PROMPT }, CONTEXT)

    expect(result.isError).toBeUndefined()
    expect(provider.calls[0]?.tools?.map((item) => item.name)).toEqual(['read_file'])
  })

  it('未注入白名单 → 工具表与今天完全一致（不过滤）', async () => {
    const { tool, provider } = createHarness({
      rounds: [{ text: '报告内容' }],
      extraTools: [makeTool('read_file'), makeTool('grep')],
    })
    const result = await tool.execute({ description: DESCRIPTION, prompt: PROMPT }, CONTEXT)

    expect(result.isError).toBeUndefined()
    expect(provider.calls[0]?.tools?.map((item) => item.name)).toEqual(['grep', 'read_file'])
  })

  it(`报告超过 ${MAX_TASK_RESULT_CHARS} 字符时从尾部截断并附说明`, async () => {
    const { tool } = createHarness({
      rounds: [{ text: 'a'.repeat(MAX_TASK_RESULT_CHARS + 500) }],
    })
    const result = await tool.execute({ description: DESCRIPTION, prompt: PROMPT }, CONTEXT)
    expect(result.isError).toBeUndefined()
    expect(result.content).toBe('a'.repeat(MAX_TASK_RESULT_CHARS) + '…（子代理结果过长，已截断）')
  })

  it('进度上报：初始快照 + 每步一次 + 终态（含报告），callId 取自工具上下文', async () => {
    const { tool } = createHarness({
      rounds: [
        // 子代理第 1 轮：一段文本 + 一次工具调用
        { text: '先读目录', toolCalls: [{ id: 'sub-call-1', name: 'probe' }] },
        { text: '结论：模块清单如下。' },
      ],
      extraTools: [makeTool('probe')],
    })
    const snapshots: SubagentSnapshot[] = []
    const result = await tool.execute(
      { description: DESCRIPTION, prompt: PROMPT },
      {
        sessionId: 'quick',
        toolCallId: 'call-parent-1',
        emitProgress: (payload) => {
          expect(payload.kind).toBe('subagent')
          snapshots.push(payload.snapshot)
        },
      },
    )

    // ① 派生瞬间先推一份「已开始」的空快照（卡片要立刻出现，而不是等第一个事件）
    expect(snapshots.length).toBeGreaterThanOrEqual(3)
    expect(snapshots[0]).toMatchObject({ status: 'running', toolCalls: 0, callId: 'call-parent-1' })
    expect(snapshots[0]?.steps).toEqual([])
    // ② 中途快照：文本步骤 + 工具步骤（running 与终态各一次，按 call.id 原地更新不重复）
    const running = snapshots.find((item) =>
      item.steps.some((step) => step.kind === 'tool' && step.state === 'running'),
    )
    expect(running?.status).toBe('running')
    expect(running?.toolCalls).toBe(1)
    // ③ 终态快照：状态收尾、有耗时、报告全文（与回传主代理的文本同源）
    const last = snapshots[snapshots.length - 1]
    expect(last).toMatchObject({ status: 'success', callId: 'call-parent-1' })
    expect(last?.endedAt).toBeGreaterThanOrEqual(last?.startedAt ?? 0)
    expect(last?.report).toBe('先读目录结论：模块清单如下。')
    expect(last?.steps.filter((step) => step.kind === 'tool')).toHaveLength(1)
    expect(last?.steps.filter((step) => step.kind === 'tool')[0]).toMatchObject({
      name: 'probe',
      state: 'success',
    })
    // ④ 最终快照也随工具结果回传（渲染层据此持久化到工具卡）
    expect(result.subagent?.report).toBe('先读目录结论：模块清单如下。')
    expect(result.subagent?.callId).toBe('call-parent-1')
  })

  it('没有 emitProgress 端口（直接调用工具）时静默跳过，不影响结果', async () => {
    const { tool } = createHarness({ rounds: [{ text: '报告' }] })
    const result = await tool.execute({ description: DESCRIPTION, prompt: PROMPT }, CONTEXT)
    expect(result.content).toBe('报告')
    expect(result.subagent?.report).toBe('报告')
  })

  it('provider 缺省（create 返回 undefined）→ isError，不发起请求', async () => {
    const { tool, provider } = createHarness({ rounds: [], withProvider: false })
    const result = await tool.execute({ description: DESCRIPTION, prompt: PROMPT }, CONTEXT)
    expect(result.isError).toBe(true)
    expect(result.content).toBe('还没有可用的 AI 模型配置，无法派生子代理。')
    expect(provider.calls).toHaveLength(0)
  })

  it('非法参数 → isError 且不触碰 provider', async () => {
    const { tool, provider } = createHarness({ rounds: [{ text: 'x' }] })
    const noDescription = await tool.execute({ prompt: PROMPT }, CONTEXT)
    expect(noDescription.isError).toBe(true)
    expect(noDescription.content).toContain('description')

    const noPrompt = await tool.execute({ description: DESCRIPTION }, CONTEXT)
    expect(noPrompt.isError).toBe(true)
    expect(noPrompt.content).toContain('prompt')

    const blank = await tool.execute({ description: DESCRIPTION, prompt: '   ' }, CONTEXT)
    expect(blank.isError).toBe(true)

    expect(provider.calls).toHaveLength(0)
  })

  it('abort 信号传导：循环结束后返回已有部分内容，不抛错', async () => {
    const controller = new AbortController()
    const { tool } = createHarness({
      rounds: [
        { text: '部分结论', toolCalls: [{ id: 'c1', name: 'probe' }] },
        { text: '不应到达' },
      ],
      extraTools: [
        makeTool('probe', undefined, async () => {
          controller.abort()
          return { content: 'probe 结果' }
        }),
      ],
    })
    const result = await tool.execute(
      { description: DESCRIPTION, prompt: PROMPT },
      { sessionId: 'quick', signal: controller.signal },
    )
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('部分结论')
    expect(result.content).not.toContain('不应到达')
  })

  it('子代理 todo 隔离：todo_write 落在 <父sessionId>-sub 清单上', async () => {
    const writes: Array<{ sessionId: string; todos: TodoItem[] }> = []
    const store = new Map<string, TodoItem[]>()
    const port: TodoPort = {
      read: async (sessionId) => store.get(sessionId) ?? [],
      write: async (sessionId, todos) => {
        writes.push({ sessionId, todos })
        store.set(sessionId, todos)
      },
    }
    const { tool, provider } = createHarness({
      rounds: [
        {
          toolCalls: [
            {
              id: 'c1',
              name: 'todo_write',
              arguments: '{"todos":[{"content":"子任务","status":"in_progress"}]}',
            },
          ],
        },
        { text: '清单已建立' },
      ],
      extraTools: [...createTodoTools({ port })],
    })
    const result = await tool.execute({ description: DESCRIPTION, prompt: PROMPT }, CONTEXT)

    expect(result.isError).toBeUndefined()
    expect(writes).toHaveLength(1)
    expect(writes[0]?.sessionId).toBe(`quick${SUBAGENT_SESSION_SUFFIX}`)
    expect(writes[0]?.todos).toEqual([{ id: 't1', content: '子任务', status: 'in_progress' }])
    // 第二轮请求里能看到工具结果回填（子循环正常续接）
    expect(provider.calls[1]?.messages.some((item) => item.role === 'tool')).toBe(true)
  })

  it('报告为空且出现过 error → isError', async () => {
    const { tool } = createHarness({
      rounds: [{ error: { code: 'E_NETWORK', message: '网络中断' } }],
    })
    const result = await tool.execute({ description: DESCRIPTION, prompt: PROMPT }, CONTEXT)
    expect(result.isError).toBe(true)
    expect(result.content).toBe('子代理执行失败：网络中断')
    expect(result.summary).toBe(`子代理：${DESCRIPTION}`)
  })

  it('有报告时 error 只作附注追加，不算失败', async () => {
    // 循环在报错的轮次不产出 text 事件，因此「报告 + 错误附注」需要跨轮：
    // 第一轮正常产出文本，第二轮才出错
    const { tool } = createHarness({
      rounds: [
        { text: '部分结论', toolCalls: [{ id: 'c1', name: 'probe' }] },
        { error: { code: 'E_TIMEOUT', message: '请求超时' } },
      ],
      extraTools: [makeTool('probe')],
    })
    const result = await tool.execute({ description: DESCRIPTION, prompt: PROMPT }, CONTEXT)
    expect(result.isError).toBeUndefined()
    expect(result.content).toBe('部分结论\n\n（子代理执行中出现过一次错误：请求超时）')
  })

  it('轮次用尽（done.pending）→ 追加部分结果说明', async () => {
    const { tool } = createHarness({
      rounds: [{ text: '初步结论', toolCalls: [{ id: 'c1', name: 'probe' }] }],
      maxRounds: 1,
      extraTools: [makeTool('probe')],
    })
    const result = await tool.execute({ description: DESCRIPTION, prompt: PROMPT }, CONTEXT)
    expect(result.isError).toBeUndefined()
    expect(result.content).toBe('初步结论\n\n（子代理已到轮次上限，以上为部分结果。）')
  })

  it('无报告无错误 → 提示调整任务指令', async () => {
    const { tool } = createHarness({ rounds: [{}] })
    const result = await tool.execute({ description: DESCRIPTION, prompt: PROMPT }, CONTEXT)
    expect(result.isError).toBeUndefined()
    expect(result.content).toBe('（子代理没有返回文本结果，请调整任务指令后重试。）')
  })

  it('内部意外异常转 isError（不冒泡）', async () => {
    const { tool } = createHarness({ rounds: [], createThrows: new Error('工厂炸了') })
    const result = await tool.execute({ description: DESCRIPTION, prompt: PROMPT }, CONTEXT)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('子代理执行异常：工厂炸了')
  })
})

/**
 * 权限授予（`permission: 'write'`，2026-09）与独立对话视图的投影（docs/06 §19）。
 *
 * 一条铁律：**写能力不是新通道** —— 写工具进子表后仍由父会话的确认回调逐次判定，
 * 且 `run_command` / MCP / 递归派生在任何档位下都拿不到。
 */
describe('createTaskTool 的写权限授予', () => {
  const allowAll = async (): Promise<'machine'> => 'machine'

  it('缺省（read）时即使注入了确认链，子代理也拿不到写工具', async () => {
    const { tool, provider } = createHarness({
      rounds: [{ text: '报告' }],
      extraTools: [makeTool('read_file'), makeTool('write_file', 'confirm')],
      confirmTool: allowAll,
    })
    const result = await tool.execute({ description: DESCRIPTION, prompt: PROMPT }, CONTEXT)

    expect(result.isError).toBeUndefined()
    expect(provider.calls[0]?.tools?.map((item) => item.name)).toEqual(['read_file'])
    expect(result.subagent?.permission).toBe('read')
    expect(result.subagent?.tools).toEqual(['read_file'])
  })

  it("permission: 'write' + 确认链 → 写工具进子表，run_command / mcp / task 仍拿不到", async () => {
    const { tool, provider } = createHarness({
      rounds: [{ text: '报告' }],
      extraTools: [
        makeTool('read_file'),
        makeTool('write_file', 'confirm'),
        makeTool('edit_file', 'confirm'),
        makeTool('run_command', 'confirm'),
        makeTool('mcp.demo.tool', 'confirm'),
      ],
      confirmTool: allowAll,
    })
    const result = await tool.execute(
      { description: DESCRIPTION, prompt: PROMPT, permission: 'write' },
      CONTEXT,
    )

    expect(result.isError).toBeUndefined()
    expect(provider.calls[0]?.tools?.map((item) => item.name)).toEqual([
      'edit_file',
      'read_file',
      'write_file',
    ])
    expect(result.subagent?.permission).toBe('write')
    // 系统提示词里的工具目录与请求体的 tools 同源（命令 / MCP 都不在里面）
    const system = provider.calls[0]?.messages[0]?.content ?? ''
    expect(system).toContain('write_file')
    expect(system).not.toContain('run_command')
    expect(system).not.toContain('mcp.demo.tool')
  })

  it("permission: 'write' 但装配层没接确认链 → 降级只读，并在结果里如实说明", async () => {
    const { tool, provider } = createHarness({
      rounds: [{ text: '报告' }],
      extraTools: [makeTool('read_file'), makeTool('write_file', 'confirm')],
    })
    const result = await tool.execute(
      { description: DESCRIPTION, prompt: PROMPT, permission: 'write' },
      CONTEXT,
    )

    expect(provider.calls[0]?.tools?.map((item) => item.name)).toEqual(['read_file'])
    expect(result.subagent?.permission).toBe('read')
    expect(result.content).toContain('本次已按只读执行')
  })

  it('写工具的确认走注入的回调，且会话 id 钉回父会话（不是 -sub）', async () => {
    const confirmations: { name: string; sessionId: string; sensitivity: string }[] = []
    const executed: string[] = []
    const { tool } = createHarness({
      rounds: [
        { text: '先写文件', toolCalls: [{ id: 'c1', name: 'write_file', arguments: '{"x":1}' }] },
        { text: '写完了' },
      ],
      extraTools: [
        makeTool('write_file', 'confirm', async () => {
          executed.push('write_file')
          return { content: '写入成功', summary: '已写入' }
        }),
      ],
      confirmTool: async (info) => {
        confirmations.push({
          name: info.name,
          sessionId: info.sessionId,
          sensitivity: info.sensitivity,
        })
        return 'machine'
      },
    })
    const result = await tool.execute(
      { description: DESCRIPTION, prompt: PROMPT, permission: 'write' },
      CONTEXT,
    )

    expect(confirmations).toEqual([
      { name: 'write_file', sessionId: 'quick', sensitivity: 'confirm' },
    ])
    expect(executed).toEqual(['write_file'])
    expect(result.subagent?.report).toBe('先写文件写完了')
  })

  it('只读档的白名单是交集：写工具即使被授予也进不来', async () => {
    const { tool, provider } = createHarness({
      rounds: [{ text: '报告' }],
      extraTools: [makeTool('read_file'), makeTool('write_file', 'confirm')],
      confirmTool: allowAll,
      // 只读档下装配层给的白名单里没有 write_file
      subagentToolNames: () => ['read_file'],
    })
    const result = await tool.execute(
      { description: DESCRIPTION, prompt: PROMPT, permission: 'write' },
      CONTEXT,
    )

    expect(provider.calls[0]?.tools?.map((item) => item.name)).toEqual(['read_file'])
    expect(result.subagent?.tools).toEqual(['read_file'])
    // 白名单把写工具滤掉后，快照必须按**实际**授予落 read（不能拿请求参数充数）
    expect(result.subagent?.permission).toBe('read')
    expect(result.content).toContain('当前权限档未提供写工具')
  })

  it('permission 非法取值 → isError 且不触碰 provider', async () => {
    const { tool, provider } = createHarness({ rounds: [{ text: '报告' }] })
    const result = await tool.execute(
      { description: DESCRIPTION, prompt: PROMPT, permission: 'root' },
      CONTEXT,
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('permission 只能是 read 或 write')
    expect(provider.calls).toHaveLength(0)
  })

  it('连续正文增量合并成一段步骤（时间线不再是一堆半句）', async () => {
    const { tool } = createHarness({ rounds: [{ text: ['第一段', '继续写', '收尾。'] }] })
    const result = await tool.execute({ description: DESCRIPTION, prompt: PROMPT }, CONTEXT)
    const texts = (result.subagent?.steps ?? []).filter((step) => step.kind === 'text')
    expect(texts).toHaveLength(1)
    expect(texts[0]?.text).toBe('第一段继续写收尾。')
  })

  it('对话投影：任务 / 正文与工具调用 / 结果回填到对应调用', async () => {
    const { tool } = createHarness({
      rounds: [
        { text: '先读目录', toolCalls: [{ id: 'c1', name: 'probe', arguments: '{"path":"."}' }] },
        { text: '结论：共 3 个模块。' },
      ],
      extraTools: [makeTool('probe')],
    })
    const result = await tool.execute({ description: DESCRIPTION, prompt: PROMPT }, CONTEXT)
    const messages = result.subagent?.messages ?? []

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(messages[0]?.text).toBe(PROMPT)
    expect(messages[1]?.text).toBe('先读目录')
    expect(messages[1]?.toolCalls?.[0]).toMatchObject({
      id: 'c1',
      name: 'probe',
      args: '{"path":"."}',
      state: 'success',
      // 工具结果的正文只在子代理的对话里看得到（主对话的工具卡只有摘要）
      output: 'probe 结果',
    })
    expect(messages[2]?.text).toBe('结论：共 3 个模块。')
    expect(result.subagent?.transcriptTruncated).toBeUndefined()
    // 轨迹步骤也带上入参（「它拿什么参数做了什么」）
    const toolStep = (result.subagent?.steps ?? []).find((step) => step.kind === 'tool')
    expect(toolStep?.args).toBe('{"path":"."}')
  })
})

describe('createTaskTool 的多子代理与可写（docs/06 §19.5）', () => {
  /** 记录“同时在跑几个子代理”的假 provider：maxActive 是并发的唯一硬证据 */
  function createCountingProvider(options: { holdMs: number }): {
    provider: LoopProvider
    get maxActive(): number
  } {
    let active = 0
    let maxActive = 0
    let started = 0
    let releaseBarrier: () => void = () => undefined
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve
    })
    const provider: LoopProvider = {
      id: 'counting',
      chat() {
        return (async function* (): AsyncIterable<ChatEvent> {
          started += 1
          active += 1
          maxActive = Math.max(maxActive, active)
          if (started >= 2) releaseBarrier()
          try {
            // 两个并发用例靠这行让“同时起跑”真的发生；串行用例会等满 holdMs 后 maxActive=1
            await Promise.race([
              barrier,
              new Promise<void>((resolve) => setTimeout(resolve, options.holdMs)),
            ])
            yield { type: 'text', delta: '报告' }
            yield { type: 'done', finishReason: 'stop' }
          } finally {
            active -= 1
          }
        })()
      },
    }
    return {
      provider,
      get maxActive(): number {
        return maxActive
      },
    }
  }

  function makeTaskTool(options: {
    provider: LoopProvider
    tools: ToolRegistry
    limiter?: ReturnType<typeof createSubagentLimiter>
    confirmTool?: (info: {
      name: string
      input: unknown
      sensitivity: 'confirm'
      sessionId: string
    }) => Promise<'machine'>
  }): ToolDefinition {
    return createTaskTool({
      provider: { create: () => ({ provider: options.provider, model: 'fake-model' }) },
      tools: options.tools,
      ...(options.limiter === undefined ? {} : { limiter: options.limiter }),
      ...(options.confirmTool === undefined ? {} : { confirmTool: options.confirmTool }),
    })
  }

  it('两个只读 task 并发：provider 同时在跑 2 个（不是“看起来快”）', async () => {
    const counting = createCountingProvider({ holdMs: 100 })
    const tool = makeTaskTool({
      provider: counting.provider,
      tools: new ToolRegistry(),
      limiter: createSubagentLimiter(3),
    })
    const sessionId = 'task-parallel-read'
    const [first, second] = await Promise.all([
      tool.execute({ description: '任务 A', prompt: '做 A' }, { sessionId }),
      tool.execute({ description: '任务 B', prompt: '做 B' }, { sessionId }),
    ])

    expect(counting.maxActive).toBe(2)
    expect(first.subagent?.permission).toBe('read')
    expect(second.subagent?.permission).toBe('read')
    expect(first.subagent?.report).toContain('报告')
    expect(second.subagent?.report).toContain('报告')
  })

  it('两个写 task 串行：provider 同时最多 1 个（整段串行，不是只锁写工具）', async () => {
    const counting = createCountingProvider({ holdMs: 60 })
    const parent = new ToolRegistry()
    parent.register(makeTool('write_file', 'confirm'))
    parent.register(makeTool('edit_file', 'confirm'))
    const tool = makeTaskTool({
      provider: counting.provider,
      tools: parent,
      limiter: createSubagentLimiter(3),
      confirmTool: async () => 'machine',
    })
    const sessionId = 'task-parallel-write'
    const input = { description: '写任务', prompt: '写点东西', permission: 'write' as const }
    const [first, second] = await Promise.all([
      tool.execute(input, { sessionId }),
      tool.execute(input, { sessionId }),
    ])

    expect(counting.maxActive).toBe(1)
    expect(first.subagent?.permission).toBe('write')
    expect(second.subagent?.permission).toBe('write')
  })

  it('只读档（父表没有写工具）即使请求 write 也按实际授予落 read，并说明原因', async () => {
    const counting = createCountingProvider({ holdMs: 10 })
    const parent = new ToolRegistry()
    parent.register(makeTool('read_file'))
    const tool = makeTaskTool({
      provider: counting.provider,
      tools: parent,
      limiter: createSubagentLimiter(3),
      confirmTool: async () => 'machine',
    })
    const result = await tool.execute(
      { description: '写任务', prompt: '写点东西', permission: 'write' },
      { sessionId: 'task-write-downgrade' },
    )

    expect(result.subagent?.permission).toBe('read')
    expect(result.subagent?.tools).toEqual(['read_file'])
    expect(result.content).toContain('当前权限档未提供写工具')
  })

  it('排队中被 abort：返回“未启动”，不会偷偷跑，也不占着槽位', async () => {
    const limiter = createSubagentLimiter(1)
    const parent = new ToolRegistry()
    let releaseFirst: () => void = () => undefined
    let enteredFirst: () => void = () => undefined
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve
    })
    const provider: LoopProvider = {
      id: 'gated',
      chat() {
        return (async function* (): AsyncIterable<ChatEvent> {
          enteredFirst()
          await firstGate
          yield { type: 'text', delta: '报告' }
          yield { type: 'done', finishReason: 'stop' }
        })()
      },
    }
    const tool = makeTaskTool({ provider, tools: parent, limiter })
    const sessionId = 'task-queue-abort'
    const first = tool.execute({ description: '先跑', prompt: '先跑' }, { sessionId })
    await firstEntered

    const controller = new AbortController()
    const second = tool.execute(
      { description: '排队', prompt: '排队' },
      { sessionId, signal: controller.signal },
    )
    controller.abort()
    const queued = await second
    expect(queued.isError).toBe(true)
    expect(queued.content).toContain('父请求已取消，子代理未启动')

    releaseFirst()
    const done = await first
    expect(done.content).toContain('报告')
    expect(limiter.snapshot(sessionId)).toEqual({ active: 0, queued: 0, writeLocked: false })
  })
})
