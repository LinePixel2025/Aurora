/**
 * `ask_user` 工具的内核单测（docs/06 §21）。
 *
 * 重点验证三件容易写错的事：
 * 1. **端口缺失时不静默失败** —— 明确告诉模型"这里问不了人"，让它改用假设继续；
 * 2. **超时 / 跳过不是错误** —— 判据是结果里有没有"不要重复提问"的指引，而不是 isError；
 * 3. **参数校验在调用端口之前** —— 非法参数不该打扰用户（端口一次都不该被调用）。
 */
import { describe, expect, it } from 'vitest'
import { ASK_USER_MAX_OPTIONS, ASK_USER_TOOL_NAME, createAskUserTool } from './ask-user.js'
import type { AskUserAnswer, AskUserQuestion, AskUserPort } from './ask-user.js'
import type { ToolDefinition } from './registry.js'

interface Recorded {
  question: AskUserQuestion
  sessionId: string
  toolCallId?: string
}

function makeHarness(options: {
  answer?: AskUserAnswer
  /** 让端口直接抛错（验证异常不冒泡） */
  throws?: unknown
  withPort?: boolean
}): { tool: ToolDefinition; calls: Recorded[] } {
  const calls: Recorded[] = []
  const port: AskUserPort = {
    ask: async (question, context) => {
      if (options.throws !== undefined) throw options.throws
      calls.push({
        question,
        sessionId: context.sessionId,
        ...(context.toolCallId === undefined ? {} : { toolCallId: context.toolCallId }),
      })
      return options.answer ?? { answers: [] }
    },
  }
  const tool = createAskUserTool(options.withPort === false ? {} : { port })
  return { tool, calls }
}

const CONTEXT = { sessionId: 'main', toolCallId: 'call-1' }

describe('createAskUserTool', () => {
  it('声明工具名、safe 敏感级与必填 question', () => {
    const { tool } = makeHarness({})
    expect(tool.name).toBe(ASK_USER_TOOL_NAME)
    // 提问没有系统副作用：不走确认卡片（它的"危险"只是打扰用户）
    expect(tool.sensitivity).toBe('safe')
    expect(tool.parameters.required).toEqual(['question'])
  })

  it('正常路径：问题交给端口，回答原文回填给模型', async () => {
    const { tool, calls } = makeHarness({ answer: { answers: ['科目资料文件夹'] } })
    const result = await tool.execute(
      {
        question: '归档到哪个目录？',
        header: '目标目录',
        options: [{ label: '科目资料文件夹' }, { label: '桌面', description: '先堆着' }],
      },
      CONTEXT,
    )

    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('你向用户提问：归档到哪个目录？')
    expect(result.content).toContain('用户回答：科目资料文件夹')
    expect(result.summary).toBe('用户回答：科目资料文件夹')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ sessionId: 'main', toolCallId: 'call-1' })
    expect(calls[0]?.question.options).toEqual([
      { label: '科目资料文件夹' },
      { label: '桌面', description: '先堆着' },
    ])
  })

  it('未注入端口（单测 / 别的壳层）→ isError 且给出替代做法，而不是假装问过了', async () => {
    const { tool } = makeHarness({ withPort: false })
    const result = await tool.execute({ question: '怎么办？' }, CONTEXT)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('不支持向用户提问')
    expect(result.content).toContain('假设')
  })

  it('端口抛错 → isError 且不冒泡（问答通道坏了不能把整轮请求带崩）', async () => {
    const { tool } = makeHarness({ throws: new Error('通道炸了') })
    const result = await tool.execute({ question: '怎么办？' }, CONTEXT)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('提问通道异常（通道炸了）')
    expect(result.content).toContain('说明你的假设并继续')
  })

  it('用户没回答（超时）→ 不是错误，但必须带上「不要重复提问」的指引', async () => {
    const { tool } = makeHarness({ answer: { answers: [], timedOut: true } })
    const result = await tool.execute({ question: '归档到哪？' }, CONTEXT)
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('（用户超时未答）')
    expect(result.content).toContain('不要重复提问')
    expect(result.summary).toBe('用户未回答')
  })

  it('用户跳过 → 文案与 summaries 与超时区分开', async () => {
    const { tool } = makeHarness({ answer: { answers: [], skipped: true } })
    const result = await tool.execute({ question: '归档到哪？' }, CONTEXT)
    expect(result.content).toContain('（用户跳过）')
    expect(result.summary).toBe('用户未回答')
  })

  it('请求被中止 → isError（这一轮已经不算数了）', async () => {
    const { tool } = makeHarness({ answer: { answers: [], aborted: true } })
    const result = await tool.execute({ question: '归档到哪？' }, CONTEXT)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('（请求已中止）')
    expect(result.summary).toBe('提问已取消')
  })

  it('多选项 + 多选被原样透传；只有 1 个选项时退化为单选', async () => {
    const { tool, calls } = makeHarness({ answer: { answers: ['甲', '乙'] } })
    await tool.execute(
      { question: '选哪些？', options: [{ label: '甲' }, { label: '乙' }], multiSelect: true },
      CONTEXT,
    )
    expect(calls[0]?.question.multiSelect).toBe(true)

    await tool.execute(
      { question: '选哪个？', options: [{ label: '甲' }], multiSelect: true },
      CONTEXT,
    )
    // 单选语义：1 个选项的"多选"没有意义，按单选走（界面据此渲染圆点而不是勾选框）
    expect(calls[1]?.question.multiSelect).toBe(false)
  })

  it('参数非法 → isError 且一次都不调用端口（不打扰用户）', async () => {
    const { tool, calls } = makeHarness({ answer: { answers: ['x'] } })
    const cases: unknown[] = [
      undefined,
      { header: '没有 question' },
      { question: '   ' },
      { question: 'a'.repeat(600) },
      {
        question: '太多了',
        options: Array.from({ length: ASK_USER_MAX_OPTIONS + 1 }, (_, index) => ({
          label: `选项${index}`,
        })),
      },
      { question: '选项没名字', options: [{}] },
      { question: '选项太长', options: [{ label: 'a'.repeat(80) }] },
      { question: '说明太长', options: [{ label: '甲', description: 'b'.repeat(300) }] },
    ]
    for (const input of cases) {
      const result = await tool.execute(input, CONTEXT)
      expect(result.isError).toBe(true)
    }
    expect(calls).toHaveLength(0)
  })
})
