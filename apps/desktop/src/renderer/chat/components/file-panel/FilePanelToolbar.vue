<script setup lang="ts">
/**
 * 文件面板工具条（docs/07 §2.3，2026-11-12）：路径输入 + 面包屑 + 四导航钮 + 搜索 / 排序。
 *
 * 纯展示件：所有状态由 `FilePreviewPanel.vue` 持有（历史栈与序号护栏都在那边），
 * 这里只把点击原样 emit 回去。类名与 data-field 是截图探针的锚点，**不要改名**。
 */
import {
  ArrowDown,
  ArrowDownUp,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  House,
  RotateCw,
  Search,
  X,
} from '@aurora/shared/browser'
import type { FileSortKey } from './fileTypeMeta'

const props = defineProps<{
  pathInput: string
  /** 正在读文件：路径输入的「预览」钮据此置灰 */
  loading: boolean
  /** 列表或预览任一在加载：刷新钮据此置灰 */
  busy: boolean
  rootLabel: string
  crumbs: Array<{ name: string; path: string }>
  currentDir: string
  listingDir: string
  hasListing: boolean
  canGoBack: boolean
  canGoForward: boolean
  canGoUp: boolean
  query: string
  sortKey: FileSortKey
  sortDir: 'asc' | 'desc'
  /** 预览态不显示搜索 / 排序（那时列表不在场） */
  showFilter: boolean
}>()

const emit = defineEmits<{
  'update:pathInput': [value: string]
  'update:query': [value: string]
  preview: []
  root: []
  jump: [path: string]
  back: []
  forward: []
  up: []
  refresh: []
  sort: [key: FileSortKey]
}>()

const SORT_KEYS: Array<{ key: FileSortKey; label: string }> = [
  { key: 'name', label: '名称' },
  { key: 'size', label: '大小' },
  { key: 'mtime', label: '时间' },
]

function onPathInput(event: Event): void {
  emit('update:pathInput', (event.target as HTMLInputElement).value)
}

function onQueryInput(event: Event): void {
  emit('update:query', (event.target as HTMLInputElement).value)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') emit('preview')
}
</script>

<template>
  <div class="fp-input-row">
    <input
      :value="props.pathInput"
      class="fp-input"
      type="text"
      placeholder="输入工作目录内的文件路径…"
      spellcheck="false"
      @input="onPathInput"
      @keydown="onKeydown"
    />
    <button
      type="button"
      class="fp-go"
      :disabled="props.loading || props.pathInput.trim() === ''"
      @click="emit('preview')"
    >
      {{ props.loading ? '…' : '预览' }}
    </button>
  </div>

  <!--
    面包屑（根 + 各级目录，可点跳转）+ 导航（后退 / 前进 / 上级 / 刷新）。
    导航按钮恒在，只按状态置灰 —— 字形按钮曾在内容撑宽时被挤出可视区，
    用户看到的就是「完全没有按钮」。
  -->
  <div class="fp-bar" data-field="chat.file-bar">
    <div class="fp-crumbs" data-field="chat.file-crumbs" :title="props.listingDir">
      <button
        type="button"
        class="fp-crumb fp-crumb-root"
        data-field="chat.file-root"
        title="回到根目录"
        :disabled="!props.hasListing"
        @click="emit('root')"
      >
        <House :size="12" :stroke-width="1.75" aria-hidden="true" />
        <span class="fp-crumb-text">{{ props.rootLabel }}</span>
      </button>
      <template v-for="crumb in props.crumbs" :key="crumb.path">
        <ChevronRight class="fp-sep" :size="11" :stroke-width="2" aria-hidden="true" />
        <button
          type="button"
          class="fp-crumb"
          :class="{ current: crumb.path === props.currentDir }"
          :title="crumb.path"
          @click="emit('jump', crumb.path)"
        >
          <span class="fp-crumb-text">{{ crumb.name }}</span>
        </button>
      </template>
    </div>
    <div class="fp-nav">
      <button
        type="button"
        class="fp-mini"
        title="后退"
        data-field="chat.file-back"
        :disabled="!props.canGoBack"
        @click="emit('back')"
      >
        <ArrowLeft :size="14" :stroke-width="1.8" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="fp-mini"
        title="前进"
        data-field="chat.file-forward"
        :disabled="!props.canGoForward"
        @click="emit('forward')"
      >
        <ArrowRight :size="14" :stroke-width="1.8" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="fp-mini"
        title="上级目录"
        data-field="chat.file-up"
        :disabled="!props.canGoUp"
        @click="emit('up')"
      >
        <ArrowUp :size="14" :stroke-width="1.8" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="fp-mini"
        title="刷新"
        data-field="chat.file-refresh"
        :disabled="props.busy"
        @click="emit('refresh')"
      >
        <RotateCw :size="13" :stroke-width="1.8" aria-hidden="true" />
      </button>
    </div>
  </div>

  <div v-if="props.showFilter" class="fp-filter-row">
    <div class="fp-search-wrap">
      <Search class="fp-search-icon" :size="14" :stroke-width="1.8" aria-hidden="true" />
      <input
        :value="props.query"
        class="fp-search"
        type="text"
        placeholder="搜索当前目录…"
        spellcheck="false"
        aria-label="搜索当前目录"
        @input="onQueryInput"
      />
      <button
        v-if="props.query !== ''"
        type="button"
        class="fp-search-clear"
        title="清除搜索"
        aria-label="清除搜索"
        @click="emit('update:query', '')"
      >
        <X :size="12" :stroke-width="2" aria-hidden="true" />
      </button>
    </div>
    <div class="fp-sort" role="group" aria-label="排序">
      <ArrowDownUp class="fp-sort-icon" :size="12" :stroke-width="1.8" aria-hidden="true" />
      <button
        v-for="item in SORT_KEYS"
        :key="item.key"
        type="button"
        class="fp-sort-key"
        :class="{ active: props.sortKey === item.key }"
        :data-sort="item.key"
        :title="props.sortKey === item.key ? '再点一次切换升降序' : `按${item.label}排序`"
        :aria-pressed="props.sortKey === item.key"
        @click="emit('sort', item.key)"
      >
        {{ item.label }}
        <component
          :is="props.sortDir === 'asc' ? ArrowUp : ArrowDown"
          class="fp-sort-arrow"
          :size="10"
          :stroke-width="2.2"
          aria-hidden="true"
        />
      </button>
    </div>
  </div>
</template>

<style scoped>
.fp-input-row {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}

.fp-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 28px;
  padding: 0 var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-primary);
  font-family: inherit;
  font-size: var(--text-xs);
}

.fp-input:focus {
  outline: none;
  border-color: var(--border-strong);
}

.fp-go {
  flex: 0 0 auto;
  height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--fill-3);
  color: var(--text-secondary);
  font-family: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
}

.fp-go:hover:not(:disabled) {
  background: var(--fill-2);
  color: var(--text-primary);
}

.fp-go:disabled {
  opacity: 0.5;
  cursor: default;
}

/* ── 面包屑（左，可横向滚动）+ 导航按钮（右，恒在） ── */
.fp-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  height: 30px;
}

.fp-crumbs {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  /* 深路径时面包屑自己横向滚动，绝不把右侧导航按钮顶出可视区 */
  overflow-x: auto;
  scrollbar-width: none;
}

.fp-crumbs::-webkit-scrollbar {
  display: none;
}

.fp-crumb {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: clamp(72px, 34%, 168px);
  height: 24px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: var(--text-xs);
  white-space: nowrap;
  cursor: pointer;
}

.fp-crumb-root {
  /* 根段是「项目：xxx」，比目录段长得多；只有一段时它该占满可用宽度而不是被截成「项目：截…」 */
  max-width: clamp(120px, 62%, 260px);
  background: var(--fill-2);
}

.fp-crumb:hover:not(:disabled) {
  background: var(--fill-3);
  color: var(--text-primary);
}

.fp-crumb.current {
  color: var(--text-primary);
}

.fp-crumb:disabled {
  opacity: 0.5;
  cursor: default;
}

.fp-crumb-text {
  overflow: hidden;
  text-overflow: ellipsis;
}

.fp-sep {
  flex: 0 0 auto;
  color: var(--text-muted);
  opacity: 0.6;
}

.fp-nav {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 2px;
}

.fp-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.fp-mini:hover:not(:disabled) {
  background: var(--fill-2);
  color: var(--text-primary);
}

/* 置灰要「看得见但不亮」：0.35 透明度在浅色主题下几乎等于消失 */
.fp-mini:disabled {
  color: var(--text-muted);
  opacity: 0.55;
  cursor: default;
}

/* ── 搜索 + 排序 ── */
.fp-filter-row {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}

.fp-search-wrap {
  flex: 1 1 auto;
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
}

.fp-search-icon {
  position: absolute;
  left: 7px;
  color: var(--text-muted);
  pointer-events: none;
}

.fp-search {
  flex: 1 1 auto;
  min-width: 0;
  height: 26px;
  padding: 0 24px 0 26px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-primary);
  font-family: inherit;
  font-size: var(--text-xs);
}

.fp-search:focus {
  outline: none;
  border-color: var(--border-strong);
}

.fp-search-clear {
  position: absolute;
  right: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.fp-search-clear:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.fp-sort {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 1px;
}

.fp-sort-icon {
  margin-right: 2px;
  color: var(--text-muted);
}

.fp-sort-key {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  height: 24px;
  padding: 0 5px;
  border: 0;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-muted);
  font-family: inherit;
  font-size: var(--text-xs);
  white-space: nowrap;
  cursor: pointer;
}

.fp-sort-key:hover {
  background: var(--fill-2);
  color: var(--text-secondary);
}

.fp-sort-key.active {
  background: var(--fill-3);
  color: var(--text-primary);
}

/* 箭头槽恒占位：切换排序键时不产生横向抖动 */
.fp-sort-arrow {
  opacity: 0;
}

.fp-sort-key.active .fp-sort-arrow {
  opacity: 1;
}

/* 窄栏（右栏可拖到 280px）：让搜索框先让位，排序键与四导航钮恒在 */
@container (max-width: 320px) {
  .fp-crumb-root .fp-crumb-text {
    display: none;
  }

  .fp-sort-icon {
    display: none;
  }

  .fp-sort-key {
    padding: 0 4px;
  }
}
</style>
