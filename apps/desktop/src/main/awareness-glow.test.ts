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
    awarenessGlow: true,
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

  it('用户关掉流光特效后一律不显示（v33 的 appearance.awarenessGlow）', () => {
    expect(visible({ awarenessGlow: false })).toBe(false)
    // 关掉时其它条件怎么变都不显示：它是独立的显隐闸门，不是"仅在与其它项同时成立时生效"
    expect(visible({ awarenessGlow: false, stage: 'extracting' })).toBe(false)
  })

  it('四周流光覆盖目标显示器整块矩形（bounds，不是 workArea）', () => {
    expect(awarenessGlowBounds({ x: 1920, y: 40, width: 2560, height: 1400 })).toEqual({
      x: 1920,
      y: 40,
      width: 2560,
      height: 1400,
    })
    // 负坐标（副屏在主屏左侧）与小显示器都原样保留；非整数按四舍五入
    expect(awarenessGlowBounds({ x: -1280, y: 0, width: 1280, height: 720 })).toEqual({
      x: -1280,
      y: 0,
      width: 1280,
      height: 720,
    })
    expect(awarenessGlowBounds({ x: 1.4, y: -2.6, width: 100.5, height: 200.4 })).toEqual({
      x: 1,
      y: -3,
      width: 101,
      height: 200,
    })
  })
})
