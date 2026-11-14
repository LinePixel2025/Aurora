<script setup lang="ts">
/*
 * 右栏「文件」面板（2026-10-03 起＝**小文件管理器 + 预览**，docs/07 §2.3）。
 *
 * 结构（自上而下）：
 * - 路径输入（「从消息 / 工具卡里看到路径 → 拿来预览」是主入口之一）；
 * - 工具条：面包屑（根 = 会话边界根，绑了项目就是**项目文件夹**）+ 后退 / 前进 / 上级 / 刷新
 *   + 即时搜索 + 排序切换；
 * - 正文：目录列表，或**同一面板内**的文件预览（markdown / 文本 / 图片 / Office 正文与版式）。
 *
 * 本文件只管**状态与编排**：历史栈、请求序号护栏、IPC 调用、标签标题上报。画面拆在
 * `file-panel/`（工具条 / 列表 / 预览正文 / 类型图标）；类名与 data-field 是截图探针的
 * 锚点，改名会让 chat-file-project 等场景直接打红。
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
import type {
  FileLayoutManifest,
  FileLayoutPage,
  FileListEntry,
  FileListResult,
  FilePreviewResult,
} from '@aurora/shared'
import { renderMarkdown } from '@aurora/shared/browser'
import '@aurora/shared/browser/markdown/md.css'
import FilePanelToolbar from './file-panel/FilePanelToolbar.vue'
import FilePanelList from './file-panel/FilePanelList.vue'
import FilePreviewBody from './file-panel/FilePreviewBody.vue'
import FileKindIcon from './file-panel/FileKindIcon.vue'
import type { FileSortKey } from './file-panel/fileTypeMeta'

const props = defineProps<{
  sessionId: string
  /** 当前会话绑定的项目名（未绑定 / 孤儿绑定时 undefined）：目录条据此换标题 */
  projectName?: string
  /**
   * 外部请求打开某个文件（2026-11-07，docs/07 §2.3）：对话尾部「本次改动文件」卡片点击后，
   * 由 `App.vue` 打开「文件」标签并把 `{ path, token }` 传进来。`token` 单调递增 ——
   * 同一路径再次请求也必须重新预览（只比 path 会漏掉「又来了一次」）。
   */
  openRequest?: { path: string; token: number } | null
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
/** 渲染后的 markdown html（markdown 与 document 正文共用） */
const markdownHtml = ref('')

// ── 目录列表（文件管理器） ──

const listing = ref<FileListResult | null>(null)
const listError = ref('')
const listLoading = ref(false)
/** 视图：列表 / 预览（预览时列表让位，「返回列表」按钮负责切回） */
const view = ref<'list' | 'preview'>('list')

// ── 纯视图态（不进历史栈；排序是跨会话保留的用户偏好） ──

const query = ref('')
const sortKey = ref<FileSortKey>('name')
const sortDir = ref<'asc' | 'desc'>('asc')
const selectedPath = ref('')

// ── Office 双视图（正文秒开，版式按需渲染） ──

const layoutMode = ref<'body' | 'layout'>('body')
const layout = ref<FileLayoutManifest | null>(null)
const layoutPage = ref<FileLayoutPage | null>(null)
const layoutLoading = ref(false)
const layoutError = ref('')

// ── 交给系统 ──

const opening = ref(false)
const openError = ref('')
/** 已自动外开过的路径：防止连点同一行反复拉起系统程序 */
let openedFor = ''

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

/** 面包屑根标签：绑定了项目就是项目文件夹，否则是会话工作目录 */
const rootLabel = computed(() =>
  props.projectName === undefined ? '工作目录' : `项目：${props.projectName}`,
)

/** 能否上升一层：当前目录不等于边界根才给「上级」 */
const canGoUp = computed(() => {
  const info = listing.value
  return info !== null && relativeTo(info.root, info.dir) !== ''
})

/**
 * 搜索 + 排序后的条目。**默认口径必须与主进程逐字一致**（目录优先 + 名称数字感知升序）：
 * 截图探针按首行是不是目录、按行数断言，改了默认序就是自己给自己造恒红。
 */
const filteredEntries = computed(() => {
  const entries = listing.value?.entries ?? []
  const keyword = query.value.trim().toLowerCase()
  const matched =
    keyword === '' ? entries : entries.filter((entry) => entry.name.toLowerCase().includes(keyword))
  const sign = sortDir.value === 'asc' ? 1 : -1
  return [...matched].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'dir' ? -1 : 1
    let order = 0
    if (sortKey.value === 'size') order = left.bytes - right.bytes
    else if (sortKey.value === 'mtime') order = (left.mtimeMs ?? 0) - (right.mtimeMs ?? 0)
    // 主键相等（含按名称排序）时一律回落到名称，同大小 / 同时间的条目顺序才稳定
    if (order === 0) {
      order = left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
    }
    return order * sign
  })
})

/** 点当前排序键 = 翻转升降序；换键时大小 / 时间默认降序（最大 / 最新在前） */
function toggleSort(key: FileSortKey): void {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
    return
  }
  sortKey.value = key
  sortDir.value = key === 'name' ? 'asc' : 'desc'
}

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
 * 请求序号护栏：列表、读盘、版式都允许并发，**只认最后一次**的结果。
 * 旧实现是「正在加载就 return」——快速连点两下目录时第二下被静默丢掉，
 * 用户看到的是「点了没反应」（与历史栈一起改掉）。
 */
let dirRequest = 0
let fileRequest = 0
let layoutRequest = 0
/** 最近一次请求的页码：与 `layoutRequest` 双判，慢的那一页回来也不许覆盖新页 */
let wantedPage = 0

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
  // 换文件 = 上一份版式作废（序号 +1 让在途的渲染 / 取页回来时自己丢弃）
  layoutRequest += 1
  layoutMode.value = 'body'
  layout.value = null
  layoutPage.value = null
  layoutLoading.value = false
  layoutError.value = ''
  openError.value = ''
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
    const kind = result.value.kind
    markdownHtml.value =
      (kind === 'markdown' || kind === 'document') && result.value.content !== undefined
        ? renderMarkdown(result.value.content)
        : ''
    selectedPath.value = result.value.path
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
  // 换目录才清搜索词；同层刷新（刷新钮 / 后退回到同一层）保留用户正在敲的过滤
  if (location.dir !== listing.value?.dir) query.value = ''
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

/**
 * 点目录：进下一层；点文件：预览（列表留在历史里，后退即回到同一层）。
 * 预览不了的类型**单击即交给系统默认程序** —— 用户点它就是想打开它，
 * 不该只回一句「不支持预览」再让人自己去资源管理器里找。
 */
async function activate(entry: FileListEntry): Promise<void> {
  if (entry.kind === 'dir') {
    navigate({ dir: entry.path })
    return
  }
  const location: Location = { dir: currentDir.value, file: entry.path }
  pushHistory(location)
  await applyLocation(location)
  const opened = current.value
  if (opened === null || opened.kind !== 'unsupported' || openedFor === opened.path) return
  openedFor = opened.path
  await openWith('default')
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

/**
 * 外部打开请求（对话尾部改动文件卡片，2026-11-07）：`token` 变化才执行一次。
 * 预览失败（越界 / 已删除）由 `readFile` 把原因写进面板错误行，这里不额外弹窗。
 */
watch(
  () => props.openRequest?.token,
  () => {
    const request = props.openRequest
    if (request === undefined || request === null || request.path.trim() === '') return
    pathInput.value = request.path
    void previewPath(request.path)
  },
)

async function refresh(): Promise<void> {
  const here = trail.value[cursor.value]
  if (here === undefined) {
    await loadDir()
    return
  }
  await applyLocation(here)
}

// ── Office 版式（按需触发，失败一律回落正文） ──

function setMode(mode: 'body' | 'layout'): void {
  if (mode === 'body') {
    layoutMode.value = 'body'
    return
  }
  if (current.value?.layoutAvailable !== true) return
  layoutMode.value = 'layout'
  if (layout.value === null) void loadLayout()
}

/** 渲染失败不留在空白版式页：退回正文并把原因写出来，用户至少读得到内容 */
function fallbackToBody(message: string): void {
  layoutMode.value = 'body'
  layout.value = null
  layoutPage.value = null
  layoutError.value = `${message}，已显示正文`
}

async function loadLayout(): Promise<void> {
  const target = current.value
  if (target === null) return
  const id = (layoutRequest += 1)
  layoutLoading.value = true
  layoutError.value = ''
  try {
    const result = await window.aurora.preview.render({
      sessionId: props.sessionId,
      path: target.path,
    })
    if (id !== layoutRequest) return
    if (!result.ok) {
      fallbackToBody(result.message)
      return
    }
    layout.value = result.value
    layoutPage.value = result.value.firstPage ?? null
    // manifest 只带首页；首页缺失时按普通取页补一次
    if (layoutPage.value === null) await loadPage(0, id)
  } catch (cause) {
    if (id !== layoutRequest) return
    fallbackToBody(cause instanceof Error ? cause.message : String(cause))
  } finally {
    if (id === layoutRequest) layoutLoading.value = false
  }
}

async function loadPage(index: number, id = layoutRequest): Promise<void> {
  const manifest = layout.value
  if (manifest === null || index < 0 || index >= manifest.pageCount) return
  wantedPage = index
  layoutLoading.value = true
  layoutError.value = ''
  try {
    const result = await window.aurora.preview.renderPage({
      sessionId: props.sessionId,
      renderId: manifest.renderId,
      index,
    })
    if (id !== layoutRequest || wantedPage !== index) return
    if (!result.ok) {
      layoutError.value = result.message
      return
    }
    layoutPage.value = result.value
  } catch (cause) {
    if (id !== layoutRequest || wantedPage !== index) return
    layoutError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (id === layoutRequest && wantedPage === index) layoutLoading.value = false
  }
}

function retryLayout(): void {
  layoutError.value = ''
  if (current.value?.layoutAvailable !== true) return
  layoutMode.value = 'layout'
  void loadLayout()
}

// ── 交给系统（用户直接点击，不走工具确认闸门） ──

async function openWith(mode: 'default' | 'reveal'): Promise<void> {
  const path = current.value?.path
  if (path === undefined || opening.value) return
  opening.value = true
  openError.value = ''
  try {
    const result = await window.aurora.preview.open({ sessionId: props.sessionId, path, mode })
    if (!result.ok) openError.value = result.message
  } catch (cause) {
    openError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    opening.value = false
  }
}

/** 会话切换：列表、预览、版式与历史全部作废（旧路径按新会话的边界解析会越界） */
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
    query.value = ''
    selectedPath.value = ''
    layoutRequest += 1
    layoutMode.value = 'body'
    layout.value = null
    layoutPage.value = null
    layoutLoading.value = false
    layoutError.value = ''
    openError.value = ''
    openedFor = ''
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
    <FilePanelToolbar
      v-model:path-input="pathInput"
      v-model:query="query"
      :loading="loading"
      :busy="listLoading || loading"
      :root-label="rootLabel"
      :crumbs="crumbs"
      :current-dir="currentDir"
      :listing-dir="listing?.dir ?? ''"
      :has-listing="listing !== null"
      :can-go-back="canGoBack"
      :can-go-forward="canGoForward"
      :can-go-up="canGoUp"
      :sort-key="sortKey"
      :sort-dir="sortDir"
      :show-filter="view === 'list'"
      @preview="previewPath(pathInput)"
      @root="goRoot"
      @jump="jumpTo"
      @back="goBack"
      @forward="goForward"
      @up="goUp"
      @refresh="refresh"
      @sort="toggleSort"
    />

    <p v-if="listError !== ''" class="fp-list-error" data-field="chat.file-list-error">
      {{ listError }}
    </p>

    <FilePanelList
      v-if="view === 'list'"
      :entries="filteredEntries"
      :loading="listLoading"
      :has-listing="listing !== null"
      :query="query"
      :selected-path="selectedPath"
      :truncated="listing?.truncated === true"
      @activate="activate"
      @clear-query="query = ''"
    />

    <FilePreviewBody
      v-else
      :current="current"
      :markdown-html="markdownHtml"
      :error="error"
      :loading="loading"
      :layout-mode="layoutMode"
      :layout="layout"
      :layout-page="layoutPage"
      :layout-loading="layoutLoading"
      :layout-error="layoutError"
      :opening="opening"
      :open-error="openError"
      @exit="exitPreview"
      @open="openWith"
      @mode="setMode"
      @page="loadPage"
      @retry-layout="retryLayout"
    />

    <div v-if="recent.length > 0 && view === 'list'" class="fp-recent">
      <p class="fp-recent-title">最近预览</p>
      <button
        v-for="item in recent"
        :key="item"
        type="button"
        class="fp-recent-item"
        :title="item"
        @click="previewPath(item)"
      >
        <FileKindIcon :name="item" :size="13" :box="18" />
        <span class="fp-recent-name">{{ lastSegment(item) }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.fp {
  /* 窄栏降级靠容器查询（右栏可拖到 280px），不是视口宽度 */
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 0;
  min-width: 0;
  height: 100%;
  padding: var(--space-2);
  /**
   * 文件类型色相（docs/07 §5「组件作用域语义色的唯一例外」）：只在本面板定义一次，
   * 子组件按 `data-tone` 取用，行内不散落 hex。这些颜色表达的是**文件类型**而不是
   * 应用状态，所以不进 theme.css 令牌表（进了就得让 Center 网页端一起背这套语义）。
   */
  --fp-word: #5b9dff;
  --fp-excel: #4cc38a;
  --fp-ppt: #ff9f45;
  --fp-pdf: #ff6b6b;
  --fp-image: #b58cff;
  --fp-code: #4cc9d9;
  --fp-archive: #e0b341;
  --fp-media: #ff7ac6;
  --fp-text: #9aa4b2;
}

@media (prefers-color-scheme: light) {
  .fp {
    --fp-word: #2563eb;
    --fp-excel: #15803d;
    --fp-ppt: #c2410c;
    --fp-pdf: #dc2626;
    --fp-image: #7c3aed;
    --fp-code: #0e7490;
    --fp-archive: #a16207;
    --fp-media: #be185d;
    --fp-text: #64748b;
  }
}

.fp :deep([data-tone='folder']) {
  --fp-tone: var(--accent-text);
}

.fp :deep([data-tone='word']) {
  --fp-tone: var(--fp-word);
}

.fp :deep([data-tone='excel']) {
  --fp-tone: var(--fp-excel);
}

.fp :deep([data-tone='ppt']) {
  --fp-tone: var(--fp-ppt);
}

.fp :deep([data-tone='pdf']) {
  --fp-tone: var(--fp-pdf);
}

.fp :deep([data-tone='image']) {
  --fp-tone: var(--fp-image);
}

.fp :deep([data-tone='code']) {
  --fp-tone: var(--fp-code);
}

.fp :deep([data-tone='archive']) {
  --fp-tone: var(--fp-archive);
}

.fp :deep([data-tone='media']) {
  --fp-tone: var(--fp-media);
}

.fp :deep([data-tone='text']) {
  --fp-tone: var(--fp-text);
}

.fp :deep([data-tone='unknown']) {
  --fp-tone: var(--text-muted);
}

.fp-list-error {
  flex: 0 0 auto;
  margin: 0;
  color: var(--status-error);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  overflow-wrap: anywhere;
}

.fp-recent {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 96px;
  overflow: auto;
}

.fp-recent-title {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.fp-recent-item {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  height: 26px;
  padding: 0 6px;
  border: 0;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: var(--text-xs);
  text-align: left;
  cursor: pointer;
}

.fp-recent-item:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.fp-recent-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
