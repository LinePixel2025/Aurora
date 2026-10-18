/**
 * 兼容 User-Agent（v35，docs/06 §27）：只剥 Electron / Aurora token，保留真实 Chromium 版本。
 */
import { describe, expect, it } from 'vitest'
import { compatUserAgent } from './compatUserAgent.js'

const REAL =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Electron/44.5.1 Safari/537.36 Aurora/0.4.9'

describe('compatUserAgent', () => {
  it('剥掉 Electron / Aurora token，保留 Chromium 版本与平台', () => {
    expect(compatUserAgent(REAL)).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    )
  })

  it('大小写不敏感，并压平多余空白', () => {
    expect(compatUserAgent('Mozilla/5.0 electron/1.0   aurora/2.0 Chrome/1 Safari/2')).toBe(
      'Mozilla/5.0 Chrome/1 Safari/2',
    )
  })

  it('没有宿主 token 时原样返回', () => {
    const clean = 'Mozilla/5.0 (Windows NT 10.0) Chrome/141.0.0.0 Safari/537.36'
    expect(compatUserAgent(clean)).toBe(clean)
  })

  it('空串 / 剥完不像浏览器 UA 时回落原文（不制造空 UA）', () => {
    expect(compatUserAgent('')).toBe('')
    expect(compatUserAgent('Electron/44.5.1 Aurora/0.4.9')).toBe('Electron/44.5.1 Aurora/0.4.9')
  })
})
