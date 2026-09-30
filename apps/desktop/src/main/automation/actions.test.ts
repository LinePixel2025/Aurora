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
