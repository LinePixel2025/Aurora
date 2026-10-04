<script setup lang="ts">
/** 文件自感知记忆库独立窗口（docs/06 §26、docs/07 §2.6）。 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { FileAwarenessNote, FileAwarenessNoteContent } from '@aurora/shared'
import { renderMarkdown } from '@aurora/shared/browser'
import { BookOpen, FileText, FolderOpen, Search, TriangleAlert } from '@aurora/shared/browser'
import AppButton from '../shared/components/AppButton.vue'
import AppToast from '../shared/components/AppToast.vue'
import WindowCaption from '../shared/components/WindowCaption.vue'
import { useWindowDrag } from '../shared/composables/useWindowDrag.js'

const notes = ref<FileAwarenessNote[]>([])
const selectedId = ref('')
const content = ref<FileAwarenessNoteContent | null>(null)
const query = ref('')
const loading = ref(false)
const error = ref<string | null>(null)
let offChanged: (() => void) | null = null
let loadToken = 0

const { dragClass, noDragClass } = useWindowDrag('memory')

interface NoteDateGroup {
  key: string
  label: string
  notes: FileAwarenessNote[]
}

interface NoteFormatGroup {
  ext: string
  label: string
  count: number
  dates: NoteDateGroup[]
}

const selected = computed(() => notes.value.find((note) => note.id === selectedId.value) ?? null)
const filteredNotes = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  if (keyword === '') return notes.value
  return notes.value.filter(
    (note) =>
      note.title.toLowerCase().includes(keyword) ||
      note.sourcePath.toLowerCase().includes(keyword) ||
      note.excerpt.toLowerCase().includes(keyword),
  )
})
const groupedNotes = computed<NoteFormatGroup[]>(() => {
  const formats = new Map<string, Map<string, FileAwarenessNote[]>>()
  for (const note of filteredNotes.value) {
    const ext = note.ext.trim().toLowerCase() || 'other'
    const day = dayKeyOf(note.createdAt || note.updatedAt)
    const dates = formats.get(ext) ?? new Map<string, FileAwarenessNote[]>()
    const items = dates.get(day) ?? []
    items.push(note)
    dates.set(day, items)
    formats.set(ext, dates)
  }
  return [...formats.entries()]
    .sort(([left], [right]) => formatRank(left) - formatRank(right) || left.localeCompare(right))
    .map(([ext, dates]) => {
      const dateGroups = [...dates.entries()]
        .sort(([left], [right]) => right.localeCompare(left))
        .map(([key, items]) => ({
          key,
          label: formatDay(key),
          notes: items,
        }))
      return {
        ext,
        label: formatLabelOf(ext),
        count: dateGroups.reduce((total, group) => total + group.notes.length, 0),
        dates: dateGroups,
      }
    })
})
const markdownHtml = computed(() => renderMarkdown(content.value?.content ?? ''))
const noteCountLabel = computed(() => `${notes.value.length} 篇`)
const searchCountLabel = computed(() => `${filteredNotes.value.length} 篇匹配`)

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function dayKeyOf(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'unknown-date'
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`
}

function formatDay(day: string): string {
  if (day === 'unknown-date') return '日期未知'
  const [year, month, date] = day.split('-')
  return `${year}年${Number(month)}月${Number(date)}日`
}

function formatLabelOf(ext: string): string {
  if (ext === 'docx') return 'Word 文档'
  if (ext === 'pptx') return 'PowerPoint 演示文稿'
  return ext.toUpperCase()
}

function formatRank(ext: string): number {
  if (ext === 'docx') return 0
  if (ext === 'pptx') return 1
  return 2
}

function fileNameOf(path: string): string {
  const segments = path.split(/[\\/]/)
  return segments[segments.length - 1] ?? path
}

async function refresh(): Promise<void> {
  const result = await window.aurora.awareness.notes({ limit: 500 })
  if (!result.ok) {
    error.value = result.message
    return
  }
  notes.value = result.value
  if (selectedId.value === '' || !notes.value.some((note) => note.id === selectedId.value)) {
    selectedId.value = notes.value[0]?.id ?? ''
  }
  await loadContent()
}

async function loadContent(): Promise<void> {
  const noteId = selectedId.value
  const token = ++loadToken
  if (noteId === '') {
    content.value = null
    loading.value = false
    return
  }
  loading.value = true
  const result = await window.aurora.awareness.readNote({ noteId })
  if (token !== loadToken) return
  loading.value = false
  if (result.ok) {
    content.value = result.value
    error.value = null
  } else {
    error.value = result.message
  }
}

async function selectNote(note: FileAwarenessNote): Promise<void> {
  if (selectedId.value === note.id) return
  selectedId.value = note.id
  await loadContent()
}

async function openKnowledge(): Promise<void> {
  const result = await window.aurora.awareness.openKnowledge()
  if (!result.ok) error.value = result.message
}

async function openWithSystem(): Promise<void> {
  const note = selected.value
  if (note === null) return
  const result = await window.aurora.awareness.openNote({ noteId: note.id })
  if (!result.ok) error.value = result.message
}

async function openSource(): Promise<void> {
  const note = selected.value
  if (note === null || !note.sourceAvailable) return
  const result = await window.aurora.awareness.openSource({ noteId: note.id })
  if (!result.ok) error.value = result.message
}

async function onMarkdownClick(event: MouseEvent): Promise<void> {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  const button = target.closest('.code-copy')
  if (!(button instanceof HTMLElement)) return
  const code = button.closest('.code-block')?.querySelector('code')?.textContent ?? ''
  if (code === '') return
  await navigator.clipboard.writeText(code)
  button.textContent = '已复制'
  window.setTimeout(() => {
    if (button.isConnected) button.textContent = '复制'
  }, 1_200)
}

onMounted(() => {
  void refresh()
  offChanged = window.aurora.awareness.onChanged(() => void refresh())
})

onUnmounted(() => {
  offChanged?.()
  offChanged = null
})
</script>

<template>
  <div class="memory">
    <header class="memory-head glass-bar" :class="dragClass">
      <div class="head-title">
        <BookOpen :size="16" :stroke-width="1.6" aria-hidden="true" />
        <strong>记忆库</strong>
        <span class="badge">{{ query.trim() === '' ? noteCountLabel : searchCountLabel }}</span>
      </div>
      <div class="head-tools" :class="noDragClass">
        <label class="search">
          <Search :size="13" :stroke-width="1.7" aria-hidden="true" />
          <input v-model="query" type="search" placeholder="搜索笔记或来源…" />
        </label>
        <AppButton size="sm" variant="ghost" @click="openKnowledge">
          <FolderOpen :size="13" :stroke-width="1.7" aria-hidden="true" />
          文件夹
        </AppButton>
      </div>
      <WindowCaption window="memory" />
    </header>

    <div class="memory-body">
      <aside class="note-list glass-shell" aria-label="笔记列表">
        <p v-if="filteredNotes.length === 0" class="empty">
          {{ notes.length === 0 ? '暂无 Markdown 笔记' : '没有匹配的笔记' }}
        </p>
        <section v-for="format in groupedNotes" :key="format.ext" class="format-group">
          <h2 class="format-head">
            <span>{{ format.label }}</span>
            <span class="group-count">{{ format.count }}</span>
          </h2>
          <div v-for="date in format.dates" :key="date.key" class="date-group">
            <h3 class="date-head">{{ date.label }}</h3>
            <button
              v-for="note in date.notes"
              :key="note.id"
              type="button"
              class="note-row"
              :class="{ active: note.id === selectedId }"
              @click="selectNote(note)"
            >
              <span class="note-row-head">
                <strong>{{ note.title }}</strong>
                <TriangleAlert
                  v-if="note.conflict"
                  :size="12"
                  :stroke-width="1.8"
                  aria-label="手工修改冲突"
                />
              </span>
              <span class="note-source">{{ fileNameOf(note.sourcePath) }}</span>
              <span class="note-meta">更新 {{ formatTime(note.updatedAt) }}</span>
            </button>
          </div>
        </section>
      </aside>

      <main class="note-detail">
        <template v-if="selected">
          <div class="detail-head glass-bar">
            <div class="detail-title">
              <h1>{{ selected.title }}</h1>
              <p>{{ selected.sourcePath }}</p>
            </div>
            <div class="detail-actions">
              <AppButton size="sm" variant="ghost" @click="openWithSystem">
                <FileText :size="13" :stroke-width="1.7" aria-hidden="true" />
                用系统打开
              </AppButton>
              <AppButton
                size="sm"
                variant="ghost"
                :disabled="!selected.sourceAvailable"
                @click="openSource"
              >
                <FolderOpen :size="13" :stroke-width="1.7" aria-hidden="true" />
                打开源文件
              </AppButton>
            </div>
          </div>
          <div class="preview">
            <p v-if="loading" class="empty">正在读取笔记…</p>
            <template v-else-if="content">
              <p v-if="content.truncated" class="warn">笔记较大，预览已截断。</p>
              <!-- eslint-disable-next-line vue/no-v-html -- renderMarkdown 先转义再套白名单结构 -->
              <article class="md note-md" @click="onMarkdownClick" v-html="markdownHtml" />
            </template>
          </div>
        </template>
        <p v-else class="empty detail-empty">从左侧选择一篇笔记</p>
      </main>
    </div>

    <AppToast v-if="error" tone="error" class="toast">{{ error }}</AppToast>
  </div>
</template>

<style scoped>
.memory {
  position: relative;
  display: grid;
  grid-template-rows: var(--head-h, 48px) minmax(0, 1fr);
  height: 100vh;
  overflow: hidden;
  background: transparent;
  color: var(--text-primary);
}

.memory-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding-left: var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
}

.head-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.head-title svg {
  flex: 0 0 auto;
  color: var(--aurora-blue);
  stroke: currentColor;
}

.head-tools {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: auto;
}

.search {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: 240px;
  height: 30px;
  padding: 0 var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-pill);
  background: var(--glass-surface);
  color: var(--text-muted);
}

.search svg {
  flex: 0 0 auto;
  stroke: currentColor;
}

.search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text-primary);
  font-size: var(--text-sm);
}

.memory-body {
  display: grid;
  grid-template-columns: 292px minmax(0, 1fr);
  min-height: 0;
}

.note-list {
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-2);
  border-right: 1px solid var(--border-subtle);
}

.format-group + .format-group {
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}

.format-head,
.date-head {
  display: flex;
  align-items: center;
  margin: 0;
  padding: 0 10px;
}

.format-head {
  justify-content: space-between;
  min-height: 26px;
  color: var(--text-secondary);
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  letter-spacing: 0.03em;
}

.group-count {
  min-width: 18px;
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: var(--fill-2);
  color: var(--text-muted);
  text-align: center;
  font-variant-numeric: var(--num-tabular);
}

.date-group + .date-group {
  margin-top: var(--space-2);
}

.date-head {
  min-height: 24px;
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-weight: var(--weight-regular);
}

.note-row {
  display: grid;
  gap: 3px;
  width: 100%;
  padding: 9px 10px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  text-align: left;
}

.note-row:hover {
  background: var(--fill-2);
}

.note-row.active {
  background: var(--fill-3);
  color: var(--text-primary);
}

.note-row-head {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}

.note-row-head strong {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
}

.note-row-head svg {
  flex: 0 0 auto;
  color: var(--status-unread);
  stroke: currentColor;
}

.note-source,
.note-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.note-detail {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
}

.detail-head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--border-subtle);
}

.detail-title {
  flex: 1;
  min-width: 0;
}

.detail-title h1 {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: var(--weight-semibold);
}

.detail-title p {
  margin: var(--space-1) 0 0;
  overflow-wrap: anywhere;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.detail-actions {
  display: flex;
  gap: var(--space-1);
  flex: 0 0 auto;
}

.preview {
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-5) var(--space-6) var(--space-8);
}

.note-md {
  max-width: 780px;
  margin: 0 auto;
}

.empty {
  margin: 0;
  padding: var(--space-5);
  color: var(--text-muted);
  font-size: var(--text-sm);
  text-align: center;
}

.detail-empty {
  align-self: center;
}

.warn {
  max-width: 780px;
  margin: 0 auto var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--warning-fill);
  color: var(--warning-text);
  font-size: var(--text-sm);
}

.toast {
  position: fixed;
  right: var(--space-4);
  bottom: var(--space-4);
}

@media (max-width: 820px) {
  .memory-body {
    grid-template-columns: 240px minmax(0, 1fr);
  }

  .search {
    width: 180px;
  }
}
</style>
