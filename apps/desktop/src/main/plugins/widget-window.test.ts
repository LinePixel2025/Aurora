import { describe, expect, it } from 'vitest'
import {
  nativeHandleToNumber,
  resolveWidgetWindowLevel,
  resolveWidgetWindowMaterial,
} from './widget-window.js'

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

describe('桌面小组件旧材质字段兼容', () => {
  it('旧清单 none 与 acrylic 都保持可解析，但实际材质恒为 none', () => {
    expect(resolveWidgetWindowMaterial('none')).toBe('none')
    expect(resolveWidgetWindowMaterial('acrylic')).toBe('none')
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
