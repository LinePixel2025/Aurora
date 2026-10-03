/**
 * `show_preview` 工具的内核单测（docs/06 §14，2026-10-03）。
 *
 * 全程用**假端口**：这里只验证工具层契约（名字 / safe 敏感级 / 参数校验 /
 * 结果回填 / 端口错误转工具错误）；真实的目标校验与推送由主进程
 * （`main/tools/preview-port.ts`）承担。
 */
import { describe, expect, it } from 'vitest'
import { createShowPreviewTool } from './preview.js'
import type { PreviewPort, PreviewShowOptions } from './preview.js'
import type { ToolDefinition } from './registry.js'

const CONTEXT = { sessionId: 'session-test' }

interface Harness {
  tool: ToolDefinition
  calls: Array<{ target: string; options: PreviewShowOptions }>
}

function createHarness(options: { error?: unknown } = {}): Harness {
  const calls: Array<{ target: string; options: PreviewShowOptions }> = []
  const port: PreviewPort = {
    show: async (target, showOptions) => {
      if (options.error !== undefined) throw options.error
      calls.push({ target, options: showOptions })
      return { url: `file:///${target}`, display: target, openedIn: 'panel' }
    },
  }
  return { tool: createShowPreviewTool({ port }), calls }
}

describe('createShowPreviewTool', () => {
  it('声明名字、safe 敏感级与必填参数', () => {
    const { tool } = createHarness()
    expect(tool.name).toBe('show_preview')
    expect(tool.sensitivity).toBe('safe')
    expect(tool.parameters.required).toEqual(['target'])
    expect(tool.parameters.additionalProperties).toBe(false)
  })

  it('成功：target 与当前会话一起交给端口，结果回填展示串', async () => {
    const { tool, calls } = createHarness()
    const result = await tool.execute(
      { target: 'report.html', title: '课程报告' },
      { sessionId: 's-42' },
    )

    expect(calls).toEqual([
      { target: 'report.html', options: { sessionId: 's-42', title: '课程报告' } },
    ])
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('report.html')
    expect(result.summary).toBe('已展示预览')
  })

  it('title 可选：缺省 / 空白按空串传给端口，不影响调用', async () => {
    const { tool, calls } = createHarness()
    await tool.execute({ target: 'https://example.com' }, CONTEXT)
    await tool.execute({ target: 'https://example.com', title: '   ' }, CONTEXT)
    expect(calls.map((call) => call.options.title)).toEqual(['', ''])
  })

  it('端口回报外部浏览器打开时，回填文案与实际去向一致', async () => {
    const calls: Array<{ target: string; options: PreviewShowOptions }> = []
    const tool = createShowPreviewTool({
      port: {
        show: async (target, showOptions) => {
          calls.push({ target, options: showOptions })
          return { url: target, display: target, openedIn: 'external' }
        },
      },
    })
    const result = await tool.execute({ target: 'https://example.com' }, CONTEXT)
    expect(result.isError).toBeUndefined()
    expect(result.summary).toBe('已在外部浏览器打开')
    expect(result.content).toContain('外部浏览器')
  })

  it('缺少 target（或全空白）时报错且不触碰端口', async () => {
    const { tool, calls } = createHarness()
    for (const input of [{}, { target: '' }, { target: '   ' }, { target: 42 }]) {
      const result = await tool.execute(input, CONTEXT)
      expect(result.isError).toBe(true)
      expect(result.summary).toBe('展示预览参数缺失')
    }
    expect(calls).toEqual([])
  })

  it('端口抛错转为工具错误结果（不冒泡），错误文案原样回填', async () => {
    const { tool } = createHarness({ error: new Error('该文件在当前会话的工作目录边界之外') })
    const result = await tool.execute({ target: 'C:\\Windows\\win.ini' }, CONTEXT)
    expect(result.isError).toBe(true)
    expect(result.summary).toBe('展示预览失败')
    expect(result.content).toContain('工作目录边界之外')
  })

  it('非对象入参（字符串 / null）按缺参处理，不抛错', async () => {
    const { tool } = createHarness()
    for (const input of ['https://example.com', null, 42]) {
      const result = await tool.execute(input, CONTEXT)
      expect(result.isError).toBe(true)
    }
  })
})
