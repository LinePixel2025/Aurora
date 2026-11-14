import { describe, expect, it } from 'vitest'
import { nextZoomFactor, zoomActionForInput } from './zoom-shortcuts.js'

describe('zoomActionForInput', () => {
  it('识别 Ctrl 减号缩小', () => {
    expect(zoomActionForInput({ type: 'keyDown', key: '-', code: 'Minus', control: true })).toBe(
      'out',
    )
  })

  it('识别 Ctrl + Shift + =（Windows 上的 Ctrl 加号）放大', () => {
    expect(
      zoomActionForInput({
        type: 'keyDown',
        key: '=',
        code: 'Equal',
        control: true,
        shift: true,
      }),
    ).toBe('in')
  })

  it('识别数字小键盘加减与 Ctrl 0 复位', () => {
    expect(
      zoomActionForInput({ type: 'keyDown', key: '+', code: 'NumpadAdd', control: true }),
    ).toBe('in')
    expect(
      zoomActionForInput({ type: 'keyDown', key: '-', code: 'NumpadSubtract', control: true }),
    ).toBe('out')
    expect(zoomActionForInput({ type: 'keyDown', key: '0', code: 'Digit0', control: true })).toBe(
      'reset',
    )
  })

  it('无 Ctrl / Meta、Alt 组合与 keyUp 都不触发', () => {
    expect(zoomActionForInput({ type: 'keyDown', key: '+', code: 'Equal' })).toBeUndefined()
    expect(
      zoomActionForInput({ type: 'keyDown', key: '+', code: 'Equal', control: true, alt: true }),
    ).toBeUndefined()
    expect(
      zoomActionForInput({ type: 'keyUp', key: '+', code: 'Equal', control: true }),
    ).toBeUndefined()
  })
})

describe('nextZoomFactor（全局统一缩放，docs/07 §1）', () => {
  it('步长 0.1 且 round 防浮点漂移', () => {
    expect(nextZoomFactor(1, 'in')).toBe(1.1)
    expect(nextZoomFactor(1.1, 'in')).toBe(1.2)
    expect(nextZoomFactor(1, 'out')).toBe(0.9)
    expect(nextZoomFactor(0.9, 'out')).toBe(0.8)
  })

  it('clamp 到 0.5–3', () => {
    expect(nextZoomFactor(3, 'in')).toBe(3)
    expect(nextZoomFactor(2.95, 'in')).toBe(3)
    expect(nextZoomFactor(0.5, 'out')).toBe(0.5)
    expect(nextZoomFactor(0.55, 'out')).toBe(0.5)
  })

  it('复位恒 1；脏当前值回落 1 再 stepping', () => {
    expect(nextZoomFactor(2.4, 'reset')).toBe(1)
    expect(nextZoomFactor(Number.NaN, 'in')).toBe(1.1)
  })
})
