import { describe, expect, it } from 'vitest'
import {
  buildScreenView,
  displayAtPhysicalPoint,
  displayAtPoint,
  imageSizeToPhysical,
  imageToPhysical,
  physicalToImage,
  planScreenCapture,
  targetBoundsMoved,
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
    // 分辨率 / 缩放变化同样让旧视图失效（旧实现只比 origin，会漏掉这两项）
    expect(
      viewMatchesDisplay(view, { ...primary, physicalSize: { width: 3201, height: 1800 } }),
    ).toBe(false)
    expect(viewMatchesDisplay(view, { ...primary, scaleFactor: 1.5 })).toBe(false)
  })

  it('窗口裁剪视图仍按显示器几何校验（不是按窗口 origin）', () => {
    const primary = display()
    const view = buildScreenView({
      display: primary,
      imageWidth: 800,
      imageHeight: 450,
      physicalRect: { x: 400, y: 300, width: 800, height: 450 },
    })
    expect(view.origin).toEqual({ x: 400, y: 300 })
    expect(viewMatchesDisplay(view, primary)).toBe(true)
    expect(viewMatchesDisplay(view, { ...primary, id: 9 })).toBe(false)
  })

  it('按物理点选屏：混合 DPI 下不再拿物理点去比 DIP bounds', () => {
    const primary = display({
      id: 1,
      bounds: { x: 0, y: 0, width: 1707, height: 1067 },
      physicalOrigin: { x: 0, y: 0 },
      physicalSize: { width: 2560, height: 1600 },
      scaleFactor: 1.5,
    })
    const left = display({
      id: 2,
      bounds: { x: -1280, y: 0, width: 1280, height: 1024 },
      physicalOrigin: { x: -1920, y: 0 },
      physicalSize: { width: 1920, height: 1080 },
      scaleFactor: 1.5,
    })
    expect(displayAtPhysicalPoint([primary, left], { x: -100, y: 10 }, 1)?.id).toBe(2)
    expect(displayAtPhysicalPoint([primary, left], { x: 2000, y: 900 }, 1)?.id).toBe(1)
    // 物理中心落在 DIP bounds 之外也能正确命中原显示器
    expect(displayAtPhysicalPoint([primary, left], { x: 2500, y: 1500 }, 1)?.id).toBe(1)
    expect(displayAtPhysicalPoint([primary], { x: 9999, y: 9999 }, 1)?.id).toBe(1)
  })

  it('目标窗口 bounds 漂移判定（6px 容差）', () => {
    const before = { x: 100, y: 100, width: 800, height: 600 }
    expect(targetBoundsMoved(before, { ...before, x: 103 })).toBe(false)
    expect(targetBoundsMoved(before, { ...before, x: 107 })).toBe(true)
    expect(targetBoundsMoved(before, { ...before, width: 810 })).toBe(true)
    expect(targetBoundsMoved(before, { ...before, y: 108 }, 10)).toBe(false)
  })
})

describe('Computer Use 截图裁剪计划', () => {
  it('1:1 源图：physicalRect 用源图尺寸（修正 Electron 1px 取整差）', () => {
    const plan = planScreenCapture({
      display: display({ physicalSize: { width: 2561, height: 1601 } }),
      sourceWidth: 2560,
      sourceHeight: 1600,
    })
    expect(plan.cropped).toBe(false)
    expect(plan.cropFailed).toBe(false)
    expect(plan.physicalRect).toEqual({ x: 0, y: 0, width: 2560, height: 1600 })
    expect(plan.sourceScaleX).toBe(1)
    expect(plan.sourceScaleY).toBe(1)
  })

  it('被缩放的源图：窗口裁剪按源图像素换算，physicalRect 由实际裁剪反算', () => {
    const plan = planScreenCapture({
      display: display({ physicalSize: { width: 2560, height: 1600 } }),
      sourceWidth: 1707,
      sourceHeight: 1067,
      windowRect: { x: 100, y: 100, width: 600, height: 400 },
    })
    expect(plan.cropped).toBe(true)
    expect(plan.cropFailed).toBe(false)
    // 1707/2560 ≈ 0.66680；100 * 0.66680 ≈ 66.68 → 67
    expect(plan.crop).toEqual({ x: 67, y: 67, width: 400, height: 267 })
    expect(plan.physicalRect.x).toBeCloseTo(67 / (1707 / 2560), 5)
    expect(plan.physicalRect.y).toBeCloseTo(67 / (1067 / 1600), 5)
    expect(plan.physicalRect.width).toBeCloseTo(400 / (1707 / 2560), 5)
    expect(plan.physicalRect.height).toBeCloseTo(267 / (1067 / 1600), 5)
  })

  it('1:1 源图的窗口裁剪：crop 就是窗口物理偏移', () => {
    const plan = planScreenCapture({
      display: display({ physicalSize: { width: 2560, height: 1600 } }),
      sourceWidth: 2560,
      sourceHeight: 1600,
      windowRect: { x: 120, y: 80, width: 640, height: 480 },
    })
    expect(plan.crop).toEqual({ x: 120, y: 80, width: 640, height: 480 })
    expect(plan.physicalRect).toEqual({ x: 120, y: 80, width: 640, height: 480 })
  })

  it('窗口部分越界：裁剪到显示器内，physicalRect 由实际裁剪反算', () => {
    const plan = planScreenCapture({
      display: display({ physicalSize: { width: 1920, height: 1080 } }),
      sourceWidth: 1920,
      sourceHeight: 1080,
      windowRect: { x: -100, y: -50, width: 500, height: 400 },
    })
    expect(plan.crop).toEqual({ x: 0, y: 0, width: 400, height: 350 })
    expect(plan.physicalRect).toEqual({ x: 0, y: 0, width: 400, height: 350 })
  })

  it('窗口完全在屏外 / 源图宽高比异常：不裁剪并标记 cropFailed', () => {
    const offscreen = planScreenCapture({
      display: display({ physicalSize: { width: 1920, height: 1080 } }),
      sourceWidth: 1920,
      sourceHeight: 1080,
      windowRect: { x: 3000, y: 3000, width: 200, height: 200 },
    })
    expect(offscreen.cropped).toBe(false)
    expect(offscreen.cropFailed).toBe(true)
    expect(offscreen.warning).toContain('已截整屏')

    const aspect = planScreenCapture({
      display: display({ physicalSize: { width: 2560, height: 1600 } }),
      sourceWidth: 1000,
      sourceHeight: 1000,
      windowRect: { x: 10, y: 10, width: 200, height: 200 },
    })
    expect(aspect.cropped).toBe(false)
    expect(aspect.cropFailed).toBe(true)
    expect(aspect.warning).toContain('宽高比')
  })

  it('负原点副屏：裁剪偏移相对显示器物理原点', () => {
    const plan = planScreenCapture({
      display: display({
        id: 2,
        physicalOrigin: { x: -1920, y: 0 },
        physicalSize: { width: 1920, height: 1080 },
        scaleFactor: 1,
      }),
      sourceWidth: 1920,
      sourceHeight: 1080,
      windowRect: { x: -1820, y: 100, width: 960, height: 540 },
    })
    expect(plan.crop).toEqual({ x: 100, y: 100, width: 960, height: 540 })
    expect(plan.physicalRect).toEqual({ x: -1820, y: 100, width: 960, height: 540 })
  })

  it('缩略图与显示器尺寸完全一致时不做整屏裁剪', () => {
    const plan = planScreenCapture({
      display: display({ physicalSize: { width: 1280, height: 800 }, scaleFactor: 1 }),
      sourceWidth: 1280,
      sourceHeight: 800,
    })
    expect(plan.cropped).toBe(false)
    expect(plan.physicalRect).toEqual({ x: 0, y: 0, width: 1280, height: 800 })
  })
})
