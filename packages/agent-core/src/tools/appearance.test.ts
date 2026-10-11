/**
 * `set_appearance` 工具的纯逻辑单测（docs/06 §12.1）。
 *
 * 与 `settings.test.ts` 同一套路：全部用内存假端口，**没有真实配置读写** ——
 * 真实实现由主进程的 `SettingsToolPort` 承担（`main/tools/settings-port.ts`），
 * 它同时被 `set_setting` 使用，因此这里只验"外观工具自己的语义"：
 * 参数校验、无字段=读、可写性预检、回填文案、错误不冒泡。
 */
import { describe, expect, it } from 'vitest'
import { createMemoryLogger } from '@aurora/shared'
import { APPEARANCE_TOOL_NAME, createAppearanceTool } from './appearance.js'
import type { SettingsToolPort, SettingsWriteOutcome } from './settings.js'
import type { ToolContext, ToolDefinition } from './registry.js'

const ctx: ToolContext = { sessionId: 'test-session' }

/** 外观四件套的缩小版快照（与真实 `appearance` 分组同形） */
function appearanceSnapshot(): Record<string, unknown> {
  return {
    appearance: { theme: 'system', accent: 'aurora', glass: true, awarenessGlow: true },
  }
}

interface FakePortOptions {
  snapshot?: Record<string, unknown>
  /** 模拟用户把 `appearance` 追加进只读黑名单 */
  readonlyPrefixes?: string[]
  writeImpl?: (paths: Array<{ path: string; value: unknown }>) => Promise<SettingsWriteOutcome>
}

interface FakeCalls {
  writable: string[]
  read: string[]
  write: Array<Array<{ path: string; value: unknown }>>
}

function createFakePort(options: FakePortOptions = {}): {
  port: SettingsToolPort
  calls: FakeCalls
  snapshot: Record<string, unknown>
} {
  const snapshot = options.snapshot ?? appearanceSnapshot()
  const readonlyPrefixes = options.readonlyPrefixes ?? []
  const calls: FakeCalls = { writable: [], read: [], write: [] }

  const port: SettingsToolPort = {
    snapshot: () => snapshot,
    read(path) {
      calls.read.push(path)
      return resolvePath(snapshot, path)
    },
    writable(path) {
      calls.writable.push(path)
      const denied = readonlyPrefixes.find(
        (prefix) => path === prefix || path.startsWith(`${prefix}.`),
      )
      if (denied !== undefined) return { ok: false, reason: `路径 ${denied} 不允许通过工具修改` }
      return { ok: true }
    },
    async write(paths) {
      calls.write.push(paths)
      if (options.writeImpl !== undefined) return await options.writeImpl(paths)
      // 与主进程端口同语义：真写回快照，`applied` 只记原样生效的路径
      for (const item of paths) setPath(snapshot, item.path, item.value)
      return { ok: true, message: '已更新', applied: paths.map((item) => item.path) }
    },
  }

  return { port, calls, snapshot }
}

function resolvePath(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function setPath(source: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.')
  let cursor = source
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) return
    cursor = next as Record<string, unknown>
  }
  cursor[segments[segments.length - 1] as string] = value
}

function toolOf(options: FakePortOptions = {}): {
  tool: ToolDefinition
  calls: FakeCalls
  snapshot: Record<string, unknown>
} {
  const { port, calls, snapshot } = createFakePort(options)
  const tool = createAppearanceTool({ port, logger: createMemoryLogger() })
  return { tool, calls, snapshot }
}

describe('createAppearanceTool 元信息', () => {
  it('名字与敏感级：safe（纯视觉、即时可撤销，不弹确认卡）', () => {
    const { tool } = toolOf()
    expect(tool.name).toBe(APPEARANCE_TOOL_NAME)
    expect(tool.name).toBe('set_appearance')
    expect(tool.sensitivity).toBe('safe')
    expect(tool.description).toContain('明暗档位')
    expect(tool.description).toContain('毛玻璃')
  })

  it('四个参数都是可选的，且枚举与 Schema 同源', () => {
    const { tool } = toolOf()
    const properties = tool.parameters.properties as Record<
      string,
      { enum?: readonly string[]; type?: string }
    >
    expect(tool.parameters.required).toBeUndefined()
    expect(tool.parameters.additionalProperties).toBe(false)
    expect(properties['theme']?.enum).toEqual(['system', 'light', 'dark'])
    expect(properties['accent']?.enum).toEqual(['aurora', 'teal', 'violet', 'rose', 'amber'])
    expect(properties['glass']?.type).toBe('boolean')
    expect(properties['awarenessGlow']?.type).toBe('boolean')
  })
})

describe('set_appearance 的读取分支', () => {
  it('一个字段都不给 = 只读当前外观，且不写盘', async () => {
    const { tool, calls } = toolOf()
    const result = await tool.execute({}, ctx)
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('跟随系统')
    expect(result.content).toContain('品牌蓝')
    expect(result.content).toContain('开启')
    expect(result.summary).toBe('读取界面外观')
    expect(calls.write).toEqual([])
  })

  it('入参不是对象（模型写错形状）也按"只读"处理，不抛错', async () => {
    const { tool, calls } = toolOf()
    const result = await tool.execute('dark', ctx)
    expect(result.isError).toBeUndefined()
    expect(calls.write).toEqual([])
  })
})

describe('set_appearance 的写入分支', () => {
  it('写单字段：只提交该路径，且回填改后的值', async () => {
    const { tool, calls, snapshot } = toolOf()
    const result = await tool.execute({ theme: 'dark' }, ctx)
    expect(result.isError).toBeUndefined()
    expect(calls.write).toEqual([[{ path: 'appearance.theme', value: 'dark' }]])
    expect(resolvePath(snapshot, 'appearance.theme')).toBe('dark')
    expect(result.content).toContain('暗色')
    // 未给的其他字段如实标注"未改动"，让模型知道另外几项没被动
    expect(result.content).toContain('未改动')
  })

  it('批量写四字段：按 path 逐条提交，顺序稳定（theme / accent / glass / awarenessGlow）', async () => {
    const { tool, calls } = toolOf()
    const result = await tool.execute(
      { glass: false, awarenessGlow: false, theme: 'light', accent: 'violet' },
      ctx,
    )
    expect(result.isError).toBeUndefined()
    expect(calls.write).toEqual([
      [
        { path: 'appearance.theme', value: 'light' },
        { path: 'appearance.accent', value: 'violet' },
        { path: 'appearance.glass', value: false },
        { path: 'appearance.awarenessGlow', value: false },
      ],
    ])
    expect(result.summary).toContain('明暗档位')
    expect(result.summary).toContain('毛玻璃')
    expect(result.summary).toContain('流光特效')
    expect(result.content).toContain('关闭')
  })

  it('枚举外的值就地失败，且不触碰端口（不写半个字段）', async () => {
    const { tool, calls } = toolOf()
    for (const input of [{ theme: 'deep' }, { accent: 'pink' }, { glass: 'yes' }]) {
      const result = await tool.execute(input, ctx)
      expect(result.isError).toBe(true)
      expect(result.content.length).toBeGreaterThan(0)
    }
    // 流光开关同样是布尔：非布尔值不许落到 Schema 那一层
    const glow = await tool.execute({ awarenessGlow: 'on' }, ctx)
    expect(glow.isError).toBe(true)
    expect(glow.content).toContain('awarenessGlow')
    expect(calls.write).toEqual([])
  })

  it('单独读写流光开关：路径与中文名都对，读回时也能报告关闭态', async () => {
    const { tool, calls, snapshot } = toolOf()
    const result = await tool.execute({ awarenessGlow: false }, ctx)
    expect(result.isError).toBeUndefined()
    expect(calls.write).toEqual([[{ path: 'appearance.awarenessGlow', value: false }]])
    expect(resolvePath(snapshot, 'appearance.awarenessGlow')).toBe(false)
    expect(result.content).toContain('流光特效')

    const read = await tool.execute({}, ctx)
    expect(read.content).toContain('流光特效：关闭')
  })

  it('部分字段非法时整体拒绝：合法字段也不会被写进去', async () => {
    const { tool, calls } = toolOf()
    const result = await tool.execute({ theme: 'dark', accent: 'pink' }, ctx)
    expect(result.isError).toBe(true)
    expect(calls.write).toEqual([])
  })

  it('可写性预检：用户把 appearance 追加进只读黑名单后整体拒绝（不写盘）', async () => {
    const { tool, calls } = toolOf({ readonlyPrefixes: ['appearance'] })
    const result = await tool.execute({ theme: 'dark' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('不能修改 appearance.theme')
    expect(calls.write).toEqual([])
  })

  it('端口抛错转成工具错误（绝不冒泡进工具循环）', async () => {
    const { tool } = toolOf({
      writeImpl: async () => {
        throw new Error('磁盘炸了')
      },
    })
    const result = await tool.execute({ theme: 'dark' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('磁盘炸了')
  })

  it('端口返回失败时原样回填原因', async () => {
    const { tool } = toolOf({
      writeImpl: async () => ({ ok: false, message: '配置校验失败：theme 非法', applied: [] }),
    })
    const result = await tool.execute({ theme: 'dark' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('配置校验失败')
  })

  it('写了但未被原样生效时如实标注（对齐 set_setting 的「未生效」口径）', async () => {
    const { tool } = toolOf({
      writeImpl: async () => ({ ok: true, message: '已更新', applied: [] }),
    })
    const result = await tool.execute({ glass: false }, ctx)
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('未生效')
  })
})
