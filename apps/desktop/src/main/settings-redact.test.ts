import { describe, expect, it } from 'vitest'
import { createDefaultSettings, type Settings } from '@aurora/shared'
import { redactSettings } from './settings-redact.js'

describe('redactSettings · center 令牌脱敏（v16，docs/12 §7）', () => {
  it('center.tokenEnc 折成空串，不随 settings:get 进渲染层', () => {
    const settings = createDefaultSettings() as Settings
    settings.center.tokenEnc = 'cipher-leak-if-visible'
    const store = {
      getSecret: () => 'plain-implies-set',
    }
    const redacted = redactSettings(store as never, settings)
    expect(JSON.stringify(redacted)).not.toContain('cipher-leak-if-visible')
    expect(redacted.center.tokenEnc).toBe('')
    // 其它字段原样保留
    expect(redacted.center.enabled).toBe(false)
    expect(redacted.center.serverUrl).toBe('')
  })
})
