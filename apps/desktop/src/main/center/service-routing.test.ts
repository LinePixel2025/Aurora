import { describe, expect, it } from 'vitest'
import { resolveCapabilityRoute } from './service-routing.js'

interface TestProvider {
  ready: boolean
}

const ready = (providerId: string, provider: TestProvider): boolean => provider.ready

describe('Center 服务分派', () => {
  it('官方开启且 active 指向 center 时走 Center，并准备本地回落', () => {
    expect(
      resolveCapabilityRoute(
        '语音输入',
        {
          enabled: true,
          active: 'center-stt',
          providers: { 'center-stt': { ready: true }, local: { ready: true } },
        },
        true,
        'center-stt',
        ready,
      ),
    ).toEqual({ mode: 'center', fallbackProviderId: 'local' })
  })

  it('官方仍开启但 active 为本地 Provider 时直接走本地', () => {
    expect(
      resolveCapabilityRoute(
        '生图',
        {
          enabled: true,
          active: 'local',
          providers: { 'center-imagegen': { ready: true }, local: { ready: true } },
        },
        true,
        'center-imagegen',
        ready,
      ),
    ).toEqual({ mode: 'local', providerId: 'local' })
  })

  it('官方关闭但 active 残留 center 时跳过官方并选择本地回落', () => {
    expect(
      resolveCapabilityRoute(
        'TTS',
        {
          enabled: true,
          active: 'center-tts',
          providers: { 'center-tts': { ready: true }, local: { ready: true } },
        },
        false,
        'center-tts',
        ready,
      ),
    ).toEqual({ mode: 'local', providerId: 'local' })
  })

  it('只有 Center 可用时走官方，失败后不伪造本地回落', () => {
    expect(
      resolveCapabilityRoute(
        'TTS',
        {
          enabled: true,
          active: 'center-tts',
          providers: { 'center-tts': { ready: true } },
        },
        true,
        'center-tts',
        ready,
      ),
    ).toEqual({ mode: 'center' })
  })

  it('官方关闭且没有可用本地 Provider 时返回错误', () => {
    expect(
      resolveCapabilityRoute(
        'TTS',
        {
          enabled: true,
          active: 'missing',
          providers: { 'center-tts': { ready: true } },
        },
        false,
        'center-tts',
        ready,
      ),
    ).toEqual({ mode: 'error', message: 'TTS未配置可用的 Provider' })
  })
})
