import { describe, expect, it, vi } from 'vitest'
import {
  COMPUTER_USE_ALL_TOOL_NAMES,
  COMPUTER_USE_START_TOOL_NAME,
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
    start: vi.fn(async () => ({ content: 'started', summary: 'started' })),
    stop: vi.fn(async () => ({ content: 'stopped' })),
  }
}

const ctx = { sessionId: 's1' }

describe('Computer Use 工具定义', () => {
  it('Agent 入口 + 七个授权工具都有名字且默认串行', () => {
    const tools = createComputerUseTools({ port: port() })
    expect(tools.map((tool) => tool.name)).toEqual([...COMPUTER_USE_ALL_TOOL_NAMES])
    expect(tools.every((tool) => tool.parallel !== true)).toBe(true)
    expect(tools.find((tool) => tool.name === 'computer_screenshot')?.sensitivity).toBe('safe')
    expect(tools.find((tool) => tool.name === 'computer_mouse')?.sensitivity).toBe('confirm')
    expect(tools.find((tool) => tool.name === 'computer_stop')?.sensitivity).toBe('safe')
  })

  it('入口是 confirm、退出是 safe —— 收回桌面授权不能被确认链卡住', () => {
    const tools = createComputerUseTools({ port: port() })
    expect(tools.find((tool) => tool.name === COMPUTER_USE_START_TOOL_NAME)?.sensitivity).toBe(
      'confirm',
    )
    expect(tools.find((tool) => tool.name === 'computer_stop')?.sensitivity).toBe('safe')
  })

  it('computer_start 透传理由与 sessionId，并提示授权 ≠ 开始操作', async () => {
    const fake = port()
    const tool = createComputerUseTools({ port: fake }).find(
      (item) => item.name === COMPUTER_USE_START_TOOL_NAME,
    )!
    const result = await tool.execute({ reason: '帮用户打开浏览器' }, ctx)
    expect(fake.start).toHaveBeenCalledWith({
      sessionId: 's1',
      reason: '帮用户打开浏览器',
    })
    expect(result.isError).toBeUndefined()
    // 具体文案由主进程端口生成；工具层只负责透传端口结果
    expect(result.content).toBe('started')
  })

  it('computer_start 的端口错误折成工具错误', async () => {
    const fake = port()
    fake.start = vi.fn(async () => {
      throw new Error('Computer Use 未启用')
    })
    const tool = createComputerUseTools({ port: fake }).find(
      (item) => item.name === COMPUTER_USE_START_TOOL_NAME,
    )!
    const result = await tool.execute({}, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Computer Use 未启用')
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

  it('六个动作工具都透传 next（下一步计划），空串视为缺省', async () => {
    const fake = port()
    const tools = createComputerUseTools({ port: fake })
    const at = (name: string) => tools.find((tool) => tool.name === name)!
    await at('computer_screenshot').execute({ next: ' 点击搜索框 ' }, ctx)
    expect(fake.screenshot).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', next: '点击搜索框' }),
    )
    await at('computer_mouse').execute({ action: 'position', next: '输入关键词' }, ctx)
    expect(fake.mouse).toHaveBeenCalledWith(expect.objectContaining({ next: '输入关键词' }))
    await at('computer_keyboard').execute({ action: 'key', keys: ['Enter'], next: '看结果' }, ctx)
    expect(fake.keyboard).toHaveBeenCalledWith(expect.objectContaining({ next: '看结果' }))
    await at('computer_window').execute({ action: 'active', next: '切换窗口' }, ctx)
    expect(fake.window).toHaveBeenCalledWith(expect.objectContaining({ next: '切换窗口' }))
    await at('computer_ui').execute({ action: 'tree', next: '读控件' }, ctx)
    expect(fake.ui).toHaveBeenCalledWith(expect.objectContaining({ next: '读控件' }))
    await at('computer_wait').execute({ seconds: 0, next: '等加载' }, ctx)
    expect(fake.wait).toHaveBeenCalledWith(expect.objectContaining({ next: '等加载' }))
    // 空白 next = 没给计划（主进程据此清空面板的「下一步」一行）
    await at('computer_mouse').execute({ action: 'position', next: '   ' }, ctx)
    expect(fake.mouse).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ next: expect.anything() }),
    )
  })

  it('next 超过 120 字折成工具错误（与其它参数同一口径，不静默截断）', async () => {
    const fake = port()
    const tool = createComputerUseTools({ port: fake }).find(
      (item) => item.name === 'computer_mouse',
    )!
    const result = await tool.execute({ action: 'position', next: 'x'.repeat(121) }, ctx)
    expect(result.isError).toBe(true)
    expect(fake.mouse).not.toHaveBeenCalled()
  })

  it('computer_start 文案说明动作工具同请求下一轮可用，且不要同轮批量', () => {
    const tool = createComputerUseTools({ port: port() }).find(
      (item) => item.name === COMPUTER_USE_START_TOOL_NAME,
    )!
    expect(tool.description).toContain('同一次请求的下一轮')
    expect(tool.description).toContain('不要在同一轮')
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
      (item) => item.name === 'computer_mouse',
    )!
    const result = await mouse.execute({ action: 'click', x: 1, y: 2 }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('target changed')
  })
})

describe('Computer Use 工具名清单', () => {
  it('授权后 7 个工具（6 动作 + 退出），全集再加 Agent 入口', () => {
    expect(COMPUTER_USE_TOOL_NAMES).toHaveLength(7)
    expect(COMPUTER_USE_ALL_TOOL_NAMES).toHaveLength(8)
    expect(COMPUTER_USE_ALL_TOOL_NAMES[0]).toBe(COMPUTER_USE_START_TOOL_NAME)
  })
})
