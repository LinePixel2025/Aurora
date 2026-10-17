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

  it('关闭毛玻璃时连接口令牌也压成实色（提示条面板走 --edge-bar-tint）', () => {
    // `--edge-bar-tint` 是提示条面板 / 竖条专用的 tint（2026-10-11 起提示条改回原生 Acrylic，
    // 玻璃开时它比其它玻璃面更透，让 DWM 的模糊桌面透出来）。不压它，
    // 「窗口没有原生材质 + 面板半透明」就会裸漏桌面 —— 这是关掉毛玻璃后最显眼的一面。
    expect(glassOff).toContain('--glass-fallback: var(--bg-base)')
    expect(glassOff).toContain('--edge-bar-tint: var(--bg-base)')
    // 两块必须同口径（超集断言只看「有没有」，值对不对靠这里）：系统降级那块也压成实色材质
    expect(reduced).toContain('--edge-bar-tint: var(--glass-fallback)')
  })
})

/**
 * 输入卡浮层的锚点 / 宽度 / 层级是**双端同一份**（2026-10-18，docs/07 §2.3）：
 * 桌面与 Center Web 的五个浮层都要贴在输入卡上方、同宽、走 `--z-flyout`。
 * 这里钉住 `.composer-flyout` 的四条声明，防止某一端又写回自己的数字。
 */
describe('theme.css 的输入卡浮层契约', () => {
  const block = blockAfter(/\.composer-flyout \{([\s\S]*?)\}/) ?? ''

  it('规则存在且用共享令牌定位', () => {
    expect(block, '未找到 .composer-flyout 规则').toBeTruthy()
    expect(block).toContain('bottom: calc(100% + var(--composer-flyout-gap))')
    expect(block).toContain('width: var(--composer-flyout-width)')
    expect(block).toContain('z-index: var(--z-flyout)')
    expect(block).toContain('max-width: 100%')
  })

  it('有高度上限并内部滚动，窗口压到最小时不被裁掉', () => {
    expect(block).toContain('max-height: min(320px, 42dvh)')
    expect(block).toContain('overflow-y: auto')
  })
})

/**
 * 原生 `<select>` 的**弹出列表**由平台主题绘制，`:root` 的 `color-scheme` 管不到它 ——
 * 暗档下会得到「白底 + 继承自控件的弱字色」（用户实测「弹出选项框没有反色」）。
 * `theme.css` 因此显式给 `option` 上主题底色。这里钉住两件事：
 *
 * 1. 规则还在（删掉它 = 暗档弹出列表又变白底灰字，而这种回归只有真机上肉眼看得见）；
 * 2. 规则里**不许**出现 `color` —— 收起态显示的正是选中项文字，给 `option` 设颜色会把
 *    工具行四枚芯片的静息灰字（`--text-muted`）顶成正文色，比原问题更明显。
 */
describe('theme.css 的原生下拉反色', () => {
  const optionBlock = blockAfter(/select option \{([\s\S]*?)\}/) ?? ''
  const checkedBlock = blockAfter(/select option:checked \{([\s\S]*?)\}/) ?? ''
  /** 去掉 `background-color` 再找 `color:`，否则它自己会命中规则名里的 "color" */
  const withoutBackgroundColor = (block: string): string =>
    block.replace(/background-color\s*:/g, '')

  it('给 option 与选中项一层主题底色', () => {
    expect(optionBlock, '未找到 select option 规则').toBeTruthy()
    expect(optionBlock).toContain('background-color: var(--bg-raised)')
    expect(checkedBlock, '未找到 select option:checked 规则').toBeTruthy()
    expect(checkedBlock).toContain('background-color: var(--selection-fill)')
  })

  it('option 规则里不设 color（否则收起态芯片文字会串色）', () => {
    expect(withoutBackgroundColor(optionBlock)).not.toContain('color:')
    expect(withoutBackgroundColor(checkedBlock)).not.toContain('color:')
  })
})
