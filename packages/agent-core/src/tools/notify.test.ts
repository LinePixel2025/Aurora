/**
 * `notify_user` 工具的内核单测（Design/betav2-spec.md §6）。
 *
 * 全程用**假端口**，不弹真实系统通知：这里只验证工具层契约
 * （safe 敏感级 / 参数校验 / 结果回填 / 端口错误转工具错误）；
 * 真实通知由主进程（NotificationService）承担。
 */
import { describe, expect, it } from 'vitest'
import { createNotifyTool } from './notify.js'
import type { NotifyPort } from './notify.js'
import type { ToolDefinition } from './registry.js'

const CONTEXT = { sessionId: 'session-test' }

interface Harness {
  tool: ToolDefinition
  calls: Array<{ title: string; body: string }>
}

function createHarness(options: { error?: unknown } = {}): Harness {
  const calls: Array<{ title: string; body: string }> = []
  const port: NotifyPort = {
    show: async (title, body) => {
      if (options.error !== undefined) throw options.error
      calls.push({ title, body })
    },
  }
  return { tool: createNotifyTool({ port }), calls }
}

describe('createNotifyTool', () => {
  it('声明名字、safe 敏感级与必填参数', () => {
    const { tool } = createHarness()
    expect(tool.name).toBe('notify_user')
    expect(tool.sensitivity).toBe('safe')
    expect(tool.parameters.required).toEqual(['title', 'body'])
    expect(tool.parameters.additionalProperties).toBe(false)
  })

  it('成功：title / body 透传给端口并回填结果', async () => {
    const { tool, calls } = createHarness()
    const result = await tool.execute({ title: '任务完成', body: '文档已生成' }, CONTEXT)

    expect(calls).toEqual([{ title: '任务完成', body: '文档已生成' }])
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('任务完成')
    expect(result.summary).toBe('已发送通知')
  })

  it('缺少 title 或 body 时报错且不触碰端口', async () => {
    const { tool, calls } = createHarness()
    for (const input of [{}, { title: '只有标题' }, { title: '', body: '空白标题也不行' }]) {
      const result = await tool.execute(input, CONTEXT)
      expect(result.isError).toBe(true)
      expect(result.summary).toBe('通知参数缺失')
    }
    expect(calls).toEqual([])
  })

  it('端口抛错转为工具错误结果（不冒泡）', async () => {
    const { tool } = createHarness({ error: new Error('系统不支持通知') })
    const result = await tool.execute({ title: 't', body: 'b' }, CONTEXT)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('发送通知失败')
    expect(result.content).toContain('系统不支持通知')
  })
})
