<script setup lang="ts">
/**
 * 分类流水面板（docs/05 §3.3）：时间 / 文件 / 科目 / 依据 + 就地修正 + 打开所在文件夹 + 清空。
 *
 * 交互窗与设置页共用。默认折叠（`startOpen = false`），避免挤占对话区域；
 * 折叠时标题行仍展示条数与「处理中」状态，用户能感知后台在归类。
 */
import { computed, onMounted, ref } from 'vue'
import { ChevronRight } from '../icons.js'
import type { ClassificationState } from '@aurora/shared'
import type { ClassificationRow } from '../composables/useClassification.js'
import {
  classificationSourceLabel,
  classificationStateLabel,
  isClassificationActive,
  useClassification,
} from '../composables/useClassification.js'
import { useSettingsStore } from '../stores.js'
import AppButton from './AppButton.vue'

const props = withDefaults(defineProps<{ limit?: number; startOpen?: boolean; title?: string }>(), {
  limit: 20,
  startOpen: false,
  title: '分类流水',
})

const settingsStore = useSettingsStore()
const ledger = useClassification({ limit: props.limit })
const {
  rows,
  queueDepth,
  running,
  loading,
  error,
  activeCount,
  hydrate,
  correct,
  clear,
  openFolder,
} = ledger

const open = ref(props.startOpen)
const busyId = ref<string | null>(null)
const notice = ref<string | null>(null)

const subjects = computed(() => settingsStore.settings?.modes.classroom.subjects ?? [])
const watchDir = computed(() => settingsStore.settings?.modes.classroom.watchDir ?? '')

onMounted(() => {
  void hydrate()
})

/** 「今天」只显示时刻，更早的补月-日，避免跨天流水看不出日期。 */
function timeLabel(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '--:--'
  const pad = (value: number): string => String(value).padStart(2, '0')
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  const today = new Date()
  if (date.toDateString() === today.toDateString()) return clock
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${clock}`
}

function confidenceLabel(value: number): string {
  return `${Math.round(value * 100)}%`
}

function stateBadge(state: ClassificationState): string {
  if (state === 'done') return 'ok'
  if (state === 'fallback') return 'warn'
  if (state === 'error') return 'error'
  return ''
}

async function pickSubject(row: ClassificationRow, event: Event): Promise<void> {
  const select = event.target as HTMLSelectElement
  const subject = select.value
  select.value = ''
  if (subject === '') return
  busyId.value = row.id
  notice.value = null
  const ok = await correct(row.id, subject)
  busyId.value = null
  if (ok) notice.value = `《${row.record.fileName}》已改到「${subject}」`
}

async function openRecordFolder(row: ClassificationRow): Promise<void> {
  notice.value = null
  const ok = await openFolder(row.record)
  if (ok) notice.value = `已打开：${row.record.subject === '' ? '感知文件夹' : row.record.subject}`
}

async function clearAll(): Promise<void> {
  const confirmed = window.confirm('确定清空分类流水吗？已沉淀的分类规则不会被删除。')
  if (!confirmed) return
  notice.value = null
  if (await clear()) notice.value = '分类流水已清空'
}
</script>

<template>
  <section class="ledger" :class="{ open }">
    <button class="head" type="button" @click="open = !open">
      <ChevronRight class="chevron" :size="14" :stroke-width="1.8" aria-hidden="true" />
      <strong>{{ title }}</strong>
      <span v-if="rows.length > 0" class="badge">{{ rows.length }} 条</span>
      <span v-if="activeCount > 0 || running > 0" class="badge run">处理中</span>
      <span v-else-if="queueDepth > 0" class="badge">排队 {{ queueDepth }}</span>
      <span class="grow" />
      <span class="tiny muted">{{ open ? '收起' : '展开' }}</span>
    </button>

    <div v-if="open" class="body">
      <p v-if="error" class="tiny err">{{ error }}</p>
      <p v-else-if="notice" class="tiny ok">{{ notice }}</p>

      <div class="row">
        <span class="tiny muted grow ellipsis">
          感知文件夹：<span class="mono">{{ watchDir === '' ? '未配置' : watchDir }}</span>
        </span>
        <AppButton
          size="sm"
          variant="ghost"
          :disabled="loading || rows.length === 0"
          @click="clearAll"
        >
          清空流水
        </AppButton>
      </div>

      <p v-if="rows.length === 0" class="tiny muted empty">
        暂无分类记录：把文件放进感知文件夹后会自动归类。
      </p>

      <div v-else class="list">
        <article v-for="row in rows" :key="row.id" class="item">
          <div class="line">
            <span
              class="dot"
              :class="`s-${row.state}`"
              :title="classificationStateLabel(row.state)"
            />
            <span class="tiny mono time">{{ timeLabel(row.record.occurredAt) }}</span>
            <span class="name grow ellipsis" :title="row.record.path">
              {{ row.record.fileName }}
            </span>
            <span class="badge" :class="stateBadge(row.state)">
              {{ classificationStateLabel(row.state) }}
            </span>
            <select
              class="pick"
              :disabled="
                subjects.length === 0 || isClassificationActive(row.state) || busyId === row.id
              "
              :title="
                subjects.length === 0
                  ? '请先在「设置 → 模式 → ClassRoom」添加科目'
                  : '把这条记录改到其他科目'
              "
              @change="pickSubject(row, $event)"
            >
              <option value="">改到其他科目…</option>
              <option v-for="subject in subjects" :key="subject.name" :value="subject.name">
                {{ subject.name }}
              </option>
            </select>
            <AppButton size="sm" variant="ghost" @click="openRecordFolder(row)">
              打开所在文件夹
            </AppButton>
          </div>
          <p class="tiny muted detail">
            <span v-if="row.record.subject !== ''" class="tag">{{ row.record.subject }}</span>
            <span class="tag">{{ classificationSourceLabel(row.record.source) }}</span>
            <span v-if="row.record.confidence > 0" class="tag">
              置信 {{ confidenceLabel(row.record.confidence) }}
            </span>
            <span class="reason" :title="row.record.reason">{{ row.record.reason }}</span>
            <span v-if="row.record.corrected === true" class="tag">已修正</span>
            <span v-if="row.record.movedTo" class="tag" :title="row.record.movedTo">已移动</span>
          </p>
        </article>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ledger {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--fill-1);
  box-shadow: var(--shadow-hairline);
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: 8px var(--space-3);
  text-align: left;
  transition: background var(--transition-fast);
}

.head:hover {
  background: var(--fill-2);
}

.head strong {
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-eyebrow);
  color: var(--text-secondary);
}

.chevron {
  display: inline-block;
  color: var(--text-muted);
  transition: transform var(--transition-fast);
}

.open .chevron {
  transform: rotate(90deg);
}

.body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: 0 var(--space-3) var(--space-3);
}

.ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-height: 220px;
  overflow-y: auto;
}

.item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  box-shadow: var(--shadow-hairline);
  transition: background var(--transition-fast);
}

.item:hover {
  background: var(--fill-2);
}

.line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.time {
  color: var(--text-muted);
  flex: 0 0 auto;
  font-variant-numeric: var(--num-tabular);
}

.name {
  font-size: var(--text-base);
  min-width: 0;
}

.dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--status-idle);
}

.dot.s-done {
  background: var(--status-ok);
}

.dot.s-fallback {
  background: var(--status-unread);
}

.dot.s-error {
  background: var(--status-error);
}

.dot.s-skipped {
  background: var(--status-idle);
}

.dot.s-queued,
.dot.s-extracting,
.dot.s-classifying,
.dot.s-moving {
  background: var(--status-running);
}

.badge.run {
  background: var(--status-running-ring);
  color: var(--status-running);
}

.head .badge,
.detail .tag {
  font-variant-numeric: var(--num-tabular);
}

.pick {
  flex: 0 0 auto;
  max-width: 132px;
  padding: 3px 6px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  transition:
    border-color var(--transition-fast),
    box-shadow var(--transition-fast);
}

.pick:focus {
  border-color: var(--focus-ring);
  box-shadow: 0 0 0 1px var(--accent-ring);
  outline: none;
}

.pick:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.detail {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  min-width: 0;
}

.tag {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  background: var(--fill-2);
  color: var(--text-secondary);
}

.reason {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty {
  margin: 0;
  padding: var(--space-2) 0;
}

.err {
  margin: 0;
  color: var(--error-text);
}

.ok {
  margin: 0;
  color: var(--ok-text);
}
</style>
