/**
 * 浏览器端口策略（v35，docs/06 §27）：URL 归一 / 协议拒绝 / 内网开关 / 总开关 / 错误透传。
 * 不 import electron —— driver 是注入的假实现。
 */
import { describe, expect, it, vi } from 'vitest'
import { createMemoryLogger } from '@aurora/shared'
import {
  createBrowserAgentPort,
  hostnameOf,
  isPrivateHostname,
  normalizeBrowserUrl,
  type BrowserAgentDriver,
  type BrowserPortSettings,
} from './browser-port.js'
import type { BrowserSnapshot, BrowserScreenshotResult } from '@aurora/agent-core'

const SNAPSHOT: BrowserSnapshot = {
  url: 'https://example.com/',
  title: 'Example',
  readyState: 'complete',
  elements: [],
  text: '',
  truncated: false,
}

function fakeDriver(overrides: Partial<BrowserAgentDriver> = {}): BrowserAgentDriver {
  return {
    open: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => SNAPSHOT),
    act: vi.fn(async () => ({ summary: '已点击 [e1]', url: SNAPSHOT.url, title: SNAPSHOT.title })),
    read: vi.fn(async () => ({})),
    wait: vi.fn(async () => ({
      matched: true,
      detail: 'ok',
      url: SNAPSHOT.url,
      title: SNAPSHOT.title,
    })),
    screenshot: vi.fn(async (): Promise<BrowserScreenshotResult> => ({
      path: '/tmp/a.png',
      image: {
        path: '/tmp/a.png',
        image: { mimeType: 'image/png', dataBase64: '', name: 'a.png' },
      },
      width: 1,
      height: 1,
      bytes: 1,
      fullPage: false,
    })),
    evaluate: vi.fn(async () => ({ value: '1', truncated: false })),
    stop: vi.fn(() => true),
    ...overrides,
  }
}

function makePort(
  driver: BrowserAgentDriver = fakeDriver(),
  settings: BrowserPortSettings = { enabled: true, allowPrivateNetwork: true },
) {
  return createBrowserAgentPort({
    driver,
    settings: () => settings,
    logger: createMemoryLogger(),
  })
}

describe('normalizeBrowserUrl', () => {
  it('带协议的 http/https 原样保留（trailing slash 由 URL 归一）', () => {
    expect(normalizeBrowserUrl('https://a.dev/x?q=1')).toEqual({
      ok: true,
      url: 'https://a.dev/x?q=1',
    })
    expect(normalizeBrowserUrl('http://a.dev')).toEqual({ ok: true, url: 'http://a.dev/' })
  })

  it('无协议：本机地址补 http，其余补 https', () => {
    expect(normalizeBrowserUrl('localhost:3000/app')).toEqual({
      ok: true,
      url: 'http://localhost:3000/app',
    })
    expect(normalizeBrowserUrl('127.0.0.1:5173')).toEqual({
      ok: true,
      url: 'http://127.0.0.1:5173/',
    })
    expect(normalizeBrowserUrl('example.com/a')).toEqual({ ok: true, url: 'https://example.com/a' })
  })

  it('拒绝非 http(s) 协议与空串', () => {
    for (const raw of [
      '',
      '   ',
      'file:///C:/a.html',
      'javascript:alert(1)',
      'data:text/html,hi',
    ]) {
      const result = normalizeBrowserUrl(raw)
      expect(result.ok).toBe(false)
    }
    expect(normalizeBrowserUrl('file:///C:/a.html')).toMatchObject({ ok: false })
    const rejected = normalizeBrowserUrl('file:///C:/a.html')
    expect(rejected.ok === false ? rejected.error : '').toContain('只支持 http / https')
  })
})

describe('isPrivateHostname', () => {
  it('覆盖 localhost / .local / IPv4 私网 / IPv6 本地', () => {
    for (const host of [
      'localhost',
      'app.localhost',
      'printer.local',
      'nas.internal',
      '0.0.0.0',
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.10',
      '169.254.1.1',
      '100.64.0.1',
      '::1',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
    ]) {
      expect(isPrivateHostname(host), host).toBe(true)
    }
  })

  it('公网域名与公网 IP 不算内网', () => {
    for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:4860::8888']) {
      expect(isPrivateHostname(host), host).toBe(false)
    }
  })

  it('hostnameOf 去掉 IPv6 方括号并小写', () => {
    expect(hostnameOf('http://[::1]:3000/')).toBe('::1')
    expect(hostnameOf('https://Example.COM/x')).toBe('example.com')
    expect(hostnameOf('not a url')).toBe('')
  })
})

describe('createBrowserAgentPort', () => {
  it('总开关关闭时读取类方法都明确报错；close 仍可收尾（幂等清理）', async () => {
    const port = makePort(fakeDriver(), { enabled: false, allowPrivateNetwork: true })
    await expect(port.open({ sessionId: 's', url: 'https://a.dev' })).rejects.toThrow(
      '内置浏览器已被用户关闭',
    )
    await expect(port.snapshot({ sessionId: 's' })).rejects.toThrow('内置浏览器已被用户关闭')
    await expect(port.close({ sessionId: 's' })).resolves.toEqual({ closed: true })
  })

  it('open 归一 URL 后交给 driver，并用快照回填真实地址/标题', async () => {
    const driver = fakeDriver({ snapshot: vi.fn(async () => SNAPSHOT) })
    const port = makePort(driver)
    const result = await port.open({ sessionId: 's', url: 'example.com' })
    expect(driver.open).toHaveBeenCalledWith('s', 'https://example.com/', '')
    expect(result).toMatchObject({ url: SNAPSHOT.url, title: 'Example', snapshot: SNAPSHOT })
  })

  it('allowPrivateNetwork=false 时拒绝本机/内网，但公网放行', async () => {
    const driver = fakeDriver()
    const port = makePort(driver, { enabled: true, allowPrivateNetwork: false })
    await expect(port.open({ sessionId: 's', url: 'localhost:3000' })).rejects.toThrow(
      '不允许访问本机 / 内网地址',
    )
    await expect(port.open({ sessionId: 's', url: 'http://192.168.0.2' })).rejects.toThrow(
      '不允许访问本机 / 内网地址',
    )
    expect(driver.open).not.toHaveBeenCalled()
    await expect(port.open({ sessionId: 's', url: 'example.com' })).resolves.toBeDefined()
  })

  it('act / read / wait / screenshot / evaluate 原样委托并带上 sessionId', async () => {
    const driver = fakeDriver()
    const port = makePort(driver)
    await port.act({ sessionId: 's', action: 'click', ref: 'e1' })
    expect(driver.act).toHaveBeenCalledWith('s', 'click', { ref: 'e1' })
    await port.read({ sessionId: 's', what: 'network' })
    expect(driver.read).toHaveBeenCalledWith('s', 'network')
    await port.wait({ sessionId: 's', for: 'load', timeoutMs: 5000 })
    expect(driver.wait).toHaveBeenCalledWith('s', { for: 'load', timeoutMs: 5000 })
    await port.screenshot({ sessionId: 's', fullPage: true })
    expect(driver.screenshot).toHaveBeenCalledWith('s', true)
    await port.evaluate({ sessionId: 's', expression: '1+1' })
    expect(driver.evaluate).toHaveBeenCalledWith('s', '1+1')
  })

  it('close 调 driver.stop 并把 closed 透出（关标签保留页面的语义在 manager）', async () => {
    const driver = fakeDriver()
    const port = makePort(driver)
    expect(await port.close({ sessionId: 's' })).toEqual({ closed: true })
    expect(driver.stop).toHaveBeenCalledWith('s', '已通过 browser_close 结束')
  })

  it('并发上限错误由 driver 抛出，端口不改写（可执行建议原样给模型）', async () => {
    const driver = fakeDriver({
      open: vi.fn(async () => {
        throw new Error('内置浏览器会话已达上限（2 个），先调用 browser_close 结束一个')
      }),
    })
    const port = makePort(driver)
    await expect(port.open({ sessionId: 's', url: 'example.com' })).rejects.toThrow(
      '先调用 browser_close',
    )
  })
})
