<script setup lang="ts">
/**
 * 右侧提示条（docs/07 §2.2）：贴屏幕右缘的 8px 竖条 + 悬停展开的全高面板。
 *
 * 行为契约：
 * - 鼠标悬停 → 主进程把宿主 shape 扩到面板区域（`window:setEdgeBarExpanded`），面板从右滑入；
 *   移开鼠标 → 面板淡出后再把 shape 收回 8px（否则屏幕右侧会留一块看不见却挡鼠标的区域）；
 * - 鼠标点击竖条 → 呼出主界面（`window:showChat`，chat 窗即主界面）；展开态下竖条仍贴着
 *   屏幕右缘，仍是有效点击目标；
 * - 触摸 / 触控笔没有 hover：点按竖条直接展开 / 收起，且保持到用户显式收起；
 * - 面板内容：自感知状态 → 文件提醒 → 最近理解 → 上下文摘要，底部是三个操作入口。
 *   提示条不承载对话输入；快速会话仍从主界面左栏固定项进入。
 *   窗口始终保持 `focusable: false`，悬停展开不抢键盘焦点。
 *
 * 几何预算（不要突破）：展开窗口 328px = 竖条 8px + 面板 320px。
 * 面板宽度写死 320px，任何内部布局都在这个宽度内成立，否则会被窗口裁切。
 *
 * 拖动：**刻意不提供**。本窗 `focusable: false`，宿主位置与尺寸由主进程按「工作区边缘 +
 * 垂直居中 + 展开态宿主」推导，可见 / 可点区域再由原生 shape 裁切，不参与用户拖动，
 * 因此模板里不挂 `drag-region`（不在 `useWindowDrag` 的清单里，docs/07 §2.2）。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type {
  FileAwarenessAnalysisStage,
  FileAwarenessNote,
  FileAwarenessRecord,
  FileAwarenessStatus,
  FileAwarenessSuggestion,
} from '@aurora/shared'
import AppButton from '../shared/components/AppButton.vue'
import StatusDot from '../shared/components/StatusDot.vue'
import {
  BookOpen,
  ChevronDown,
  Clock,
  FolderSearch,
  LoaderCircle,
  MessageSquare,
  SettingsGear,
  X,
} from '@aurora/shared/browser'
import {
  useModeStore,
  usePerceptionStore,
  useSettingsStore,
  useWindowStore,
} from '../shared/stores.js'

/** 悬停多久才展开：太短会被鼠标划过边缘误触发，太长显得迟钝 */
const EXPAND_DELAY_MS = 120
/** 移开多久才收起：给用户从竖条移到面板的容错时间 */
const COLLAPSE_DELAY_MS = 220
const windowStore = useWindowStore()
const settingsStore = useSettingsStore()
const modeStore = useModeStore()
const perception = usePerceptionStore()

const expanded = ref(false)
let expandTimer: ReturnType<typeof setTimeout> | undefined
let collapseTimer: ReturnType<typeof setTimeout> | undefined

function clearTimers(): void {
  clearTimeout(expandTimer)
  clearTimeout(collapseTimer)
  expandTimer = undefined
  collapseTimer = undefined
}

const suggestions = ref<FileAwarenessSuggestion[]>([])
const suggestionsExpanded = ref(false)
const suggestionBusy = ref(false)
const suggestionError = ref('')
let offAwarenessSuggestion: (() => void) | null = null
const awarenessStatus = ref<FileAwarenessStatus | null>(null)
const awarenessNotes = ref<FileAwarenessNote[]>([])
const awarenessRecords = ref<FileAwarenessRecord[]>([])
const awarenessBusy = ref(false)
let offAwarenessChanged: (() => void) | null = null
let awarenessPromise: Promise<void> | null = null

function onAwarenessSuggestion(next: FileAwarenessSuggestion): void {
  if (suggestions.value.some((item) => item.id === next.id)) return
  const before = suggestions.value.length
  suggestions.value = [next, ...suggestions.value]
  if (before === 1) suggestionsExpanded.value = false
  suggestionError.value = ''
  suggestionBusy.value = false
  clearTimeout(collapseTimer)
  collapseTimer = undefined
  void windowStore.setEdgeBarExpanded(true)
  expanded.value = true
}

async function executeSuggestion(current: FileAwarenessSuggestion): Promise<void> {
  if (current.action === undefined || suggestionBusy.value) return
  suggestionBusy.value = true
  suggestionError.value = ''
  try {
    const result = await window.aurora.awareness.execute({ suggestionId: current.id })
    if (!result.ok) {
      suggestionError.value = result.message
      return
    }
    removeSuggestion(current.id)
    collapseNow()
  } finally {
    suggestionBusy.value = false
  }
}

async function viewSuggestion(current: FileAwarenessSuggestion): Promise<void> {
  const result = await window.aurora.awareness.presentNote({ noteId: current.noteId })
  if (!result.ok) suggestionError.value = result.message
}

async function openSuggestionSource(current: FileAwarenessSuggestion): Promise<void> {
  await window.aurora.awareness.openSource({ noteId: current.noteId })
}

async function ignoreSuggestion(current: FileAwarenessSuggestion): Promise<void> {
  await window.aurora.awareness.ignore({ suggestionId: current.id })
  removeSuggestion(current.id)
}

function removeSuggestion(id: string): void {
  suggestions.value = suggestions.value.filter((item) => item.id !== id)
  if (suggestions.value.length < 2) suggestionsExpanded.value = false
  suggestionBusy.value = false
  suggestionError.value = ''
}

function toggleSuggestions(): void {
  suggestionsExpanded.value = !suggestionsExpanded.value
}

/**
 * 自感知工作台数据：只在面板展开时拉取，事件驱动 + 30s 低频兜底。
 *
 * status / notes / records 都是主进程内存快照，按需读取；不在这里轮询文件系统，
 * 避免常驻提示条重新引入后台 CPU / IO。
 */
async function refreshAwareness(): Promise<void> {
  if (awarenessPromise !== null) return awarenessPromise
  awarenessBusy.value = true
  awarenessPromise = (async () => {
    try {
      const [statusResult, notesResult, recordsResult] = await Promise.all([
        window.aurora.awareness.status(),
        window.aurora.awareness.notes({ limit: 50 }),
        window.aurora.awareness.records({ limit: 12 }),
      ])
      if (statusResult.ok) awarenessStatus.value = statusResult.value
      if (notesResult.ok) awarenessNotes.value = notesResult.value
      if (recordsResult.ok) awarenessRecords.value = recordsResult.value
    } finally {
      awarenessBusy.value = false
      awarenessPromise = null
    }
  })()
  return awarenessPromise
}

function onAwarenessChanged(): void {
  if (!expanded.value) return
  void refreshAwareness()
}

const awarenessTone = computed<'idle' | 'running' | 'unread' | 'error'>(() => {
  const status = awarenessStatus.value
  if (status?.lastError) return 'error'
  if (!status?.enabled || !status.consentAccepted) return 'idle'
  if (status.waitingForAgent) return 'unread'
  if (status.waitingForModel || !status.knowledgeDirAvailable) return 'unread'
  return status.active ? 'running' : 'idle'
})

const awarenessLabel = computed(() => {
  const status = awarenessStatus.value
  if (status === null) return '读取状态…'
  if (!status.enabled || !status.consentAccepted) return '未启用'
  if (status.waitingForAgent) return '等待 Agent'
  if (!status.knowledgeDirAvailable) return '知识库不可用'
  if (status.waitingForModel) return '等待模型'
  if (status.lastError) return '需要处理'
  return status.active ? '正在感知' : '已暂停'
})

const ANALYSIS_STAGE_VIEW: Record<
  FileAwarenessAnalysisStage,
  { label: string; percent: number; running: boolean }
> = {
  queued: { label: '等待分析', percent: 8, running: false },
  extracting: { label: '提取内容', percent: 35, running: true },
  analyzing: { label: '分析内容', percent: 75, running: true },
  writing: { label: '写入记忆', percent: 95, running: true },
}

const analysisProgress = computed<
  | ((typeof ANALYSIS_STAGE_VIEW)[FileAwarenessAnalysisStage] & {
      stage: FileAwarenessAnalysisStage
      fileName: string
    })
  | null
>(() => {
  const status = awarenessStatus.value
  const progress = status?.analysisProgress
  if (status === null || progress === undefined) return null
  if (!status.enabled || !status.consentAccepted || !status.knowledgeDirAvailable) return null
  return {
    ...ANALYSIS_STAGE_VIEW[progress.stage],
    stage: progress.stage,
    fileName: progress.fileName,
  }
})

const awarenessHint = computed(() => {
  const status = awarenessStatus.value
  if (status === null) return '正在读取文件自感知状态'
  if (!status.enabled || !status.consentAccepted) return '在设置中开启后，才会分析选定目录'
  if (status.waitingForAgent) return '前台 Agent 正在工作，自感知队列已暂停'
  if (!status.knowledgeDirAvailable) return '知识库目录不存在，文件仍不会出网'
  if (status.waitingForModel) return '监听已就绪，配置模型后开始分析'
  if (status.lastError) return status.lastError
  if (analysisProgress.value?.stage === 'queued') return '等待处理已发现的新文件'
  if (analysisProgress.value !== null) return '后台正在处理文件内容'
  return status.lastScanAt ? '已同步最近文件变化' : '等待目录中的新变化'
})

type InsightItem = {
  id: string
  title: string
  detail: string
  time: string
  kind: string
  sortAt: string
  noteId?: string
  tone: 'done' | 'active' | 'warning' | 'idle'
}

function formatClock(value: string | undefined): string {
  if (value === undefined || value === '') return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function recordLabel(record: FileAwarenessRecord): string {
  switch (record.status) {
    case 'done':
      return '已理解'
    case 'conflict':
      return '有冲突'
    case 'error':
      return '失败'
    case 'skipped':
      return record.kind === 'delete' ? '已删除' : '已跳过'
  }
}

function recordTone(record: FileAwarenessRecord): InsightItem['tone'] {
  if (record.status === 'error' || record.status === 'conflict') return 'warning'
  if (record.status === 'done') return 'done'
  return 'idle'
}

const insightItems = computed<InsightItem[]>(() => {
  const noteItems: InsightItem[] = awarenessNotes.value.map((note) => ({
    id: `note-${note.id}`,
    title: note.title,
    detail: note.excerpt || note.sourcePath,
    time: formatClock(note.updatedAt),
    kind: note.ext.toUpperCase(),
    sortAt: note.updatedAt,
    noteId: note.id,
    tone: note.conflict ? 'warning' : 'done',
  }))
  const seen = new Set(awarenessNotes.value.map((note) => note.sourcePath.toLowerCase()))
  const recordItems: InsightItem[] = awarenessRecords.value
    .filter((record) => !seen.has(record.sourcePath.toLowerCase()))
    .map((record) => ({
      id: `record-${record.id}`,
      title: record.fileName,
      detail: record.summary || record.error || `${recordLabel(record)} · 尚未生成笔记`,
      time: formatClock(record.occurredAt),
      kind: record.ext.toUpperCase() || record.kind,
      sortAt: record.occurredAt,
      ...(record.noteId === undefined ? {} : { noteId: record.noteId }),
      tone: recordTone(record),
    }))
  return [...noteItems, ...recordItems]
    .sort((left, right) => right.sortAt.localeCompare(left.sortAt))
    .slice(0, 5)
})

const insightTotal = computed(() => {
  const seen = new Set(awarenessNotes.value.map((note) => note.sourcePath.toLowerCase()))
  return (
    awarenessNotes.value.length +
    awarenessRecords.value.filter((record) => !seen.has(record.sourcePath.toLowerCase())).length
  )
})

const systemChips = computed(() => {
  const summary = perception.summary
  if (summary === null) return []
  const chips: string[] = []
  if (summary.battery) {
    chips.push(
      summary.battery.hasBattery
        ? `${summary.battery.percent}%${summary.battery.isCharging ? ' 充电中' : ''}`
        : '交流电',
    )
  }
  if (summary.network) chips.push(summary.network.online ? '网络在线' : '网络离线')
  if (summary.foreground) chips.push(summary.foreground.app || summary.foreground.title)
  return chips
})

/**
 * 悬停进入：宿主 shape 先切换，面板后出现。宿主尺寸始终稳定，因此这里只负责
 * 渲染层的淡入 / 滑入，不再触发原生窗口尺寸变化。
 *
 * **不做 `if (expanded.value) return` 早退**：主进程可能在我们不知情时把提示条隐藏
 * （勿扰时段的 `EdgeBarScheduler`、设置页的「立即显隐」），shape 已被收回 8px 而渲染层的
 * `expanded` 仍是 true；早退会让面板渲染在收起 shape 里被裁掉且无法自愈。
 * `setEdgeBarExpanded` 在主进程是幂等的，无条件调用即是最省事的自愈路径。
 */
function onPointerEnter(event: PointerEvent): void {
  if (event.pointerType !== 'mouse') return
  clearTimeout(collapseTimer)
  collapseTimer = undefined
  expandTimer = setTimeout(() => {
    expandTimer = undefined
    expandPanel()
  }, EXPAND_DELAY_MS)
}

/** 收起链：面板先淡出，动画结束后再把 shape 收回竖条。 */
function scheduleCollapse(): void {
  clearTimeout(expandTimer)
  expandTimer = undefined
  clearTimeout(collapseTimer)
  collapseTimer = setTimeout(() => {
    collapseTimer = undefined
    collapseNow()
  }, COLLAPSE_DELAY_MS)
}

function onPointerLeave(event: PointerEvent): void {
  if (event.pointerType !== 'mouse') return
  scheduleCollapse()
}

function expandPanel(): void {
  clearTimers()
  void (async () => {
    await windowStore.setEdgeBarExpanded(true)
    expanded.value = true
  })()
}

function finishCollapse(): void {
  if (expanded.value) return
  void windowStore.setEdgeBarExpanded(false)
}

/** 面板退场结束后才收回原生 shape，避免固定计时器与真实过渡时长漂移。 */
function onPanelAfterLeave(): void {
  finishCollapse()
}

/** 面板内的操作：立即进入退场；shape 等 `after-leave` 再收回。 */
function collapseNow(): void {
  clearTimers()
  if (!expanded.value) {
    finishCollapse()
    return
  }
  expanded.value = false
}

const statusLabel = computed(() =>
  awarenessTone.value === 'error'
    ? '需处理'
    : awarenessTone.value === 'running'
      ? '感知中'
      : awarenessTone.value === 'unread'
        ? '待处理'
        : '闲置',
)
/**
 * 展开期间的系统状态刷新间隔（与右栏 ContextPanel 同口径 30s）。
 *
 * 收起时**完全不拉感知**（2026-10-04 性能轮）：提示条常驻但 8px 收起态不显示这些数据，
 * 挂载即 `perception.refresh()` 会让主进程为每个用户都加载 systeminformation、起 DNS 探测。
 */
const PERCEPTION_REFRESH_INTERVAL_MS = 30_000
let perceptionTimer: ReturnType<typeof setInterval> | undefined

watch(expanded, (isOpen) => {
  // 收起：停掉自动刷新，避免后台空转。
  if (!isOpen) {
    clearInterval(perceptionTimer)
    perceptionTimer = undefined
    return
  }
  void perception.refresh()
  void refreshAwareness()
  clearInterval(perceptionTimer)
  perceptionTimer = setInterval(() => {
    void perception.refresh()
    void refreshAwareness()
  }, PERCEPTION_REFRESH_INTERVAL_MS)
})

const modelLabel = computed(() => {
  const current = settingsStore.settings
  if (current === null) return '未配置模型'
  const selected = current.fileAwareness.backgroundModel
  const providerId = selected.providerId.trim()
  if (providerId === '') {
    return current.llm.providers[current.llm.active]?.model.trim() || '未配置模型'
  }
  const provider = current.llm.providers[providerId]
  if (provider === undefined) return '后台模型不可用'
  return selected.model.trim() || provider.model.trim() || '未选择后台模型'
})

/** 模式提示：未完成引导 / 未就绪时给一句话，正常时为空串（不占版面） */
const modeHint = computed(() => {
  const current = modeStore.current
  if (!current) return '尚未激活任何模式'
  if (!current.guideCompleted) return '引导未完成：点「打开主界面」继续'
  if (!current.ready) return current.readinessHint ?? ''
  return ''
})

const isClassroom = computed(() => modeStore.current?.id === 'classroom')
const lessons = computed(() => perception.summary?.lessons ?? [])
/** 课堂摘要只在 ClassRoom 模式生效；Work / Code 模式不能借用课堂状态。 */
const nextLesson = computed(() => (isClassroom.value ? (lessons.value[0] ?? null) : null))

async function openChat(): Promise<void> {
  collapseNow()
  await windowStore.showChat()
}

async function openMemory(): Promise<void> {
  collapseNow()
  await windowStore.show('memory')
}

async function openInsight(item: InsightItem): Promise<void> {
  if (item.noteId === undefined) {
    await openMemory()
    return
  }
  const result = await window.aurora.awareness.presentNote({ noteId: item.noteId })
  if (!result.ok) {
    await openMemory()
    return
  }
  collapseNow()
}

let lastTouchToggleAt = 0
let suppressClickUntil = 0

function firesTouchEvents(event: MouseEvent): boolean {
  const source = (
    event as MouseEvent & {
      sourceCapabilities?: { firesTouchEvents?: boolean }
    }
  ).sourceCapabilities
  return source?.firesTouchEvents === true
}

/** 触摸 / 触控笔没有可靠 hover：点按竖条只负责展开 / 收起。 */
function toggleForTouch(): void {
  const now = performance.now()
  if (now - lastTouchToggleAt < 500) return
  lastTouchToggleAt = now
  suppressClickUntil = now + 1_200
  if (expanded.value) collapseNow()
  else expandPanel()
}

/**
 * `pointerdown` 在部分 Windows 触摸设备上可能直接派发为鼠标；
 * `touchstart` 作为第二入口兜底，两者用时间窗去重，避免同一次点按连续翻转两次。
 */
function onStripPointerDown(event: PointerEvent): void {
  if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return
  event.preventDefault()
  toggleForTouch()
}

function onStripTouchStart(event: TouchEvent): void {
  event.preventDefault()
  toggleForTouch()
}

function onStripClick(event: MouseEvent): void {
  const now = performance.now()
  if (now < suppressClickUntil) return
  if (firesTouchEvents(event)) {
    toggleForTouch()
    return
  }
  void openChat()
}

async function openSettings(): Promise<void> {
  collapseNow()
  await windowStore.show('settings')
}

async function hideSelf(): Promise<void> {
  collapseNow()
  await windowStore.hide('edge-bar')
}

// 面板数据只在展开时读取；收起态不轮询感知或记忆。
onMounted(() => {
  offAwarenessSuggestion = window.aurora.awareness.onSuggestion((item) => {
    onAwarenessSuggestion(item)
  })
  offAwarenessChanged = window.aurora.awareness.onChanged(onAwarenessChanged)
  if (expanded.value) {
    void perception.refresh()
    void refreshAwareness()
  }
})

onUnmounted(() => {
  clearTimers()
  clearInterval(perceptionTimer)
  offAwarenessSuggestion?.()
  offAwarenessSuggestion = null
  offAwarenessChanged?.()
  offAwarenessChanged = null
})
</script>

<template>
  <div
    class="edge anim-window"
    :class="{ expanded }"
    @pointerenter="onPointerEnter"
    @pointerleave="onPointerLeave"
  >
    <button
      class="strip"
      type="button"
      :title="expanded ? undefined : '打开 Aurora 主界面'"
      aria-label="打开 Aurora 主界面"
      @pointerdown="onStripPointerDown"
      @touchstart="onStripTouchStart"
      @click="onStripClick"
    >
      <span class="strip-dot">
        <StatusDot :tone="awarenessTone" :size="6" :title="statusLabel" />
      </span>
      <span class="strip-label">AURORA</span>
    </button>

    <transition name="sheet" @after-leave="onPanelAfterLeave">
      <aside v-if="expanded" class="panel glass" data-field="edge-bar.panel">
        <header class="panel-head">
          <div class="brand-lockup">
            <span class="brand-mark aurora-mark" aria-hidden="true" />
            <span class="brand-copy">
              <strong>Aurora</strong>
              <span class="tiny muted">{{ statusLabel }} · {{ modelLabel }}</span>
            </span>
          </div>
          <button
            type="button"
            class="head-hide press"
            data-action="edge-bar.hide"
            title="隐藏提示条"
            aria-label="隐藏提示条"
            @click="hideSelf"
          >
            <X :size="13" :stroke-width="2" aria-hidden="true" />
          </button>
        </header>

        <div class="panel-scroll">
          <section class="awareness-hero" data-field="edge-bar.awareness-status">
            <div class="hero-head">
              <span class="hero-icon" aria-hidden="true">
                <FolderSearch :size="15" :stroke-width="1.8" />
              </span>
              <span class="hero-copy">
                <span class="eyebrow">文件自感知</span>
                <strong>{{ awarenessLabel }}</strong>
              </span>
              <StatusDot :tone="awarenessTone" :size="7" :title="awarenessLabel" />
            </div>
            <p class="hero-hint">{{ awarenessHint }}</p>

            <div class="metric-grid">
              <span class="metric">
                <strong>{{ awarenessStatus?.todayAnalyzed ?? 0 }}</strong>
                <small>/ {{ awarenessStatus?.dailyAnalysisLimit ?? 0 }} 今日</small>
              </span>
              <span class="metric">
                <strong>{{ awarenessStatus?.queueDepth ?? 0 }}</strong>
                <small>队列</small>
              </span>
              <span class="metric">
                <strong>{{ awarenessStatus?.noteCount ?? awarenessNotes.length }}</strong>
                <small>记忆</small>
              </span>
            </div>
            <div
              v-if="analysisProgress"
              class="analysis-progress"
              data-field="edge-bar.analysis-progress"
            >
              <span
                class="progress-track"
                :class="{ running: analysisProgress.running }"
                role="progressbar"
                :aria-label="`文件分析：${analysisProgress.label}，${analysisProgress.fileName}`"
                :aria-valuenow="analysisProgress.percent"
                :aria-valuetext="analysisProgress.label"
              >
                <i :style="{ width: `${analysisProgress.percent}%` }" />
              </span>
              <div class="live-file">
                <Clock
                  v-if="analysisProgress.stage === 'queued'"
                  :size="13"
                  :stroke-width="1.8"
                  aria-hidden="true"
                />
                <LoaderCircle
                  v-else
                  class="spin"
                  :size="13"
                  :stroke-width="1.8"
                  aria-hidden="true"
                />
                <span>{{ analysisProgress.label }} · {{ analysisProgress.fileName }}</span>
              </div>
            </div>
          </section>

          <section
            v-if="suggestions.length === 1"
            class="card suggestion"
            data-field="edge-bar.awareness"
          >
            <div class="card-head">
              <p class="card-title">文件提醒</p>
              <span class="badge">新</span>
            </div>
            <strong class="suggestion-title">{{ suggestions[0]?.headline }}</strong>
            <p class="suggestion-body">{{ suggestions[0]?.body }}</p>
            <p v-if="suggestionError !== ''" class="suggestion-error">{{ suggestionError }}</p>
            <div class="suggestion-actions">
              <button
                v-if="suggestions[0]?.action"
                type="button"
                class="suggestion-action primary"
                :disabled="suggestionBusy"
                @click="suggestions[0] && executeSuggestion(suggestions[0])"
              >
                {{ suggestionBusy ? '正在创建…' : suggestions[0]?.action?.label }}
              </button>
              <button
                type="button"
                class="suggestion-action"
                @click="suggestions[0] && viewSuggestion(suggestions[0])"
              >
                查看分析
              </button>
              <button
                type="button"
                class="suggestion-action"
                @click="suggestions[0] && openSuggestionSource(suggestions[0])"
              >
                打开文件
              </button>
              <button
                type="button"
                class="suggestion-action muted"
                @click="suggestions[0] && ignoreSuggestion(suggestions[0])"
              >
                忽略
              </button>
            </div>
          </section>

          <section
            v-else-if="suggestions.length > 1"
            class="card suggestion"
            data-field="edge-bar.awareness"
          >
            <button
              type="button"
              class="suggestion-group-toggle"
              data-field="edge-bar.suggestions-toggle"
              :aria-expanded="suggestionsExpanded"
              @click="toggleSuggestions"
            >
              <span>
                <strong>{{ suggestions.length }} 个文件有新提醒</strong>
                <small>点击{{ suggestionsExpanded ? '收起' : '展开' }}全部提醒</small>
              </span>
              <ChevronDown
                :size="14"
                :stroke-width="1.8"
                :class="{ rotated: suggestionsExpanded }"
                aria-hidden="true"
              />
            </button>
            <p v-if="suggestionError !== ''" class="suggestion-error">{{ suggestionError }}</p>
            <div v-if="suggestionsExpanded" class="suggestion-group-list">
              <article
                v-for="item in suggestions"
                :key="item.id"
                class="suggestion-item"
                data-field="edge-bar.awareness-item"
              >
                <strong class="suggestion-title">{{ item.headline }}</strong>
                <p class="suggestion-body">{{ item.body }}</p>
                <div class="suggestion-actions">
                  <button
                    v-if="item.action"
                    type="button"
                    class="suggestion-action primary"
                    :disabled="suggestionBusy"
                    @click="executeSuggestion(item)"
                  >
                    {{ suggestionBusy ? '正在创建…' : item.action.label }}
                  </button>
                  <button type="button" class="suggestion-action" @click="viewSuggestion(item)">
                    查看
                  </button>
                  <button
                    type="button"
                    class="suggestion-action muted"
                    @click="ignoreSuggestion(item)"
                  >
                    忽略
                  </button>
                </div>
              </article>
            </div>
          </section>

          <section class="card insight-card" data-field="edge-bar.insights">
            <div class="card-head">
              <span class="section-heading">
                <BookOpen :size="13" :stroke-width="1.8" aria-hidden="true" />
                <p class="card-title">最近理解</p>
              </span>
              <span v-if="insightTotal > 0" class="badge">{{ insightTotal }}</span>
            </div>
            <div v-if="insightItems.length > 0" class="insight-list">
              <button
                v-for="item in insightItems"
                :key="item.id"
                type="button"
                class="insight-row press"
                @click="openInsight(item)"
              >
                <span class="insight-kind">{{ item.kind }}</span>
                <span class="insight-main">
                  <strong>{{ item.title }}</strong>
                  <small>{{ item.detail }}</small>
                </span>
                <span class="insight-time">{{ item.time }}</span>
                <span class="insight-tone" :class="`t-${item.tone}`" aria-hidden="true" />
              </button>
            </div>
            <p v-else class="empty">开启文件自感知后，这里会显示最近理解的文件。</p>
            <button
              v-if="insightTotal > 5"
              type="button"
              class="insight-more press"
              data-field="edge-bar.insights-more"
              @click="openMemory"
            >
              更多记录
            </button>
          </section>

          <section
            v-if="nextLesson || systemChips.length > 0 || modeHint !== ''"
            class="card context-card"
          >
            <div v-if="nextLesson" class="context-line">
              <span class="context-label">下一节</span>
              <strong>{{ nextLesson.startTime }} {{ nextLesson.subject }}</strong>
            </div>
            <div v-else-if="modeHint !== ''" class="context-line">
              <span class="context-label">{{ isClassroom ? '课堂' : '模式' }}</span>
              <strong>{{ modeHint }}</strong>
            </div>
            <div v-if="systemChips.length > 0" class="chip-row">
              <span v-for="chip in systemChips" :key="chip" class="mini-chip">{{ chip }}</span>
            </div>
          </section>
        </div>

        <section class="actions">
          <AppButton variant="primary" size="sm" block class="press" @click="openChat">
            <MessageSquare class="icon" :size="14" :stroke-width="1.7" aria-hidden="true" />
            打开主界面
          </AppButton>
          <AppButton variant="ghost" size="sm" block class="press" @click="openMemory">
            <BookOpen class="icon" :size="14" :stroke-width="1.7" aria-hidden="true" />
            记忆库
          </AppButton>
          <AppButton variant="ghost" size="sm" block class="press" @click="openSettings">
            <SettingsGear class="icon" :size="14" :stroke-width="1.7" aria-hidden="true" />
            设置
          </AppButton>
        </section>
      </aside>
    </transition>
  </div>
</template>

<style scoped>
.edge {
  position: relative;
  height: 100vh;
  display: flex;
  justify-content: flex-end;
  align-items: stretch;
  /* 窗口宽度就是内容宽度（收起 8 / 展开 328）；保留 hidden 兜住圆角与滑入动画的溢出 */
  overflow: hidden;
}

/* ───────── 收起态竖条（8px，贴屏幕右缘；展开态下仍可见、仍可点） ───────── */

.strip {
  position: relative;
  flex: 0 0 auto;
  align-self: center;
  width: 8px;
  /* 与主进程收起 shape 的 200px 高度保持一致；稳定宿主不会再把元素拉伸到全高。 */
  height: 200px;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  /* 与面板共用同一份材质 tint（`--edge-bar-tint`）：提示条 2026-10-11 起挂原生 Acrylic，
     桌面模糊由 DWM 提供，页面这层只负责可读性 —— 旧的 94% 不透明底会把材质盖死。
     左圆角 6px 与 `edgeBarShape` 的竖条阶梯区域同值。 */
  background: var(--edge-bar-tint);
  border-left: 1px solid var(--glass-border);
  border-radius: 6px 0 0 6px;
  box-shadow: var(--shadow-1);
  /* 常驻元素：静置时稍压暗，避免在桌面右缘变成一条纯色装饰条。 */
  filter: brightness(0.9);
  transition:
    width var(--dur-fast) var(--ease-spring),
    filter var(--transition-fast);
}

.strip:hover {
  /* 可交互提示：加亮 + 微增宽（--ease-spring 让增长带一点弹性） */
  width: 10px;
  filter: brightness(1.12);
}

/* 状态点外面套一圈深色底座，否则在极光渐变上看不清 */
.strip-dot {
  display: grid;
  place-items: center;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--bg-overlay);
  box-shadow: var(--shadow-1);
}

.strip-label {
  writing-mode: vertical-rl;
  font-size: 8px;
  font-weight: var(--weight-semibold);
  letter-spacing: 1.6px;
  color: var(--text-secondary);
}

/* ───────── 展开面板（左圆角毛玻璃工作台） ───────── */

.panel {
  position: absolute;
  top: 0;
  bottom: 0;
  /* 右缘留出 8px 竖条；左缘贴窗口，宽度由客户区决定（实测客户区约 334px，
     Electron 给透明窗口补的那几 px 归面板，面板实际约 326px 宽）。 */
  left: 0;
  right: 8px;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  /* 左圆角 28px（`--radius-xl`）：窗口区域会用主进程的 `edgeBarShape` 按 1px 阶梯
     近似同一条弧 —— DWM 材质按窗口区域裁剪，两者必须对齐，否则圆角外会露出矩形材质。 */
  border-radius: var(--radius-xl) 0 0 var(--radius-xl);
  border-color: var(--glass-border);
  /* 面板与竖条同一份材质 tint（2026-10-11）：半透明 → 看见 DWM 模糊后的桌面。
     `backdrop-filter` 明确置 none —— 透明窗口里的 CSS backdrop-filter 只能采样页面自身内容，
     模糊不了窗外桌面；桌面模糊只能由 `backgroundMaterial: 'acrylic'` 提供。 */
  background: var(--edge-bar-tint);
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  box-shadow:
    inset 0 1px 0 var(--glass-highlight),
    var(--shadow-3);
  overflow: hidden;
}

/* 提示条专用轻滑淡入：不改全局 .sheet-*，避免影响其他抽屉。 */
.panel.sheet-enter-active,
.panel.sheet-leave-active {
  transition:
    opacity var(--dur-base) var(--ease-standard),
    transform var(--dur-base) var(--ease-smooth);
}

.panel.sheet-enter-from,
.panel.sheet-leave-to {
  opacity: 0;
  transform: translateX(20px);
}

/* 品牌识别元素：面板顶部 1px 极光高光（只此一处，不满屏渐变） */
.panel::before {
  content: '';
  position: absolute;
  top: 0;
  left: var(--space-4);
  right: var(--space-4);
  height: 1px;
  background: var(--aurora-gradient);
  opacity: 0.8;
}

.panel-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-height: 36px;
  padding: 0 var(--space-1);
}

.brand-lockup,
.section-heading {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.brand-mark {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border-radius: 9px;
}

.brand-copy {
  display: grid;
  gap: 1px;
  min-width: 0;
}

.brand-copy strong {
  font-family: var(--font-display);
  font-size: var(--text-base);
  line-height: var(--leading-tight);
}

.head-hide {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.head-hide:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.panel-scroll {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  overflow-y: auto;
  overflow-x: hidden;
}

.panel-scroll::-webkit-scrollbar {
  width: 6px;
}

/* 分组卡片：全面板统一用 --fill-1 卡片分组，不用分隔线（二选一，不混用） */
.card {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  padding: var(--space-3);
  border: 1px solid var(--glass-border-soft);
  border-radius: var(--radius-md);
  background: var(--glass-surface);
  box-shadow: inset 0 1px 0 var(--glass-highlight);
}

.awareness-hero {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-4);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--aurora-blue) 9%, transparent),
      transparent 58%
    ),
    var(--glass-surface-strong);
  box-shadow:
    inset 0 1px 0 var(--glass-highlight),
    var(--shadow-hairline);
}

.hero-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.hero-icon {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--aurora-blue) 15%, transparent);
  color: var(--accent-text);
}

.hero-copy {
  display: grid;
  flex: 1;
  min-width: 0;
  gap: 1px;
}

.hero-copy strong {
  font-size: var(--text-lg);
  line-height: var(--leading-tight);
}

.eyebrow {
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  letter-spacing: var(--tracking-eyebrow);
  text-transform: uppercase;
}

.hero-hint {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  overflow-wrap: anywhere;
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-1);
}

.metric {
  display: grid;
  gap: 1px;
  min-width: 0;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--fill-1);
}

.metric strong {
  font-size: var(--text-lg);
  font-variant-numeric: var(--num-tabular);
}

.metric small {
  color: var(--text-muted);
  font-size: var(--text-xs);
  white-space: nowrap;
}

.analysis-progress {
  display: grid;
  gap: var(--space-2);
}

.progress-track {
  display: block;
  height: 3px;
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: var(--fill-2);
}

.progress-track i {
  display: block;
  position: relative;
  height: 100%;
  overflow: hidden;
  border-radius: inherit;
  background: var(--aurora-blue);
  transition: width var(--dur-base) var(--ease-standard);
}

.progress-track.running i::after {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--glass-highlight) 80%, transparent),
    transparent
  );
  content: '';
  animation: aurora-shimmer var(--dur-pulse) var(--ease-standard) infinite;
}

.live-file {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.live-file span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.insight-card {
  gap: var(--space-2);
}

.section-heading {
  color: var(--text-muted);
}

.section-heading .card-title {
  color: inherit;
}

.text-action {
  flex: 0 0 auto;
  padding: 2px var(--space-1);
  border-radius: var(--radius-xs);
  color: var(--accent-text);
  font-size: var(--text-xs);
  transition: background var(--transition-fast);
}

.text-action:hover {
  background: var(--fill-2);
}

.insight-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 236px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.insight-list::-webkit-scrollbar,
.suggestion-group-list::-webkit-scrollbar {
  width: 6px;
}

.insight-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  text-align: left;
  transition: background var(--transition-fast);
}

.insight-row:hover {
  background: var(--fill-2);
}

.insight-kind {
  padding: 2px 5px;
  border-radius: var(--radius-xs);
  background: var(--fill-2);
  color: var(--text-muted);
  font-size: 10px;
  font-weight: var(--weight-semibold);
  letter-spacing: 0.03em;
}

.insight-main {
  display: grid;
  min-width: 0;
  gap: 1px;
}

.insight-main strong,
.insight-main small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.insight-main strong {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}

.insight-main small,
.insight-time {
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.insight-time {
  font-variant-numeric: var(--num-tabular);
}

.insight-tone {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--status-idle);
}

.insight-tone.t-done {
  background: var(--status-ok);
}

.insight-tone.t-active {
  background: var(--status-running);
  box-shadow: 0 0 0 3px var(--status-running-ring);
}

.insight-tone.t-warning {
  background: var(--status-unread);
}

.insight-more {
  width: 100%;
  margin-top: var(--space-1);
  padding: 6px var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--fill-1);
  color: var(--accent-text);
  font: inherit;
  font-size: var(--text-xs);
}

.insight-more:hover {
  background: var(--fill-2);
}

.context-card {
  gap: var(--space-2);
}

.context-line {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}

.context-line strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
}

.context-label {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.mini-chip {
  max-width: 100%;
  padding: 3px 7px;
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: var(--fill-1);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.suggestion {
  border-color: var(--accent-ring);
}

.suggestion-title {
  display: block;
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: var(--text-sm);
  line-height: 1.4;
}

.suggestion-body {
  margin: var(--space-2) 0;
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--text-secondary);
  font-size: var(--text-xs);
  line-height: 1.5;
}

.suggestion-group-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  width: 100%;
  padding: 2px 0;
  color: var(--text-primary);
  text-align: left;
}

.suggestion-group-toggle > span {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.suggestion-group-toggle strong {
  font-size: var(--text-sm);
}

.suggestion-group-toggle small {
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.suggestion-group-toggle svg {
  flex: 0 0 auto;
  transition: transform var(--transition-fast);
}

.suggestion-group-toggle svg.rotated {
  transform: rotate(180deg);
}

.suggestion-group-list {
  display: grid;
  gap: var(--space-2);
  max-height: 300px;
  margin-top: var(--space-2);
  overflow-y: auto;
  overscroll-behavior: contain;
}

.suggestion-item {
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--fill-1);
}

.suggestion-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.suggestion-action {
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 4px 7px;
  background: var(--fill-2);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
}

.suggestion-action.muted {
  color: var(--text-muted);
}

.suggestion-action.primary {
  border-color: transparent;
  background: var(--aurora-blue);
  color: var(--on-accent);
}

.suggestion-action:disabled {
  cursor: default;
  opacity: 0.6;
}

.suggestion-action:hover {
  background: var(--fill-3);
}

.suggestion-action.primary:hover:not(:disabled) {
  background: var(--aurora-blue);
  filter: brightness(1.08);
}

.suggestion-error {
  margin: 0 0 var(--space-2);
  color: var(--error-text);
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
}

.card-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.card-title {
  margin: 0;
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  letter-spacing: var(--tracking-eyebrow);
  text-transform: uppercase;
  color: var(--text-muted);
}

/* 卡片内的计数徽标要浮在卡片底色之上，否则和 --fill-1 同色看不见 */
.card .badge {
  background: var(--fill-2);
  font-variant-numeric: var(--num-tabular);
}

.status-text {
  font-weight: var(--weight-medium);
}

.meta {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.mode-name {
  font-weight: var(--weight-medium);
}

.warn {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--status-unread);
}

.key-value {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}

.key-value .value {
  flex: 1;
  min-width: 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  text-align: right;
  font-variant-numeric: var(--num-tabular);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lesson-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

.lesson-list li {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--text-sm);
}

.lesson-time {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-variant-numeric: var(--num-tabular);
}

.lesson-subject {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
}

.status-row {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.status-row dt {
  flex: 0 0 auto;
  color: var(--text-muted);
}

.status-row dd {
  flex: 1;
  min-width: 0;
  margin: 0;
  text-align: right;
  font-variant-numeric: var(--num-tabular);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-muted);
}

/* 操作区：同样用 --fill-1 卡片分组，主入口（打开主界面）用 primary 变体 */
.actions {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-1);
  border-radius: var(--radius-md);
  background: var(--fill-1);
}

/* 整行左对齐（覆盖 AppButton 的居中；选择器带上 .block 保证优先级高于子组件） */
.actions :deep(.aurora-button.block) {
  justify-content: flex-start;
  padding-inline: var(--space-3);
}

/* ghost 悬停改用 --fill-2：比默认的 --fill-1 更明确一点 */
.actions :deep(.aurora-button.v-ghost.block):hover:not(:disabled) {
  background: var(--fill-2);
  color: var(--text-primary);
}

.icon {
  flex: 0 0 auto;
  stroke: currentColor;
}
</style>
