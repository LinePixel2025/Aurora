/**
 * 图像产物落盘纯逻辑的单测（图像工具，docs/06 §25）。
 *
 * 命名与清理选人都靠「13 位毫秒时间戳打头 ⇒ 字典序 = 时间序」这一个约定，
 * 因此这里既钉排序口径，也钉"配置成 0 不清理"这条防呆分支。
 */
import { describe, expect, it } from 'vitest'
import { imageFileName, selectExpiredFiles } from './image-store.js'

describe('imageFileName', () => {
  it('形如 <13 位时间戳>-<随机段>.png（与生图产物同一形态）', () => {
    const name = imageFileName(1_770_000_000_000, 'abc123')
    expect(name).toBe('1770000000000-abc123.png')
    expect(name).toMatch(/^\d{13}-[0-9a-f]+\.png$/)
  })
})

describe('selectExpiredFiles', () => {
  it('超出 keep 时只挑最旧的那些（按时间戳字典序）', () => {
    const names = [
      '1770000000003-c.png',
      '1770000000001-a.png',
      '1770000000004-d.png',
      '1770000000002-b.png',
    ]
    expect(selectExpiredFiles(names, 2)).toEqual(['1770000000001-a.png', '1770000000002-b.png'])
  })

  it('不超过 keep：一个都不删', () => {
    const names = ['1770000000001-a.png', '1770000000002-b.png', '1770000000003-c.png']
    expect(selectExpiredFiles(names, 3)).toEqual([])
    expect(selectExpiredFiles(names, 50)).toEqual([])
  })

  it('keep <= 0 视为不清理（宁可留着，也不因一个错误配置清空目录）', () => {
    const names = ['1770000000001-a.png', '1770000000002-b.png']
    expect(selectExpiredFiles(names, 0)).toEqual([])
    expect(selectExpiredFiles(names, -1)).toEqual([])
  })

  it('不改动入参数组（调用方可能还要用同一份清单）', () => {
    const names = ['1770000000002-b.png', '1770000000001-a.png']
    selectExpiredFiles(names, 1)
    expect(names).toEqual(['1770000000002-b.png', '1770000000001-a.png'])
  })
})
