/** `formatTokenCount` / `formatExactCount`：上下文详解条的显示口径（docs/07 §2.3）。 */
import { describe, expect, it } from 'vitest'
import { formatExactCount, formatTokenCount } from './format.js'

describe('formatTokenCount', () => {
  it('千以内取整原样显示', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(1)).toBe('1')
    expect(formatTokenCount(999)).toBe('999')
    expect(formatTokenCount(999.4)).toBe('999')
  })

  it('千位以上用 k，且百位以上不再保留小数（128.0k 读起来比 128k 差）', () => {
    expect(formatTokenCount(1000)).toBe('1.0k')
    expect(formatTokenCount(1234)).toBe('1.2k')
    expect(formatTokenCount(12_345)).toBe('12.3k')
    expect(formatTokenCount(99_999)).toBe('100k')
    expect(formatTokenCount(128_000)).toBe('128k')
    // 千位进位到 M：`999999` 四舍五入到 `1000.0k` 时改走 M 档，不出现「1000k」这种读法
    expect(formatTokenCount(999_999)).toBe('1.00M')
  })

  it('百万以上用 M（两位小数）', () => {
    expect(formatTokenCount(1_000_000)).toBe('1.00M')
    expect(formatTokenCount(1_500_000)).toBe('1.50M')
    expect(formatTokenCount(2_000_000)).toBe('2.00M')
  })

  it('非法输入按 0 处理（宁可显示 0，也不要在界面上出现 NaN）', () => {
    expect(formatTokenCount(Number.NaN)).toBe('0')
    expect(formatTokenCount(Number.POSITIVE_INFINITY)).toBe('0')
    expect(formatTokenCount(-5)).toBe('0')
  })
})

describe('formatExactCount', () => {
  it('带千分位且不缩写：明细里要的是准确数字', () => {
    expect(formatExactCount(0)).toBe('0')
    expect(formatExactCount(1234)).toBe('1,234')
    expect(formatExactCount(128_000)).toBe('128,000')
  })

  it('四舍五入到整数；非有限数按 0', () => {
    expect(formatExactCount(999.6)).toBe('1,000')
    expect(formatExactCount(Number.NaN)).toBe('0')
  })
})
