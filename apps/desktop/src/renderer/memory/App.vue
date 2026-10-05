<script setup lang="ts">
/** 文件自感知记忆库独立窗口（docs/06 §26、docs/07 §2.6）。 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type {
  FileAwarenessNote,
  FileAwarenessNoteContent,
  FileAwarenessNoteExpiry,
} from '@aurora/shared'
import { renderMarkdown } from '@aurora/shared/browser'
import {
  BookOpen,
  ChevronDown,
  CircleX,
  FileText,
  FolderOpen,
  Search,
  TriangleAlert,
} from '@aurora/shared/browser'
import AppButton from '../shared/components/AppButton.vue'
import AppToast from '../shared/components/AppToast.vue'
import WindowCaption from '../shared/components/WindowCaption.vue'
import { useWindowDrag } from '../shared/composables/useWindowDrag.js'

const notes = ref<FileAwarenessNote[]>([])
const selectedId = ref('')
const content = ref<FileAwarenessNoteContent | null>(null)
const query = ref('')
const formatFilter = ref('all')
const dateFilter = ref<'all' | 'today' | '7d' | '30d'>('all')
const expandedDateKeys = ref<Set<string>>(new Set())
const previewEl = ref<HTMLElement | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const customExpiryValue = ref('')
const customExpiryOpen = ref(false)
let offChanged: (() => void) | null = null
let offNotePresented: (() => void) | null = null
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
const availableFormats = computed(() => {
  const formats = new Set(notes.value.map((note) => note.ext.trim().toLowerCase() || 'other'))
  return [...formats].sort((left, right) => formatRank(left) - formatRank(right))
})
const filteredNotes = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  const cutoff = dateCutoff(dateFilter.value)
  return notes.value.filter((note) => {
    const ext = note.ext.trim().toLowerCase() || 'other'
    if (formatFilter.value !== 'all' && ext !== formatFilter.value) return false
    if (cutoff !== undefined) {
      const created = Date.parse(note.createdAt)
      if (!Number.isFinite(created) || created < cutoff) return false
    }
    if (keyword === '') return true
    return [note.title, note.sourcePath, note.excerpt, ...note.tags]
      .join('\n')
      .toLowerCase()
      .includes(keyword)
  })
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
          key: `${ext}:${key}`,
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
const selectedDateKey = computed(() => {
  const note = selected.value ?? notes.value[0]
  return note === undefined ? '' : groupKeyOf(note)
})
const selectedExpiryChoice = computed(() => {
  const expiry = selected.value?.expiry
  if (expiry?.mode === 'never') return 'never'
  if (expiry?.mode === 'at') return expiry.preset ?? 'custom'
  return 'inherit'
})

watch(filteredNotes, (items) => {
  if (items.length === 0) {
    content.value = null
    return
  }
  if (items.some((note) => note.id === selectedId.value)) return
  void selectNote(items[0]!)
})

watch(selected, (note) => {
  customExpiryOpen.value = note?.expiry.mode === 'at' && note.expiry.preset !== 'manual'
  customExpiryValue.value = toLocalDateTimeInput(
    note?.expiry.mode === 'at' ? note.expiry.at : undefined,
  )
})

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function toLocalDateTimeInput(value?: string): string {
  const date =
    value === undefined ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000) : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (number: number): string => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

function expiryLabel(note: FileAwarenessNote): string {
  if (note.expiry.mode === 'at' && note.expiry.preset === 'manual') return '已手动过期'
  if (note.expired) return '已过期'
  if (note.expiry.mode === 'never') return '永不过期'
  if (note.expiresAt === undefined) return '跟随默认 · 永不过期'
  const date = new Date(note.expiresAt)
  if (Number.isNaN(date.getTime())) return '到期时间无效'
  const prefix = note.expiry.mode === 'inherit' ? '默认续期至 ' : '到期 '
  return `${prefix}${date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })}`
}

async function applyExpiry(expiry: FileAwarenessNoteExpiry): Promise<void> {
  const note = selected.value
  if (note === null) return
  const result = await window.aurora.awareness.setNoteExpiry({ noteId: note.id, expiry })
  if (!result.ok) {
    error.value = result.message
    return
  }
  notes.value = notes.value.map((item) => (item.id === result.value.id ? result.value : item))
  error.value = null
}

async function setExpiryChoice(value: string): Promise<void> {
  if (value === 'inherit') {
    customExpiryOpen.value = false
    await applyExpiry({ mode: 'inherit' })
    return
  }
  if (value === 'never') {
    customExpiryOpen.value = false
    await applyExpiry({ mode: 'never' })
    return
  }
  if (value === 'manual') {
    customExpiryOpen.value = false
    await applyExpiry({
      mode: 'at',
      at: new Date().toISOString(),
      preset: 'manual',
    })
    return
  }
  if (value === 'custom') {
    customExpiryOpen.value = true
    return
  }
  const days = value === 'at24' ? 1 : value === 'at7' ? 7 : value === 'at30' ? 30 : 0
  if (days === 0) return
  customExpiryOpen.value = false
  await applyExpiry({
    mode: 'at',
    at: new Date(Date.now() + days * 24 * 60 * 60 * 1_000).toISOString(),
    preset: value as 'at24' | 'at7' | 'at30',
  })
}

async function expireNow(): Promise<void> {
  await setExpiryChoice('manual')
}

async function applyCustomExpiry(): Promise<void> {
  const at = new Date(customExpiryValue.value)
  if (Number.isNaN(at.getTime())) {
    error.value = '请选择有效的到期时间'
    return
  }
  await applyExpiry({ mode: 'at', at: at.toISOString() })
  customExpiryOpen.value = false
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
  if (ext === 'xlsx') return 'Excel 表格'
  if (ext === 'pdf') return 'PDF'
  if (ext === 'odt' || ext === 'odp' || ext === 'ods') return 'OpenDocument'
  if (ext === 'rtf') return '富文本'
  if (ext === 'html' || ext === 'htm') return '网页'
  if (ext === 'epub') return '电子书'
  if (
    [
      'txt',
      'md',
      'markdown',
      'csv',
      'tsv',
      'json',
      'xml',
      'yaml',
      'yml',
      'log',
      'tex',
      'srt',
      'vtt',
    ].includes(ext)
  ) {
    return '文本'
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'svg'].includes(ext)) {
    return '图片'
  }
  return ext.toUpperCase()
}

function formatRank(ext: string): number {
  if (ext === 'docx') return 0
  if (ext === 'pptx') return 1
  if (ext === 'xlsx') return 2
  if (ext === 'pdf') return 3
  if (ext === 'odt' || ext === 'odp' || ext === 'ods') return 4
  if (ext === 'rtf' || ext === 'html' || ext === 'htm' || ext === 'epub') return 5
  if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'svg'].includes(ext)) return 6
  return 7
}

function dateCutoff(filter: 'all' | 'today' | '7d' | '30d'): number | undefined {
  if (filter === 'all') return undefined
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (filter === 'today') return start.getTime()
  const days = filter === '7d' ? 6 : 29
  start.setDate(start.getDate() - days)
  return start.getTime()
}

function groupKeyOf(note: FileAwarenessNote): string {
  const ext = note.ext.trim().toLowerCase() || 'other'
  return `${ext}:${dayKeyOf(note.createdAt || note.updatedAt)}`
}

function isDateExpanded(key: string): boolean {
  return expandedDateKeys.value.has(key)
}

function toggleDateGroup(key: string): void {
  const next = new Set(expandedDateKeys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expandedDateKeys.value = next
}

function expandDateGroup(key: string): void {
  if (key === '' || expandedDateKeys.value.has(key)) return
  expandedDateKeys.value = new Set([...expandedDateKeys.value, key])
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
  expandDateGroup(selectedDateKey.value)
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
  selectedId.value = note.id
  expandDateGroup(groupKeyOf(note))
  await loadContent()
  await nextTick()
  if (previewEl.value !== null) previewEl.value.scrollTop = 0
}

async function presentNote(noteId: string): Promise<void> {
  if (!notes.value.some((note) => note.id === noteId)) await refresh()
  const note = notes.value.find((item) => item.id === noteId)
  if (note === undefined) {
    error.value = '没有找到对应笔记'
    return
  }
  selectedId.value = note.id
  expandDateGroup(groupKeyOf(note))
  await loadContent()
  await nextTick()
  if (previewEl.value !== null) previewEl.value.scrollTop = 0
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
  offNotePresented = window.aurora.awareness.onNotePresented(
    ({ noteId }) => void presentNote(noteId),
  )
})

onUnmounted(() => {
  offChanged?.()
  offChanged = null
  offNotePresented?.()
  offNotePresented = null
})
</script>

<template>
  <div class="memory anim-window">
    <header class="memory-head glass-bar" :class="dragClass">
      <div class="head-title">
        <BookOpen :size="16" :stroke-width="1.6" aria-hidden="true" />
        <strong>记忆库</strong>
        <span class="badge">{{
          filteredNotes.length === notes.length ? noteCountLabel : searchCountLabel
        }}</span>
      </div>
      <div class="head-tools" :class="noDragClass">
        <AppButton size="sm" variant="ghost" @click="openKnowledge">
          <FolderOpen :size="13" :stroke-width="1.7" aria-hidden="true" />
          文件夹
        </AppButton>
      </div>
      <WindowCaption window="memory" />
    </header>

    <div class="memory-body">
      <aside class="note-list glass-shell rail-surface anim-shell-left" aria-label="笔记列表">
        <div class="note-filters" :class="noDragClass">
          <label class="search">
            <Search :size="13" :stroke-width="1.7" aria-hidden="true" />
            <input v-model="query" type="search" placeholder="搜索标题、来源或内容…" />
          </label>
          <div class="filter-pills" aria-label="格式筛选">
            <button
              type="button"
              class="filter-pill"
              :class="{ active: formatFilter === 'all' }"
              data-field="memory.filter-format-all"
              @click="formatFilter = 'all'"
            >
              全部
            </button>
            <button
              v-for="ext in availableFormats"
              :key="ext"
              type="button"
              class="filter-pill"
              :class="{ active: formatFilter === ext }"
              :data-field="`memory.filter-format-${ext}`"
              @click="formatFilter = ext"
            >
              {{ formatLabelOf(ext) }}
            </button>
          </div>
          <label class="date-filter">
            <span>时间</span>
            <select v-model="dateFilter">
              <option value="all">全部</option>
              <option value="today">今天</option>
              <option value="7d">近 7 天</option>
              <option value="30d">近 30 天</option>
            </select>
          </label>
        </div>
        <p v-if="filteredNotes.length === 0" class="empty">
          {{ notes.length === 0 ? '暂无 Markdown 笔记' : '没有匹配的笔记' }}
        </p>
        <section v-for="format in groupedNotes" :key="format.ext" class="format-group">
          <h2 class="format-head">
            <span>{{ format.label }}</span>
            <span class="group-count">{{ format.count }}</span>
          </h2>
          <div v-for="date in format.dates" :key="date.key" class="date-group">
            <button
              type="button"
              class="date-head"
              :class="{ expanded: isDateExpanded(date.key) }"
              :data-date-key="date.key"
              :aria-expanded="isDateExpanded(date.key)"
              @click="toggleDateGroup(date.key)"
            >
              <ChevronDown :size="12" :stroke-width="1.8" aria-hidden="true" />
              <span>{{ date.label }}</span>
              <span class="group-count">{{ date.notes.length }}</span>
            </button>
            <div v-if="isDateExpanded(date.key)" class="date-notes">
              <button
                v-for="note in date.notes"
                :key="note.id"
                type="button"
                class="note-row"
                :class="{ active: note.id === selectedId, expired: note.expired }"
                :data-note-id="note.id"
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
                <span class="note-meta">
                  更新 {{ formatTime(note.updatedAt) }} · {{ expiryLabel(note) }}
                </span>
              </button>
            </div>
          </div>
        </section>
      </aside>

      <main class="note-detail anim-pane">
        <template v-if="selected">
          <div class="detail-head glass-bar">
            <div class="detail-title">
              <h1>{{ selected.title }}</h1>
              <p>{{ selected.sourcePath }}</p>
              <div class="detail-expiry" :class="{ expired: selected.expired }">
                <label>
                  <span>提供给 Agent</span>
                  <select
                    data-field="memory.note-expiry"
                    :value="selectedExpiryChoice"
                    @change="setExpiryChoice(($event.target as HTMLSelectElement).value)"
                  >
                    <option value="inherit">跟随默认</option>
                    <option value="never">永不过期</option>
                    <option value="at24">24 小时</option>
                    <option value="at7">7 天</option>
                    <option value="at30">30 天</option>
                    <option value="manual">已手动过期</option>
                    <option value="custom">自定义时间</option>
                  </select>
                </label>
                <AppButton
                  size="sm"
                  variant="ghost"
                  data-action="memory.expire-now"
                  :disabled="selectedExpiryChoice === 'manual'"
                  @click="expireNow"
                >
                  <CircleX :size="13" :stroke-width="1.8" aria-hidden="true" />
                  立即过期
                </AppButton>
                <div v-if="customExpiryOpen" class="custom-expiry">
                  <input
                    v-model="customExpiryValue"
                    data-field="memory.note-expiry-custom"
                    type="datetime-local"
                  />
                  <AppButton size="sm" variant="ghost" @click="applyCustomExpiry">应用</AppButton>
                </div>
                <span class="expiry-summary" data-field="memory.note-expiry-state">
                  {{ expiryLabel(selected) }}
                </span>
              </div>
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
          <div ref="previewEl" class="preview">
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
  width: 100%;
  height: 30px;
  padding: 0 var(--space-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--bg-raised) 90%, var(--text-primary) 10%);
  color: var(--text-muted);
  box-shadow: inset 0 1px 0 var(--glass-highlight);
  transition:
    border-color var(--transition-fast),
    background var(--transition-fast);
}

.search:focus-within {
  border-color: var(--aurora-blue);
  background: var(--fill-3);
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
}

.note-filters {
  position: sticky;
  top: calc(-1 * var(--space-2));
  z-index: 2;
  display: grid;
  gap: var(--space-2);
  margin: calc(-1 * var(--space-2)) calc(-1 * var(--space-2)) 0;
  padding: var(--space-2);
  background: var(--bg-raised);
  box-shadow: 0 1px 0 var(--border-subtle);
}

.filter-pills {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.filter-pill {
  padding: 3px 8px;
  border-radius: var(--radius-pill);
  background: var(--fill-1);
  color: var(--text-muted);
  font: inherit;
  font-size: var(--text-xs);
}

.filter-pill:hover {
  background: var(--fill-2);
}

.filter-pill.active {
  background: color-mix(in srgb, var(--aurora-blue) 18%, transparent);
  color: var(--accent-text);
}

.date-filter {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.date-filter select {
  height: 26px;
  min-width: 96px;
  padding: 0 7px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  outline: 0;
  background: var(--glass-surface);
  color: var(--text-primary);
  font: inherit;
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
  width: 100%;
  gap: var(--space-1);
  min-height: 24px;
  border: 0;
  background: transparent;
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-weight: var(--weight-regular);
  text-align: left;
}

.date-head:hover {
  color: var(--text-secondary);
}

.date-head svg {
  flex: 0 0 auto;
  transition: transform var(--transition-fast);
}

.date-head.expanded svg {
  transform: rotate(180deg);
}

.date-head .group-count {
  margin-left: auto;
}

.date-notes {
  display: grid;
  gap: 2px;
  margin-top: 2px;
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

.note-row.expired .note-row-head strong,
.note-row.expired .note-source {
  color: var(--text-muted);
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
  background-color: var(--glass-content);
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

.detail-expiry {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-subtle);
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.detail-expiry label {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.detail-expiry select,
.detail-expiry input {
  height: 28px;
  padding: 0 var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  outline: 0;
  background: var(--bg-raised);
  color: var(--text-primary);
  font: inherit;
}

.detail-expiry input {
  min-width: 190px;
}

.detail-expiry.expired .expiry-summary {
  color: var(--status-unread);
}

.custom-expiry {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.expiry-summary {
  margin-left: auto;
  color: var(--text-secondary);
  font-variant-numeric: var(--num-tabular);
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
