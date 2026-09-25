/**
 * `web_fetch` 工具的内核单测（Design/betav2-spec.md §6）。
 *
 * 全程用**假端口**，不发真实网络请求：这里只验证工具层契约
 * （参数校验 / 协议白名单 / 状态码映射 / 端口错误转工具错误）；
 * 真实抓取（netFetch + 剥标签 + 20k 截断）由主进程端口承担。
 */
import { describe, expect, it } from 'vitest'
import { MAX_WEB_FETCH_CHARS, createWebFetchTool } from './web-fetch.js'
import type { WebFetchPort } from './web-fetch.js'
import type { ToolDefinition } from './registry.js'

const CONTEXT = { sessionId: 'session-test' }

interface Harness {
  tool: ToolDefinition
  calls: string[]
}

function createHarness(options: {
  result?: { status: number; text: string }
  error?: unknown
}): Harness {
  const calls: string[] = []
  const port: WebFetchPort = {
    fetch: async (url) => {
      calls.push(url)
      if (options.error !== undefined) throw options.error
      return options.result ?? { status: 200, text: '网页正文' }
    },
  }
  return { tool: createWebFetchTool({ port }), calls }
}

describe('createWebFetchTool', () => {
  it('声明名字、safe 敏感级与参数 schema', () => {
    const { tool } = createHarness({})
    expect(tool.name).toBe('web_fetch')
    expect(tool.sensitivity).toBe('safe')
    expect(tool.parameters.required).toEqual(['url'])
    expect(tool.parameters.additionalProperties).toBe(false)
    // 描述要交代 GET、纯文本与截断口径（截断由主进程端口做）
    expect(tool.description).toContain('GET')
    expect(tool.description).toContain('纯文本')
    expect(tool.description).toContain(String(MAX_WEB_FETCH_CHARS))
  })

  it('成功：正文回填并带来源与状态码头部', async () => {
    const { tool, calls } = createHarness({ result: { status: 200, text: '正文内容' } })
    const result = await tool.execute({ url: 'https://example.com/a' }, CONTEXT)

    expect(calls).toEqual(['https://example.com/a'])
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('https://example.com/a')
    expect(result.content).toContain('HTTP 200')
    expect(result.content).toContain('正文内容')
  })

  it('非 http/https 协议直接拒绝，不触碰端口', async () => {
    const { tool, calls } = createHarness({})
    for (const url of ['ftp://example.com/f', 'file:///C:/x', 'javascript:alert(1)', '不是网址']) {
      const result = await tool.execute({ url }, CONTEXT)
      expect(result.isError).toBe(true)
      expect(result.summary).toBe('url 参数非法')
    }
    expect(calls).toEqual([])
  })

  it('缺少 url 参数时报错且不触碰端口', async () => {
    const { tool, calls } = createHarness({})
    const result = await tool.execute({}, CONTEXT)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('缺少参数 url')
    expect(calls).toEqual([])
  })

  it('非 2xx 状态：isError 且保留原始内容供模型判断', async () => {
    const { tool } = createHarness({ result: { status: 404, text: 'not found' } })
    const result = await tool.execute({ url: 'https://example.com/404' }, CONTEXT)
    expect(result.isError).toBe(true)
    expect(result.summary).toBe('抓取失败：HTTP 404')
    expect(result.content).toContain('not found')
  })

  it('端口抛错转为工具错误结果（不冒泡）', async () => {
    const { tool } = createHarness({ error: new Error('网络不可达') })
    const result = await tool.execute({ url: 'https://example.com/' }, CONTEXT)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('抓取网页失败')
    expect(result.content).toContain('网络不可达')
  })
})
