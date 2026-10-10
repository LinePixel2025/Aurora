/**
 * `theme.css` 两条「玻璃退实色」路径必须同口径（v32）。
 *
 * 一处在系统偏好里（`prefers-reduced-transparency` / `prefers-contrast: more`），
 * 一处在应用内开关里（`:root[data-glass='off']`，由 `appearance.glass = false` 驱动）。
 * 两份令牌是手写的（CSS 没有 mixin），改一处漏另一处就是"关掉毛玻璃后某些面还是半透明"
 * 这种只有在真实窗口里才看得出来的偏差 —— 因此这里把**关系**钉住：
 *
 * 1. 两块的 `:root` 都还在（重命名 / 挪位就红，别让它静默失效）；
 * 2. 应用内开关声明的自定义属性是系统偏好那块的**超集**（它可以多，但不能少）。
 *
 * 只读源码文本，不需要浏览器环境。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync(new URL('./theme.css', import.meta.url), 'utf8')

/** 取出一个块里声明的全部自定义属性名（含 `--x: none` 这类非颜色值） */
function customPropsIn(block: string): Set<string> {
  const names = new Set<string>()
  for (const match of block.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) {
    if (match[1] !== undefined) names.add(match[1])
  }
  return names
}

function blockAfter(anchor: RegExp): string | undefined {
  const found = anchor.exec(CSS)
  return found?.[1]
}

describe('theme.css 的玻璃降级令牌', () => {
  const reduced = blockAfter(/@media \(prefers-reduced-transparency[\s\S]*?:root \{([\s\S]*?)\}/)
  const glassOff = blockAfter(/:root\[data-glass='off'\] \{([\s\S]*?)\}/)

  it('两块都还在（系统偏好降级 / 应用内开关）', () => {
    expect(reduced, '未找到 prefers-reduced-transparency 的 :root 块').toBeTruthy()
    expect(glassOff, "未找到 :root[data-glass='off'] 块").toBeTruthy()
  })

  it('应用内开关的令牌是系统偏好降级的超集', () => {
    const expected = customPropsIn(reduced ?? '')
    const actual = customPropsIn(glassOff ?? '')
    expect(expected.size).toBeGreaterThan(10)
    const missing = [...expected].filter((name) => !actual.has(name))
    expect(missing, '这两块必须同口径：缺的令牌就是「关了毛玻璃还半透明」的面').toEqual([])
  })

  it('关闭毛玻璃时连接口令牌也压成实色（提示条面板走 color-mix）', () => {
    // `--glass-fallback` 被 edge-bar 的圆角面板以 `color-mix(… 94%, transparent)` 消费，
    // 不压它，那条最显眼的浮层就仍是约 90% 半透明。
    expect(glassOff).toContain('--glass-fallback: var(--bg-base)')
  })
})
