/**
 * `view_image` 的内核单测（图像工具，docs/06 §25）。
 *
 * 全程用**假端口**：这里只钉工具层契约 —— `safe` 敏感级（与 `read_file` 同档，
 * 没有确认卡片）、参数校验、成功时把图片挂到 `ToolResult.images`、
 * 读不出来时**如实回填端口给的原因**（不编造"我看到了"）；
 * 真正的读盘、大小上限与项目根边界由主进程的 `image-read-port.ts` 承担。
 */
import { describe, expect, it } from 'vitest'
import { VIEW_IMAGE_TOOL_NAME, createViewImageTool } from './image.js'
import type { ViewImagePort, ViewImageResult } from './image.js'
import type { ToolDefinition } from './registry.js'

const IMAGE = { mimeType: 'image/png', dataBase64: 'AAA', name: 'a.png' }

interface Harness {
  tool: ToolDefinition
  calls: Array<{ path: string; sessionId: string }>
}

function createHarness(options: { reply?: ViewImageResult; error?: unknown } = {}): Harness {
  const calls: Array<{ path: string; sessionId: string }> = []
  const port: ViewImagePort = {
    view: async (input) => {
      if (options.error !== undefined) throw options.error
      calls.push(input)
      return options.reply ?? { path: input.path, image: IMAGE }
    },
  }
  return { tool: createViewImageTool({ port }), calls }
}

describe('createViewImageTool', () => {
  it('声明名字、safe 敏感级（与 read_file 同档）与必填参数', () => {
    const { tool } = createHarness()
    expect(tool.name).toBe(VIEW_IMAGE_TOOL_NAME)
    expect(tool.name).toBe('view_image')
    // 读一张图不该弹确认卡：与 clipboard_read / screenshot 那类隐私工具刻意不同档
    expect(tool.sensitivity).toBe('safe')
    expect(tool.parameters.required).toEqual(['path'])
    expect(tool.parameters.additionalProperties).toBe(false)
    // 描述要交代"只读图片格式"与"根外会被拒时的退路"，否则模型会拿它去读文本文件
    expect(tool.description).toContain('图片')
    expect(tool.description).toContain('read_file')
    expect(tool.description).toContain('拖进对话窗口')
  })

  it('成功：回填路径并把图片挂到 images 上', async () => {
    const { tool, calls } = createHarness()
    const result = await tool.execute({ path: 'C:\\tmp\\a.png' }, { sessionId: 's1' })

    expect(calls).toEqual([{ path: 'C:\\tmp\\a.png', sessionId: 's1' }])
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('C:\\tmp\\a.png')
    expect(result.images).toEqual([{ path: 'C:\\tmp\\a.png', image: IMAGE }])
  })

  it('把会话 id 透传给端口（读盘边界按会话解析，docs/06 §5.1）', async () => {
    const { tool, calls } = createHarness()
    await tool.execute({ path: 'a.png' }, { sessionId: 'session-bound-to-project' })
    expect(calls[0]?.sessionId).toBe('session-bound-to-project')
  })

  it('缺少 / 空白 path 时报错且不触碰端口', async () => {
    const { tool, calls } = createHarness()
    const missing = await tool.execute({}, { sessionId: 's1' })
    expect(missing.isError).toBe(true)
    expect(missing.content).toContain('缺少参数 path')

    const blank = await tool.execute({ path: '   ' }, { sessionId: 's1' })
    expect(blank.isError).toBe(true)
    expect(calls).toEqual([])
  })

  it('端口说读不出来（越界 / 超限）：如实回填原因，且不带图片分片', async () => {
    const { tool } = createHarness({
      reply: { path: 'D:\\elsewhere\\a.png', note: '该路径在当前会话的项目根之外' },
    })
    const result = await tool.execute({ path: 'D:\\elsewhere\\a.png' }, { sessionId: 's1' })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('该路径在当前会话的项目根之外')
    expect(result.images).toBeUndefined()
  })

  it('端口抛错转为工具错误结果（不冒泡）', async () => {
    const { tool } = createHarness({ error: new Error('磁盘读取失败') })
    const result = await tool.execute({ path: 'a.png' }, { sessionId: 's1' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('读取图片失败')
    expect(result.content).toContain('磁盘读取失败')
  })
})
