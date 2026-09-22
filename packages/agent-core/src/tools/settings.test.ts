/**
 * `set_setting` 工具的纯逻辑单测（docs/06 §12）。
 *
 * 全部用内存假端口，**没有真实配置读写**：真实实现由主进程端口承担
 * （`apps/desktop/src/main/tools/settings-port.ts`）。
 */
import { describe, expect, it } from 'vitest'
import { createMemoryLogger } from '@aurora/shared'
import {
  createSettingsTool,
  isSensitiveSettingPath,
  redactValue,
  SETTINGS_TOOL_NAME,
} from './settings.js'
import type { SettingsToolPort, SettingsWriteOutcome } from './settings.js'
import type { ToolContext, ToolDefinition } from './registry.js'

const ctx: ToolContext = { sessionId: 'test-session' }

/** 默认快照：一份「有可写字段、也有黑名单字段」的缩小版配置 */
function defaultSnapshot(): Record<string, unknown> {
  return {
    agent: {
      tools: {
        enabled: true,
        terminal: { enabled: true, timeoutMs: 60_000 },
      },
    },
    advanced: { logLevel: 'info', proxy: '' },
    llm: {
      active: 'deepseek',
      providers: { deepseek: { apiKeyEnc: '', model: 'deepseek-chat' } },
    },
  }
}

interface FakeCalls {
  writable: string[]
  read: string[]
  write: Array<Array<{ path: string; value: unknown }>>
}

interface FakePort {
  port: SettingsToolPort
  calls: FakeCalls
}

interface FakePortOptions {
  snapshot?: Record<string, unknown>
  /** 模拟黑名单 / 未知路径：命中即不可写 */
  readonlyPrefixes?: string[]
  /** 覆盖 write 行为（抛错 / 返回失败 / 返回残缺的 applied） */
  writeImpl?: (paths: Array<{ path: string; value: unknown }>) => Promise<SettingsWriteOutcome>
}

function createFakePort(options: FakePortOptions = {}): FakePort {
  const snapshot = options.snapshot ?? defaultSnapshot()
  const readonlyPrefixes = options.readonlyPrefixes ?? [
    'llm.providers',
    'advanced.proxy',
    'version',
  ]
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
      if (resolvePath(snapshot, path) === undefined) {
        return { ok: false, reason: '未知配置路径' }
      }
      return { ok: true }
    },
    async write(paths) {
      calls.write.push(paths)
      if (options.writeImpl !== undefined) return await options.writeImpl(paths)
      return { ok: true, message: '已更新', applied: paths.map((item) => item.path) }
    },
  }

  return { port, calls }
}

/** 测试侧的路径解析（不复用内核内部实现，避免「用实现测实现」） */
function resolvePath(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function toolOf(options: FakePortOptions = {}): ToolDefinition {
  return createSettingsTool({ port: createFakePort(options).port })
}

describe('createSettingsTool 元信息', () => {
  it('名字 / 敏感级别 / 参数 schema 与契约一致', () => {
    const tool = toolOf()

    expect(tool.name).toBe('set_setting')
    expect(tool.name).toBe(SETTINGS_TOOL_NAME)
    expect(tool.sensitivity).toBe('confirm')
    expect(tool.parameters.type).toBe('object')
    expect(tool.parameters.required).toEqual(['action'])
    expect(tool.parameters.additionalProperties).toBe(false)
  })

  it('description 写明「先 list 查」「改完立即生效」「敏感字段会被拒」', () => {
    const { description } = toolOf()

    expect(description).toContain('action=list')
    expect(description).toContain('立即生效')
    expect(description).toContain('不可修改')
  })
})

describe('action=get', () => {
  it('返回可写路径的当前值', async () => {
    const { port } = createFakePort()
    const result = await createSettingsTool({ port }).execute(
      { action: 'get', path: 'agent.tools.enabled' },
      ctx,
    )

    expect(result.isError).toBeUndefined()
    expect(result.content).toBe('agent.tools.enabled = true')
  })

  it('不可读路径（凭据 / 黑名单）返回「该路径不可读」且不回显值', async () => {
    const { port, calls } = createFakePort()
    const result = await createSettingsTool({ port }).execute(
      { action: 'get', path: 'llm.providers.deepseek.apiKeyEnc' },
      ctx,
    )

    expect(result.isError).toBe(true)
    expect(result.content).toBe('该路径不可读')
    // 不可读时连 read 都不该发生
    expect(calls.read).toEqual([])
  })

  it('未知路径同样按不可读处理（拼错字段不会泄露 Schema 结构）', async () => {
    const result = await toolOf().execute({ action: 'get', path: 'modes.classrom.typo' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toBe('该路径不可读')
  })

  it('缺少 path 时报错且不触碰端口', async () => {
    const { port, calls } = createFakePort()
    const result = await createSettingsTool({ port }).execute({ action: 'get' }, ctx)

    expect(result.isError).toBe(true)
    expect(calls.writable).toEqual([])
  })
})

describe('action=list', () => {
  it('只列可写路径，黑名单字段一个都不出现', async () => {
    const result = await toolOf().execute({ action: 'list' }, ctx)

    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('agent.tools.enabled = true')
    expect(result.content).toContain('advanced.logLevel = info')
    expect(result.content).not.toContain('llm.providers')
    expect(result.content).not.toContain('advanced.proxy')
  })

  it('group 收窄到前缀子树', async () => {
    const result = await toolOf().execute({ action: 'list', group: 'agent.tools' }, ctx)

    expect(result.content).toContain('agent.tools.enabled')
    expect(result.content).toContain('agent.tools.terminal.timeoutMs = 60000')
    expect(result.content).not.toContain('advanced.logLevel')
    expect(result.content).toContain('group="agent.tools"')
  })

  it('group 容错尾点，无匹配时给空结果而不是报错', async () => {
    const dotted = await toolOf().execute({ action: 'list', group: 'agent.tools.' }, ctx)
    expect(dotted.content).toContain('agent.tools.enabled')

    const empty = await toolOf().execute({ action: 'list', group: 'modes.classroom' }, ctx)
    expect(empty.isError).toBeUndefined()
    expect(empty.content).toContain('没有匹配')
  })

  it('单条 value 超 200 字符时截断', async () => {
    const { port } = createFakePort({
      snapshot: { agent: { tools: { note: 'y'.repeat(500) } } },
    })
    const result = await createSettingsTool({ port }).execute({ action: 'list' }, ctx)
    const line = result.content.split('\n').find((text) => text.startsWith('agent.tools.note'))

    expect(line).toBeDefined()
    expect(line).toContain('已截断 300 字符')
    // 200 字符上限 + 路径 + 截断后缀，绝不该出现完整的 500 字符
    expect(line?.length).toBeLessThan(260)
  })

  it('整体超 4000 字符时截断并提示用 group 收窄', async () => {
    const snapshot: Record<string, unknown> = {}
    for (let index = 0; index < 60; index += 1) {
      snapshot[`field${index}`] = 'x'.repeat(150)
    }
    const { port } = createFakePort({ snapshot })
    const result = await createSettingsTool({ port }).execute({ action: 'list' }, ctx)

    expect(result.content.length).toBeLessThanOrEqual(4_000)
    expect(result.content).toContain('已截断')
    expect(result.content).toContain('group')
    expect(result.content).toContain('field0')
    expect(result.content).not.toContain('field59')
    expect(result.summary).toContain('已截断')
  })

  it('快照为空时报「没有可写的配置字段」', async () => {
    const result = await toolOf({ snapshot: {} }).execute({ action: 'list' }, ctx)

    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('没有可写')
  })
})

describe('action=set', () => {
  it('成功时一次批量写入并回填新旧值', async () => {
    const { port, calls } = createFakePort()
    const result = await createSettingsTool({ port }).execute(
      {
        action: 'set',
        values: [
          { path: 'agent.tools.enabled', value: false },
          { path: 'advanced.logLevel', value: 'debug' },
        ],
      },
      ctx,
    )

    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('已修改：agent.tools.enabled = false（旧值：true）')
    expect(result.content).toContain('已修改：advanced.logLevel = debug（旧值：info）')
    // 多路径必须聚合成**一次** write
    expect(calls.write).toHaveLength(1)
    expect(calls.write[0]).toEqual([
      { path: 'agent.tools.enabled', value: false },
      { path: 'advanced.logLevel', value: 'debug' },
    ])
    expect(result.summary).toBe('已修改 2 项配置')
  })

  it('含一个不可写路径时整体拒绝：一个字段都没写', async () => {
    const { port, calls } = createFakePort()
    const result = await createSettingsTool({ port }).execute(
      {
        action: 'set',
        values: [
          { path: 'agent.tools.enabled', value: false },
          { path: 'advanced.proxy', value: 'http://127.0.0.1:7890' },
        ],
      },
      ctx,
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('不能修改 advanced.proxy')
    expect(result.content).toContain('不允许通过工具修改')
    // 关键：write 一次都没被调用（绝不写一半）
    expect(calls.write).toEqual([])
  })

  it('不可写字段排在最后也一样整体拒绝', async () => {
    const { port, calls } = createFakePort()
    const result = await createSettingsTool({ port }).execute(
      {
        action: 'set',
        values: [
          { path: 'llm.providers.deepseek.apiKeyEnc', value: 'leak' },
          { path: 'agent.tools.enabled', value: false },
        ],
      },
      ctx,
    )

    expect(result.isError).toBe(true)
    expect(calls.write).toEqual([])
  })

  it('路径含 apiKey 时回填值被 *** 覆盖', async () => {
    const { port } = createFakePort({
      // 这份假配置故意放开黑名单，只为钉住「脱敏」这件事本身
      snapshot: { llm: { providers: { deepseek: { apiKeyEnc: 'CIPHER-OLD' } } } },
      readonlyPrefixes: [],
    })
    const result = await createSettingsTool({ port }).execute(
      { action: 'set', values: [{ path: 'llm.providers.deepseek.apiKeyEnc', value: 'leak' }] },
      ctx,
    )

    expect(result.isError).toBeUndefined()
    expect(result.content).toBe('已修改：llm.providers.deepseek.apiKeyEnc = ***（旧值：***）')
    expect(result.content).not.toContain('leak')
    expect(result.content).not.toContain('CIPHER-OLD')
  })

  it('旧值里的疑似密文也不会漏出（路径命中 env / token / secret）', async () => {
    const snapshot = {
      mcp: { servers: { demo: { envEnc: 'CIPHER-ENV' } } },
      agent: { tools: { token: 'PLAIN-TOKEN', secret: 'PLAIN-SECRET' } },
    }
    const { port } = createFakePort({ snapshot, readonlyPrefixes: [] })
    const result = await createSettingsTool({ port }).execute(
      {
        action: 'set',
        values: [
          { path: 'mcp.servers.demo.envEnc', value: 'x' },
          { path: 'agent.tools.token', value: 'y' },
          { path: 'agent.tools.secret', value: 'z' },
        ],
      },
      ctx,
    )

    expect(result.content).not.toContain('CIPHER-ENV')
    expect(result.content).not.toContain('PLAIN-TOKEN')
    expect(result.content).not.toContain('PLAIN-SECRET')
    expect(result.content.match(/\*\*\*/g)).toHaveLength(6)
  })

  it('port.write 抛异常时返回 isError，而不是把异常抛穿', async () => {
    const logger = createMemoryLogger()
    const { port } = createFakePort({
      writeImpl: () => Promise.reject(new Error('磁盘炸了')),
    })
    const result = await createSettingsTool({ port, logger }).execute(
      { action: 'set', values: [{ path: 'agent.tools.enabled', value: false }] },
      ctx,
    )

    expect(result.isError).toBe(true)
    expect(result.content).toBe('写入失败：磁盘炸了')
    expect(logger.entries.some((entry) => entry.includes('配置写入失败'))).toBe(true)
  })

  it('port.write 返回 ok=false 时回填 message', async () => {
    const { port } = createFakePort({
      writeImpl: async () => ({
        ok: false,
        message: '配置校验失败：logLevel 不是合法枚举值',
        applied: [],
      }),
    })
    const result = await createSettingsTool({ port }).execute(
      { action: 'set', values: [{ path: 'advanced.logLevel', value: 'verbose' }] },
      ctx,
    )

    expect(result.isError).toBe(true)
    expect(result.content).toBe('配置校验失败：logLevel 不是合法枚举值')
  })

  it('端口实际只生效了一部分时补一行未生效提示', async () => {
    const { port } = createFakePort({
      writeImpl: async () => ({ ok: true, message: '部分生效', applied: ['agent.tools.enabled'] }),
    })
    const result = await createSettingsTool({ port }).execute(
      {
        action: 'set',
        values: [
          { path: 'agent.tools.enabled', value: false },
          { path: 'advanced.logLevel', value: 'debug' },
        ],
      },
      ctx,
    )

    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('已修改：agent.tools.enabled = false')
    expect(result.content).toContain('未生效：advanced.logLevel')
  })

  it('空 values / 非法元素被拒且不触碰 write', async () => {
    const invalidInputs: unknown[] = [
      { action: 'set', values: [] },
      { action: 'set' },
      { action: 'set', values: [{ path: 'agent.tools.enabled' }] },
      { action: 'set', values: [{ value: true }] },
      { action: 'set', values: [{ path: '  ', value: true }] },
      { action: 'set', values: [{ path: 'agent.tools.enabled', value: { nested: 1 } }] },
      { action: 'set', values: [{ path: 'agent.tools.enabled', value: null }] },
      { action: 'set', values: [{ path: 'agent.tools.enabled', value: Number.NaN }] },
      { action: 'set', values: ['agent.tools.enabled'] },
    ]
    for (const input of invalidInputs) {
      const { port, calls } = createFakePort()
      const result = await createSettingsTool({ port }).execute(input, ctx)
      expect(result.isError).toBe(true)
      expect(calls.write).toEqual([])
    }
  })

  it('端口 write 抛出的非 Error 值也能转成文本', async () => {
    const { port } = createFakePort({ writeImpl: () => Promise.reject('字符串错误') })
    const result = await createSettingsTool({ port }).execute(
      { action: 'set', values: [{ path: 'agent.tools.enabled', value: true }] },
      ctx,
    )

    expect(result.content).toBe('写入失败：字符串错误')
  })
})

describe('参数与兜底', () => {
  it('未知 action / 缺 action / 非对象入参都报错且不触碰端口', async () => {
    const { port, calls } = createFakePort()
    const tool = createSettingsTool({ port })
    for (const input of [{ action: 'delete' }, {}, null, 'set', ['set'], 42]) {
      const result = await tool.execute(input, ctx)
      expect(result.isError).toBe(true)
    }
    expect(calls.writable).toEqual([])
    expect(calls.write).toEqual([])
  })

  it('port.snapshot 抛错不冒泡进工具循环', async () => {
    const port: SettingsToolPort = {
      snapshot: () => {
        throw new Error('快照失败')
      },
      read: () => undefined,
      writable: () => ({ ok: true }),
      write: async () => ({ ok: true, message: '', applied: [] }),
    }
    const result = await createSettingsTool({ port }).execute({ action: 'list' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('快照失败')
  })
})

describe('redactValue', () => {
  it('命中疑似密钥的路径一律 ***，其余正常渲染', () => {
    for (const path of [
      'llm.providers.deepseek.apiKey',
      'llm.providers.deepseek.apiKeyEnc',
      'mcp.servers.demo.env',
      'agent.tools.token',
      'agent.tools.secret',
      'general.hotkey',
    ]) {
      expect(isSensitiveSettingPath(path)).toBe(true)
      expect(redactValue(path, 'PLAIN-LEAK')).toBe('***')
    }

    expect(isSensitiveSettingPath('agent.tools.enabled')).toBe(false)
    expect(redactValue('agent.tools.enabled', true)).toBe('true')
    expect(redactValue('advanced.logLevel', undefined)).toBe('（未设置）')
    expect(redactValue('agent.tools.list', ['a', 'b'])).toBe('["a","b"]')
  })
})
