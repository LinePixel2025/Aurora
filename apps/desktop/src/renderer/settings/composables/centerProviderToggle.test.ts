import { describe, expect, it } from 'vitest'
import { resolveCenterProviderToggle } from './centerProviderToggle.js'

describe('Center Provider 开关状态', () => {
  it('首次开启自动切到官方默认', () => {
    expect(
      resolveCenterProviderToggle({ enabled: false, active: 'local' }, 'center-tts', true, 'local'),
    ).toEqual({ enabled: true, active: 'center-tts' })
  })

  it('关闭且默认仍是官方时回落到第一个本地 Provider', () => {
    expect(
      resolveCenterProviderToggle(
        { enabled: true, active: 'center-tts' },
        'center-tts',
        false,
        'local',
      ),
    ).toEqual({ active: 'local' })
  })

  it('关闭且没有本地 Provider 时清空默认', () => {
    expect(
      resolveCenterProviderToggle({ enabled: true, active: 'center-tts' }, 'center-tts', false, ''),
    ).toEqual({ active: '' })
  })

  it('用户已覆盖到本地时不再改 active', () => {
    expect(
      resolveCenterProviderToggle({ enabled: true, active: 'local' }, 'center-tts', false, 'other'),
    ).toEqual({})
  })

  it('官方已开启时只更换模型，不重新覆盖本地默认', () => {
    expect(
      resolveCenterProviderToggle({ enabled: true, active: 'local' }, 'center-tts', true, 'local'),
    ).toEqual({})
  })
})
