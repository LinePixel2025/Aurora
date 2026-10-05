<script setup lang="ts">
/**
 * 自动化独立窗口的运行历史视图（docs/07 §2.2.1、docs/13 §11）。
 */
import { onMounted, onUnmounted, ref } from 'vue'
import type { AutomationMode, AutomationRun, ChatMessageDto } from '@aurora/shared'
import AppTooltip from '../../shared/components/AppTooltip.vue'
import {
  Bot,
  ChevronRight,
  CircleCheck,
  CircleStop,
  CircleX,
  Clock,
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

const tab = ref<AutomationMode>(props.mode)
const runs = ref<AutomationRun[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const detail = ref<{ run: AutomationRun; messages: ChatMessageDto[] } | null>(null)
const detailLoading = ref(false)
let offHistoryChanged: (() => void) | null = null

const STATUS_LABELS: Record<AutomationRun['status'], string> = {
  running: '进行中',
  success: '成功',
  failed: '失败',
  interrupted: '已中断',
}

function statusIconOf(status: AutomationRun['status']): typeof CircleCheck {
  if (status === 'running') return LoaderCircle
  if (status === 'failed') return CircleX
  if (status === 'interrupted') return CircleStop
  return CircleCheck
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

async function refresh(): Promise<void> {
  loading.value = true
  error.value = null
  detail.value = null
  runs.value = []
  const result = await window.aurora.automation.history({ mode: tab.value, limit: 100 })
  loading.value = false
  if (result.ok) runs.value = result.value
  else error.value = result.message
}

async function openDetail(run: AutomationRun): Promise<void> {
  if (run.mode !== 'agent' || run.sessionId === undefined) return
  detailLoading.value = true
  const result = await window.aurora.chat.history({ sessionId: run.sessionId, limit: 200 })
  detailLoading.value = false
  if (!result.ok) {
    error.value = result.message
    return
  }
  detail.value = { run, messages: result.value.filter((message) => message.role !== 'system') }
}

function setTab(next: AutomationMode): void {
  if (tab.value === next) return
  tab.value = next
  void refresh()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (detail.value !== null) {
    detail.value = null
    return
  }
  emit('close')
}

onMounted(() => {
  void refresh()
  offHistoryChanged = window.aurora.automation.onHistoryChanged(() => void refresh())
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
      <ul v-else class="run-list" data-field="automation.history-list">
        <li
          v-for="run in runs"
          :key="run.id"
          class="run-item"
          :class="{ clickable: run.mode === 'agent' && run.sessionId !== undefined }"
          @click="openDetail(run)"
        >
          <span class="run-status-icon" :class="run.status" aria-hidden="true">
            <component
              :is="statusIconOf(run.status)"
              :size="13"
              :stroke-width="1.8"
              :class="{ spin: run.status === 'running' }"
            />
          </span>
          <span class="run-time">
            <Clock :size="12" :stroke-width="1.7" aria-hidden="true" />
            {{ formatTime(run.triggeredAt) }}
          </span>
          <span class="run-name">{{ run.automationName }}</span>
          <span class="run-status tiny" :class="run.status">{{ STATUS_LABELS[run.status] }}</span>
          <span v-if="run.durationMs !== undefined" class="tiny muted run-duration">
            {{ formatDuration(run.durationMs) }}
          </span>
          <span
            v-if="run.mode === 'agent' && run.sessionId !== undefined"
            class="run-open tiny"
            aria-hidden="true"
          >
            查看对话
            <ChevronRight :size="11" :stroke-width="1.8" />
          </span>
          <span
            v-if="run.status === 'failed' && run.error !== undefined && run.error !== ''"
            class="run-error tiny"
            :title="run.error"
          >
            {{ run.error }}
          </span>
        </li>
      </ul>

      <section v-if="detail !== null" class="run-detail">
        <h3 class="detail-title tiny muted">
          「{{ detail.run.automationName }}」的对话回放 · {{ formatTime(detail.run.triggeredAt) }} ·
          {{ STATUS_LABELS[detail.run.status]
          }}<template v-if="detail.run.durationMs !== undefined">
            · {{ formatDuration(detail.run.durationMs) }}</template
          >
        </h3>
        <p v-if="detailLoading" class="tiny muted">加载对话…</p>
        <div v-else-if="detail.messages.length === 0" class="tiny muted">
          会话已被删除或还没有消息。
        </div>
        <template v-else>
          <div
            v-for="message in detail.messages"
            :key="message.id"
            class="detail-message"
            :class="message.role"
          >
            <span class="role-tag tiny muted">{{
              message.role === 'user' ? '任务' : 'Agent'
            }}</span>
            <p class="detail-content">{{ message.content }}</p>
          </div>
        </template>
      </section>
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
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
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
  margin: 0;
  padding: 6px var(--space-3);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
}

.feedback.error {
  background: var(--error-fill);
  color: var(--error-text);
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

.run-time,
.run-open {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}

.run-time {
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

.run-open {
  color: var(--text-muted);
}

.run-item.clickable:hover .run-open {
  color: var(--accent-text);
}

.run-error {
  flex-basis: 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--status-error);
}

.run-detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}

.detail-title {
  margin: 0;
}

.detail-message {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--fill-1);
}

.detail-message.user {
  background: color-mix(in srgb, var(--aurora-blue) 8%, transparent);
}

.detail-content {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
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
