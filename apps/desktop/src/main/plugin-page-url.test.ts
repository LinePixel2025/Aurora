import { describe, expect, it } from 'vitest'
import { isPluginPageUrl, pluginPageTargetOf } from './plugin-page-url.js'

describe('pluginPageTargetOf', () => {
  it('拆出插件 id 与相对路径（忽略 query）', () => {
    expect(pluginPageTargetOf('aurora-plugin://com.example.hello/ui/page.html?panel=info')).toEqual(
      { pluginId: 'com.example.hello', path: 'ui/page.html' },
    )
    expect(pluginPageTargetOf('aurora-plugin://com.example.hello/panel.json')).toEqual({
      pluginId: 'com.example.hello',
      path: 'panel.json',
    })
  })

  it('非本协议 / 空 id / 空路径一律拒绝', () => {
    for (const url of [
      'https://example.com/index.html',
      'file:///C:/Windows/System32/calc.exe',
      'aurora-plugin:///ui/page.html',
      'aurora-plugin://com.example.hello',
      'aurora-plugin://com.example.hello/',
      'not a url',
    ]) {
      expect(pluginPageTargetOf(url)).toBeNull()
      expect(isPluginPageUrl(url)).toBe(false)
    }
  })

  it('encoded traversal / 盘符 / 反斜杠 / NUL / 非法编码一律拒绝', () => {
    // WHATWG URL 会把「整段 %2e%2e」按点段归一化 → 等价于根下的 secret.txt（不越界，交给磁盘 404）
    expect(
      pluginPageTargetOf('aurora-plugin://com.example.hello/%2e%2e/%2e%2e/secret.txt'),
    ).toEqual({ pluginId: 'com.example.hello', path: 'secret.txt' })
    for (const url of [
      'aurora-plugin://com.example.hello/..%2F..%2Fsecret.txt',
      'aurora-plugin://com.example.hello/C:%5CWindows%5Cwin.ini',
      'aurora-plugin://com.example.hello/%5C%5Cserver%5Cshare',
      'aurora-plugin://com.example.hello/ui%00.html',
      'aurora-plugin://com.example.hello/%E0%A4%A',
    ]) {
      expect(pluginPageTargetOf(url)).toBeNull()
    }
  })
})
