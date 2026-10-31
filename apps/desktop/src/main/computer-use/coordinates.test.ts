import { describe, expect, it } from 'vitest'
import {
  buildScreenView,
  displayAtPoint,
  imageSizeToPhysical,
  imageToPhysical,
  physicalToImage,
  viewMatchesDisplay,
  type DisplayGeometry,
} from './coordinates.js'

function display(overrides: Partial<DisplayGeometry> = {}): DisplayGeometry {
  return {
    id: 1,
    bounds: { x: 0, y: 0, width: 1600, height: 900 },
    physicalOrigin: { x: 0, y: 0 },
    physicalSize: { width: 3200, height: 1800 },
    scaleFactor: 2,
    ...overrides,
  }
}

describe('Computer Use 坐标换算', () => {
  it('图片像素 → 物理像素（含缩放与原点）', () => {
    const view = buildScreenView({
      display: display(),
      imageWidth: 1600,
      imageHeight: 900,
    })
    expect(imageToPhysical(view, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 })
    expect(imageToPhysical(view, { x: 800, y: 450 })).toEqual({ x: 1600, y: 900 })
    expect(physicalToImage(view, { x: 1600, y: 900 })).toEqual({ x: 800, y: 450 })
  })

  it('负原点（左侧副屏）与窗口裁剪矩形', () => {
    const view = buildScreenView({
      display: display({
        id: 2,
        physicalOrigin: { x: -1920, y: 0 },
        physicalSize: { width: 1920, height: 1080 },
      }),
      imageWidth: 960,
      imageHeight: 540,
      physicalRect: { x: -1820, y: 100, width: 960, height: 540 },
    })
    expect(imageToPhysical(view, { x: 0, y: 0 })).toEqual({ x: -1820, y: 100 })
    expect(imageToPhysical(view, { x: 480, y: 270 })).toEqual({ x: -1820 + 480, y: 100 + 270 })
  })

  it('窗口尺寸换算不加原点', () => {
    const view = buildScreenView({
      display: display(),
      imageWidth: 1600,
      imageHeight: 900,
    })
    expect(imageSizeToPhysical(view, { width: 800, height: 450 })).toEqual({
      width: 1600,
      height: 900,
    })
  })

  it('显示器选择与几何变化判定', () => {
    const primary = display({ id: 1, bounds: { x: 0, y: 0, width: 1600, height: 900 } })
    const left = display({
      id: 2,
      bounds: { x: -1200, y: 0, width: 1200, height: 900 },
      physicalOrigin: { x: -2400, y: 0 },
      physicalSize: { width: 2400, height: 1800 },
    })
    expect(displayAtPoint([primary, left], { x: -10, y: 10 }, 1)?.id).toBe(2)
    expect(displayAtPoint([primary, left], { x: 10, y: 10 }, 1)?.id).toBe(1)
    const view = buildScreenView({ display: primary, imageWidth: 1600, imageHeight: 900 })
    expect(viewMatchesDisplay(view, primary)).toBe(true)
    expect(viewMatchesDisplay(view, { ...primary, physicalOrigin: { x: 1, y: 0 } })).toBe(false)
  })
})
