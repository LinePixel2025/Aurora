/**
 * `notify_banner` 工具的内核单测（docs/06 §14、docs/07 §2.2.3）。
 *
 * 全程用**假端口**，不碰真实窗口：这里只验证工具层契约
 * （safe 敏感级 / 参数与长度校验 / speak·sound 透传 / 端口失败折成业务结果）。
 * 真实流光与卡片由主进程的 `BannerService` + 两个窗口承担。
 */
import { describe, expect, it } from 'vitest'
import {
  BANNER_NOTIFY_BODY_MAX,
  BANNER_NOTIFY_TITLE_MAX,
  BANNER_NOTIFY_TOOL_NAME,
  createBannerNotifyTool,
  type BannerNotifyInput,
  type BannerNotifyPort,
} from './banner-notify.js'
import type { ToolDefinition } from './registry.js'

const CONTEXT = { sessionId: 'session-test' }

interface Harness {
  tool: ToolDefinition
  calls: BannerNotifyInput[]
}

function createHarness(
  options: { error?: unknown; outcome?: { ok: boolean; reason?: string } } = {},
): Harness {
  const calls: BannerNotifyInput[] = []
  const port: BannerNotifyPort = {
    show: async (input) => {
      if (options.error !== undefined) throw options.error
      calls.push(input)
      return options.outcome ?? { ok: true }
    },
  }
  return { tool: createBannerNotifyTool({ port }), calls }
}

describe('createBannerNotifyTool', () => {
  it('声明名字、safe 敏感级与必填参数', () => {
    const { tool } = createHarness()
    expect(tool.name).toBe(BANNER_NOTIFY_TOOL_NAME)
    expect(tool.name).toBe('notify_banner')
    expect(tool.sensitivity).toBe('safe')
    expect(tool.parameters.required).toEqual(['title', 'body'])
    expect(tool.parameters.additionalProperties).toBe(false)
  })

  it('成功：标题 / 正文透传，speak / sound 只在给定时带上', async () => {
    const { tool, calls } = createHarness()
    const plain = await tool.execute({ title: '构建完成', body: '产物已就绪' }, CONTEXT)
    expect(calls[0]).toEqual({ title: '构建完成', body: '产物已就绪' })
    expect(plain.isError).toBeUndefined()
    expect(plain.summary).toBe('已显示流光提醒')
    expect(plain.content).toContain('构建完成')

    await tool.execute({ title: '提问', body: '要点哪个？', speak: false, sound: true }, CONTEXT)
    expect(calls[1]).toEqual({ title: '提问', body: '要点哪个？', speak: false, sound: true })
  })

  it('允许空正文（卡片只显示标题），但缺 title / 非字符串仍判参数错误', async () => {
    const { tool, calls } = createHarness()
    const emptyBody = await tool.execute({ title: '只有标题', body: '' }, CONTEXT)
    expect(emptyBody.isError).toBeUndefined()
    expect(calls[0]).toEqual({ title: '只有标题', body: '' })

    for (const input of [
      {},
      { body: '没标题' },
      { title: '   ', body: 'x' },
      { title: 1, body: 'x' },
    ]) {
      const result = await tool.execute(input, CONTEXT)
      expect(result.isError).toBe(true)
      expect(result.summary).toBe('流光提醒参数缺失')
    }
    expect(calls).toHaveLength(1)
  })

  it('标题 / 正文超长直接拒绝（不裁切后静默发送）', async () => {
    const { tool, calls } = createHarness()
    const longTitle = await tool.execute(
      { title: 'x'.repeat(BANNER_NOTIFY_TITLE_MAX + 1), body: 'b' },
      CONTEXT,
    )
    expect(longTitle.isError).toBe(true)
    expect(longTitle.summary).toBe('流光提醒标题过长')

    const longBody = await tool.execute(
      { title: 't', body: 'x'.repeat(BANNER_NOTIFY_BODY_MAX + 1) },
      CONTEXT,
    )
    expect(longBody.isError).toBe(true)
    expect(longBody.summary).toBe('流光提醒正文过长')
    expect(calls).toEqual([])
  })

  it('端口返回 ok:false 是业务结果（去重 / 队列满），带原因回填', async () => {
    const { tool } = createHarness({ outcome: { ok: false, reason: '短时间内重复的提醒已合并' } })
    const result = await tool.execute({ title: 't', body: 'b' }, CONTEXT)
    expect(result.isError).toBe(true)
    expect(result.summary).toBe('流光提醒未显示')
    expect(result.content).toContain('短时间内重复的提醒已合并')
    // 去重是正常合并行为，工具要明确告诉模型「不用重试」
    expect(result.content).toContain('不用重试')
  })

  it('端口抛错也被折成失败结果（不冒泡进工具循环）', async () => {
    const { tool } = createHarness({ error: new Error('窗口创建失败') })
    const result = await tool.execute({ title: 't', body: 'b' }, CONTEXT)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('窗口创建失败')
  })
})
