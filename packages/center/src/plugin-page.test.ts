import { describe, expect, it } from 'vitest'
import {
  PLUGIN_PAGE_HOST_SOURCE,
  PLUGIN_PAGE_SOURCE,
  injectPluginPageBridge,
  pluginPageCsp,
  sanitizeRequestHost,
} from './plugin-page.js'

describe('injectPluginPageBridge', () => {
  it('插到 <head> 开头，先于页面自己的脚本', () => {
    const html = '<!doctype html><html><head><title>x</title></head><body>hi</body></html>'
    const out = injectPluginPageBridge(html)
    const shimAt = out.indexOf('auroraPlugin')
    const titleAt = out.indexOf('<title>')
    expect(shimAt).toBeGreaterThan(-1)
    expect(shimAt).toBeLessThan(titleAt)
    expect(out.indexOf('<head>')).toBeLessThan(shimAt)
  })

  it('没有 head 时退到 <html> 之后；都没有就前置', () => {
    const noHead = '<html lang="zh"><body>x</body></html>'
    const injected = injectPluginPageBridge(noHead)
    expect(injected.startsWith('<html lang="zh"><script>')).toBe(true)

    const bare = '<div>片段</div>'
    expect(injectPluginPageBridge(bare).endsWith(bare)).toBe(true)
    expect(injectPluginPageBridge(bare).startsWith('<script>')).toBe(true)
  })

  it('注入的桥与父页共用同一组 postMessage 标识', () => {
    const out = injectPluginPageBridge('<html><head></head></html>')
    expect(out).toContain(`'${PLUGIN_PAGE_SOURCE}'`)
    expect(out).toContain(`'${PLUGIN_PAGE_HOST_SOURCE}'`)
    expect(out).toContain('window.auroraPlugin')
    expect(out).toContain('request')
    expect(out).toContain('onEvent')
  })
})

describe('sanitizeRequestHost', () => {
  it('保留合法 host:port / IPv6 字面量', () => {
    expect(sanitizeRequestHost('center.example.com')).toBe('center.example.com')
    expect(sanitizeRequestHost('120.24.223.65:8787')).toBe('120.24.223.65:8787')
    expect(sanitizeRequestHost('[::1]:8787')).toBe('[::1]:8787')
  })

  it('空值 / 超长 / 带注入字符一律回落 localhost', () => {
    expect(sanitizeRequestHost(undefined)).toBe('localhost')
    expect(sanitizeRequestHost('   ')).toBe('localhost')
    expect(sanitizeRequestHost('a'.repeat(300))).toBe('localhost')
    expect(sanitizeRequestHost("evil.com'; script-src *")).toBe('localhost')
    expect(sanitizeRequestHost('evil.com/../../x')).toBe('localhost')
  })
})

describe('pluginPageCsp', () => {
  it('关死外联与表单，sandbox 只留 allow-scripts，并放行请求 Host', () => {
    const csp = pluginPageCsp('center.example.com:8787')
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("form-action 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain('sandbox allow-scripts')
    expect(csp).toContain('http://center.example.com:8787')
    expect(csp).toContain('https://center.example.com:8787')
    // opaque origin 下 'self' 不可靠：不能只依赖它
    expect(csp).not.toContain("script-src 'self'")
    // 不允许同源脚本以外的东西开新窗口 / 访问父页
    expect(csp).not.toContain('allow-same-origin')
    expect(csp).not.toContain('allow-popups')
  })
})
