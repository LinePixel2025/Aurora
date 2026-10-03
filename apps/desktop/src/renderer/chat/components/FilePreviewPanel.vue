<script setup lang="ts">
/*
 * 右栏「文件」面板（2026-10-03 起＝**小文件管理器 + 预览**，docs/07 §2.3）。
 *
 * 结构：
 * - 顶部路径输入仍保留（「从消息 / 工具卡里看到路径 → 拿来预览」是主入口之一）；
 * - 目录条 + 列表：缺省列出**会话边界根** —— 会话绑定了项目就是**项目文件夹**
 *   （`preview:list`，主进程按会话现解析，会话没有项目时是 Agent / Work 空间目录）；
 *   「上级」按钮止于边界根，不允许走到根之外；
 * - 点目录进下一层，点文件在**同一面板内**预览（markdown 走渲染器 / 文本 / 图片）；
 * - 「最近预览」是 localStorage 记忆，最多 8 条（预览入口的快捷方式）。
 *
 * 能力边界（与主进程 `file-preview.ts` / `file-list.ts` 的口径一一对应）：
 * - 只能读写**发起会话边界根之内**的路径（越界主进程拒绝，文案原样展示）；
 * - 文本 2 MB / 图片 10 MB；文本超限截断显示并标记，图片超限拒绝；
 * - 二进制文件返回 `unsupported`（只给原因，不渲染乱码）；列目录上限 500 条。
 */
import { computed, ref, watch } from 'vue'
import type { FileListEntry, FileListResult, FilePreviewResult } from '@aurora/shared'
import { FileText, FolderOpen, formatExactCount, renderMarkdown } from '@aurora/shared/browser'
import '@aurora/shared/browser/markdown/md.css'

const props = defineProps<{
  sessionId: string
  /** 当前会话绑定的项目名（未绑定 / 孤儿绑定时 undefined）：目录条据此换标题 */
  projectName?: string
}>()

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
/** 视图：列表 / 预览（预览时列表让位，顶部目录条与「返回」按钮负责切回） */
const view = ref<'list' | 'preview'>('list')

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

/** 目录条上的标签：绑定了项目就是项目文件夹，否则是会话工作目录 */
const rootLabel = computed(() =>
  props.projectName === undefined ? '工作目录' : `项目：${props.projectName}`,
)

/** 当前目录相对边界的显示串（根内相对路径；根本身显示 `·`） */
const dirLabel = computed(() => {
  const info = listing.value
  if (info === null) return '…'
  const rel = relativeTo(info.root, info.dir)
  return rel === '' ? '·' : rel
})

/** 能否上升一层：当前目录不等于边界根才给「上级」 */
const canGoUp = computed(() => {
  const info = listing.value
  return info !== null && relativeTo(info.root, info.dir) !== ''
})

/** `dir` 相对 `root` 的路径（Windows / POSIX 两种分隔符都认）；同路径返回空串 */
function relativeTo(root: string, dir: string): string {
  const prefix = root.endsWith('\\') || root.endsWith('/') ? root : `${root}\\`
  if (dir === root) return ''
  if (dir.startsWith(prefix)) return dir.slice(prefix.length).split(/[\\/]/).join('/')
  return dir
}

/** 上一级目录（到边界根为止；调用方先用 `canGoUp` 判过） */
function parentOf(dir: string): string {
  const cut = Math.max(dir.lastIndexOf('\\'), dir.lastIndexOf('/'))
  return cut > 0 ? dir.slice(0, cut) : dir
}

async function loadDir(path?: string): Promise<void> {
  if (listLoading.value) return
  listLoading.value = true
  listError.value = ''
  try {
    const result = await window.aurora.preview.list({
      sessionId: props.sessionId,
      ...(path === undefined ? {} : { path }),
    })
    if (!result.ok) {
      listError.value = result.message
      return
    }
    listing.value = result.value
  } catch (cause) {
    listError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    listLoading.value = false
  }
}

/** 点目录：进下一层；点文件：预览（不改 cwd，返回时还在同一层） */
function activate(entry: FileListEntry): void {
  if (entry.kind === 'dir') {
    void loadDir(entry.path)
    return
  }
  void open(entry.path)
}

function goUp(): void {
  const info = listing.value
  if (info === null || !canGoUp.value) return
  void loadDir(parentOf(info.dir))
}

async function open(path: string): Promise<void> {
  const trimmed = path.trim()
  if (trimmed === '' || loading.value) return
  loading.value = true
  error.value = ''
  try {
    const result = await window.aurora.preview.read({ sessionId: props.sessionId, path: trimmed })
    if (!result.ok) {
      error.value = result.message
      view.value = 'preview'
      return
    }
    current.value = result.value
    markdownHtml.value =
      result.value.kind === 'markdown' && result.value.content !== undefined
        ? renderMarkdown(result.value.content)
        : ''
    saveRecent(result.value.path)
    view.value = 'preview'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
    view.value = 'preview'
  } finally {
    loading.value = false
  }
}

function backToList(): void {
  view.value = 'list'
  error.value = ''
}

async function refresh(): Promise<void> {
  // 刷新当前目录；预览态下顺带刷新根（用户多半刚在别处写过文件）
  await loadDir(listing.value?.dir)
  if (view.value === 'preview' && current.value !== null) await open(current.value.path)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') void open(pathInput.value)
}

/** 会话切换：列表与预览都要按新会话的边界重来（旧路径一律作废） */
watch(
  () => props.sessionId,
  () => {
    listing.value = null
    current.value = null
    markdownHtml.value = ''
    error.value = ''
    listError.value = ''
    view.value = 'list'
    void loadDir()
  },
  { immediate: true },
)
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
        @click="open(pathInput)"
      >
        {{ loading ? '…' : '预览' }}
      </button>
    </div>

    <!-- 目录条：根标签（项目文件夹 / 工作目录）+ 当前相对路径 + 刷新 / 上级 -->
    <div class="fp-dirbar" data-field="chat.file-root">
      <span class="fp-root tiny" :title="listing?.root ?? ''">{{ rootLabel }}</span>
      <span class="fp-dir tiny muted" data-field="chat.file-dir" :title="listing?.dir ?? ''">
        {{ dirLabel }}
      </span>
      <span class="grow" />
      <button type="button" class="fp-mini" title="刷新" @click="refresh">⟳</button>
      <button
        type="button"
        class="fp-mini"
        title="上级目录"
        :disabled="!canGoUp"
        data-field="chat.file-up"
        @click="goUp"
      >
        ⤴
      </button>
      <button
        v-if="view === 'preview'"
        type="button"
        class="fp-mini fp-back"
        data-field="chat.file-back"
        @click="backToList"
      >
        ← 返回
      </button>
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

    <!-- 预览视图：错误与内容都在这里（返回按钮在目录条右侧） -->
    <div v-else class="fp-body">
      <p v-if="error !== ''" class="fp-error tiny" data-field="chat.file-preview-error">
        {{ error }}
      </p>
      <template v-if="current !== null">
        <p class="fp-meta tiny muted">
          <span class="fp-kind" :data-kind="current.kind">{{ current.kind }}</span>
          <span class="fp-path">{{ current.path }}</span>
          {{ bytesText }} 字节<template v-if="current.truncated === true">（已截断）</template>
        </p>
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
        @click="open(item)"
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
  height: 100%;
  padding: var(--space-2);
}

.fp-input-row {
  display: flex;
  gap: var(--space-1);
  flex: 0 0 auto;
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

/* 目录条：根标签 + 相对路径 + 三个小按钮 */
.fp-dirbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}

.fp-root {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--fill-2);
  color: var(--text-secondary);
}

.fp-dir {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fp-mini {
  flex: 0 0 auto;
  padding: 1px 6px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--text-xs);
  cursor: pointer;
}

.fp-mini:hover:not(:disabled) {
  background: var(--fill-2);
  color: var(--text-primary);
}

.fp-mini:disabled {
  opacity: 0.35;
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
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  overflow: hidden;
}

.fp-meta {
  margin: 0;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
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
  overflow: auto;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
}

.fp-text {
  flex: 1 1 auto;
  min-height: 0;
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
