import { describe, expect, it } from 'vitest'
import {
  nativeHandleToNumber,
  resolveWidgetWindowLevel,
  shouldUseWidgetMaterial,
  widgetRoundedShape,
  WIDGET_CARD_RADIUS,
  type Rect,
} from './widget-window.js'

/** 断言每一块都在卡片矩形内（shape 区域越界会露出材质 / 吃掉点击）。 */
function expectInsideBounds(card: Rect, shape: Rect[]): void {
  for (const block of shape) {
    expect(block.width).toBeGreaterThan(0)
    expect(block.height).toBeGreaterThan(0)
    expect(block.x).toBeGreaterThanOrEqual(card.x)
    expect(block.y).toBeGreaterThanOrEqual(card.y)
    expect(block.x + block.width).toBeLessThanOrEqual(card.x + card.width)
    expect(block.y + block.height).toBeLessThanOrEqual(card.y + card.height)
  }
}

/**
 * 断言阶梯块**无重叠、无缝隙地铺满**卡片高度，且每一行左右内缩对称。
 * （圆角外的四个三角本来就不属于区域，所以不能用「面积等于卡片」当判据。）
 */
function expectVerticalTiling(card: Rect, shape: Rect[]): void {
  const sorted = [...shape].sort((left, right) => left.y - right.y)
  let nextY = card.y
  for (const block of sorted) {
    expect(block.y).toBe(nextY)
    const leftInset = block.x - card.x
    const rightInset = card.x + card.width - (block.x + block.width)
    expect(leftInset).toBe(rightInset)
    nextY += block.height
  }
  expect(nextY).toBe(card.y + card.height)
}

describe('桌面小组件层级解析', () => {
  it('用户覆盖优先于清单声明', () => {
    expect(resolveWidgetWindowLevel('floating', 'desktop')).toBe('desktop')
    expect(resolveWidgetWindowLevel('desktop', 'normal')).toBe('normal')
    expect(resolveWidgetWindowLevel('normal', 'floating')).toBe('floating')
    expect(resolveWidgetWindowLevel('desktop', 'desktop')).toBe('desktop')
  })

  it('没有覆盖时跟随清单声明', () => {
    expect(resolveWidgetWindowLevel('floating', undefined)).toBe('floating')
    expect(resolveWidgetWindowLevel('normal', undefined)).toBe('normal')
    expect(resolveWidgetWindowLevel('desktop', undefined)).toBe('desktop')
  })
})

describe('桌面小组件原生材质判定', () => {
  it('acrylic 需要「声明 + 外观开启 + win32」同时成立', () => {
    expect(shouldUseWidgetMaterial('acrylic', true, 'win32')).toBe(true)
    expect(shouldUseWidgetMaterial('acrylic', false, 'win32')).toBe(false)
    expect(shouldUseWidgetMaterial('acrylic', true, 'darwin')).toBe(false)
    expect(shouldUseWidgetMaterial('acrylic', true, 'linux')).toBe(false)
  })

  it('声明 none 时任何平台 / 开关都不挂材质', () => {
    expect(shouldUseWidgetMaterial('none', true, 'win32')).toBe(false)
    expect(shouldUseWidgetMaterial('none', false, 'win32')).toBe(false)
    expect(shouldUseWidgetMaterial('none', true, 'darwin')).toBe(false)
  })
})

describe('桌面小组件圆角 shape', () => {
  it('卡片圆角与 CSS --radius-lg 同值（20px）', () => {
    expect(WIDGET_CARD_RADIUS).toBe(20)
  })

  it('所有块都在 bounds 内，且阶梯块无重叠无缝隙地铺满卡片高度', () => {
    const card: Rect = { x: 40, y: 60, width: 300, height: 200 }
    const shape = widgetRoundedShape(card, WIDGET_CARD_RADIUS)
    expectInsideBounds(card, shape)
    expectVerticalTiling(card, shape)
  })

  it('四个角都有内缩：顶 / 底第一块窄于卡片且左右对称，中间一块整宽', () => {
    const card: Rect = { x: 0, y: 0, width: 300, height: 200 }
    const shape = widgetRoundedShape(card, WIDGET_CARD_RADIUS)
    const top = shape[0]!
    // 最底下一行（bottom band 最后一块不是最底行，按 y 取最大）
    const bottom = shape.reduce((lowest, block) => (block.y > lowest.y ? block : lowest))
    // 左上 / 右上角同时内缩
    expect(top.y).toBe(0)
    expect(top.x).toBeGreaterThan(card.x)
    expect(top.x + top.width).toBeLessThan(card.x + card.width)
    // 左下 / 右下角同时内缩，且与顶部对称
    expect(bottom.y + bottom.height).toBe(card.height)
    expect(bottom.x).toBe(top.x)
    expect(bottom.width).toBe(top.width)
    expect(bottom.x + bottom.width).toBe(top.x + top.width)
    // 中间整宽一块，高度 = 高 - 2r
    const middle = shape.find((block) => block.y === WIDGET_CARD_RADIUS)
    expect(middle).toEqual({
      x: 0,
      y: WIDGET_CARD_RADIUS,
      width: 300,
      height: 200 - WIDGET_CARD_RADIUS * 2,
    })
  })

  it('连续相同内缩量的行被合并（不是逐行 1px 块）', () => {
    const card: Rect = { x: 0, y: 0, width: 300, height: 200 }
    const shape = widgetRoundedShape(card, WIDGET_CARD_RADIUS)
    // 四角各至多 r 块 + 中间一块；逐行切会是 2r + 中间 + ... 更多
    expect(shape.length).toBeLessThanOrEqual(WIDGET_CARD_RADIUS * 2 + 1)
    const topBlocks = shape.filter((block) => block.y < WIDGET_CARD_RADIUS)
    expect(topBlocks.length).toBeGreaterThan(1)
    // 合并后相邻块的内缩量必须不同（相同就说明没合并干净）
    for (let index = 1; index < topBlocks.length; index += 1) {
      expect(topBlocks[index]!.x).not.toBe(topBlocks[index - 1]!.x)
    }
    // 顶部阶梯高度合计 = r
    expect(topBlocks.reduce((sum, block) => sum + block.height, 0)).toBe(WIDGET_CARD_RADIUS)
    const bottomBlocks = shape.filter((block) => block.y >= card.height - WIDGET_CARD_RADIUS)
    expect(bottomBlocks.reduce((sum, block) => sum + block.height, 0)).toBe(WIDGET_CARD_RADIUS)
  })

  it('各种卡片尺寸都完整覆盖、不越界（含奇数高度与窄卡片）', () => {
    const cards: Rect[] = [
      { x: 0, y: 0, width: 120, height: 80 },
      { x: 10, y: -20, width: 301, height: 201 },
      { x: 5, y: 7, width: 41, height: 41 },
      { x: 0, y: 0, width: 300, height: 40 },
      { x: -100, y: -100, width: 600, height: 900 },
    ]
    for (const card of cards) {
      const shape = widgetRoundedShape(card, WIDGET_CARD_RADIUS)
      expect(shape.length).toBeGreaterThan(0)
      expectInsideBounds(card, shape)
      expectVerticalTiling(card, shape)
    }
  })

  it('半径为 0 / 退化尺寸时原样返回矩形（不切阶梯）', () => {
    const card: Rect = { x: 1, y: 2, width: 30, height: 20 }
    expect(widgetRoundedShape(card, 0)).toEqual([card])
    const empty: Rect = { x: 0, y: 0, width: 0, height: 10 }
    expect(widgetRoundedShape(empty, 20)).toEqual([empty])
  })

  it('半径超过半宽 / 半高时按较小边夹取，仍不越界', () => {
    const card: Rect = { x: 0, y: 0, width: 100, height: 40 }
    const shape = widgetRoundedShape(card, 500)
    expectInsideBounds(card, shape)
    expectVerticalTiling(card, shape)
  })
})

describe('nativeHandleToNumber', () => {
  it('8 字节（64 位进程）按小端解析为 Number', () => {
    const buffer = Buffer.alloc(8)
    buffer.writeBigUInt64LE(0x0000_0001_2345_6789n)
    expect(nativeHandleToNumber(buffer)).toBe(0x123456789)
  })

  it('4 字节（32 位进程）按小端解析', () => {
    const buffer = Buffer.alloc(4)
    buffer.writeUInt32LE(0xdead_beef)
    expect(nativeHandleToNumber(buffer)).toBe(0xdeadbeef)
  })

  it('8 字节里高位为 0 时仍按 64 位解析', () => {
    const buffer = Buffer.alloc(8)
    buffer.writeUInt32LE(42, 0)
    expect(nativeHandleToNumber(buffer)).toBe(42)
  })

  it('长度不足 4 字节返回 undefined（调用方按拿不到句柄降级）', () => {
    expect(nativeHandleToNumber(Buffer.alloc(0))).toBeUndefined()
    expect(nativeHandleToNumber(Buffer.alloc(3))).toBeUndefined()
  })
})
