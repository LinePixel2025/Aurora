/*
 * 右栏标签容器的纯逻辑（2026-10-03 二次修订，docs/07 §2.3）。
 *
 * 右栏是「浏览器式多标签」：一个标签 = 一个面板实例。这里只放**不依赖 Vue / DOM** 的
 * 记账与几何计算（新 id、关闭后的激活回落、可见数量、滑动窗口），组件与 App.vue 只做接线，
 * 单测覆盖同一份判据（`ctxTabsCore.test.ts`）。
 *
 * 三个关键口径：
 * - **首个实例沿用种类名做 id**（`context` / `files` / `terminal` / `browser`）：
 *   `data-field="chat.ctx-tab-<id>"` 因此与旧的四个固定 tab **逐字一致**，旧探针零改动；
 *   追加实例是 `files-2` / `browser-2`…。
 * - **「上下文」是单例**：任务面板 + 模式感知栏收在它里面，重复开只会激活已有的那个。
 * - **溢出 = 固定数量 + 「＋N」菜单**（用户口径）：标签不缩窄（固定 CTX_TAB_WIDTH），
 *   可见数量由标签条实测宽度算出；激活标签永远落在可见区（滑动窗口，浏览器同款）。
 */

/** 右栏标签种类（同时也是「首个实例」的 id） */
export type CtxTabKind = 'context' | 'files' | 'terminal' | 'browser'

export interface CtxTab {
  id: string
  kind: CtxTabKind
  title: string
}

/** 开新标签菜单的条目顺序（也是标签默认顺序） */
export const CTX_TAB_KINDS: readonly CtxTabKind[] = ['context', 'files', 'terminal', 'browser']

/** 面板上报标题之前的默认展示名（面板上报空串时回落到它） */
export const CTX_TAB_DEFAULT_TITLE: Record<CtxTabKind, string> = {
  context: '上下文',
  files: '文件',
  terminal: '终端',
  browser: '浏览器',
}

/**
 * 初始标签集：**每种一个**（锚点 `chat.ctx-tab-<kind>` 与旧探针逐字一致），
 * **缺省激活「上下文」**（旧探针读的 DOM 就是它）。顺序把上下文放最左：
 * 384px 默认宽下可见 2 个，激活项因此天然在可见区里。
 */
export const CTX_TABS_DEFAULT: readonly CtxTab[] = [
  { id: 'context', kind: 'context', title: CTX_TAB_DEFAULT_TITLE.context },
  { id: 'files', kind: 'files', title: CTX_TAB_DEFAULT_TITLE.files },
  { id: 'terminal', kind: 'terminal', title: CTX_TAB_DEFAULT_TITLE.terminal },
  { id: 'browser', kind: 'browser', title: CTX_TAB_DEFAULT_TITLE.browser },
]

/** 标签总数上限：再往上开只会把溢出菜单撑爆，没有使用价值 */
export const CTX_TABS_MAX = 12

/** 单个标签的宽度（px，**固定不缩窄** —— 用户点名的口径）。88px 是「图标 + 约 4–6 字标题 +
 *  关闭钮」在当前字体下的下限；再窄标题就只剩省略号了。可见数量因此是它在宽度里能塞几个。 */
export const CTX_TAB_WIDTH = 88

/** 标签条自身的间距（与 CSS 的 `gap: 1px` 对齐）：两枚按钮与相邻标签之间也要算一档 */
export const CTX_TAB_GAP = 1

/** 「＋N」「＋」两枚按钮的固定占宽（30 + 26，与 CSS 的宽度对齐） */
export const CTX_TAB_BUTTONS_WIDTH = 56

/** 标签宽度的上限：空间有富余时标签可以变宽（浏览器同款），但不至于宽得没边 */
export const CTX_TAB_WIDTH_MAX = 160

/** 下一个可用 id：首个实例 = 种类名，追加实例 = `<kind>-2` / `<kind>-3`…（关闭后可复用编号） */
export function nextCtxTabId(kind: CtxTabKind, tabs: readonly CtxTab[]): string {
  if (!tabs.some((tab) => tab.id === kind)) return kind
  let ordinal = 2
  while (tabs.some((tab) => tab.id === `${kind}-${ordinal}`)) ordinal += 1
  return `${kind}-${ordinal}`
}

export interface CtxTabOpenResult {
  tabs: CtxTab[]
  /** 新建的、或「上下文」单例已存在时命中的那一个 */
  tab: CtxTab
  /** false = 单例已存在，只是要切过去（没有新建） */
  created: boolean
}

/**
 * 开一个标签：普通种类新建（到 CTX_TABS_MAX 返回 null，由调用方给提示）；
 * 「上下文」单例已存在时**不新建**，返回 `created: false` + 已有的那个（调用方切过去即可）。
 * 上下文单例**不受上限约束**：左栏「任务」入口随时要能把它叫出来，不能因为标签开满而失联。
 */
export function openCtxTab(tabs: readonly CtxTab[], kind: CtxTabKind): CtxTabOpenResult | null {
  if (kind === 'context') {
    const existing = tabs.find((tab) => tab.kind === 'context')
    if (existing !== undefined) return { tabs: [...tabs], tab: existing, created: false }
  } else if (tabs.length >= CTX_TABS_MAX) {
    return null
  }

  const tab: CtxTab = {
    id: nextCtxTabId(kind, tabs),
    kind,
    title: CTX_TAB_DEFAULT_TITLE[kind],
  }
  return { tabs: [...tabs, tab], tab, created: true }
}

export interface CtxTabCloseResult {
  tabs: CtxTab[]
  /** 关闭后的激活 id（全关完时是空串）；关的不是激活标签则原样返回 */
  activeId: string
}

/**
 * 关一个标签：关的是**激活**标签时按浏览器口径回落 —— 优先右邻（原索引位置的新住户），
 * 没有右邻取左邻；关非激活标签不动激活项。id 不存在时原样返回（幂等）。
 */
export function closeCtxTab(
  tabs: readonly CtxTab[],
  activeId: string,
  id: string,
): CtxTabCloseResult {
  const index = tabs.findIndex((tab) => tab.id === id)
  if (index === -1) return { tabs: [...tabs], activeId }

  const next = tabs.filter((tab) => tab.id !== id)
  if (id !== activeId) return { tabs: next, activeId }
  if (next.length === 0) return { tabs: next, activeId: '' }

  const neighbor = next[Math.min(index, next.length - 1)]
  return { tabs: next, activeId: neighbor === undefined ? '' : neighbor.id }
}

/**
 * 更新标题（面板上报）：标题没变（含空串回落成默认名后没变）时**返回原数组** ——
 * 面板 watcher 可能频繁触发，每次 map 出新数组会让标签条白重渲染一轮。
 */
export function withCtxTabTitle(
  tabs: readonly CtxTab[],
  id: string,
  title: string,
): readonly CtxTab[] {
  const trimmed = title.trim()
  const index = tabs.findIndex((tab) => tab.id === id)
  if (index === -1) return tabs
  const current = tabs[index]
  if (current === undefined) return tabs
  const next = trimmed === '' ? CTX_TAB_DEFAULT_TITLE[current.kind] : trimmed
  if (current.title === next) return tabs
  return tabs.map((tab) => (tab.id === id ? { ...tab, title: next } : tab))
}

/**
 * 标签条能同时显示几个标签（**固定宽度不缩窄**：塞不下就进「＋N」菜单）。
 * 宽度读的是标签条自身的实测内容宽（不含 caption 让位与内边距），因此窗口 / 右栏拖宽后
 * 容量自动跟着变。判据是「N 个标签 + 两枚按钮 + 它们之间的间距都放得下」。
 */
export function ctxTabCapacity(listWidth: number): number {
  if (!Number.isFinite(listWidth) || listWidth <= 0) return 1
  const usable = listWidth - CTX_TAB_BUTTONS_WIDTH - CTX_TAB_GAP
  return Math.max(1, Math.floor(usable / (CTX_TAB_WIDTH + CTX_TAB_GAP)))
}

export interface CtxTabWindow {
  /** 可见区的起点（被折叠的标签可能在它左边） */
  start: number
  /** 可见区的终点（不含） */
  end: number
}

/**
 * 单个标签的**实际宽度**：最小 CTX_TAB_WIDTH（绝不缩窄 —— 用户口径），空间有富余时
 * 长到 CTX_TAB_WIDTH_MAX 为止（浏览器同款：标签少/栏宽时标题多露几个字）。
 * 容量按最小宽度算（`ctxTabCapacity`），所以算出来的宽度永远不会把标签挤出可视区。
 */
export function ctxTabWidth(listWidth: number, visibleCount: number): number {
  if (visibleCount <= 0) return CTX_TAB_WIDTH
  // 间距共 visibleCount + 1 档：标签之间 visibleCount − 1，加上「最后一个标签 → ＋N」与
  // 「＋N → ＋」两档（＋N 不在场时那一档空着，宁可留着也不把标签顶出可视区）
  const usable = listWidth - CTX_TAB_BUTTONS_WIDTH - (visibleCount + 1) * CTX_TAB_GAP
  if (!Number.isFinite(usable) || usable <= 0) return CTX_TAB_WIDTH
  return Math.max(CTX_TAB_WIDTH, Math.min(CTX_TAB_WIDTH_MAX, Math.floor(usable / visibleCount)))
}

/**
 * 滑动窗口：容量装不下全部标签时，窗口滑到**激活标签可见**的位置（浏览器同款）——
 * 从「＋N」菜单激活一个被折叠的标签时，标签条会把它带回可见区，否则用户会看着别的标签、
 * 内容却是另一个的。
 */
export function ctxTabWindow(count: number, activeIndex: number, capacity: number): CtxTabWindow {
  if (count <= 0) return { start: 0, end: 0 }
  const cap = Math.max(1, Math.min(capacity, count))
  if (count <= cap) return { start: 0, end: count }
  const active = Math.max(0, Math.min(activeIndex, count - 1))
  const start = Math.max(0, Math.min(active - cap + 1, count - cap))
  return { start, end: start + cap }
}
