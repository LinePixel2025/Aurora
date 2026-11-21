import { describe, expect, it, vi } from 'vitest'
import {
  SUBMIT_PLAN_MAX_CHARS,
  SUBMIT_PLAN_TOOL_NAME,
  createSubmitPlanTool,
  type SubmitPlanPort,
} from './submit-plan.js'

function portOf(overrides?: Partial<SubmitPlanPort>): SubmitPlanPort {
  return {
    submit: vi.fn(async () => ({ ok: true as const, plan: { active: true } })),
    ...overrides,
  }
}

const PLAN = '# 实施计划\n\n1. 改 A\n2. 验证 B'

describe('submit_plan 工具（docs/06 §29）', () => {
  it('名称 / 敏感级 / 参数形状固定', () => {
    const tool = createSubmitPlanTool(portOf())
    expect(tool.name).toBe(SUBMIT_PLAN_TOOL_NAME)
    expect(tool.name).toBe('submit_plan')
    expect(tool.sensitivity).toBe('safe')
    expect(tool.parameters.required).toEqual(['plan'])
    expect(tool.parameters.additionalProperties).toBe(false)
  })

  it('合法计划：调用端口并回「等待批准」，planId 取 toolCallId', async () => {
    const submit = vi.fn(async () => ({ ok: true as const, plan: { active: true } }))
    const tool = createSubmitPlanTool({ submit })
    const result = await tool.execute({ plan: PLAN }, { sessionId: 'main', toolCallId: 'call-7' })
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('等待用户批准')
    expect(result.summary).toContain('已提交计划')
    expect(submit).toHaveBeenCalledWith({ sessionId: 'main', planId: 'call-7', markdown: PLAN })
  })

  it('缺参数 / 空正文 / 不以 # 开头 / 超长：一律 isError 且不调用端口', async () => {
    const submit = vi.fn(async () => ({ ok: true as const, plan: { active: true } }))
    const tool = createSubmitPlanTool({ submit })
    for (const input of [
      {},
      { plan: '   ' },
      { plan: '没有标题的计划' },
      { plan: `# ${'x'.repeat(SUBMIT_PLAN_MAX_CHARS)}` },
    ]) {
      const result = await tool.execute(input, { sessionId: 'main' })
      expect(result.isError).toBe(true)
    }
    expect(submit).not.toHaveBeenCalled()
  })

  it('端口拒绝（不在计划模式 / 文件写失败）：原样回文案并置 isError', async () => {
    const tool = createSubmitPlanTool(
      portOf({ submit: async () => ({ ok: false, error: '当前不在计划模式' }) }),
    )
    const result = await tool.execute({ plan: PLAN }, { sessionId: 'main', toolCallId: 'c1' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('当前不在计划模式')
    expect(result.summary).toBe('计划未提交')
  })

  it('端口抛错：不冒泡，转 isError', async () => {
    const tool = createSubmitPlanTool(
      portOf({
        submit: async () => {
          throw new Error('磁盘满了')
        },
      }),
    )
    const result = await tool.execute({ plan: PLAN }, { sessionId: 'main', toolCallId: 'c1' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('磁盘满了')
  })
})
