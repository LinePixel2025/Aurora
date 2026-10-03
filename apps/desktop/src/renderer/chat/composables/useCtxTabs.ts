/*
 * 右栏标签状态（Vue 壳，2026-10-03 二次修订，docs/07 §2.3）。
 *
 * 记账全在 `ctxTabsCore.ts`（纯逻辑、有单测），这里只把它接成响应式，并给出三个调用方
 * 真正需要的动作：开 / 关 / 激活，以及「别越开越多」的复用判定（`ensureKind` /
 * `lastUsedOf` —— 左栏「任务」入口与 `show_preview` 都走它）。
 *
 * 刻意**不落 localStorage**（与左栏 / 右栏宽度记忆不同）：浏览器 / 终端标签的恢复会在启动时
 * 偷偷加载页面、拉起 shell，收益不抵惊扰；标签是窗口级的临时工作集，重启回到初始四标签。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import {
  CTX_TABS_DEFAULT,
  closeCtxTab,
  openCtxTab,
  withCtxTabTitle,
  type CtxTab,
  type CtxTabKind,
} from './ctxTabsCore'

export interface UseCtxTabs {
  tabs: Ref<CtxTab[]>
  activeId: Ref<string>
  activeTab: ComputedRef<CtxTab | undefined>
  /** 激活一个已存在的标签（不存在时什么也不做），返回命中的那个 */
  activate(id: string): CtxTab | null
  /** 开一个新标签并激活（到上限返回 null，调用方给提示） */
  openTab(kind: CtxTabKind): CtxTab | null
  /** 已有就切过去、没有才新建（「任务」入口 / `show_preview` 的复用口径） */
  ensureKind(kind: CtxTabKind): CtxTab | null
  closeTab(id: string): void
  /** 面板上报标题（空串回落种类默认名；没变化时不触发重渲染） */
  setTitle(id: string, title: string): void
  /** 某种类**最近一次激活过**且仍存在的标签：`show_preview` 复用它而不是再开一个 */
  lastUsedOf(kind: CtxTabKind): CtxTab | undefined
}

export function useCtxTabs(): UseCtxTabs {
  const tabs = ref<CtxTab[]>([...CTX_TABS_DEFAULT])
  const activeId = ref<string>(CTX_TABS_DEFAULT[0]?.id ?? '')
  /** 每种标签最近激活的 id（「复用哪个」的口径；标签被关掉时清掉对应项） */
  const lastUsed = ref<Record<string, string>>(
    Object.fromEntries(CTX_TABS_DEFAULT.map((tab) => [tab.kind, tab.id])),
  )

  const activeTab = computed(() => tabs.value.find((tab) => tab.id === activeId.value))

  function activate(id: string): CtxTab | null {
    const tab = tabs.value.find((item) => item.id === id)
    if (tab === undefined) return null
    activeId.value = tab.id
    lastUsed.value = { ...lastUsed.value, [tab.kind]: tab.id }
    return tab
  }

  function openTab(kind: CtxTabKind): CtxTab | null {
    const result = openCtxTab(tabs.value, kind)
    if (result === null) return null
    tabs.value = result.tabs
    return activate(result.tab.id)
  }

  function ensureKind(kind: CtxTabKind): CtxTab | null {
    // 优先「当前激活的就是它」→ 其次「最近用过且还在的」→ 再退到「同类里第一个」→ 最后新建。
    // 顺序即口径：不要因为用户多开了几个浏览器标签，就让 show_preview 又开一个新的。
    const active = activeTab.value
    const candidate =
      active !== undefined && active.kind === kind
        ? active
        : (lastUsedOf(kind) ?? tabs.value.find((tab) => tab.kind === kind))
    if (candidate !== undefined) return activate(candidate.id)
    return openTab(kind)
  }

  function closeTab(id: string): void {
    const result = closeCtxTab(tabs.value, activeId.value, id)
    tabs.value = result.tabs
    activeId.value = result.activeId

    // 把「最近使用」里已经消失的 id 清掉，并把回落后的激活项记回去 ——
    // 否则 show_preview / 任务入口会指着一个不存在的标签去找。
    const kept: Record<string, string> = {}
    for (const [kind, tabId] of Object.entries(lastUsed.value)) {
      if (tabs.value.some((tab) => tab.id === tabId)) kept[kind] = tabId
    }
    const current = tabs.value.find((tab) => tab.id === result.activeId)
    if (current !== undefined) kept[current.kind] = current.id
    lastUsed.value = kept
  }

  function setTitle(id: string, title: string): void {
    const next = withCtxTabTitle(tabs.value, id, title)
    // core 在「标题没变」时返回原数组引用：不白造新数组，标签条就不会白重渲染一轮
    if (next !== tabs.value) tabs.value = [...next]
  }

  function lastUsedOf(kind: CtxTabKind): CtxTab | undefined {
    const id = lastUsed.value[kind]
    if (id === undefined) return undefined
    return tabs.value.find((tab) => tab.id === id)
  }

  return {
    tabs,
    activeId,
    activeTab,
    activate,
    openTab,
    ensureKind,
    closeTab,
    setTitle,
    lastUsedOf,
  }
}
