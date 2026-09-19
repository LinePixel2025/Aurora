/**
 * 代理字符串归一单测（docs/08 §6 `advanced.proxy`）。
 *
 * 这一项曾经是「假开关」：设置页能写、运行时无人消费，用户以为配了代理却没效果。
 * 接线后最容易出错的残余是**输入归一** —— 漏写 scheme 会让 Chromium 把
 * `127.0.0.1:7890` 当成协议名，且失败得毫无提示。
 */
import { describe, expect, it } from 'vitest'
import { parseProxy } from './net-proxy.js'

describe('parseProxy', () => {
  it('空串 / 纯空白 → 直连', () => {
    expect(parseProxy('')).toEqual({ mode: 'direct' })
    expect(parseProxy('   ')).toEqual({ mode: 'direct' })
  })

  it('带 scheme 原样保留', () => {
    expect(parseProxy('http://127.0.0.1:7890')).toEqual({
      mode: 'fixed',
      rules: 'http://127.0.0.1:7890',
    })
    expect(parseProxy('socks5://127.0.0.1:1080')).toEqual({
      mode: 'fixed',
      rules: 'socks5://127.0.0.1:1080',
    })
    expect(parseProxy('HTTPS://proxy.local:8443')).toEqual({
      mode: 'fixed',
      rules: 'HTTPS://proxy.local:8443',
    })
  })

  it('漏写 scheme 时补 http://（用户最常见的写法）', () => {
    expect(parseProxy('127.0.0.1:7890')).toEqual({
      mode: 'fixed',
      rules: 'http://127.0.0.1:7890',
    })
    expect(parseProxy('proxy.local:8080')).toEqual({
      mode: 'fixed',
      rules: 'http://proxy.local:8080',
    })
  })

  it('两端空白被忽略', () => {
    expect(parseProxy('  http://127.0.0.1:7890  ')).toEqual({
      mode: 'fixed',
      rules: 'http://127.0.0.1:7890',
    })
  })

  it('Chromium 分协议规则（http=…;https=…）原样保留，不误补 scheme', () => {
    const rules = 'http=http://127.0.0.1:7890;https=http://127.0.0.1:7890'
    expect(parseProxy(rules)).toEqual({ mode: 'fixed', rules })
  })
})
