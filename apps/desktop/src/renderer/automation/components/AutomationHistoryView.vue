<script setup lang="ts">
/**
 * 自动化独立窗口的运行历史视图（docs/07 §2.2.1、docs/13 §11）。
 *
 * 详略分三层：
 * - 列表行只放「一眼能读完」的信息（状态 / 时间 / 名称 / 触发上下文 / 用时 + 一行摘要）；
 * - 摘要行放派生结论（Agent 的最终结论首行 + 步数，Normal 的成功 / 失败步数）；
 * - 点行就地展开明细：Agent = 复用主界面的 `MessageList` 完整回放对话（Markdown /
 *   执行轨迹 / 工具卡 / 子代理卡 / 图片），Normal = 逐个操作组件的执行结果。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { AutomationMode, AutomationRun, ChatMessageDto } from '@aurora/shared'
import type { ChatMessage } from '../../shared/composables/useChat.js'
import AppTooltip from '../../shared/components/AppTooltip.vue'
import MessageList from '../../shared/components/MessageList.vue'
import {
  Bot,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleStop,
  CircleX,
  LoaderCircle,
  X,
  Zap,
} from '@aurora/shared/browser'

const props = defineProps<{
  mode: AutomationMode
}>()

const emit = defineEmits<{
  (event: 'close'): void
}>()

/** 一次拉取 / 每追加一页的条数（历史上限 500，分页只是把「一次读多少」定死） */
const PAGE_SIZE = 40

const tab = ref<AutomationMode>(props.mode)
const runs = ref<AutomationRun[]>([])
const loading = ref(false)
const loadingMore = ref(false)
const error = ref<string | null>(null)
const fetched = ref(0)
/** 已取到列表末尾（「加载更多」点了也没增量）—— 服务端不给总数，只能这样判 */
const exhausted = ref(false)
const expandedId = ref<string | null>(null)
const replay = ref<{ sessionId: string; messages: ChatMessage[] } | null>(null)
const replayLoading = ref(false)
let offHistoryChanged: (() => void) | null = null

const STATUS_LABELS: Record<AutomationRun['status'], string> = {
  running: '进行中',
  success: '成功',
  failed: '失败',
  interrupted: '已中断',
}

const hasMore = computed(() => !exhausted.value && fetched.value >= PAGE_SIZE)

/** 按本地日期分组（倒序列表切段，组内保持原有顺序）。 */
const groups = computed(() => {
  const buckets: Array<{ key: string; label: string; runs: AutomationRun[] }> = []
  for (const run of runs.value) {
    const day = startOfDay(run.triggeredAt)
    const key = day === null ? run.triggeredAt : String(day)
    const last = buckets[buckets.length - 1]
    if (last !== undefined && last.key === key) {
      last.runs.push(run)
      continue
    }
    buckets.push({ key, label: dayLabel(day), runs: [run] })
  }
  return buckets
})

function statusIconOf(status: AutomationRun['status']): typeof CircleCheck {
  if (status === 'running') return LoaderCircle
  if (status === 'failed') return CircleX
  if (status === 'interrupted') return CircleStop
  return CircleCheck
}

function startOfDay(iso: string): number | null {
  const time = Date.parse(iso)
  return Number.isNaN(time) ? null : new Date(time).setHours(0, 0, 0, 0)
}

/** 分组标题：今天 / 昨天 / 月日（跨年补年份）。 */
function dayLabel(day: number | null): string {
  if (day === null) return '未知时间'
  const date = new Date(day)
  const today = new Date().setHours(0, 0, 0, 0)
  const diffDays = Math.round((today - day) / 86_400_000)
  if (diffDays === 0) return '今天'
  if (diffDays === 1) return '昨天'
  const monthDay = `${date.getMonth() + 1} 月 ${date.getDate()} 日`
  return date.getFullYear() === new Date(today).getFullYear()
    ? monthDay
    : `${date.getFullYear()} 年 ${monthDay}`
}

function formatClock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** 摘要行：Agent 用结论摘要 + 步数，Normal 用「N 步 · M 步失败」。 */
function metaLineOf(run: AutomationRun): string {
  if (run.mode === 'agent') {
    const steps = run.toolCallCount === undefined ? '' : `${run.toolCallCount} 步`
    const conclusion = run.summary ?? ''
    return [steps, conclusion].filter((part) => part !== '').join(' · ')
  }
  const steps = run.steps ?? []
  if (steps.length === 0) return ''
  const failed = steps.filter((step) => !step.ok).length
  return failed === 0 ? `${steps.length} 步全部完成` : `${steps.length} 步 · ${failed} 步失败`
}

function failedStepOf(run: AutomationRun): string {
  const step = (run.steps ?? []).find((item) => !item.ok)
  if (step === undefined) return ''
  return `${step.label}：${step.error ?? '执行失败'}`
}

function canExpand(run: AutomationRun): boolean {
  if (run.mode === 'agent') return run.sessionId !== undefined
  return (run.steps?.length ?? 0) > 0 || run.error !== undefined
}

async function load(): Promise<void> {
  loading.value = runs.value.length === 0
  error.value = null
  exhausted.value = false
  const result = await window.aurora.automation.history({ mode: tab.value, limit: PAGE_SIZE })
  loading.value = false
  if (!result.ok) {
    error.value = result.message
    return
  }
  runs.value = result.value
  fetched.value = result.value.length
  // 推送刷新时若展开的那条还在，就同步它的终态（不重开面板、不清回放）
  const id = expandedId.value
  if (id === null) return
  const settled = result.value.find((run) => run.id === id)
  if (settled === undefined) closeDetail()
  else void loadReplay(settled)
}

async function loadMore(): Promise<void> {
  loadingMore.value = true
  const result = await window.aurora.automation.history({
    mode: tab.value,
    limit: fetched.value + PAGE_SIZE,
  })
  loadingMore.value = false
  if (!result.ok) {
    error.value = result.message
    return
  }
  if (result.value.length <= fetched.value) {
    exhausted.value = true
    return
  }
  runs.value = result.value
  fetched.value = result.value.length
}

function toReplayMessage(dto: ChatMessageDto): ChatMessage {
  return {
    id: dto.id,
    role: dto.role,
    content: dto.content,
    createdAt: Date.parse(dto.createdAt) || Date.now(),
    ...(dto.requestId === undefined ? {} : { requestId: dto.requestId }),
    ...(dto.toolCalls === undefined ? {} : { toolCalls: dto.toolCalls }),
    ...(dto.reasoning === undefined || dto.reasoning === '' ? {} : { reasoning: dto.reasoning }),
  }
}

/** 拉某条运行的对话回放（只负责取数，展开 / 收起由 `toggleRow` 决定）。 */
async function loadReplay(run: AutomationRun): Promise<void> {
  if (run.mode !== 'agent' || run.sessionId === undefined) return
  replayLoading.value = true
  const result = await window.aurora.chat.history({ sessionId: run.sessionId, limit: 200 })
  replayLoading.value = false
  // 等待期间可能已切到别的行：只认当前展开的那条
  if (expandedId.value !== run.id) return
  if (!result.ok) {
    error.value = result.message
    return
  }
  replay.value = {
    sessionId: run.sessionId,
    messages: result.value.filter((message) => message.role !== 'system').map(toReplayMessage),
  }
}

function toggleRow(run: AutomationRun): void {
  if (!canExpand(run)) return
  if (expandedId.value === run.id) {
    closeDetail()
    return
  }
  expandedId.value = run.id
  replay.value = null
  void loadReplay(run)
}

function closeDetail(): void {
  expandedId.value = null
  replay.value = null
}

function setTab(next: AutomationMode): void {
  if (tab.value === next) return
  tab.value = next
  closeDetail()
  runs.value = []
  fetched.value = 0
  exhausted.value = false
  void load()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (expandedId.value !== null) {
    closeDetail()
    return
  }
  emit('close')
}

onMounted(() => {
  void load()
  offHistoryChanged = window.aurora.automation.onHistoryChanged(() => void load())
  window.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  offHistoryChanged?.()
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <section class="history-view" data-field="automation.history-panel">
    <header class="view-head">
      <component
        :is="tab === 'agent' ? Bot : Zap"
        :size="15"
        :stroke-width="1.7"
        aria-hidden="true"
      />
      <h2>运行历史</h2>
      <div class="tabs" role="tablist">
        <button
          type="button"
          class="tab press"
          data-field="automation.tab-agent"
          :class="{ active: tab === 'agent' }"
          role="tab"
          :aria-selected="tab === 'agent'"
          @click="setTab('agent')"
        >
          <Bot :size="13" :stroke-width="1.7" aria-hidden="true" />
          Agent Mode
        </button>
        <button
          type="button"
          class="tab press"
          data-field="automation.tab-normal"
          :class="{ active: tab === 'normal' }"
          role="tab"
          :aria-selected="tab === 'normal'"
          @click="setTab('normal')"
        >
          <Zap :size="13" :stroke-width="1.7" aria-hidden="true" />
          Normal Mode
        </button>
      </div>
      <span class="grow" />
      <AppTooltip text="关闭" placement="bottom">
        <button
          type="button"
          class="icon-btn press"
          data-action="automation.history-close"
          aria-label="关闭"
          @click="emit('close')"
        >
          <X :size="15" :stroke-width="1.7" aria-hidden="true" />
        </button>
      </AppTooltip>
    </header>

    <div class="view-body">
      <p v-if="error !== null" class="feedback error" role="alert">{{ error }}</p>
      <p v-if="loading" class="tiny muted">加载中…</p>
      <p v-else-if="runs.length === 0" class="tiny muted">还没有运行记录。</p>

      <div v-for="group in groups" :key="group.key" class="day-group">
        <h3 class="day-head tiny muted">{{ group.label }}</h3>
        <ul class="run-list" data-field="automation.history-list">
          <li
            v-for="run in group.runs"
            :key="run.id"
            class="run-item"
            :class="{ clickable: canExpand(run), expanded: expandedId === run.id }"
            @click="toggleRow(run)"
          >
            <span class="run-status-icon" :class="run.status" aria-hidden="true">
              <component
                :is="statusIconOf(run.status)"
                :size="13"
                :stroke-width="1.8"
                :class="{ spin: run.status === 'running' }"
              />
            </span>
            <span class="run-time">{{ formatClock(run.triggeredAt) }}</span>
            <span class="run-name">{{ run.automationName }}</span>
            <span v-if="run.triggerDetail" class="run-trigger tiny">{{ run.triggerDetail }}</span>
            <span class="run-status tiny" :class="run.status">{{ STATUS_LABELS[run.status] }}</span>
            <span v-if="run.durationMs !== undefined" class="tiny muted run-duration">
              {{ formatDuration(run.durationMs) }}
            </span>
            <span v-if="canExpand(run)" class="run-caret" aria-hidden="true">
              <component
                :is="expandedId === run.id ? ChevronDown : ChevronRight"
                :size="12"
                :stroke-width="1.8"
              />
            </span>

            <p v-if="metaLineOf(run) !== ''" class="run-meta tiny muted">{{ metaLineOf(run) }}</p>
            <p v-if="failedStepOf(run) !== ''" class="run-error tiny">{{ failedStepOf(run) }}</p>
            <p
              v-else-if="run.status === 'failed' && run.error !== undefined && run.error !== ''"
              class="run-error tiny"
            >
              {{ run.error }}
            </p>

            <!--
              明细不是行首的一部分：整行挂着 `toggleRow`，回放里任何一次点击（展开轨迹 /
              点开一条工具行）冒泡上来都会把这条记录收起来 —— 2026-10-17 用户报的
              「点折叠的工具调用记录，历史对话就关了」就是这个冒泡。这里阻断冒泡。
            -->
            <div
              v-if="expandedId === run.id"
              class="run-detail"
              data-field="automation.run-detail"
              @click.stop
            >
              <p class="detail-head tiny muted">
                {{ formatTime(run.triggeredAt) }}
                <template v-if="run.triggerDetail"> · {{ run.triggerDetail }}</template>
                · {{ STATUS_LABELS[run.status] }}
                <template v-if="run.durationMs !== undefined">
                  · {{ formatDuration(run.durationMs) }}</template
                >
              </p>

              <template v-if="run.mode === 'agent'">
                <p v-if="replayLoading" class="tiny muted">加载对话…</p>
                <div v-else-if="replay === null" class="tiny muted">会话已被删除或还没有消息。</div>
                <div v-else class="replay" data-field="automation.replay">
                  <MessageList
                    :key="replay.sessionId"
                    :messages="replay.messages"
                    :session-id="replay.sessionId"
                    :streaming="false"
                    :latest-turn-groupable="true"
                    empty-hint="会话已被删除或还没有消息。"
                  />
                </div>
              </template>

              <ol v-else-if="run.steps !== undefined && run.steps.length > 0" class="step-list">
                <li v-for="(step, index) in run.steps" :key="index" class="step-item">
                  <span class="step-icon" :class="{ failed: !step.ok }" aria-hidden="true">
                    <component
                      :is="step.ok ? CircleCheck : CircleX"
                      :size="12"
                      :stroke-width="1.8"
                    />
                  </span>
                  <span class="step-index tiny muted">{{ index + 1 }}</span>
                  <span class="step-label">{{ step.label }}</span>
                  <span class="step-result tiny muted">{{ step.summary ?? step.error ?? '' }}</span>
                </li>
              </ol>
              <p v-else class="tiny muted">这次运行没有记录到操作明细。</p>
            </div>
          </li>
        </ul>
      </div>

      <button
        v-if="hasMore && !loading"
        type="button"
        class="load-more press tiny"
        data-action="automation.history-more"
        :disabled="loadingMore"
        @click="loadMore"
      >
        {{ loadingMore ? '加载中…' : '加载更多' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.history-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--glass-content);
}

.view-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
}

.view-head h2 {
  margin: 0;
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
}

.view-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /*
   * 左右 / 底部留白照旧，**顶部必须为 0**：吸顶是按滚动区**内容盒**上沿对齐的，
   * 容器上边距会把每条分组标题整体顶下去，标题上方留出一条没上色的缝 —— 记录照样从缝里
   * 露出来（2026-10-17 实测：滚动区顶部 16px 内边距 → 所有吸顶标题都停在离上沿 16px 处）。
   * 顶部留白改由标题自己的上内边距给，提示语另给上外边距。
   */
  padding: 0 var(--space-4) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.grow {
  flex: 1;
}

.tabs {
  display: inline-flex;
  padding: 2px;
  border-radius: var(--radius-md);
  background: var(--fill-2);
  gap: 2px;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}

.tab.active {
  background: var(--bg-raised);
  color: var(--text-primary);
  box-shadow: var(--shadow-hairline);
}

.feedback {
  margin: var(--space-4) 0 0;
  padding: 6px var(--space-3);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
}

/* 加载中 / 空列表两句提示：顶部留白让给了吸顶标题（见 .view-body），这里自己补上 */
.view-body > p.tiny {
  margin: var(--space-4) 0 0;
}

.feedback.error {
  background: var(--error-fill);
  color: var(--error-text);
}

.day-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/*
 * 分组标题吸顶：列表一长就没有时间坐标了（吸在滚动区上沿）。
 * 底色必须不透明、且不许留外间距：半透明底（原 `--glass-content`）或吸顶盒上方的 margin
 * 缝都会让滚过去的记录透出来 / 露出来，与标题文字叠成花屏（2026-10-17 用户报的「时间标识错乱」）。
 */
.day-head {
  position: sticky;
  top: 0;
  z-index: 1;
  margin: 0;
  /* 上内边距兼作首组标题的上方留白（滚动区不再有上内边距，见 .view-body） */
  padding: var(--space-3) var(--space-2) 3px 0;
  background: var(--bg-raised);
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-muted);
  font-weight: var(--weight-medium);
}

.run-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.run-item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: 6px var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
}

.run-item.clickable {
  cursor: pointer;
}

.run-item.clickable:hover {
  background: var(--fill-2);
}

.run-item.expanded {
  background: var(--fill-1);
}

.run-status-icon {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  color: var(--text-muted);
}

.run-status-icon.success {
  color: var(--status-ok);
}

.run-status-icon.failed,
.run-status-icon.interrupted {
  color: var(--status-error);
}

.run-status-icon.running {
  color: var(--accent-text);
  animation: aurora-breathe var(--dur-pulse) var(--ease-standard) infinite;
}

.run-time {
  flex: 0 0 auto;
  color: var(--text-secondary);
  font-variant-numeric: var(--num-tabular);
}

.run-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}

.run-trigger {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  background: var(--fill-2);
  color: var(--text-secondary);
}

.run-status {
  flex: 0 0 auto;
  color: var(--text-muted);
}

.run-status.success {
  color: var(--status-ok);
}

.run-status.failed,
.run-status.interrupted {
  color: var(--status-error);
}

.run-status.running {
  color: var(--accent-text);
}

.run-duration {
  flex: 0 0 auto;
  font-variant-numeric: var(--num-tabular);
}

.run-caret {
  display: inline-flex;
  flex: 0 0 auto;
  color: var(--text-muted);
}

.run-item.clickable:hover .run-caret {
  color: var(--accent-text);
}

.run-meta {
  flex-basis: 100%;
  min-width: 0;
  margin: 0;
  padding-left: 21px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.run-error {
  flex-basis: 100%;
  min-width: 0;
  margin: 0;
  padding-left: 21px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--status-error);
}

.run-detail {
  flex-basis: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-1);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
  border: 1px solid var(--border-subtle);
}

.detail-head {
  margin: 0;
}

.replay {
  max-height: 46vh;
  min-height: 0;
  overflow-y: auto;
  padding-right: var(--space-1);
}

.step-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.step-item {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  padding: 3px 0;
  font-size: var(--text-sm);
}

.step-icon {
  display: inline-flex;
  color: var(--status-ok);
}

.step-icon.failed {
  color: var(--status-error);
}

.step-index {
  width: 14px;
  font-variant-numeric: var(--num-tabular);
}

.step-label {
  flex: 0 0 auto;
  color: var(--text-primary);
}

.step-result {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.load-more {
  align-self: center;
  margin-top: var(--space-2);
  padding: 5px var(--space-4);
  border-radius: var(--radius-pill);
  background: var(--fill-2);
  color: var(--text-secondary);
}

.icon-btn {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-xs);
  color: var(--text-muted);
}

.icon-btn:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}
</style>
