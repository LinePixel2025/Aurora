import { describe, expect, it } from 'vitest'
import { zoomActionForInput } from './zoom-shortcuts.js'

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
