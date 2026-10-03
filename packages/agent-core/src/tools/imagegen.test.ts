/**
 * `generate_image` 工具的内核单测（Design/betav2-spec.md §6）。
 *
 * 全程用**假端口**，不调用真实生图模型：这里只验证工具层契约
 * （confirm 敏感级 / 参数校验 / 结果回填「已保存到 <路径>」/ 端口错误转工具错误）；
 * 真实生图与落盘由主进程（ImageGenService）承担。
 */
import { describe, expect, it } from 'vitest'
import { createImageGenTool } from './imagegen.js'
import type { ImageGenPort } from './imagegen.js'
import type { ToolDefinition } from './registry.js'

const CONTEXT = { sessionId: 'session-test' }

interface Harness {
  tool: ToolDefinition
  calls: Array<{ prompt: string; sessionId: string; size?: string }>
}

function createHarness(options: { error?: unknown } = {}): Harness {
  const calls: Array<{ prompt: string; sessionId: string; size?: string }> = []
  const port: ImageGenPort = {
    generate: async (input) => {
      if (options.error !== undefined) throw options.error
      calls.push(input)
      return {
        filePath: 'C:\\Users\\u\\AppData\\Roaming\\Aurora\\generated\\img-1.png',
        displayImage: {
          id: 'img-1',
          path: 'C:\\Users\\u\\AppData\\Roaming\\Aurora\\generated\\img-1.png',
          name: 'img-1.png',
          mime: 'image/png',
        },
      }
    },
  }
  return { tool: createImageGenTool({ port }), calls }
}

describe('createImageGenTool', () => {
  it('声明名字、confirm 敏感级（花 API 费用）与必填参数', () => {
    const { tool } = createHarness()
    expect(tool.name).toBe('generate_image')
    expect(tool.sensitivity).toBe('confirm')
    expect(tool.parameters.required).toEqual(['prompt'])
    expect(tool.parameters.additionalProperties).toBe(false)
    // 描述要交代耗时与确认口径
    expect(tool.description).toContain('耗时')
    expect(tool.description).toContain('确认')
  })

  it('成功：按规范回填「已保存到 <文件路径>」', async () => {
    const { tool, calls } = createHarness()
    const result = await tool.execute({ prompt: '一只在雪地里的橘猫' }, CONTEXT)

    expect(calls).toEqual([{ prompt: '一只在雪地里的橘猫', sessionId: 'session-test' }])
    expect(result.isError).toBeUndefined()
    expect(result.content).toMatch(/^已保存到 .+\.png$/)
    expect(result.summary).toBe('已生成图片')
    expect(result.displayImages?.[0]?.name).toBe('img-1.png')
  })

  it('size 可选且透传，未传时不带 size 字段', async () => {
    const { tool, calls } = createHarness()
    await tool.execute({ prompt: '猫', size: '1024x1024' }, CONTEXT)
    expect(calls[0]).toEqual({ prompt: '猫', sessionId: 'session-test', size: '1024x1024' })

    await tool.execute({ prompt: '狗' }, CONTEXT)
    expect(calls[1]).toEqual({ prompt: '狗', sessionId: 'session-test' })
  })

  it('缺少 prompt 时报错且不触碰端口', async () => {
    const { tool, calls } = createHarness()
    const result = await tool.execute({}, CONTEXT)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('缺少参数 prompt')
    expect(calls).toEqual([])
  })

  it('端口抛错转为工具错误结果（不冒泡）', async () => {
    const { tool } = createHarness({ error: new Error('生图服务超时') })
    const result = await tool.execute({ prompt: '猫' }, CONTEXT)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('生成图片失败')
    expect(result.content).toContain('生图服务超时')
  })
})
