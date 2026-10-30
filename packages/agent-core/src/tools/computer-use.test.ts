import { describe, expect, it, vi } from 'vitest'
import {
  COMPUTER_USE_TOOL_NAMES,
  createComputerUseTools,
  type ComputerUsePort,
} from './computer-use.js'

function port(): ComputerUsePort {
  return {
    screenshot: vi.fn(async () => ({
      content: 'shot',
      summary: 'shot',
      images: [{ path: 'a.png', image: { mimeType: 'image/png', dataBase64: 'AA==' } }],
    })),
    mouse: vi.fn(async () => ({ content: 'mouse ok' })),
    keyboard: vi.fn(async () => ({ content: 'keyboard ok' })),
    window: vi.fn(async () => ({ content: 'window ok' })),
    ui: vi.fn(async () => ({ content: 'ui ok' })),
    wait: vi.fn(async () => ({ content: 'waited' })),
    stop: vi.fn(async () => ({ content: 'stopped' })),
  }
}

const ctx = { sessionId: 's1' }

describe('Computer Use 工具定义', () => {
  it('七个工具都有名字且默认串行', () => {
    const tools = createComputerUseTools({ port: port() })
    expect(tools.map((tool) => tool.name)).toEqual([...COMPUTER_USE_TOOL_NAMES])
    expect(tools.every((tool) => tool.parallel !== true)).toBe(true)
    expect(tools.find((tool) => tool.name === 'computer_screenshot')?.sensitivity).toBe('safe')
    expect(tools.find((tool) => tool.name === 'computer_mouse')?.sensitivity).toBe('confirm')
    expect(tools.find((tool) => tool.name === 'computer_stop')?.sensitivity).toBe('safe')
  })

  it('computer_stop 透传 sessionId 并允许 Agent 主动退出', async () => {
    const fake = port()
    const tool = createComputerUseTools({ port: fake }).find(
      (item) => item.name === 'computer_stop',
    )!
    const result = await tool.execute({}, ctx)
    expect(result.isError).toBeUndefined()
    expect(fake.stop).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1' }))
  })

  it('截图透传图片分片与默认 display', async () => {
    const fake = port()
    const tool = createComputerUseTools({ port: fake }).find(
      (item) => item.name === 'computer_screenshot',
    )!
    const result = await tool.execute({ display: 'cursor' }, ctx)
    expect(result.images?.[0]?.path).toBe('a.png')
    expect(fake.screenshot).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', display: 'cursor' }),
    )
  })

  it('非法枚举 / 缺必填参数折成工具错误', async () => {
    const fake = port()
    const tools = createComputerUseTools({ port: fake })
    const mouse = tools.find((tool) => tool.name === 'computer_mouse')!
    const badMouse = await mouse.execute({ action: 'teleport' }, ctx)
    expect(badMouse.isError).toBe(true)
    expect(fake.mouse).not.toHaveBeenCalled()

    const keyboard = tools.find((tool) => tool.name === 'computer_keyboard')!
    const badType = await keyboard.execute({ action: 'type' }, ctx)
    expect(badType.isError).toBe(true)
    expect(fake.keyboard).not.toHaveBeenCalled()
  })

  it('端口抛错折成错误结果，不把异常抛给循环', async () => {
    const fake = port()
    fake.mouse = vi.fn(async () => {
      throw new Error('target changed')
    })
    const mouse = createComputerUseTools({ port: fake }).find(
      (tool) => tool.name === 'computer_mouse',
    )!
    const result = await mouse.execute({ action: 'click', x: 1, y: 2 }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('target changed')
  })
})
