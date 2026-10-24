import { describe, expect, it } from 'vitest'
import type { Logger } from '@aurora/shared'
import { executeAction, type AutomationActionPorts } from './actions.js'

/** 静默 Logger：单测不需要日志输出（与 engine.test.ts 同款） */
function silentLogger(): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  }
  return logger
}

/** 打开类端口的记录器：记下调用参数，可注入失败 */
function openPorts(options: { openPathError?: string; openExternalError?: string } = {}): {
  ports: AutomationActionPorts
  openedPaths: string[]
  openedUrls: string[]
} {
  const openedPaths: string[] = []
  const openedUrls: string[] = []
  const ports: AutomationActionPorts = {
    notify: () => true,
    classisland: {
      available: () => false,
      notify: async () => ({ ok: true }),
    },
    openPath: async (target) => {
      if (options.openPathError !== undefined) throw new Error(options.openPathError)
      openedPaths.push(target)
    },
    openExternal: async (url) => {
      if (options.openExternalError !== undefined) throw new Error(options.openExternalError)
      openedUrls.push(url)
    },
    resolveSubjectDir: () => '',
    logger: silentLogger(),
  }
  return { ports, openedPaths, openedUrls }
}

describe('executeAction · open-url', () => {
  it('http(s) 网址经 openExternal 打开', async () => {
    const { ports, openedUrls } = openPorts()
    const result = await executeAction(
      { kind: 'open-url', params: { url: 'https://example.com/a?b=1' } },
      ports,
    )
    expect(result.ok).toBe(true)
    expect(openedUrls).toEqual(['https://example.com/a?b=1'])
  })

  it('非 http(s) 协议一律拒绝且不触达端口（协议白名单，docs/13 §5）', async () => {
    const { ports, openedUrls } = openPorts()
    for (const url of [
      'file://C:/Windows/System32/calc.exe',
      'ms-settings://display',
      'javascript:alert(1)',
    ]) {
      const result = await executeAction({ kind: 'open-url', params: { url } }, ports)
      expect(result.ok).toBe(false)
      expect(result.error).toContain('http(s)')
    }
    expect(openedUrls).toEqual([])
  })

  it('网址缺省 / 空白拒绝', async () => {
    const { ports, openedUrls } = openPorts()
    for (const params of [{}, { url: '' }, { url: '   ' }]) {
      const result = await executeAction({ kind: 'open-url', params }, ports)
      expect(result.ok).toBe(false)
    }
    expect(openedUrls).toEqual([])
  })

  it('端口抛错转成失败回执（不向外抛）', async () => {
    const { ports } = openPorts({ openExternalError: 'no browser' })
    const result = await executeAction(
      { kind: 'open-url', params: { url: 'https://example.com' } },
      ports,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('no browser')
  })
})

describe('executeAction · plugin-action', () => {
  it('转发插件 id / 动作名与解析后的 JSON 参数', async () => {
    const { ports } = openPorts()
    const calls: Array<{ pluginId: string; action: string; params: Record<string, unknown> }> = []
    ports.pluginAction = async (input) => {
      calls.push(input)
      return { ok: true, summary: '已加入待办' }
    }
    const result = await executeAction(
      {
        kind: 'plugin-action',
        params: { pluginId: 'com.example.todo', action: 'add', params: '{"text":"买牛奶"}' },
      },
      ports,
    )
    expect(result).toEqual({ ok: true, summary: '已加入待办' })
    expect(calls).toEqual([
      { pluginId: 'com.example.todo', action: 'add', params: { text: '买牛奶' } },
    ])
  })

  it('参数缺省按空对象转发；已是对象的参数原样转发', async () => {
    const { ports } = openPorts()
    const calls: Array<Record<string, unknown>> = []
    ports.pluginAction = async (input) => {
      calls.push(input.params)
      return { ok: true }
    }
    await executeAction(
      { kind: 'plugin-action', params: { pluginId: 'com.example.todo', action: 'add' } },
      ports,
    )
    await executeAction(
      {
        kind: 'plugin-action',
        params: { pluginId: 'com.example.todo', action: 'add', params: { text: '直接对象' } },
      },
      ports,
    )
    expect(calls).toEqual([{}, { text: '直接对象' }])
  })

  it('缺端口 / 缺字段 / 非法 JSON / 端口失败都回落失败回执（不抛错）', async () => {
    const { ports } = openPorts()
    const missing = await executeAction(
      { kind: 'plugin-action', params: { pluginId: 'com.example.todo', action: 'add' } },
      ports,
    )
    expect(missing.ok).toBe(false)

    ports.pluginAction = async () => ({ ok: false, error: '插件已停用' })
    for (const params of [
      { action: 'add' },
      { pluginId: 'com.example.todo' },
      { pluginId: 'com.example.todo', action: 'add', params: '{oops' },
      { pluginId: 'com.example.todo', action: 'add', params: '[]' },
    ]) {
      const result = await executeAction({ kind: 'plugin-action', params }, ports)
      expect(result.ok).toBe(false)
    }

    const failed = await executeAction(
      { kind: 'plugin-action', params: { pluginId: 'com.example.todo', action: 'add' } },
      ports,
    )
    expect(failed.ok).toBe(false)
    expect(failed.error).toContain('插件已停用')

    ports.pluginAction = async () => {
      throw new Error('进程已退出')
    }
    const thrown = await executeAction(
      { kind: 'plugin-action', params: { pluginId: 'com.example.todo', action: 'add' } },
      ports,
    )
    expect(thrown.ok).toBe(false)
    expect(thrown.error).toContain('进程已退出')
  })
})

describe('executeAction · open-app', () => {
  it('路径经 openPath 打开（与打开文件夹同一通道，不经 shell）', async () => {
    const { ports, openedPaths } = openPorts()
    const result = await executeAction(
      { kind: 'open-app', params: { path: 'C:\\Program Files\\App\\app.exe' } },
      ports,
    )
    expect(result.ok).toBe(true)
    expect(openedPaths).toEqual(['C:\\Program Files\\App\\app.exe'])
  })

  it('路径缺省 / 空白拒绝', async () => {
    const { ports, openedPaths } = openPorts()
    for (const params of [{}, { path: '' }, { path: '  ' }]) {
      const result = await executeAction({ kind: 'open-app', params }, ports)
      expect(result.ok).toBe(false)
    }
    expect(openedPaths).toEqual([])
  })

  it('端口抛错转成失败回执（不向外抛）', async () => {
    const { ports } = openPorts({ openPathError: '文件不存在' })
    const result = await executeAction(
      { kind: 'open-app', params: { path: 'C:\\missing.exe' } },
      ports,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('文件不存在')
  })
})
