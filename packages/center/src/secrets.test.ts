import { describe, expect, it } from 'vitest'
import { createSecretBox, maskApiKey } from './secrets.js'

describe('Center 上游密钥封装', () => {
  it('同一主密钥可往返解密，密文不包含明文', () => {
    const box = createSecretBox('a-very-long-center-master-secret')
    const encrypted = box.encrypt('sk-upstream-secret')
    expect(encrypted).not.toContain('sk-upstream-secret')
    expect(box.decrypt(encrypted)).toBe('sk-upstream-secret')
  })

  it('主密钥缺失时明确不可用；换密钥后旧密文无法解密', () => {
    const missing = createSecretBox('')
    expect(missing.available).toBe(false)
    expect(() => missing.decrypt('v1.a.b.c')).toThrow(/AURORA_CENTER_SECRET/)

    const first = createSecretBox('first-master')
    const encrypted = first.encrypt('secret')
    expect(() => createSecretBox('second-master').decrypt(encrypted)).toThrow()
  })

  it('脱敏只保留极短提示', () => {
    expect(maskApiKey('sk-1234567890')).toBe('sk-***890')
    expect(maskApiKey('short')).toBe('***')
  })
})
