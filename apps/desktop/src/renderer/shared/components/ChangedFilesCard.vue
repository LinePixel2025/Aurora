<script setup lang="ts">
/**
 * 「本次改动文件」卡片（2026-11-07，docs/07 §2.3，对齐 DeepSeek Harness 的 changed-files card）。
 *
 * 数据来自主进程的 `chat:turnChanges`（docs/06 §4.2）：一轮正常收敛后被改动的文件与增删行数。
 * 只在内存、重启即失；本组件只负责展示与点击，不碰 IPC。
 *
 * 2026-11-07 第二轮（用户要求「明显一点」）：从「浅灰折叠条」升级成一张**独立卡片** ——
 * 抬升表面 + 强调色左描边 + 图标底块 + 主文本色标题 + 绿/红统计药丸 + 逐行状态图标；
 * 文案与结构仍与 DSH 对齐（单/多文件标题、+n/-n、二进制/过大、折叠 4 行、点行预览）。
 */
import { computed, ref } from 'vue'
import type { ChangedFileInfo } from '@aurora/shared'
import { ChevronDown, FilePenLine, FileText } from '@aurora/shared/browser'

const props = defineProps<{
  files: readonly ChangedFileInfo[]
}>()

const emit = defineEmits<{ (event: 'open', path: string): void }>()

/** 折叠态先显示几行（DSH 同款） */
const COLLAPSED_ROWS = 4

const expanded = ref(false)

const totals = computed(() => {
  let added = 0
  let removed = 0
  let counted = 0
  for (const file of props.files) {
    if (file.added === undefined && file.removed === undefined) continue
    added += file.added ?? 0
    removed += file.removed ?? 0
    counted += 1
  }
  return counted === 0 ? null : { added, removed }
})

const single = computed(() => (props.files.length === 1 ? props.files[0] : undefined))

const visibleFiles = computed(() =>
  expanded.value ? props.files : props.files.slice(0, COLLAPSED_ROWS),
)

const hasMore = computed(() => props.files.length > COLLAPSED_ROWS)

function fileNameOf(display: string): string {
  const parts = display.split('/')
  return parts[parts.length - 1] ?? display
}

function title(): string {
  const one = single.value
  if (one !== undefined) return `已编辑 ${fileNameOf(one.display)}`
  return `已编辑 ${props.files.length} 个文件`
}

/** 有可展示的行数（二进制 / 过大 / 没有快照只给状态词，不给 +0 -0） */
function hasCounts(file: ChangedFileInfo): boolean {
  return file.added !== undefined || file.removed !== undefined
}

/** 无行数时的状态词（二进制 / 过大 / 未统计） */
function statusText(file: ChangedFileInfo): string {
  if (file.status === 'binary') return '二进制'
  if (file.status === 'oversized') return '过大'
  if (file.status === 'deleted') return '已删除'
  if (!hasCounts(file)) return '未统计'
  return ''
}

function rowHint(file: ChangedFileInfo): string {
  if (file.status === 'binary') return `${file.path}（二进制文件，不统计行数）`
  if (file.status === 'oversized') return `${file.path}（文件过大，未统计行数）`
  if (file.status === 'unknown') return `${file.path}（没有改动前的快照，未统计行数）`
  if (file.status === 'deleted') return `${file.path}（本轮删除）`
  return file.path
}

function openFile(file: ChangedFileInfo): void {
  emit('open', file.path)
}

function openFirst(): void {
  const first = props.files[0]
  if (first === undefined) return
  emit('open', first.path)
}

function toggle(): void {
  expanded.value = !expanded.value
}
</script>

<template>
  <section class="changed-files" data-field="chat.changed-files">
    <button
      type="button"
      class="changed-files-head"
      :title="single === undefined ? '在右侧文件面板预览第一个文件' : single.path"
      data-field="chat.changed-files-title"
      @click="openFirst"
    >
      <span class="changed-files-badge" aria-hidden="true">
        <FilePenLine :size="15" :stroke-width="1.9" />
      </span>
      <span class="changed-files-heading">
        <span class="changed-files-kicker">本次改动</span>
        <span class="changed-files-label">{{ title() }}</span>
      </span>
      <span v-if="totals" class="changed-files-stats">
        <span class="changed-files-stat is-added">+{{ totals.added }}</span>
        <span class="changed-files-stat is-removed">-{{ totals.removed }}</span>
      </span>
    </button>

    <ul v-if="single === undefined" class="changed-files-list">
      <li v-for="file in visibleFiles" :key="file.path">
        <button
          type="button"
          class="changed-files-row"
          :title="rowHint(file)"
          data-field="chat.changed-file"
          @click="openFile(file)"
        >
          <FileText
            class="changed-files-file-icon"
            :class="`is-${file.status}`"
            :size="13"
            :stroke-width="1.8"
            aria-hidden="true"
          />
          <span class="changed-files-path">{{ file.display }}</span>
          <span v-if="hasCounts(file)" class="changed-files-count">
            <span class="is-added">+{{ file.added ?? 0 }}</span>
            <span class="is-removed">-{{ file.removed ?? 0 }}</span>
          </span>
          <span v-else class="changed-files-status" :class="`is-${file.status}`">
            {{ statusText(file) }}
          </span>
        </button>
      </li>
    </ul>

    <div class="changed-files-footer">
      <button
        v-if="single === undefined && hasMore"
        type="button"
        class="changed-files-more"
        :aria-expanded="expanded"
        :aria-label="expanded ? '收起改动文件列表' : `展开全部 ${files.length} 个改动文件`"
        @click="toggle"
      >
        <template v-if="expanded">收起</template>
        <template v-else>全部 {{ files.length }} 个文件</template>
        <ChevronDown
          class="changed-files-chevron"
          :class="{ open: expanded }"
          :size="12"
          :stroke-width="2"
          aria-hidden="true"
        />
      </button>
      <span class="changed-files-hint">点击文件在右侧预览</span>
    </div>
  </section>
</template>

<style scoped>
/*
 * 独立卡片：抬升表面 + 强调色左描边，跟对话正文拉开层次。
 * 刻意不用大阴影（与「克制」的视觉基线一致），靠 1px 边界 + 左侧 3px 色条表达「这是结果卡」。
 */
.changed-files {
  display: flex;
  flex-direction: column;
  margin-top: var(--space-3);
  border: 1px solid var(--border-strong);
  border-left: 3px solid color-mix(in srgb, var(--aurora-blue) 62%, transparent);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
  box-shadow: var(--shadow-hairline);
  overflow: hidden;
}

.changed-files-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-3);
  border: none;
  border-bottom: 1px solid var(--border-subtle);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-fast);
}

.changed-files-head:hover,
.changed-files-head:focus-visible {
  background: var(--fill-1);
}

.changed-files-badge {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--aurora-blue) 16%, transparent);
  color: var(--aurora-blue);
}

.changed-files-heading {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.changed-files-kicker {
  color: var(--text-secondary);
  font-size: 10.5px;
  letter-spacing: 0.04em;
  line-height: 1.2;
}

.changed-files-label {
  overflow: hidden;
  color: var(--text-primary);
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.changed-files-stats {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-variant-numeric: var(--num-tabular);
}

.changed-files-stat {
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  line-height: 1.5;
}

.changed-files-stat.is-added {
  background: color-mix(in srgb, var(--status-ok) 14%, transparent);
  color: var(--status-ok);
}

.changed-files-stat.is-removed {
  background: color-mix(in srgb, var(--status-error) 12%, transparent);
  color: var(--status-error);
}

.changed-files-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 0;
  padding: var(--space-1) var(--space-2);
  list-style: none;
}

.changed-files-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 27px;
  padding: 0 var(--space-2);
  border: none;
  border-radius: calc(var(--radius-sm) - 4px);
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.changed-files-row:hover,
.changed-files-row:focus-visible {
  background: var(--fill-2);
  color: var(--text-primary);
}

.changed-files-file-icon {
  flex: none;
  color: var(--text-secondary);
}

.changed-files-file-icon.is-created {
  color: var(--status-ok);
}

.changed-files-file-icon.is-deleted {
  color: var(--status-error);
}

.changed-files-file-icon.is-oversized {
  color: var(--status-unread);
}

.changed-files-path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.changed-files-count {
  flex: none;
  display: inline-flex;
  gap: var(--space-2);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-variant-numeric: var(--num-tabular);
}

.changed-files-count .is-added {
  color: var(--status-ok);
}

.changed-files-count .is-removed {
  color: var(--status-error);
}

.changed-files-status {
  flex: none;
  color: var(--text-secondary);
  font-size: var(--text-xs);
}

.changed-files-status.is-oversized {
  color: var(--status-unread);
}

.changed-files-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 0 var(--space-3) var(--space-2);
}

.changed-files-more {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: 24px;
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-pill);
  background: var(--fill-1);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  cursor: pointer;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.changed-files-more:hover,
.changed-files-more:focus-visible {
  background: var(--fill-2);
  color: var(--text-primary);
}

.changed-files-chevron {
  transition: transform var(--transition-fast);
}

.changed-files-chevron.open {
  transform: rotate(180deg);
}

.changed-files-hint {
  margin-left: auto;
  color: var(--text-secondary);
  font-size: 10.5px;
  opacity: 0.8;
}
</style>
