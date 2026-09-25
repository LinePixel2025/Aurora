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
} from './task.js'
import { createTodoTools } from './todo.js'
import type { TodoItem, TodoPort } from './todo.js'
import { ToolRegistry } from './registry.js'
import type { ToolDefinition } from './registry.js'
import type { SubagentSnapshot } from '@aurora/shared'
import { createFakeProvider } from '../testing/fakeProvider.js'
import type { ScriptRound } from '../testing/fakeProvider.js'

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
  })
  parent.register(tool)
  return { tool, provider, parent }
}

describe('createTaskTool', () => {
  it('声明 task 名、safe 敏感级与必填参数', () => {
    const { tool } = createHarness({ rounds: [] })
    expect(tool.name).toBe(TASK_TOOL_NAME)
    expect(tool.sensitivity).toBe('safe')
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
