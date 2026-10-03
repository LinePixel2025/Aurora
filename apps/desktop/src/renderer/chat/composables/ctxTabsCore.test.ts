/*
 * 右栏标签容器的纯逻辑单测（docs/07 §2.3，2026-10-03 二次修订）。
 *
 * 覆盖四条硬口径：① 首个实例沿用种类名（旧锚点）、② 「上下文」单例、③ 溢出容量与
 * 滑动窗口（激活标签必可见）、④ 关闭后的激活回落（右邻优先、全关完为空）。
 */
import { describe, expect, it } from 'vitest'
import {
  CTX_TABS_DEFAULT,
  CTX_TABS_MAX,
  CTX_TAB_BUTTONS_WIDTH,
  CTX_TAB_GAP,
  CTX_TAB_WIDTH,
  CTX_TAB_WIDTH_MAX,
  CTX_TAB_WIDTH_MIN,
  closeCtxTab,
  ctxTabCapacity,
  ctxTabWidth,
  ctxTabWindow,
  nextCtxTabId,
  openCtxTab,
  withCtxTabTitle,
  type CtxTab,
} from './ctxTabsCore'

function tabsOf(...kinds: Array<CtxTab['kind']>): CtxTab[] {
  return kinds.map((kind) => ({ id: kind, kind, title: kind }))
}

describe('nextCtxTabId', () => {
  it('首个实例沿用种类名（旧锚点 chat.ctx-tab-<kind> 靠它保留）', () => {
    expect(nextCtxTabId('files', [])).toBe('files')
    expect(nextCtxTabId('browser', tabsOf('files'))).toBe('browser')
  })

  it('追加实例走 <kind>-2 / <kind>-3，编号可复用（关了 -2 再开还是 -2）', () => {
    const tabs = tabsOf('files')
    tabs.push({ id: 'files-2', kind: 'files', title: 'a' })
    expect(nextCtxTabId('files', tabs)).toBe('files-3')
    expect(nextCtxTabId('files', tabsOf('files'))).toBe('files-2')
  })
})

describe('openCtxTab', () => {
  it('普通种类新建：默认标题 + created', () => {
    const result = openCtxTab(CTX_TABS_DEFAULT, 'browser')
    expect(result).not.toBeNull()
    expect(result?.created).toBe(true)
    expect(result?.tab.id).toBe('browser-2')
    expect(result?.tab.title).toBe('浏览器')
    expect(result?.tabs).toHaveLength(CTX_TABS_DEFAULT.length + 1)
  })

  it('「上下文」是单例：已存在时不新建，只把已有的那个交回去', () => {
    const result = openCtxTab(CTX_TABS_DEFAULT, 'context')
    expect(result?.created).toBe(false)
    expect(result?.tab.id).toBe('context')
    expect(result?.tabs).toHaveLength(CTX_TABS_DEFAULT.length)
  })

  it('到上限返回 null（调用方据此给提示）', () => {
    const full: CtxTab[] = Array.from({ length: CTX_TABS_MAX }, (_, index) => ({
      id: index === 0 ? 'files' : `files-${index + 1}`,
      kind: 'files' as const,
      title: `f${index}`,
    }))
    expect(openCtxTab(full, 'terminal')).toBeNull()
    // 「上下文」单例不受上限影响（它本来就不新建）
    expect(openCtxTab(full, 'context')?.created).toBe(true)
  })
})

describe('closeCtxTab', () => {
  const tabs = tabsOf('context', 'files', 'terminal', 'browser')

  it('关激活标签 → 右邻顶上来（浏览器口径）', () => {
    expect(closeCtxTab(tabs, 'files', 'files')).toEqual({
      tabs: tabsOf('context', 'terminal', 'browser'),
      activeId: 'terminal',
    })
  })

  it('关最后一个激活标签 → 取左邻', () => {
    expect(closeCtxTab(tabs, 'browser', 'browser').activeId).toBe('terminal')
  })

  it('关非激活标签 → 激活项不动', () => {
    expect(closeCtxTab(tabs, 'context', 'terminal').activeId).toBe('context')
  })

  it('全关完 → 激活 id 为空串；关不存在的 id 幂等', () => {
    expect(closeCtxTab([{ id: 'files', kind: 'files', title: '文件' }], 'files', 'files')).toEqual({
      tabs: [],
      activeId: '',
    })
    expect(closeCtxTab(tabs, 'files', 'nope').activeId).toBe('files')
  })
})

describe('withCtxTabTitle', () => {
  it('写入面板上报的标题；空串 / 全空白回落默认名', () => {
    const updated = withCtxTabTitle(CTX_TABS_DEFAULT, 'files', '  src  ')
    expect(updated.find((tab) => tab.id === 'files')?.title).toBe('src')
    const blank = withCtxTabTitle(CTX_TABS_DEFAULT, 'files', '   ')
    expect(blank.find((tab) => tab.id === 'files')?.title).toBe('文件')
  })

  it('标题没变（或 id 不存在）时返回**原数组**：面板 watcher 频繁触发也不白重渲染', () => {
    expect(withCtxTabTitle(CTX_TABS_DEFAULT, 'files', '文件')).toBe(CTX_TABS_DEFAULT)
    expect(withCtxTabTitle(CTX_TABS_DEFAULT, 'nope', 'x')).toBe(CTX_TABS_DEFAULT)
    const once = withCtxTabTitle(CTX_TABS_DEFAULT, 'files', 'src')
    expect(withCtxTabTitle(once, 'files', 'src')).toBe(once)
  })
})

describe('ctxTabCapacity（固定宽度不缩窄，塞不下就折叠）', () => {
  it('默认 384px 右栏的标签条（384 − 内边距 − caption 132）能放 2 个', () => {
    // 实测内容宽约 236px：floor((236 − 56 − 1) / 89) = 2
    expect(ctxTabCapacity(236)).toBe(2)
  })

  it('拖到 720px 时放得下 5 个；极窄时至少 1 个（不给 0，否则一行标签都没有）', () => {
    expect(ctxTabCapacity(564)).toBe(5)
    expect(ctxTabCapacity(120)).toBe(1)
    expect(ctxTabCapacity(0)).toBe(1)
    expect(ctxTabCapacity(Number.NaN)).toBe(1)
  })

  it('容量 × 标签宽 + 按钮 + 间距不超可用宽（容量与宽度公式自洽）', () => {
    for (const listWidth of [236, 300, 420, 564, 720, 1200]) {
      const capacity = ctxTabCapacity(listWidth)
      const total = capacity * CTX_TAB_WIDTH + CTX_TAB_BUTTONS_WIDTH + (capacity + 1) * CTX_TAB_GAP
      expect(total).toBeLessThanOrEqual(listWidth)
    }
  })
})

describe('ctxTabWidth（先留够按钮，再给标签；88 是舒适宽、不是下限）', () => {
  it('默认宽下 2 个可见标签正好填满（88px × 2 + 两枚按钮 + 间距 ≤ 236）', () => {
    const width = ctxTabWidth(236, 2)
    expect(width).toBe(CTX_TAB_WIDTH)
    expect(width * 2 + CTX_TAB_BUTTONS_WIDTH + 3 * CTX_TAB_GAP).toBeLessThanOrEqual(236)
  })

  it('栏宽 / 标签少时变宽（但不是无限宽）', () => {
    expect(ctxTabWidth(564, 2)).toBe(CTX_TAB_WIDTH_MAX)
    expect(ctxTabWidth(420, 3)).toBeGreaterThan(CTX_TAB_WIDTH)
  })

  it('最窄局面（右栏 280px → 标签条 132px）标签让位到 74px，两枚按钮完整放得下', () => {
    // 用户实测的 bug 现场：88 + 56 + 间距 超过 132 → overflow:hidden 把「＋」裁掉、点不到
    const width = ctxTabWidth(132, 1)
    expect(width).toBe(74)
    expect(width).toBeLessThan(CTX_TAB_WIDTH)
    expect(width).toBeGreaterThanOrEqual(CTX_TAB_WIDTH_MIN)
    expect(width + CTX_TAB_BUTTONS_WIDTH + 2 * CTX_TAB_GAP).toBeLessThanOrEqual(132)
  })

  it('空间小到连 48 都放不下时兜底到 CTX_TAB_WIDTH_MIN（不返回 0 / 负数）', () => {
    expect(ctxTabWidth(60, 1)).toBe(CTX_TAB_WIDTH_MIN)
    expect(ctxTabWidth(0, 3)).toBe(CTX_TAB_WIDTH_MIN)
  })

  it('宽度 × 可见数 + 按钮 + 间距不超过可用宽（含最窄的一批宽度）', () => {
    for (const listWidth of [132, 150, 200, 236, 300, 420, 564, 720]) {
      const visible = Math.min(ctxTabCapacity(listWidth), 6)
      const total =
        ctxTabWidth(listWidth, visible) * visible +
        CTX_TAB_BUTTONS_WIDTH +
        (visible + 1) * CTX_TAB_GAP
      expect(total).toBeLessThanOrEqual(listWidth)
    }
  })
})

describe('ctxTabWindow（滑动窗口：激活标签永远可见）', () => {
  it('装得下就全显示', () => {
    expect(ctxTabWindow(3, 0, 5)).toEqual({ start: 0, end: 3 })
  })

  it('装不下时窗口滑到激活标签处：焦点在尾部 → 显示尾部', () => {
    expect(ctxTabWindow(6, 5, 2)).toEqual({ start: 4, end: 6 })
  })

  it('焦点在头部 → 显示头部；焦点在中间 → 落在窗口内', () => {
    expect(ctxTabWindow(6, 0, 2)).toEqual({ start: 0, end: 2 })
    const middle = ctxTabWindow(6, 3, 2)
    expect(middle).toEqual({ start: 2, end: 4 })
    expect(middle.start).toBeLessThanOrEqual(3)
    expect(middle.end).toBeGreaterThan(3)
  })

  it('越界的 activeIndex / 容量 0 兜底（至少 1 个可见，不越界）', () => {
    expect(ctxTabWindow(4, 99, 2)).toEqual({ start: 2, end: 4 })
    expect(ctxTabWindow(4, -5, 2).start).toBe(0)
    expect(ctxTabWindow(4, 2, 0)).toEqual({ start: 2, end: 3 })
    expect(ctxTabWindow(0, 0, 3)).toEqual({ start: 0, end: 0 })
  })
})
