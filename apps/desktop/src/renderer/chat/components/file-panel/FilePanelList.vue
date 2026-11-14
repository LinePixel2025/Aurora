<script setup lang="ts">
/**
 * 文件面板的目录列表（docs/07 §2.3，2026-11-12）：32px 行 + 类型色图标 + 选中态。
 *
 * 传进来的 `entries` 已经过搜索过滤与排序（口径在父组件），这里只负责画。
 * 骨架行**不带** `.fp-row` 类：截图探针按 `.fp-row` 数量断言，加载态不该被当成条目。
 */
import type { FileListEntry } from '@aurora/shared'
import { FolderOpen, Info, Search } from '@aurora/shared/browser'
import FileKindIcon from './FileKindIcon.vue'
import { formatFileBytes } from './fileTypeMeta'

const props = defineProps<{
  entries: FileListEntry[]
  loading: boolean
  /** 目录列表是否已就绪（未就绪 + 非加载 = 没有可用的边界根） */
  hasListing: boolean
  query: string
  selectedPath: string
  truncated: boolean
}>()

const emit = defineEmits<{ activate: [entry: FileListEntry]; clearQuery: [] }>()

const SKELETON_ROWS = 8
</script>

<template>
  <div class="fp-list" data-field="chat.file-list">
    <template v-if="!props.hasListing && props.loading">
      <div v-for="row in SKELETON_ROWS" :key="row" class="fp-skeleton" aria-hidden="true" />
    </template>

    <div v-else-if="!props.hasListing" class="fp-empty">
      <Info class="fp-empty-icon" :size="28" :stroke-width="1.5" aria-hidden="true" />
      <p class="fp-empty-title">没有可用的工作目录</p>
      <p class="fp-empty-hint">给会话绑定一个项目，即可浏览项目内的文件</p>
    </div>

    <div v-else-if="props.entries.length === 0 && props.query !== ''" class="fp-empty">
      <Search class="fp-empty-icon" :size="28" :stroke-width="1.5" aria-hidden="true" />
      <p class="fp-empty-title">没有匹配「{{ props.query }}」的条目</p>
      <button type="button" class="fp-empty-action" @click="emit('clearQuery')">清除搜索</button>
    </div>

    <div v-else-if="props.entries.length === 0" class="fp-empty">
      <FolderOpen class="fp-empty-icon" :size="28" :stroke-width="1.5" aria-hidden="true" />
      <p class="fp-empty-title">空目录</p>
      <p class="fp-empty-hint">这个文件夹里还没有文件</p>
    </div>

    <template v-else>
      <button
        v-for="entry in props.entries"
        :key="entry.path"
        type="button"
        class="fp-row"
        :class="{ dir: entry.kind === 'dir', selected: entry.path === props.selectedPath }"
        :title="entry.path"
        @click="emit('activate', entry)"
      >
        <FileKindIcon :name="entry.name" :kind="entry.kind" :size="16" :box="20" />
        <span class="fp-row-name">{{ entry.name }}</span>
        <span class="fp-row-size">
          {{ entry.kind === 'dir' ? '' : formatFileBytes(entry.bytes) }}
        </span>
      </button>
    </template>

    <p v-if="props.truncated" class="fp-note">条目过多，仅显示前 500 条</p>
  </div>
</template>

<style scoped>
.fp-list {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.fp-row {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  height: 32px;
  padding: 0 var(--space-2);
  border: 0;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
}

.fp-row:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.fp-row.dir {
  color: var(--text-primary);
}

/* 选中强调条用内阴影：outline / border 会把 32px 行撑破，横向轨道跟着抖 */
.fp-row.selected {
  background: var(--fill-3);
  color: var(--text-primary);
  box-shadow: inset 2px 0 0 var(--accent-text);
}

.fp-row-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fp-row-size {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
}

.fp-note {
  flex: 0 0 auto;
  margin: 0;
  padding: 2px var(--space-2);
  color: var(--text-muted);
  font-size: var(--text-xs);
}

/* ── 空态 ── */
.fp-empty {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  min-height: 0;
  padding: var(--space-4) var(--space-2);
  text-align: center;
}

.fp-empty-icon {
  color: var(--text-muted);
  opacity: 0.7;
}

.fp-empty-title {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}

.fp-empty-hint {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}

.fp-empty-action {
  margin-top: 2px;
  height: 26px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--fill-3);
  color: var(--text-secondary);
  font-family: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
}

.fp-empty-action:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

/* ── 骨架（首读目录时）── */
.fp-skeleton {
  flex: 0 0 auto;
  height: 32px;
  border-radius: var(--radius-xs);
  background: linear-gradient(90deg, var(--fill-1), var(--fill-2), var(--fill-1));
  background-size: 200% 100%;
  animation: fp-shimmer 1.2s ease-in-out infinite;
}

@keyframes fp-shimmer {
  from {
    background-position: 200% 0;
  }
  to {
    background-position: -200% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .fp-skeleton {
    animation: none;
  }
}

/* 窄栏：大小列先让位，名字与图标恒在 */
@container (max-width: 320px) {
  .fp-row-size {
    display: none;
  }
}
</style>
