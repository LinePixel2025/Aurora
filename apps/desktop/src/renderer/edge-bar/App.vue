<script setup lang="ts">
/**
 * 右侧提示条（docs/07 §2.2）：贴屏幕右缘的 8px 竖条 + 悬停展开的全高面板。
 *
 * 行为契约（step-02 落地，本步只换外观与动效，事件绑定与 IPC 调用保持不变）：
 * - 悬停 → 主进程把窗口加宽到 328px（`window:setEdgeBarExpanded`），面板从右滑入；
 *   移开鼠标 → 面板淡出后再把窗口收回 8px（否则屏幕右侧会留一块看不见却挡鼠标的区域）；
 * - 点击竖条 → 呼出主界面（`window:showChat`，chat 窗即主界面）；展开态下竖条仍贴着屏幕右缘，
 *   仍是有效点击目标；
 * - 面板内容：AI 状态 → 当前模式 → **快速对话**（输入框直接在面板里与 Aurora 对话，
 *   2026-09 起取代只读的「最近消息」）→ 今日课程（仅 ClassRoom 模式）→ 系统状态，
 *   底部是三个操作入口。Work 等非 ClassRoom 模式下课堂卡不渲染，面板自然更矮；
 *   对话数据仍是快速会话（`sessionId = 'quick'`，独立 useChat 实例）。
 *   窗口创建时 `focusable: false`（悬停不抢焦点），**展开时主进程临时 setFocusable(true)**——
 *   否则输入框拿不到键盘焦点；收起时交还并失焦（见 window-manager）。
 *
 * 几何预算（不要突破）：展开窗口 328px = 竖条 8px + 面板 320px。
 * 面板宽度写死 320px，任何内部布局都在这个宽度内成立，否则会被窗口裁切。
 *
 * 拖动：**刻意不提供**。本窗 `focusable: false`，位置与尺寸完全由主进程按「工作区右缘 +
 * 垂直居中 + 当前折叠态」推导（`window-manager.ts` 的 `edge` 分支），不参与用户拖动，
 * 因此模板里不挂 `drag-region`（不在 `useWindowDrag` 的清单里，docs/07 §2.2）。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type {
  FileAwarenessNote,
  FileAwarenessRecord,
  FileAwarenessStatus,
  FileAwarenessSuggestion,
} from '@aurora/shared'
import AppButton from '../shared/components/AppButton.vue'
import StatusDot from '../shared/components/StatusDot.vue'
import {
  ArrowUp,
  BookOpen,
  FolderSearch,
  LoaderCircle,
  MessageSquare,
  SettingsGear,
  Sparkles,
  Square,
  X,
} from '@aurora/shared/browser'
import { useChat } from '../shared/composables/useChat.js'
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
/** 面板退出动画时长，与 theme.css 的 --dur-base 对齐；收窗口必须晚于它，否则面板被裁掉 */
const PANEL_EXIT_MS = 250
const windowStore = useWindowStore()
const settingsStore = useSettingsStore()
const modeStore = useModeStore()
const perception = usePerceptionStore()
const chat = useChat('edge-bar', 'quick')
const { statusTone } = chat

const expanded = ref(false)
/** 鼠标是否在提示条窗口内（leave 触发后若输入框仍持有焦点，收起要等失焦再补） */
const mouseInside = ref(false)
/** 快速对话输入框是否持有焦点：聚焦期间移开鼠标**不收起面板**（正在打字） */
const quickFocused = ref(false)
let expandTimer: ReturnType<typeof setTimeout> | undefined
let collapseTimer: ReturnType<typeof setTimeout> | undefined
let shrinkTimer: ReturnType<typeof setTimeout> | undefined
let suggestionTimer: ReturnType<typeof setTimeout> | undefined

function clearTimers(): void {
  clearTimeout(expandTimer)
  clearTimeout(collapseTimer)
  clearTimeout(shrinkTimer)
  clearTimeout(suggestionTimer)
  expandTimer = undefined
  collapseTimer = undefined
  shrinkTimer = undefined
  suggestionTimer = undefined
}

const suggestion = ref<FileAwarenessSuggestion | null>(null)
const suggestionBusy = ref(false)
const suggestionError = ref('')
let offAwarenessSuggestion: (() => void) | null = null
const awarenessStatus = ref<FileAwarenessStatus | null>(null)
const awarenessNotes = ref<FileAwarenessNote[]>([])
const awarenessRecords = ref<FileAwarenessRecord[]>([])
const awarenessBusy = ref(false)
let offAwarenessChanged: (() => void) | null = null
let awarenessPromise: Promise<void> | null = null

function clearSuggestion(): void {
  clearTimeout(suggestionTimer)
  suggestionTimer = undefined
  suggestion.value = null
  suggestionBusy.value = false
  suggestionError.value = ''
}

function armSuggestionCollapse(): void {
  clearTimeout(suggestionTimer)
  suggestionTimer = setTimeout(() => {
    suggestionTimer = undefined
    suggestion.value = null
    if (!mouseInside.value) scheduleCollapse()
  }, 12_000)
}

function onAwarenessSuggestion(next: FileAwarenessSuggestion): void {
  suggestion.value = next
  suggestionError.value = ''
  suggestionBusy.value = false
  clearTimeout(collapseTimer)
  collapseTimer = undefined
  clearTimeout(shrinkTimer)
  shrinkTimer = undefined
  void windowStore.setEdgeBarExpanded(true)
  expanded.value = true
  armSuggestionCollapse()
}

async function executeSuggestion(): Promise<void> {
  const current = suggestion.value
  if (current === null || current.action === undefined || suggestionBusy.value) return
  suggestionBusy.value = true
  suggestionError.value = ''
  try {
    const result = await window.aurora.awareness.execute({ suggestionId: current.id })
    if (!result.ok) {
      suggestionError.value = result.message
      return
    }
    clearSuggestion()
    collapseNow()
  } finally {
    suggestionBusy.value = false
  }
}

async function viewSuggestion(): Promise<void> {
  const current = suggestion.value
  if (current === null) return
  await window.aurora.awareness.openNote({ noteId: current.noteId })
  clearSuggestion()
}

async function openSuggestionSource(): Promise<void> {
  const current = suggestion.value
  if (current === null) return
  await window.aurora.awareness.openSource({ noteId: current.noteId })
  clearSuggestion()
}

async function ignoreSuggestion(): Promise<void> {
  const current = suggestion.value
  if (current === null) return
  await window.aurora.awareness.ignore({ suggestionId: current.id })
  clearSuggestion()
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
  if (status.waitingForModel || !status.knowledgeDirAvailable) return 'unread'
  return status.active ? 'running' : 'idle'
})

const awarenessLabel = computed(() => {
  const status = awarenessStatus.value
  if (status === null) return '读取状态…'
  if (!status.enabled || !status.consentAccepted) return '未启用'
  if (!status.knowledgeDirAvailable) return '知识库不可用'
  if (status.waitingForModel) return '等待模型'
  if (status.lastError) return '需要处理'
  return status.active ? '正在感知' : '已暂停'
})

const awarenessHint = computed(() => {
  const status = awarenessStatus.value
  if (status === null) return '正在读取文件自感知状态'
  if (!status.enabled || !status.consentAccepted) return '在设置中开启后，才会分析选定目录'
  if (!status.knowledgeDirAvailable) return '知识库目录不存在，文件仍不会出网'
  if (status.waitingForModel) return '监听已就绪，配置模型后开始分析'
  if (status.lastError) return status.lastError
  if (status.current) return `正在读取 ${status.current.fileName}`
  return status.lastScanAt ? '已同步最近文件变化' : '等待目录中的新变化'
})

const awarenessProgress = computed(() => {
  const status = awarenessStatus.value
  if (status === null || status.dailyAnalysisLimit <= 0) return 0
  return Math.min(100, Math.round((status.todayAnalyzed / status.dailyAnalysisLimit) * 100))
})

type InsightItem = {
  id: string
  title: string
  detail: string
  time: string
  kind: string
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
    case 'analyzing':
      return '分析中'
    case 'queued':
      return '排队中'
    case 'done':
      return '已理解'
    case 'conflict':
      return '有冲突'
    case 'error':
      return '失败'
    case 'skipped':
      return '已跳过'
    default:
      return '已发现'
  }
}

function recordTone(record: FileAwarenessRecord): InsightItem['tone'] {
  if (record.status === 'analyzing') return 'active'
  if (record.status === 'error' || record.status === 'conflict') return 'warning'
  if (record.status === 'done') return 'done'
  return 'idle'
}

const insightItems = computed<InsightItem[]>(() => {
  const noteItems: InsightItem[] = awarenessNotes.value.slice(0, 3).map((note) => ({
    id: `note-${note.id}`,
    title: note.title,
    detail: note.excerpt || note.sourcePath,
    time: formatClock(note.updatedAt),
    kind: note.ext.toUpperCase(),
    noteId: note.id,
    tone: note.conflict ? 'warning' : 'done',
  }))
  if (noteItems.length >= 3) return noteItems
  const seen = new Set(awarenessNotes.value.map((note) => note.sourcePath.toLowerCase()))
  const recordItems: InsightItem[] = awarenessRecords.value
    .filter((record) => !seen.has(record.sourcePath.toLowerCase()))
    .slice(0, 3 - noteItems.length)
    .map((record) => ({
      id: `record-${record.id}`,
      title: record.fileName,
      detail: record.summary || record.error || `${recordLabel(record)} · 尚未生成笔记`,
      time: formatClock(record.occurredAt),
      kind: record.ext.toUpperCase() || record.kind,
      ...(record.noteId === undefined ? {} : { noteId: record.noteId }),
      tone: recordTone(record),
    }))
  return [...noteItems, ...recordItems]
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
 * 悬停进入：窗口先加宽，面板后出现 —— 反过来的话面板会先被 8px 窗口裁掉再跳出来。
 *
 * **不做 `if (expanded.value) return` 早退**：主进程可能在我们不知情时把提示条隐藏
 * （勿扰时段的 `EdgeBarScheduler`、设置页的「立即显隐」），窗口已被收回 8px 而渲染层的
 * `expanded` 仍是 true；早退会让面板渲染在 8px 窗口里被裁掉且无法自愈。
 * `setEdgeBarExpanded` 在主进程是幂等的，无条件调用即是最省事的自愈路径。
 */
function onPointerEnter(): void {
  mouseInside.value = true
  clearTimeout(collapseTimer)
  clearTimeout(shrinkTimer)
  collapseTimer = undefined
  shrinkTimer = undefined
  expandTimer = setTimeout(() => {
    expandTimer = undefined
    void (async () => {
      await windowStore.setEdgeBarExpanded(true)
      expanded.value = true
    })()
  }, EXPAND_DELAY_MS)
}

/** 收起链：面板先淡出，动画结束后再把窗口收回竖条（enter / leave / 失焦三条路径共用） */
function scheduleCollapse(): void {
  clearTimeout(expandTimer)
  expandTimer = undefined
  clearTimeout(collapseTimer)
  collapseTimer = setTimeout(() => {
    collapseTimer = undefined
    expanded.value = false
    clearTimeout(shrinkTimer)
    shrinkTimer = setTimeout(() => {
      shrinkTimer = undefined
      void windowStore.setEdgeBarExpanded(false)
    }, PANEL_EXIT_MS)
  }, COLLAPSE_DELAY_MS)
}

/** 移开鼠标：正在快速对话输入框里打字时不收起，等失焦再补收 */
function onPointerLeave(): void {
  mouseInside.value = false
  if (quickFocused.value) return
  scheduleCollapse()
}

/** 输入框失焦而鼠标早已离开窗口：补走一次收起，否则面板会悬在屏幕外等待不到离开事件 */
watch(quickFocused, (focused) => {
  if (focused || mouseInside.value || !expanded.value) return
  scheduleCollapse()
})

/** 面板内的操作：立即收起（用户已经明确做了选择，不需要动画缓冲） */
function collapseNow(): void {
  clearTimers()
  // 显式复位输入框聚焦态：收起守卫（onPointerLeave 的 quickFocused 分支）不能依赖
  // 「收起前 blur 必然先发生」这个隐含时序，否则残留 true 会让面板悬停不收
  quickFocused.value = false
  expanded.value = false
  void windowStore.setEdgeBarExpanded(false)
}

const statusLabel = computed(() =>
  statusTone.value === 'error'
    ? '异常'
    : statusTone.value === 'running'
      ? '思考中'
      : statusTone.value === 'unread'
        ? '有未读'
        : '闲置',
)

/** 快速对话输入内容（发送后清空） */
const quickInput = ref('')
/** 消息滚动容器（新内容贴底） */
const quickListEl = ref<HTMLElement | null>(null)

/**
 * 快速对话的消息（正序，最近 20 条）：面板不承载长历史，
 * 更早的对话在主界面左栏点「快速对话」看全量。
 */
const quickMessages = computed(() =>
  chat.messages.value.filter((message) => message.content.trim() !== '').slice(-20),
)

/** 新消息 / 流式增量贴底：迷你视图不做「用户接管」复杂度 */
const quickTail = computed(() => {
  const last = quickMessages.value.at(-1)
  return `${quickMessages.value.length}:${last?.content.length ?? 0}`
})

watch(quickTail, () => {
  void scrollToQuickBottom()
})

async function scrollToQuickBottom(): Promise<void> {
  await nextTick()
  const el = quickListEl.value
  if (el !== null) el.scrollTop = el.scrollHeight
}

/** 快速会话自动刷新间隔（docs/07 §2.2）：面板展开期间每 5 分钟重拉一次 */
const QUICK_REFRESH_INTERVAL_MS = 5 * 60_000
let quickRefreshTimer: ReturnType<typeof setInterval> | undefined
/**
 * 展开期间的系统状态刷新间隔（与右栏 ContextPanel 同口径 30s）。
 *
 * 收起时**完全不拉感知**（2026-10-04 性能轮）：提示条常驻但 8px 收起态不显示这些数据，
 * 挂载即 `perception.refresh()` 会让主进程为每个用户都加载 systeminformation、起 DNS 探测。
 */
const PERCEPTION_REFRESH_INTERVAL_MS = 30_000
let perceptionTimer: ReturnType<typeof setInterval> | undefined

/**
 * 展开态强制重拉快速会话（最近 20 条）并贴底（docs/07 §2.2）：
 * 窗口常驻，只在挂载时水合一次的话，主界面 / 其它窗口发出的新消息永远进不来。
 * 守卫：仅展开中且非流式时执行 —— 流式重拉会把正在输出的回复搅乱。
 */
function refreshQuickSession(): void {
  if (!expanded.value || chat.streaming.value) return
  void chat.hydrate({ force: true, limit: 20 }).then(() => scrollToQuickBottom())
}

watch(expanded, (isOpen) => {
  // 收起：停掉自动刷新，避免后台空转（感知与快速会话都不再拉取）
  if (!isOpen) {
    clearInterval(quickRefreshTimer)
    quickRefreshTimer = undefined
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
  if (!chat.streaming.value)
    void chat.hydrate({ force: true, limit: 20 }).then(() => scrollToQuickBottom())
  clearInterval(quickRefreshTimer)
  quickRefreshTimer = setInterval(refreshQuickSession, QUICK_REFRESH_INTERVAL_MS)
})

/** 面板里发送快速对话：同一 `quick` 会话，主界面左栏固定项点开即见全量 */
async function sendQuick(): Promise<void> {
  const text = quickInput.value.trim()
  if (text === '' || chat.streaming.value) return
  quickInput.value = ''
  await chat.send(text)
}

const modelLabel = computed(() => settingsStore.activeProvider?.model ?? '未配置模型')

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
const nextLesson = computed(() => lessons.value[0] ?? null)
const visibleQuickMessages = computed(() => quickMessages.value.slice(-4))

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
  const result = await window.aurora.awareness.openNote({ noteId: item.noteId })
  if (!result.ok) {
    await openMemory()
    return
  }
  collapseNow()
}

/**
 * 竖条的指针按下类型（触摸判定用）：click 事件本身不带 pointerType，
 * 先在 pointerdown 记一笔，click 里读。
 */
let stripPointerType = 'mouse'

/** 触摸屏没有 hover：点竖条 = 展开 / 收起面板（鼠标点竖条仍是打开主界面，docs/07 §2.2） */
function onStripPointerDown(event: PointerEvent): void {
  stripPointerType = event.pointerType
}

function onStripClick(): void {
  if (stripPointerType === 'touch') {
    if (expanded.value) collapseNow()
    else {
      clearTimers()
      void (async () => {
        await windowStore.setEdgeBarExpanded(true)
        expanded.value = true
      })()
    }
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

// 面板的「最近消息」要真有内容：**展开时**才水合（收起态不读历史、不拉感知）
onMounted(() => {
  offAwarenessSuggestion = window.aurora.awareness.onSuggestion((item) => {
    onAwarenessSuggestion(item)
  })
  offAwarenessChanged = window.aurora.awareness.onChanged(onAwarenessChanged)
  if (expanded.value) {
    void chat.hydrate()
    void perception.refresh()
    void refreshAwareness()
  }
})

onUnmounted(() => {
  clearTimers()
  clearInterval(quickRefreshTimer)
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
    @mouseenter="onPointerEnter"
    @mouseleave="onPointerLeave"
  >
    <button
      class="strip"
      type="button"
      :title="expanded ? undefined : '打开 Aurora 主界面'"
      aria-label="打开 Aurora 主界面"
      @pointerdown="onStripPointerDown"
      @click="onStripClick"
    >
      <span class="strip-dot">
        <StatusDot :tone="statusTone" :size="6" :title="statusLabel" />
      </span>
      <span class="strip-label">AURORA</span>
    </button>

    <transition name="sheet">
      <aside v-if="expanded" class="panel glass" data-field="edge-bar.panel">
        <header class="panel-head">
          <div class="brand-lockup">
            <span class="brand-mark" aria-hidden="true">
              <Sparkles :size="14" :stroke-width="1.8" />
            </span>
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
          <section class="awareness-hero anim-rise" data-field="edge-bar.awareness-status">
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
                <strong>{{ awarenessNotes.length }}</strong>
                <small>记忆</small>
              </span>
            </div>
            <span class="progress-track" aria-hidden="true">
              <i :style="{ width: `${awarenessProgress}%` }" />
            </span>

            <div v-if="awarenessStatus?.current" class="live-file">
              <LoaderCircle class="spin" :size="13" :stroke-width="1.8" aria-hidden="true" />
              <span>{{ awarenessStatus.current.fileName }}</span>
            </div>
          </section>

          <section
            v-if="suggestion"
            class="card suggestion anim-rise"
            data-field="edge-bar.awareness"
          >
            <div class="card-head">
              <p class="card-title">可行动建议</p>
              <span class="badge">新</span>
            </div>
            <strong class="suggestion-title">{{ suggestion.headline }}</strong>
            <p class="suggestion-body">{{ suggestion.body }}</p>
            <p v-if="suggestionError !== ''" class="suggestion-error">{{ suggestionError }}</p>
            <div class="suggestion-actions">
              <button
                v-if="suggestion.action"
                type="button"
                class="suggestion-action primary"
                :disabled="suggestionBusy"
                @click="executeSuggestion"
              >
                {{ suggestionBusy ? '正在创建…' : suggestion.action.label }}
              </button>
              <button type="button" class="suggestion-action" @click="viewSuggestion">
                查看分析
              </button>
              <button type="button" class="suggestion-action" @click="openSuggestionSource">
                打开文件
              </button>
              <button type="button" class="suggestion-action muted" @click="ignoreSuggestion">
                忽略
              </button>
            </div>
          </section>

          <section class="card insight-card anim-rise" data-field="edge-bar.insights">
            <div class="card-head">
              <span class="section-heading">
                <BookOpen :size="13" :stroke-width="1.8" aria-hidden="true" />
                <p class="card-title">最近理解</p>
              </span>
              <button type="button" class="text-action press" @click="openMemory">全部</button>
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
          </section>

          <section class="card recent-card anim-rise">
            <div class="card-head">
              <span class="section-heading">
                <MessageSquare :size="13" :stroke-width="1.8" aria-hidden="true" />
                <p class="card-title">快速对话</p>
              </span>
              <span v-if="visibleQuickMessages.length > 0" class="badge">{{
                visibleQuickMessages.length
              }}</span>
            </div>
            <div ref="quickListEl" class="qc-list">
              <p v-if="visibleQuickMessages.length === 0 && !chat.streaming.value" class="empty">
                直接输入，与 Aurora 快速对话
              </p>
              <div
                v-for="message in visibleQuickMessages"
                :key="message.id"
                class="qc-msg"
                :class="`r-${message.role}`"
              >
                <p class="qc-text">{{ message.content.replace(/\s+/g, ' ').trim() }}</p>
              </div>
              <span v-if="chat.streaming.value" class="qc-typing"><i /><i /><i /></span>
            </div>
            <p v-if="chat.error.value !== null" class="qc-error">{{ chat.error.value }}</p>
            <div class="qc-composer">
              <input
                v-model="quickInput"
                type="text"
                placeholder="快速提问…"
                aria-label="快速对话输入"
                @keydown.enter.prevent="sendQuick"
                @focus="quickFocused = true"
                @blur="quickFocused = false"
              />
              <button
                v-if="chat.streaming.value"
                type="button"
                class="qc-send stop press"
                title="停止"
                aria-label="停止回复"
                @click="chat.abort()"
              >
                <Square :size="12" :stroke-width="2" aria-hidden="true" />
              </button>
              <button
                v-else
                type="button"
                class="qc-send press"
                data-action="edge-bar.quick-send"
                :disabled="quickInput.trim() === ''"
                title="发送（Enter）"
                aria-label="发送快速对话"
                @click="sendQuick"
              >
                <ArrowUp :size="13" :stroke-width="2.2" aria-hidden="true" />
              </button>
            </div>
          </section>

          <section
            v-if="nextLesson || systemChips.length > 0 || modeHint !== ''"
            class="card context-card anim-rise"
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
  width: 8px;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  /* 提示条不启用原生 Acrylic：不再暴露矩形 DWM 材质，圆角必须由自己闭合。 */
  background: color-mix(in srgb, var(--glass-fallback) 94%, transparent);
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

/* ───────── 展开面板（320px 感知工作台） ───────── */

.panel {
  position: absolute;
  top: 0;
  bottom: 0;
  /* 右缘留出 8px 竖条，面板 320px；总窗口 328px */
  right: 8px;
  width: 320px;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-xl) 0 0 var(--radius-xl);
  border-color: var(--glass-border);
  background: color-mix(in srgb, var(--glass-fallback) 96%, transparent);
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  box-shadow:
    inset 0 1px 0 var(--glass-highlight),
    var(--shadow-3);
  overflow: hidden;
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
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--aurora-blue) 16%, transparent);
  color: var(--accent-text);
  box-shadow: inset 0 1px 0 var(--glass-highlight);
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

.panel-scroll::-webkit-scrollbar,
.qc-list::-webkit-scrollbar {
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

.progress-track {
  display: block;
  height: 3px;
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: var(--fill-2);
}

.progress-track i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--aurora-blue);
  transition: width var(--dur-base) var(--ease-standard);
}

.live-file {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding-top: var(--space-2);
  border-top: 1px solid var(--glass-border-soft);
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
  font-size: var(--text-sm);
  line-height: 1.4;
}

.suggestion-body {
  margin: var(--space-2) 0;
  color: var(--text-secondary);
  font-size: var(--text-xs);
  line-height: 1.5;
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

/* 快速对话卡吸收面板剩余高度，让全高面板看起来是刻意排版而不是留白 */
.recent-card {
  flex: 0 1 auto;
  min-height: 150px;
  max-height: 300px;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* 空态在吸收来的高度里居中，避免出现「卡片很高、文字贴在顶上」 */
.recent-card > .empty {
  margin: auto 0;
  text-align: center;
}

/* 消息列表：占满卡片剩余高度，内部滚动、新内容贴底 */
.qc-list {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  overflow-y: auto;
  padding-right: 2px;
}

.qc-msg {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.qc-msg.r-user {
  align-items: flex-end;
}

/* 气泡：用户强调色浅填充右对齐，助手分层填充左对齐（与主界面 QuickChat 同一套语义） */
.qc-text {
  margin: 0;
  max-width: 94%;
  padding: 4px 9px;
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.r-user .qc-text {
  background: color-mix(in srgb, var(--aurora-blue) 20%, transparent);
}

.r-assistant .qc-text {
  background: var(--fill-1);
}

.qc-typing {
  display: inline-flex;
  gap: 4px;
  padding: 2px 2px 0;
}

.qc-typing i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--aurora-blue);
  animation: qc-bounce 1s infinite ease-in-out;
}

.qc-typing i:nth-child(2) {
  animation-delay: 0.15s;
}

.qc-typing i:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes qc-bounce {
  0%,
  100% {
    opacity: 0.35;
    transform: translateY(0);
  }
  50% {
    opacity: 1;
    transform: translateY(-2px);
  }
}

.qc-error {
  margin: 0;
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
  color: var(--error-text);
  overflow-wrap: anywhere;
}

/* 输入行：紧凑输入框 + 圆形发送 / 停止钮（面板宽度固定，控件保持单行） */
.qc-composer {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.qc-composer input {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-pill);
  background: var(--fill-1);
  font-size: var(--text-sm);
  color: var(--text-primary);
  outline: none;
  transition: border-color var(--transition-fast);
}

.qc-composer input:focus {
  border-color: var(--aurora-blue);
}

.qc-composer input::placeholder {
  color: var(--text-muted);
}

.qc-send {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-pill);
  background: var(--aurora-gradient);
  color: var(--on-accent);
  transition:
    opacity var(--transition-fast),
    background var(--transition-fast);
}

.qc-send:disabled {
  opacity: 0.45;
  cursor: default;
}

.qc-send svg {
  flex: 0 0 auto;
  stroke: currentColor;
}

/* 停止态：中性填充 + 方块图标（停止不是主动作，不抢强调色） */
.qc-send.stop {
  background: var(--fill-3);
  color: var(--text-primary);
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
