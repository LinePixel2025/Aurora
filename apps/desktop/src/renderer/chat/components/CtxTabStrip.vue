<script setup lang="ts">
/*
 * 右栏标签条（2026-10-03 二次修订，docs/07 §2.3）：浏览器式多标签的**展示层**。
 *
 * 记账（开 / 关 / 激活后的回落）在 `composables/useCtxTabs.ts` + `ctxTabsCore.ts`；
 * 这里只做三件事：量标签条的实测宽度 → 算可见数量（**固定 88px 不缩窄**，塞不下的折叠）
 * → 渲染「可见标签 + ＋N 菜单 + ＋ 新建菜单」，并把用户动作 emit 上去。
 *
 * 两条硬口径：
 * - **三键让位**：右端永远留 `--caption-w`（132px，见 App.vue 的 `.ctx-tabs` 内边距）；
 *   标签条不横向滚动，`.ctx-tab-list` 带 `overflow: hidden` —— 拖宽过渡的瞬时溢出被**裁掉**，
 *   绝不画到窗口按钮底下；两个菜单都在 48px 顶带**下方**弹出，永不进 caption 矩形。
 * - **折叠标签的锚点必须在 DOM 里**：＋N 菜单的内容用 `v-show` 常驻（不是 `v-if`）——
 *   `chat-right-tabs` / `chat-preview-show` / `chat-file-project` / `chat-terminal` 四个
 *   capture 场景都直接 `querySelector('[data-field="chat.ctx-tab-*"]').click()`，
 *   锚点消失就是静默 FAIL（docs/07 §5.3）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { FileText, Globe, LayoutGrid, Plus, Terminal, X } from '@aurora/shared/browser'
import {
  CTX_TABS_MAX,
  CTX_TAB_KINDS,
  CTX_TAB_DEFAULT_TITLE,
  ctxTabCapacity,
  ctxTabWidth,
  ctxTabWindow,
  type CtxTab,
  type CtxTabKind,
} from '../composables/ctxTabsCore'

const props = defineProps<{
  tabs: CtxTab[]
  activeId: string
}>()

const emit = defineEmits<{
  (event: 'activate', id: string): void
  (event: 'close', id: string): void
  (event: 'new-tab', kind: CtxTabKind): void
}>()

/** 每种标签的图标（与左栏固定项 / 工具卡片同一套 lucide 语言；语义优先，别按外观挑） */
const TAB_ICONS = {
  context: LayoutGrid,
  files: FileText,
  terminal: Terminal,
  browser: Globe,
} as const

/** 新建菜单里的条目文案：上下文是单例，已有就「切过去」而不是再开一个 */
const NEW_TAB_LABEL: Record<CtxTabKind, string> = {
  context: '上下文面板',
  files: '新建文件标签',
  terminal: '新建终端标签',
  browser: '新建浏览器标签',
}

const rootEl = ref<HTMLElement | null>(null)
const listEl = ref<HTMLElement | null>(null)
/** 标签条实测内容宽（不含 caption 让位与内边距）：可见数量 / 标签宽度都由它算 */
const listWidth = ref(0)
let resizeObserver: ResizeObserver | null = null

const capacity = computed(() => ctxTabCapacity(listWidth.value))
const activeIndex = computed(() => props.tabs.findIndex((tab) => tab.id === props.activeId))
/** 滑动窗口：激活标签永远落在可见区（浏览器同款） */
const visibleWindow = computed(() =>
  ctxTabWindow(props.tabs.length, activeIndex.value, capacity.value),
)
const visibleTabs = computed(() =>
  props.tabs.slice(visibleWindow.value.start, visibleWindow.value.end),
)
/** 被折叠的标签（窗口左边也可能有 —— 窗口滑过之后） */
const hiddenTabs = computed(() =>
  props.tabs.filter(
    (_, index) => index < visibleWindow.value.start || index >= visibleWindow.value.end,
  ),
)
/** 标签宽度：最小 88px（不缩窄），空间富余时长到 160px */
const tabWidth = computed(() => ctxTabWidth(listWidth.value, visibleTabs.value.length))
const atLimit = computed(() => props.tabs.length >= CTX_TABS_MAX)

const moreOpen = ref(false)
const newOpen = ref(false)

function closeMenus(): void {
  moreOpen.value = false
  newOpen.value = false
}

/**
 * 两个菜单按钮的互斥开合走**具名方法**而不是内联多语句 ——
 * `@click="moreOpen = !moreOpen; newOpen = false"` 这种多语句内联处理器会被
 * prettier 在格式化 .vue 时拆成多行并**吞掉分号**，模板编译直接报错，而 `tsc` / `vue-tsc`
 * 都看不见（只在 Vite 编译 / 运行时炸）—— 2026-10-03 实测踩过，别再写回去。
 */
function toggleMore(): void {
  moreOpen.value = !moreOpen.value
  newOpen.value = false
}

function toggleNew(): void {
  newOpen.value = !newOpen.value
  moreOpen.value = false
}

/** 从 ＋N 菜单里切标签：先激活再收菜单（同样不写成多语句内联） */
function activateFromMenu(id: string): void {
  emit('activate', id)
  closeMenus()
}

/**
 * 点外面 / Esc 收起菜单。判据取**整条标签条**（`rootEl`）而不是标签列表：
 * 两个菜单是 `.ctx-tabs` 的子节点、不在 `.ctx-tab-list` 里 —— 只判列表的话，
 * 菜单项的 pointerdown 会先把菜单关掉（display:none），紧随其后的 click 就丢了。
 */
function onDocumentPointerDown(event: PointerEvent): void {
  if (!moreOpen.value && !newOpen.value) return
  const target = event.target
  if (target instanceof Node && rootEl.value?.contains(target) === true) return
  closeMenus()
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeMenus()
}

onMounted(() => {
  // 首次读数同步取一次：ResizeObserver 的首帧回调晚于挂载，先按 0 算会闪一帧「只显示 1 个」
  listWidth.value = listEl.value?.clientWidth ?? 0
  if (typeof ResizeObserver === 'function' && listEl.value !== null) {
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry === undefined) return
      listWidth.value = entry.contentRect.width
    })
    observer.observe(listEl.value)
    resizeObserver = observer
  }
  document.addEventListener('pointerdown', onDocumentPointerDown)
  document.addEventListener('keydown', onDocumentKeydown)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  document.removeEventListener('keydown', onDocumentKeydown)
})

/** ＋N 菜单空了（标签被关到不再折叠）就把它收起来，别留一个空壳浮在面板上 */
watch(hiddenTabs, (list) => {
  if (list.length === 0) moreOpen.value = false
})

function pickNewTab(kind: CtxTabKind): void {
  closeMenus()
  emit('new-tab', kind)
}

function titleOf(tab: CtxTab): string {
  return tab.title === '' ? CTX_TAB_DEFAULT_TITLE[tab.kind] : tab.title
}
</script>

<template>
  <div ref="rootEl" class="ctx-tabs" data-field="chat.ctx-tabs">
    <!--
      标签条本体：`overflow: hidden` 是「绝不压三键」的兜底 —— 容量算错的那一帧，
      多出来的标签在这里被裁掉，而不是画到窗口按钮底下。
    -->
    <div
      ref="listEl"
      class="ctx-tab-list"
      data-field="chat.ctx-tab-list"
      role="tablist"
      aria-label="右栏标签"
    >
      <div
        v-for="tab in visibleTabs"
        :key="tab.id"
        class="ctx-tab"
        :class="{ active: tab.id === activeId }"
        role="tab"
        tabindex="0"
        :aria-selected="tab.id === activeId"
        :data-field="`chat.ctx-tab-${tab.id}`"
        :data-tab-kind="tab.kind"
        :data-tab-id="tab.id"
        :title="titleOf(tab)"
        :style="{ width: `${tabWidth}px` }"
        @click="emit('activate', tab.id)"
        @keydown.enter.prevent="emit('activate', tab.id)"
        @keydown.space.prevent="emit('activate', tab.id)"
      >
        <component
          :is="TAB_ICONS[tab.kind]"
          :size="13"
          :stroke-width="1.8"
          class="ctx-tab-icon"
          aria-hidden="true"
        />
        <span class="ctx-tab-title">{{ titleOf(tab) }}</span>
        <button
          type="button"
          class="ctx-tab-close"
          :data-field="`chat.ctx-tab-close-${tab.id}`"
          :aria-label="`关闭 ${titleOf(tab)}`"
          title="关闭标签"
          @click.stop="emit('close', tab.id)"
        >
          <X :size="12" :stroke-width="2" aria-hidden="true" />
        </button>
      </div>
      <!-- 被折叠的标签：固定数量 + 「＋N」菜单（用户口径），不做缩窄 -->
      <button
        v-if="hiddenTabs.length > 0"
        type="button"
        class="ctx-tab-btn ctx-tab-more"
        data-field="chat.ctx-tab-more"
        :aria-expanded="moreOpen"
        :title="`还有 ${hiddenTabs.length} 个被折叠的标签`"
        @click.stop="toggleMore"
      >
        {{ `+${hiddenTabs.length}` }}
      </button>
      <button
        type="button"
        class="ctx-tab-btn ctx-new-tab"
        data-field="chat.ctx-new-tab"
        :aria-expanded="newOpen"
        :disabled="atLimit"
        :title="atLimit ? `标签已达上限（${CTX_TABS_MAX} 个）` : '新建标签'"
        @click.stop="toggleNew"
      >
        <Plus :size="14" :stroke-width="1.8" aria-hidden="true" />
      </button>
    </div>

    <!--
      ＋N 菜单：`v-show` 常驻 DOM（不是 v-if）—— 折叠标签的 `chat.ctx-tab-<id>` 锚点因此
      始终存在，旧场景直接 click 隐藏锚点也能切过去；菜单本身只在 48px 顶带**下方**弹出。
    -->
    <div
      v-show="moreOpen"
      class="ctx-menu ctx-more-menu glass-panel"
      data-field="chat.ctx-more-menu"
    >
      <p class="ctx-menu-caption">被折叠的标签 · {{ hiddenTabs.length }}</p>
      <div
        v-for="tab in hiddenTabs"
        :key="tab.id"
        class="ctx-menu-item"
        :class="{ active: tab.id === activeId }"
        :data-field="`chat.ctx-tab-${tab.id}`"
        :data-tab-kind="tab.kind"
        :data-tab-id="tab.id"
        :title="titleOf(tab)"
        @click="activateFromMenu(tab.id)"
      >
        <component :is="TAB_ICONS[tab.kind]" :size="13" :stroke-width="1.8" aria-hidden="true" />
        <span class="ctx-menu-title">{{ titleOf(tab) }}</span>
        <button
          type="button"
          class="ctx-tab-close"
          :data-field="`chat.ctx-tab-close-${tab.id}`"
          :aria-label="`关闭 ${titleOf(tab)}`"
          title="关闭标签"
          @click.stop="emit('close', tab.id)"
        >
          <X :size="12" :stroke-width="2" aria-hidden="true" />
        </button>
      </div>
    </div>

    <!-- 新建标签菜单（v-show 同理：条目锚点常驻） -->
    <div v-show="newOpen" class="ctx-menu ctx-new-menu glass-panel" data-field="chat.ctx-new-menu">
      <button
        v-for="kind in CTX_TAB_KINDS"
        :key="kind"
        type="button"
        class="ctx-menu-item ctx-menu-action"
        :data-field="`chat.ctx-new-${kind}`"
        @click="pickNewTab(kind)"
      >
        <component :is="TAB_ICONS[kind]" :size="13" :stroke-width="1.8" aria-hidden="true" />
        <span class="ctx-menu-title">{{ NEW_TAB_LABEL[kind] }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
/*
 * 标签条：与主区标题栏**同高**（--head-h），窗口按钮固定在这条带的右端 ——
 * 右端内边距 = caption 三键宽度 + 间距（三键是 fixed 在窗口右上角的，标签不许滑到它们底下）。
 * 不再横向滚动（折叠替代滚动），因此这里没有 `overflow-x`。
 */
.ctx-tabs {
  position: relative;
  display: flex;
  align-items: stretch;
  min-height: var(--head-h, 48px);
  padding: 0 calc(var(--caption-w, 132px) + var(--space-2)) 0 var(--space-2);
  /*
   * 这条横带参与“可见标签数量”的计算：材质类若补出四边框，会挤掉 2px 并把
   * 刚新建的标签推进 +N 菜单。玻璃底色保留，几何按原设计只占一条底边。
   */
  border: 0;
  border-bottom: 1px solid var(--glass-border-soft);
  box-shadow: none;
}

/*
 * 标签条本体：`overflow: hidden` 兜住「容量算错的那一帧」，见模板注释。
 * `gap: 1px` 与 ctxTabsCore 的 CTX_TAB_GAP 对齐（容量与宽度公式都算上了它）。
 */
.ctx-tab-list {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 1px;
  overflow: hidden;
}

/*
 * 单个标签：宽 88–160px（内联 width 由 ctxTabWidth 算），高 28px ——
 * 与输入卡的三枚控件同一条「小控件」手感线。激活态用**填充**而不是下划线：
 * 标签现在可关闭、可多开，圆角块比一条 2px 线更能表达「这是一张卡片」。
 */
.ctx-tab {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  min-width: 0;
  padding: 0 2px 0 8px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: var(--text-xs);
  line-height: 1;
  cursor: pointer;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.ctx-tab:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.ctx-tab.active {
  background: var(--fill-3);
  color: var(--text-primary);
}

.ctx-tab:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 1px var(--focus-ring);
}

.ctx-tab-icon {
  flex: 0 0 auto;
  opacity: 0.85;
}

/* 截断三件套：可压缩 + 单行 + 省略号（标题最长的是网页标题，必然超宽） */
.ctx-tab-title,
.ctx-menu-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/*
 * 关闭钮：**静止态隐形、悬停 / 激活才显形**（与左栏会话行的归档钮同一套语言）。
 * 20×20 的命中区在 28px 高的标签里已经贴着上下边 —— 它是标签内的次级控件，
 * 主命中区是整张标签（88×28）。`focus-visible` 也显形：键盘用户要看得见它。
 */
.ctx-tab-close {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-muted);
  opacity: 0;
  cursor: pointer;
}

.ctx-tab:hover .ctx-tab-close,
.ctx-tab.active .ctx-tab-close,
.ctx-menu-item:hover .ctx-tab-close,
.ctx-tab-close:focus-visible {
  opacity: 1;
}

.ctx-tab-close:hover {
  background: var(--fill-3);
  color: var(--text-primary);
}

/*
 * ＋N / ＋：两枚小方块按钮。宽度**固定**（30 / 26 = ctxTabsCore 的
 * CTX_TAB_BUTTONS_WIDTH）：容量公式按这个预留量算，任何一个变宽都会把标签顶到 caption 区。
 */
.ctx-tab-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 24px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: var(--text-xs);
  line-height: 1;
  cursor: pointer;
}

.ctx-tab-btn:hover:not(:disabled) {
  background: var(--fill-2);
  color: var(--text-primary);
}

.ctx-tab-btn:disabled {
  color: var(--text-muted);
  opacity: 0.55;
  cursor: default;
}

.ctx-tab-more {
  width: 30px;
  padding: 0;
  font-variant-numeric: tabular-nums;
}

.ctx-new-tab {
  width: 26px;
  padding: 0;
}

/*
 * 两个下拉菜单：**向下**弹出（48px 顶带之下），因此永远不进 caption 的三键矩形；
 * 宽度按右栏实际宽度夹取（`--ctx-w` 是 aside 上内联的生效宽度），窄栏下不会溢出被裁。
 */
.ctx-menu {
  position: absolute;
  top: calc(100% + 2px);
  left: var(--space-2);
  z-index: var(--z-flyout);
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-width: calc(var(--ctx-w, 384px) - var(--space-3) * 2);
  min-width: 176px;
  padding: var(--space-1);
  border-radius: var(--radius-md);
  border: 1px solid var(--glass-border);
  background: var(--glass-panel);
  box-shadow: var(--shadow-2);
}

.ctx-menu-caption {
  margin: 2px var(--space-2) 4px;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.ctx-menu-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  height: 28px;
  padding: 0 var(--space-2);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: var(--text-xs);
  text-align: left;
  cursor: pointer;
}

.ctx-menu-item:hover,
.ctx-menu-item.active {
  background: var(--fill-2);
  color: var(--text-primary);
}

.ctx-menu-action {
  width: 100%;
}
</style>
