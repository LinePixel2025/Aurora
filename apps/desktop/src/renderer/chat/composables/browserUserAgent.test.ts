import { describe, expect, it } from 'vitest'
import {
  BROWSER_USER_AGENTS,
  browserUserAgentId,
  validateCustomUserAgent,
} from './browserUserAgent.js'

describe('browserUserAgent', () => {
  it('provides common desktop and mobile presets plus a default', () => {
    expect(BROWSER_USER_AGENTS.map(({ id }) => id)).toEqual([
      'chromium',
      'chrome-windows',
      'chrome-mac',
      'chrome-android',
      'safari-mac',
      'safari-ios',
    ])
    expect(BROWSER_USER_AGENTS[0]?.value).toBe('')
  })

  it('identifies presets and custom values', () => {
    expect(browserUserAgentId(BROWSER_USER_AGENTS[1]?.value ?? '', '')).toBe('chrome-windows')
    expect(browserUserAgentId('host compatibility ua', 'host compatibility ua')).toBe('chromium')
    expect(browserUserAgentId('custom ua', '')).toBe('custom')
  })

  it('validates custom values and enforces the size limit', () => {
    expect(validateCustomUserAgent('  Mozilla/5.0 custom  ')).toBeNull()
    expect(validateCustomUserAgent('  ')).toBe('UA 不能为空')
    expect(validateCustomUserAgent('x'.repeat(513))).toBe('UA 最多 512 个字符')
    expect(validateCustomUserAgent('ua\ninvalid')).toBe('UA 不能包含换行')
  })
})
