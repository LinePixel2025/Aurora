/**
 * `screenshot` 的内核单测（图像工具，docs/06 §25）。
 *
 * 用假端口钉工具层契约：`confirm` 敏感级（屏幕内容是最敏感的一类隐私，
 * 与 `clipboard_read` 同档）、`display` 参数校验、多显示器返回多张图、
 * 空结果按失败处理。真实截屏（Electron `desktopCapturer`）在主进程，不在这里。
 */
import { describe, expect, it } from 'vitest'
import { SCREENSHOT_TOOL_NAME, createScreenshotTool } from './screenshot.js'
import type { ScreenshotDisplay, ScreenshotPort } from './screenshot.js'
import type { ToolDefinition, ToolImage } from './registry.js'

function shot(path: string): ToolImage {
  return { path, image: { mimeType: 'image/png', dataBase64: 'AAA', name: 'shot.png' } }
}

interface Harness {
  tool: ToolDefinition
  calls: Array<{ display: ScreenshotDisplay }>
}

function createHarness(options: { shots?: ToolImage[]; error?: unknown } = {}): Harness {
  const calls: Array<{ display: ScreenshotDisplay }> = []
  const port: ScreenshotPort = {
    capture: async (input) => {
      if (options.error !== undefined) throw options.error
      calls.push(input)
      return options.shots ?? [shot('C:\\shots\\1.png')]
    },
  }
  return { tool: createScreenshotTool({ port }), calls }
}

describe('createScreenshotTool', () => {
  it('声明名字、confirm 敏感级（屏幕内容涉隐私）与参数枚举', () => {
    const { tool } = createHarness()
    expect(tool.name).toBe(SCREENSHOT_TOOL_NAME)
    expect(tool.name).toBe('screenshot')
    expect(tool.sensitivity).toBe('confirm')
    expect(tool.parameters.required).toEqual([])
    // 枚举只在参数 schema 里——模型据此知道可传什么，不必试错
    expect((tool.parameters.properties?.['display'] as { enum?: string[] }).enum).toEqual([
      'primary',
      'all',
    ])
    expect(tool.description).toContain('确认')
  })

  it('缺省截主屏，display=all 原样透传', async () => {
    const { tool, calls } = createHarness()
    await tool.execute({}, { sessionId: 's1' })
    await tool.execute({ display: 'all' }, { sessionId: 's1' })
    expect(calls).toEqual([{ display: 'primary' }, { display: 'all' }])
  })

  it('display 非法时报错且不触碰端口（不静默改成 primary）', async () => {
    const { tool, calls } = createHarness()
    const result = await tool.execute({ display: 'secondary' }, { sessionId: 's1' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('display')
    expect(calls).toEqual([])
  })

  it('多显示器：逐张回填路径并全部挂到 images 上', async () => {
    const { tool } = createHarness({ shots: [shot('C:\\shots\\1.png'), shot('C:\\shots\\2.png')] })
    const result = await tool.execute({ display: 'all' }, { sessionId: 's1' })
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('C:\\shots\\1.png')
    expect(result.content).toContain('C:\\shots\\2.png')
    expect(result.images?.map((item) => item.path)).toEqual([
      'C:\\shots\\1.png',
      'C:\\shots\\2.png',
    ])
  })

  it('一块屏都没截到：按失败处理', async () => {
    const { tool } = createHarness({ shots: [] })
    const result = await tool.execute({}, { sessionId: 's1' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('没有截到任何屏幕')
    expect(result.images).toBeUndefined()
  })

  it('端口抛错转为工具错误结果（不冒泡）', async () => {
    const { tool } = createHarness({ error: new Error('desktopCapturer 不可用') })
    const result = await tool.execute({}, { sessionId: 's1' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('截屏失败')
    expect(result.content).toContain('desktopCapturer 不可用')
  })
})
