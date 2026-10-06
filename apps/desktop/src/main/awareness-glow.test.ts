import { describe, expect, it } from 'vitest'
import { awarenessGlowBounds, shouldShowAwarenessGlow } from './awareness-glow.js'

function visible(overrides: Partial<Parameters<typeof shouldShowAwarenessGlow>[0]> = {}) {
  return shouldShowAwarenessGlow({
    edgeBarEnabled: true,
    edgeBarVisible: true,
    needsOnboarding: false,
    edgeBarQuiet: false,
    systemQuiet: false,
    awarenessEnabled: true,
    consentAccepted: true,
    knowledgeDirAvailable: true,
    stage: 'analyzing',
    ...overrides,
  })
}

describe('awareness-glow', () => {
  it('只在提示条可见且实际处理文件时显示', () => {
    expect(visible()).toBe(true)
    expect(visible({ stage: 'extracting' })).toBe(true)
    expect(visible({ stage: 'writing' })).toBe(true)
    expect(visible({ stage: 'queued' })).toBe(false)
    expect(visible({ stage: undefined })).toBe(false)
    expect(visible({ edgeBarVisible: false })).toBe(false)
    expect(visible({ edgeBarEnabled: false })).toBe(false)
    expect(visible({ needsOnboarding: true })).toBe(false)
    expect(visible({ edgeBarQuiet: true })).toBe(false)
    expect(visible({ systemQuiet: true })).toBe(false)
    expect(visible({ consentAccepted: false })).toBe(false)
    expect(visible({ knowledgeDirAvailable: false })).toBe(false)
  })

  it('顶部几何跟随目标显示器并夹取高度', () => {
    expect(awarenessGlowBounds({ x: 1920, y: 40, width: 2560, height: 1400 })).toEqual({
      x: 1920,
      y: 40,
      width: 2560,
      height: 72,
    })
    expect(awarenessGlowBounds({ x: -1280, y: 0, width: 1280, height: 48 })).toEqual({
      x: -1280,
      y: 0,
      width: 1280,
      height: 48,
    })
  })
})
