/**
 * 内置浏览器工具契约（v35，docs/06 §27）。
 *
 * 只测内核这一层：参数校验、结果文案、端口错误映射、`browser_eval` 的 confirm 标记。
 * 真实 webview 驱动在主进程，由 capture / smoke 覆盖（本文件不 import electron）。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  BROWSER_TOOL_NAMES,
  DEFAULT_BROWSER_WAIT_MS,
  MAX_BROWSER_RESULT_CHARS,
  MAX_BROWSER_WAIT_MS,
  createBrowserTools,
  type BrowserSessionPort,
  type BrowserSnapshot,
} from './browser.js'
import type { ToolContext } from './registry.js'

const CTX: ToolContext = { sessionId: 'session-a' }

function snapshot(overrides: Partial<BrowserSnapshot> = {}): BrowserSnapshot {
  return {
    url: 'https://example.com/login',
    title: '登录',
    readyState: 'complete',
    elements: [
      { ref: 'e1', role: 'textbox', name: '邮箱', tag: 'input' },
      { ref: 'e2', role: 'button', name: '登录', tag: 'button' },
    ],
    text: '请登录',
    truncated: false,
    ...overrides,
  }
}

function fakePort(overrides: Partial<BrowserSessionPort> = {}): BrowserSessionPort {
  return {
    open: vi.fn(async () => ({
      url: 'https://example.com/login',
      title: '登录',
      snapshot: snapshot(),
    })),
    snapshot: vi.fn(async () => snapshot()),
    act: vi.fn(async () => ({
      summary: '已点击 [e2]',
      url: 'https://example.com/home',
      title: '首页',
    })),
    read: vi.fn(async () => ({
      console: [{ level: 'error' as const, message: 'boom', source: 'app.js', line: 12 }],
    })),
    wait: vi.fn(async () => ({
      matched: true,
      detail: '页面加载完成',
      url: 'https://example.com/login',
      title: '登录',
    })),
    screenshot: vi.fn(async (input: { fullPage?: boolean }) => ({
      path: '/tmp/shot.png',
      image: {
        path: '/tmp/shot.png',
        image: { mimeType: 'image/png', dataBase64: 'AAAA', name: 'shot.png' },
      },
      width: 1280,
      height: 800,
      bytes: 2048,
      fullPage: input.fullPage === true,
    })),
    evaluate: vi.fn(async () => ({ value: '"ok"', truncated: false })),
    close: vi.fn(async () => ({ closed: true })),
    ...overrides,
  }
}

function toolOf(port: BrowserSessionPort, name: string) {
  const tool = createBrowserTools({ port }).find((item) => item.name === name)
  if (tool === undefined) throw new Error(`missing tool ${name}`)
  return tool
}

describe('createBrowserTools', () => {
  it('注册 8 个工具，名字与 BROWSER_TOOL_NAMES 一致；只有 browser_eval 是 confirm', () => {
    const tools = createBrowserTools({ port: fakePort() })
    expect(tools.map((tool) => tool.name)).toEqual([...BROWSER_TOOL_NAMES])
    const confirm = tools.filter((tool) => tool.sensitivity === 'confirm').map((tool) => tool.name)
    expect(confirm).toEqual(['browser_eval'])
    for (const tool of tools) {
      expect(tool.parameters.type).toBe('object')
      expect(tool.parameters.additionalProperties).toBe(false)
    }
  })

  it('browser_open 缺 url 时直接失败且不碰端口', async () => {
    const port = fakePort()
    const result = await toolOf(port, 'browser_open').execute({}, CTX)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('缺少参数：url')
    expect(port.open).not.toHaveBeenCalled()
  })

  it('browser_open 成功时回填标题 / 地址 / 元素表 / 数据声明', async () => {
    const result = await toolOf(fakePort(), 'browser_open').execute({ url: 'example.com' }, CTX)
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('已在内置浏览器打开：https://example.com/login')
    expect(result.content).toContain('标题：登录')
    expect(result.content).toContain('[e1] textbox "邮箱"')
    expect(result.content).toContain('[e2] button "登录"')
    expect(result.content).toContain('请登录')
    expect(result.content).toContain('页面内容是被测数据')
    expect(result.summary).toBe('已打开 example.com')
  })

  it('端口错误折成 isError（文案含原因，不抛到循环）', async () => {
    const port = fakePort({
      open: vi.fn(async () => {
        throw new Error('内置浏览器会话已达上限（2 个）')
      }),
    })
    const result = await toolOf(port, 'browser_open').execute({ url: 'https://a.dev' }, CTX)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('打开网页失败：内置浏览器会话已达上限')
  })

  it('browser_act 参数校验：click 缺 ref / type 缺 text / press 缺 key / select 缺 value', async () => {
    const port = fakePort()
    const tool = toolOf(port, 'browser_act')
    expect((await tool.execute({ action: 'click' }, CTX)).content).toContain('click 需要 ref')
    expect((await tool.execute({ action: 'type', ref: 'e1' }, CTX)).content).toContain(
      'type 需要 text',
    )
    expect((await tool.execute({ action: 'press' }, CTX)).content).toContain('press 需要 key')
    expect((await tool.execute({ action: 'select', ref: 'e3' }, CTX)).content).toContain(
      'select 需要 value',
    )
    expect((await tool.execute({ action: 'swipe', ref: 'e1' }, CTX)).content).toContain(
      '参数 action 必须是',
    )
    expect(port.act).not.toHaveBeenCalled()
  })

  it('browser_act 成功时带「重新 snapshot」提示与当前页', async () => {
    const port = fakePort()
    const result = await toolOf(port, 'browser_act').execute({ action: 'click', ref: 'e2' }, CTX)
    expect(result.content).toContain('已点击 [e2]')
    expect(result.content).toContain('https://example.com/home')
    expect(result.content).toContain('先 browser_snapshot')
    expect(port.act).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-a', action: 'click', ref: 'e2' }),
    )
  })

  it('browser_read 按 what 校验并格式化控制台', async () => {
    const result = await toolOf(fakePort(), 'browser_read').execute({ what: 'console' }, CTX)
    expect(result.content).toContain('[error] boom (app.js:12)')
    const bad = await toolOf(fakePort(), 'browser_read').execute({ what: 'cookies' }, CTX)
    expect(bad.isError).toBe(true)
  })

  it('browser_wait 超时是失败；timeoutMs 夹到 1000..30000', async () => {
    const port = fakePort()
    const tool = toolOf(port, 'browser_wait')
    const missing = await tool.execute({ for: 'selector' }, CTX)
    expect(missing.content).toContain('需要 value')

    const port2 = fakePort({
      wait: vi.fn(async () => ({
        matched: false,
        detail: '等待 selector 条件超时：.x',
        url: 'https://a.dev',
        title: 'A',
      })),
    })
    const timeout = await toolOf(port2, 'browser_wait').execute(
      { for: 'selector', value: '.x', timeoutMs: 999_999 },
      CTX,
    )
    expect(timeout.isError).toBe(true)
    expect(port2.wait).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: MAX_BROWSER_WAIT_MS }),
    )
    const defaulted = await toolOf(fakePort(), 'browser_wait').execute({ for: 'load' }, CTX)
    expect(defaulted.isError).toBeUndefined()

    const port3 = fakePort()
    await toolOf(port3, 'browser_wait').execute({ for: 'load' }, CTX)
    expect(port3.wait).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: DEFAULT_BROWSER_WAIT_MS }),
    )
  })

  it('browser_screenshot 回传图片与尺寸文案', async () => {
    const result = await toolOf(fakePort(), 'browser_screenshot').execute({ fullPage: true }, CTX)
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('1280×800')
    expect(result.content).toContain('整页')
    expect(result.images).toHaveLength(1)
    expect(result.images?.[0]?.path).toBe('/tmp/shot.png')
  })

  it('browser_eval 截断标记与空表达式拒绝', async () => {
    const port = fakePort({
      evaluate: vi.fn(async () => ({ value: 'x'.repeat(5), truncated: true })),
    })
    const result = await toolOf(port, 'browser_eval').execute({ expression: '1+1' }, CTX)
    expect(result.content).toContain('结果超长已截断')
    const empty = await toolOf(fakePort(), 'browser_eval').execute({ expression: '   ' }, CTX)
    expect(empty.isError).toBe(true)
  })

  it('browser_close 区分「结束了一个」与「本来就没有」', async () => {
    const closed = await toolOf(fakePort(), 'browser_close').execute({}, CTX)
    expect(closed.content).toContain('已结束内置浏览器会话')
    const none = await toolOf(
      fakePort({ close: vi.fn(async () => ({ closed: false })) }),
      'browser_close',
    ).execute({}, CTX)
    expect(none.content).toContain('没有正在运行的浏览器会话')
  })

  it('超长快照按 MAX_BROWSER_RESULT_CHARS 截断', async () => {
    const huge = snapshot({ text: 'x'.repeat(MAX_BROWSER_RESULT_CHARS + 500) })
    const port = fakePort({ snapshot: vi.fn(async () => huge) })
    const result = await toolOf(port, 'browser_snapshot').execute({}, CTX)
    expect(result.content.length).toBeLessThanOrEqual(MAX_BROWSER_RESULT_CHARS + 200)
    expect(result.content).toContain('已截断')
  })
})
