/**
 * `classisland_remind` 工具与装配器单测（docs/05 §3.4 v3）。
 *
 * 覆盖三条口径：
 * - **sensitivity 与 `notify_user` 同级（`safe`）**：只弹提醒、不碰系统状态；
 * - **不受 `agent.tools.enabled` 门控**（不在 `COMPUTER_TOOL_NAMES` 里）；
 * - **按可用性注册**：桥接未配置时不进工具表，配置好之后 `sync()` 补上。
 */
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '@aurora/agent-core'
import { createMemoryLogger, type ClassIslandNotifyResult } from '@aurora/shared'
import {
  CLASSISLAND_REMIND_TOOL_NAME,
  DEFAULT_REMIND_TITLE,
  createClassIslandRemindTool,
  type ClassIslandNotifyPort,
} from './classisland-remind.js'
import { CLASSISLAND_TOOL_NAMES, registerClassIslandTools } from './index.js'

interface Recorded {
  title?: string
  body?: string
  channel?: string
}

function port(options: { available?: boolean; result?: ClassIslandNotifyResult } = {}): {
  port: ClassIslandNotifyPort
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  return {
    calls,
    port: {
      available: () => options.available ?? true,
      notify: async (request) => {
        calls.push({
          title: request.title,
          body: request.body,
          ...(request.channel === undefined ? {} : { channel: request.channel }),
        })
        return options.result ?? { ok: true, elapsedMs: 42 }
      },
    },
  }
}

const CTX = { sessionId: 's1' }

describe('createClassIslandRemindTool', () => {
  it('工具契约：名字 / 必填参数 / sensitivity 与 notify_user 同级（safe）', () => {
    const tool = createClassIslandRemindTool({ port: port().port })
    expect(tool.name).toBe(CLASSISLAND_REMIND_TOOL_NAME)
    expect(tool.sensitivity).toBe('safe')
    expect(tool.parameters['required']).toEqual(['body'])
    expect(tool.parameters['additionalProperties']).toBe(false)
  })

  it('只给 body 时标题用默认值，渠道留给实现决定（不带 channel）', async () => {
    const { port: p, calls } = port()
    const tool = createClassIslandRemindTool({ port: p })
    const result = await tool.execute({ body: '  该交作业了  ' }, CTX)

    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('已通过 ClassIsland 发送提醒')
    expect(result.content).toContain('42ms')
    expect(calls).toEqual([{ title: DEFAULT_REMIND_TITLE, body: '该交作业了' }])
  })

  it('接受白名单渠道；未知渠道按缺省处理（写错渠道名不该让提醒失败）', async () => {
    const { port: p, calls } = port()
    const tool = createClassIslandRemindTool({ port: p })

    await tool.execute({ title: 'T', body: 'B', channel: 'pre-class' }, CTX)
    await tool.execute({ title: 'T', body: 'B', channel: 'not-a-channel' }, CTX)
    expect(calls).toEqual([
      { title: 'T', body: 'B', channel: 'pre-class' },
      { title: 'T', body: 'B' },
    ])
  })

  it('缺 body / body 为空白 → 参数错误，且**不触碰端口**', async () => {
    const { port: p, calls } = port()
    const tool = createClassIslandRemindTool({ port: p })

    for (const input of [{}, { body: '   ' }, { body: 42 }, null, 'nope']) {
      const result = await tool.execute(input, CTX)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('body')
    }
    expect(calls).toEqual([])
  })

  it('桥接未配置（available=false）→ 直接给出可执行指引，不发起发送', async () => {
    const { port: p, calls } = port({ available: false })
    const tool = createClassIslandRemindTool({ port: p })
    const result = await tool.execute({ body: 'B' }, CTX)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('ClassIsland')
    expect(result.content).toContain('notify_user')
    expect(calls).toEqual([])
  })

  it('发送失败（ok:false）→ 错误结果带上原因与耗时', async () => {
    const { port: p } = port({
      result: { ok: false, error: '等待 ClassIsland 回执超时（3000ms）', elapsedMs: 3001 },
    })
    const tool = createClassIslandRemindTool({ port: p })
    const result = await tool.execute({ body: 'B' }, CTX)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('等待 ClassIsland 回执超时')
    expect(result.content).toContain('3001ms')
  })
})

describe('registerClassIslandTools', () => {
  it('桥接可用时注册，不可用时摘除（同一个 sync 幂等）', () => {
    const tools = new ToolRegistry()
    let available = false
    const registry = registerClassIslandTools({
      tools,
      logger: createMemoryLogger(),
      port: { available: () => available, notify: async () => ({ ok: true, elapsedMs: 1 }) },
    })

    expect(registry.sync()).toEqual([])
    expect(tools.get(CLASSISLAND_REMIND_TOOL_NAME)).toBeUndefined()

    // 用户在设置页填好端点 → settings:changed 触发 sync → 工具出现（无需重启）
    available = true
    expect(registry.sync()).toEqual([...CLASSISLAND_TOOL_NAMES])
    expect(tools.get(CLASSISLAND_REMIND_TOOL_NAME)?.sensitivity).toBe('safe')

    // 再关掉端点 → 摘除
    available = false
    expect(registry.sync()).toEqual([])
    expect(tools.get(CLASSISLAND_REMIND_TOOL_NAME)).toBeUndefined()
  })
})
