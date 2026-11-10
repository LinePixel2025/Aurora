import { describe, expect, it } from 'vitest'
import { centeredDialogBounds, resolveDialogSize } from './dialog-window.js'

const area = { x: 100, y: 40, width: 1600, height: 900 }

describe('插件临时对话框窗口几何（docs/14 §5.8）', () => {
  it('未声明尺寸时用默认值', () => {
    expect(resolveDialogSize(undefined, area)).toEqual({ width: 440, height: 320 })
  })

  it('清单尺寸夹到白名单范围', () => {
    expect(resolveDialogSize({ width: 100, height: 900 }, area)).toEqual({
      width: 320,
      height: 800,
    })
    expect(resolveDialogSize({ width: 2000, height: 400 }, area)).toEqual({
      width: 900,
      height: 400,
    })
  })

  it('窗口比工作区大时夹到工作区', () => {
    const small = { x: 0, y: 0, width: 500, height: 300 }
    expect(resolveDialogSize({ width: 900, height: 800 }, small)).toEqual({
      width: 500,
      height: 300,
    })
  })

  it('在工作区内居中（含偏移与取整）', () => {
    expect(centeredDialogBounds({ width: 440, height: 320 }, area)).toEqual({
      x: 680,
      y: 330,
      width: 440,
      height: 320,
    })
  })
})
