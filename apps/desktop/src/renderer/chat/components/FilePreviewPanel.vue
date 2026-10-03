<script setup lang="ts">
/*
 * 右栏「文件」面板（2026-10-03 起＝**小文件管理器 + 预览**，docs/07 §2.3）。
 *
 * 结构（自上而下）：
 * - 路径输入（「从消息 / 工具卡里看到路径 → 拿来预览」是主入口之一）；
 * - 工具条：面包屑（根 = 会话边界根，绑了项目就是**项目文件夹**）+ 后退 / 前进 / 上级 / 刷新；
 * - 正文：目录列表，或**同一面板内**的文件预览（markdown / 文本 / 图片）。
 *
 * 导航模型（2026-10-03 补，用户点名「预览文件、进入文件夹后无法返回」）：
 * 与浏览器同构的**历史栈** —— 一个位置 = `{ dir, file? }`（file 为空即该目录的列表态）。
 * 进目录 / 预览文件 / 点面包屑 / 上级 都是 push 一步；「后退」「前进」在栈里移动。
 * 预览态的「返回列表」就是后退一步（历史里前一条正是同目录的列表态），**不额外造路径**。
 *
 * 能力边界（与主进程 `file-preview.ts` / `file-list.ts` 的口径一一对应）：
 * - 只能读写**发起会话边界根之内**的路径（越界主进程拒绝，文案原样展示）；
 * - 文本 2 MB / 图片 10 MB；文本超限截断显示并标记，图片超限拒绝；
 * - 二进制文件返回 `unsupported`（只给原因，不渲染乱码）；列目录上限 500 条。
 */
import { computed, ref, watch } from 'vue'
import type { FileListEntry, FileListResult, FilePreviewResult } from '@aurora/shared'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  FileText,
  FolderOpen,
  House,
  RotateCw,
  formatExactCount,
  renderMarkdown,
} from '@aurora/shared/browser'
import '@aurora/shared/browser/markdown/md.css'

const props = defineProps<{
  sessionId: string
  /** 当前会话绑定的项目名（未绑定 / 孤儿绑定时 undefined）：目录条据此换标题 */
  projectName?: string
}>()

/** 标签标题上报（docs/07 §2.3）：预览态 = 文件名，列表态 = 当前目录名 */
const emit = defineEmits<{ (event: 'title', title: string): void }>()

/** 一个浏览位置：目录 + （可选）要预览的文件。`file` 为空即该目录的列表态 */
interface Location {
  dir: string
  file?: string
}

const pathInput = ref('')
const loading = ref(false)
const error = ref('')
const current = ref<FilePreviewResult | null>(null)
/** 渲染后的 markdown html（`kind === 'markdown'` 时才有值） */
const markdownHtml = ref('')

// ── 目录列表（文件管理器） ──

const listing = ref<FileListResult | null>(null)
const listError = ref('')
const listLoading = ref(false)
/** 视图：列表 / 预览（预览时列表让位，「返回列表」按钮负责切回） */
const view = ref<'list' | 'preview'>('list')

// ── 历史栈（后退 / 前进） ──

const trail = ref<Location[]>([])
const cursor = ref(-1)
const canGoBack = computed(() => cursor.value > 0)
const canGoForward = computed(() => cursor.value >= 0 && cursor.value < trail.value.length - 1)
/** 当前目录的绝对路径（越界 / 未加载时是空串） */
const currentDir = computed(() => listing.value?.dir ?? '')

const RECENT_KEY = 'aurora.chat.previewRecent'
const RECENT_LIMIT = 8
const recent = ref<string[]>(loadRecent())

function loadRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY)
    const parsed: unknown = raw === null ? [] : JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

function saveRecent(path: string): void {
  recent.value = [path, ...recent.value.filter((item) => item !== path)].slice(0, RECENT_LIMIT)
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(recent.value))
  } catch {
    /* localStorage 不可用（隐私模式等）只是丢掉最近记录，不影响预览 */
  }
}

const bytesText = computed(() =>
  current.value === null ? '' : formatExactCount(current.value.bytes),
)

/** 面包屑根标签：绑定了项目就是项目文件夹，否则是会话工作目录 */
const rootLabel = computed(() =>
  props.projectName === undefined ? '工作目录' : `项目：${props.projectName}`,
)

/** 能否上升一层：当前目录不等于边界根才给「上级」 */
const canGoUp = computed(() => {
  const info = listing.value
  return info !== null && relativeTo(info.root, info.dir) !== ''
})

/** `dir` 相对 `root` 的路径（Windows / POSIX 两种分隔符都认）；同路径 / 不在根内返回空串 */
function relativeTo(root: string, dir: string): string {
  const base = root.replace(/[\\/]+$/, '')
  if (dir === base || dir === root) return ''
  if (!dir.startsWith(base)) return ''
  // 根后面必须紧跟分隔符才算子路径（否则 `C:\ab` 会被判成 `C:\a` 的孩子）
  if (!/[\\/]/.test(dir.charAt(base.length))) return ''
  return dir
    .slice(base.length)
    .replace(/^[\\/]+/, '')
    .split(/[\\/]/)
    .join('/')
}

/** 拼一层子路径（沿用父路径自己的分隔符） */
function childPath(parent: string, name: string): string {
  const sep = parent.includes('\\') ? '\\' : '/'
  return parent.endsWith(sep) ? `${parent}${name}` : `${parent}${sep}${name}`
}

/** 上一级目录（到边界根为止；调用方先用 `canGoUp` 判过） */
function parentOf(dir: string): string {
  const cut = Math.max(dir.lastIndexOf('\\'), dir.lastIndexOf('/'))
  return cut > 0 ? dir.slice(0, cut) : dir
}

/**
 * 标签标题上报（docs/07 §2.3）：右栏标签条上要一眼看出「这个文件标签在哪儿」——
 * 预览态取文件名，列表态取当前目录名；还在根上（或根不叫 projectName）就用项目名 /
 * 根目录末段 / 「工作目录」逐级回落。切会话重新 bootstrap 时这里跟着重算。
 */
function lastSegment(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).pop() ?? ''
}

watch(
  [view, current, listing, rootLabel],
  () => {
    if (view.value === 'preview' && current.value !== null) {
      const name = lastSegment(current.value.path)
      emit('title', name === '' ? '预览' : name)
      return
    }
    const info = listing.value
    if (info === null) {
      emit('title', props.projectName ?? '文件')
      return
    }
    if (relativeTo(info.root, info.dir) === '') {
      const name = props.projectName ?? lastSegment(info.root)
      emit('title', name === '' ? '工作目录' : name)
      return
    }
    const name = lastSegment(info.dir)
    emit('title', name === '' ? '文件' : name)
  },
  { immediate: true },
)

/**
 * 面包屑：根之后逐级可点的段（末段即当前目录）。`root` 拿不到时为空数组 ——
 * 此时工具条上「上级」是禁用的，用户仍有路径输入可用。
 */
const crumbs = computed(() => {
  const info = listing.value
  if (info === null) return []
  const rel = relativeTo(info.root, info.dir)
  if (rel === '' || rel === info.dir) return []
  const out: Array<{ name: string; path: string }> = []
  let acc = info.root
  for (const part of rel.split('/')) {
    acc = childPath(acc, part)
    out.push({ name: part, path: acc })
  }
  return out
})

// ── 目录读取 / 文件读取 ──

/**
 * 请求序号护栏：列表与读盘都允许并发，**只认最后一次**的结果。
 * 旧实现是「正在加载就 return」——快速连点两下目录时第二下被静默丢掉，
 * 用户看到的是「点了没反应」（与历史栈一起改掉）。
 */
let dirRequest = 0
let fileRequest = 0

/** 列目录（不传 `path` 即会话边界根）。返回是否成功 —— 历史回放据此决定要不要继续 */
async function loadDir(path?: string): Promise<boolean> {
  const id = (dirRequest += 1)
  listLoading.value = true
  listError.value = ''
  try {
    const result = await window.aurora.preview.list({
      sessionId: props.sessionId,
      ...(path === undefined ? {} : { path }),
    })
    if (id !== dirRequest) return false
    if (!result.ok) {
      listError.value = result.message
      return false
    }
    listing.value = result.value
    return true
  } catch (cause) {
    if (id !== dirRequest) return false
    listError.value = cause instanceof Error ? cause.message : String(cause)
    return false
  } finally {
    if (id === dirRequest) listLoading.value = false
  }
}

/** 读文件并切到预览态（失败也在预览态显示原因，与旧行为一致） */
async function readFile(path: string): Promise<boolean> {
  const trimmed = path.trim()
  if (trimmed === '') return false
  const id = (fileRequest += 1)
  loading.value = true
  error.value = ''
  try {
    const result = await window.aurora.preview.read({ sessionId: props.sessionId, path: trimmed })
    if (id !== fileRequest) return false
    if (!result.ok) {
      // 读失败：清掉上一份内容，别让「旧文件正文 + 新错误」同屏
      current.value = null
      markdownHtml.value = ''
      error.value = result.message
      view.value = 'preview'
      return false
    }
    current.value = result.value
    markdownHtml.value =
      result.value.kind === 'markdown' && result.value.content !== undefined
        ? renderMarkdown(result.value.content)
        : ''
    saveRecent(result.value.path)
    view.value = 'preview'
    return true
  } catch (cause) {
    if (id !== fileRequest) return false
    current.value = null
    markdownHtml.value = ''
    error.value = cause instanceof Error ? cause.message : String(cause)
    view.value = 'preview'
    return false
  } finally {
    if (id === fileRequest) loading.value = false
  }
}

/** 应用一个位置：先保证目录列表可用，再按需预览文件 */
async function applyLocation(location: Location): Promise<void> {
  const listed = await loadDir(location.dir)
  if (!listed) {
    // 目录打不开（越界 / 已删除）：错误行留给用户，历史停在原地不前进
    return
  }
  if (location.file === undefined) {
    view.value = 'list'
    current.value = null
    markdownHtml.value = ''
    error.value = ''
    return
  }
  await readFile(location.file)
}

/** push 一步（前进链在 push 时截断，与浏览器一致） */
function pushHistory(location: Location): void {
  trail.value = trail.value.slice(0, cursor.value + 1)
  trail.value.push(location)
  cursor.value = trail.value.length - 1
}

/** 记一步并应用 */
function navigate(location: Location): void {
  pushHistory(location)
  void applyLocation(location)
}

function goBack(): void {
  if (!canGoBack.value) return
  cursor.value -= 1
  const target = trail.value[cursor.value]
  if (target !== undefined) void applyLocation(target)
}

function goForward(): void {
  if (!canGoForward.value) return
  cursor.value += 1
  const target = trail.value[cursor.value]
  if (target !== undefined) void applyLocation(target)
}

// ── 列表 / 工具条的交互 ──

/** 点目录：进下一层；点文件：预览（列表留在历史里，后退即回到同一层） */
function activate(entry: FileListEntry): void {
  if (entry.kind === 'dir') {
    navigate({ dir: entry.path })
    return
  }
  navigate({ dir: currentDir.value, file: entry.path })
}

function goUp(): void {
  const info = listing.value
  if (info === null || !canGoUp.value) return
  navigate({ dir: parentOf(info.dir) })
}

/** 点面包屑某一段：跳到该目录（push 一步，仍可后退） */
function jumpTo(path: string): void {
  if (path === currentDir.value) return
  navigate({ dir: path })
}

function goRoot(): void {
  const info = listing.value
  if (info === null || info.dir === info.root) return
  navigate({ dir: info.root })
}

/**
 * 预览态的「返回列表」：优先后退一步（历史里前一条正是同目录列表态）；
 * 没有可退的历史（例如刚打开面板就预览了一个文件）时退回当前目录列表，不 push。
 */
function exitPreview(): void {
  if (canGoBack.value) {
    goBack()
    return
  }
  view.value = 'list'
  current.value = null
  markdownHtml.value = ''
  error.value = ''
}

/** 路径输入 / 最近预览：读文件后把「它所在目录 + 自己」记成一步（重复预览同一文件不记） */
async function previewPath(path: string): Promise<void> {
  const ok = await readFile(path)
  const resolved = ok ? current.value?.path : undefined
  if (resolved === undefined) return
  const dir = parentOf(resolved)
  const here = trail.value[cursor.value]
  if (here !== undefined && here.dir === dir && here.file === resolved) return
  pushHistory({ dir, file: resolved })
  // 预加载它所在目录：预览态点「返回列表」时列表已就绪，面包屑也与文件位置一致
  if (dir !== currentDir.value) void loadDir(dir)
}

async function refresh(): Promise<void> {
  const here = trail.value[cursor.value]
  if (here === undefined) {
    await loadDir()
    return
  }
  await applyLocation(here)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') void previewPath(pathInput.value)
}

/** 会话切换：列表、预览与历史全部作废（旧路径按新会话的边界解析会越界） */
watch(
  () => props.sessionId,
  () => {
    listing.value = null
    current.value = null
    markdownHtml.value = ''
    error.value = ''
    listError.value = ''
    view.value = 'list'
    trail.value = []
    cursor.value = -1
    void bootstrap()
  },
  { immediate: true },
)

/** 首读：列出边界根，并把它作为历史的第一步 */
async function bootstrap(): Promise<void> {
  const ok = await loadDir()
  if (!ok || listing.value === null) return
  const root = listing.value.dir
  if (cursor.value === -1) {
    trail.value = [{ dir: root }]
    cursor.value = 0
  }
}
</script>

<template>
  <div class="fp" data-field="chat.file-preview">
    <div class="fp-input-row">
      <input
        v-model="pathInput"
        class="fp-input"
        type="text"
        placeholder="输入工作目录内的文件路径…"
        spellcheck="false"
        @keydown="onKeydown"
      />
      <button
        type="button"
        class="fp-go"
        :disabled="loading || pathInput.trim() === ''"
        @click="previewPath(pathInput)"
      >
        {{ loading ? '…' : '预览' }}
      </button>
    </div>

    <!--
      工具条：面包屑（根 + 各级目录，可点跳转）+ 导航（后退 / 前进 / 上级 / 刷新）。
      导航按钮恒在（图标化，见 shared/browser/icons.ts），只按状态置灰 ——
      此前这里的字形按钮在内容撑宽时会被挤出可视区，用户看到的就是「完全没有按钮」。
    -->
    <div class="fp-bar" data-field="chat.file-bar">
      <div class="fp-crumbs" data-field="chat.file-crumbs" :title="listing?.dir ?? ''">
        <button
          type="button"
          class="fp-crumb fp-crumb-root"
          data-field="chat.file-root"
          title="回到根目录"
          :disabled="listing === null"
          @click="goRoot"
        >
          <House :size="12" :stroke-width="1.7" aria-hidden="true" />
          <span class="fp-crumb-text">{{ rootLabel }}</span>
        </button>
        <template v-for="crumb in crumbs" :key="crumb.path">
          <ChevronRight class="fp-sep" :size="11" :stroke-width="2" aria-hidden="true" />
          <button
            type="button"
            class="fp-crumb"
            :class="{ current: crumb.path === currentDir }"
            :title="crumb.path"
            @click="jumpTo(crumb.path)"
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
          :disabled="!canGoBack"
          @click="goBack"
        >
          <ArrowLeft :size="13" :stroke-width="1.8" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="fp-mini"
          title="前进"
          data-field="chat.file-forward"
          :disabled="!canGoForward"
          @click="goForward"
        >
          <ArrowRight :size="13" :stroke-width="1.8" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="fp-mini"
          title="上级目录"
          data-field="chat.file-up"
          :disabled="!canGoUp"
          @click="goUp"
        >
          <ArrowUp :size="13" :stroke-width="1.8" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="fp-mini"
          title="刷新"
          data-field="chat.file-refresh"
          :disabled="listLoading || loading"
          @click="refresh"
        >
          <RotateCw :size="12" :stroke-width="1.8" aria-hidden="true" />
        </button>
      </div>
    </div>

    <p v-if="listError !== ''" class="fp-error tiny" data-field="chat.file-list-error">
      {{ listError }}
    </p>

    <!-- 列表视图：目录在前，点目录进入、点文件预览 -->
    <div v-if="view === 'list'" class="fp-list" data-field="chat.file-list">
      <p v-if="listLoading && listing === null" class="tiny muted">加载中…</p>
      <p v-else-if="listing !== null && listing.entries.length === 0" class="tiny muted">空目录</p>
      <button
        v-for="entry in listing?.entries ?? []"
        :key="entry.path"
        type="button"
        class="fp-row"
        :class="{ dir: entry.kind === 'dir' }"
        :title="entry.path"
        @click="activate(entry)"
      >
        <FolderOpen v-if="entry.kind === 'dir'" :size="12" :stroke-width="1.7" aria-hidden="true" />
        <FileText v-else :size="12" :stroke-width="1.7" aria-hidden="true" />
        <span class="fp-row-name">{{ entry.name }}</span>
        <span class="fp-row-size tiny muted">
          {{ entry.kind === 'dir' ? '' : formatExactCount(entry.bytes) }}
        </span>
      </button>
      <p v-if="listing?.truncated === true" class="tiny muted">条目过多，仅显示前 500 条</p>
    </div>

    <!-- 预览视图：返回按钮 + 元信息 + 正文 -->
    <div v-else class="fp-body">
      <div class="fp-preview-head">
        <button type="button" class="fp-exit" data-field="chat.file-exit" @click="exitPreview">
          <ArrowLeft :size="12" :stroke-width="1.8" aria-hidden="true" />
          返回列表
        </button>
        <span v-if="current !== null" class="fp-kind tiny" :data-kind="current.kind">
          {{ current.kind }}
        </span>
        <span v-if="current !== null" class="fp-path tiny muted" :title="current.path">
          {{ current.path }}
        </span>
        <span v-if="current !== null" class="fp-bytes tiny muted">
          {{ bytesText }} 字节<template v-if="current.truncated === true">（已截断）</template>
        </span>
      </div>
      <p v-if="error !== ''" class="fp-error tiny" data-field="chat.file-preview-error">
        {{ error }}
      </p>
      <template v-if="current !== null">
        <img
          v-if="current.kind === 'image' && current.dataUrl !== undefined"
          class="fp-image"
          :src="current.dataUrl"
          alt="文件预览"
        />
        <!-- markdown 走 shared 渲染器（html:false 白名单，与消息正文同一条安全基线） -->
        <!-- eslint-disable-next-line vue/no-v-html -- 渲染器输出已转义 + 白名单（docs/07 §5） -->
        <div v-else-if="current.kind === 'markdown'" class="md fp-markdown" v-html="markdownHtml" />
        <pre v-else-if="current.kind === 'text'" class="fp-text">{{ current.content }}</pre>
        <p v-else class="tiny muted">{{ current.note ?? '该文件类型不支持预览' }}</p>
      </template>
    </div>

    <div v-if="recent.length > 0 && view === 'list'" class="fp-recent">
      <p class="tiny muted fp-recent-title">最近预览</p>
      <button
        v-for="item in recent"
        :key="item"
        type="button"
        class="fp-recent-item tiny"
        :title="item"
        @click="previewPath(item)"
      >
        <FileText :size="12" :stroke-width="1.7" aria-hidden="true" />
        <span class="fp-recent-name">{{ item.split(/[\\/]/).pop() }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.fp {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 0;
  min-width: 0;
  height: 100%;
  padding: var(--space-2);
}

.fp-input-row {
  display: flex;
  gap: var(--space-1);
  flex: 0 0 auto;
  min-width: 0;
}

.fp-input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 4px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-primary);
  font-size: var(--text-xs);
}

.fp-input:focus {
  outline: none;
  border-color: var(--border-strong);
}

.fp-go {
  flex: 0 0 auto;
  padding: 4px 10px;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--fill-3);
  color: var(--text-secondary);
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

/* ── 工具条：面包屑（左，可横向滚动）+ 导航按钮（右，恒在） ── */
.fp-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
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
  max-width: 168px;
  padding: 1px 6px;
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
  width: 24px;
  height: 24px;
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

/* 置灰要「看得见但不亮」：此前用 0.35 透明度，浅色主题下几乎等于消失 */
.fp-mini:disabled {
  color: var(--text-muted);
  opacity: 0.55;
  cursor: default;
}

.fp-error {
  margin: 0;
  color: var(--status-error);
  line-height: var(--leading-normal);
  overflow-wrap: anywhere;
}

/* 目录列表：滚动区，行是整行可点按钮 */
.fp-list {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.fp-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 3px 6px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: var(--text-xs);
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

.fp-row-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fp-row-size {
  flex: 0 0 auto;
}

.fp-body {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  overflow: hidden;
}

.fp-preview-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}

.fp-exit {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--fill-3);
  color: var(--text-secondary);
  font-family: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
}

.fp-exit:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.fp-kind {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--fill-2);
  color: var(--text-secondary);
}

.fp-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fp-bytes {
  flex: 0 0 auto;
  white-space: nowrap;
}

.fp-image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: var(--radius-sm);
  align-self: center;
}

.fp-markdown {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  overflow: auto;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  /**
   * `anywhere` 是**布局护栏**而不只是排版偏好：长 URL / 长标识符会把整栏的
   * min-content 撑大（外层 grid 轨道的下限就是它），表现为「正文被窗口右缘切断、
   * 工具条按钮整排消失」。`anywhere` 让这些串可断行，min-content 随即塌回单字符。
   * 代码块不受影响（`pre` 是 `white-space: pre` + `overflow-x: auto`，自己横滚）。
   */
  overflow-wrap: anywhere;
}

.fp-text {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  margin: 0;
  overflow: auto;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-secondary);
  font-family: var(--font-mono, monospace);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.fp-recent {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 88px;
  overflow: auto;
}

.fp-recent-title {
  margin: 0;
}

.fp-recent-item {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 2px 4px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  text-align: left;
  cursor: pointer;
}

.fp-recent-item:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.fp-recent-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
