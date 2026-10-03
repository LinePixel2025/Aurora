<script setup lang="ts">
/**
 * 「任务（Job）」面板（主界面右栏，docs/06 §4.1）。
 *
 * 一条**长任务**在 Agent 循环里可能因为「轮次用尽」或「token 预算触顶」而暂停
 * （`status: 'paused'` + `pendingReason`），此前用户界面上完全看不出来 —— 回复停在中途、
 * 也没人告诉他可以接着跑。本面板把当前会话的任务列出来：跑到第几轮、花了多少 token、
 * 做过哪些步骤、待办还剩什么，并给出**续跑入口**（「继续」）。
 *
 * 数据由 `useChat()` 持有（`jobs` 事件就地更新 + `chat:jobs` 水合），本组件只负责展示与上报意图
 * （emit），不自己拉 IPC —— 与 `SessionNav` / `SubagentPage` 同一分工口径。
 *
 * `data-field` 锚点是 capture 探针契约（面板 `chat.job-panel` / 每条 `chat.job-item` /
 * 继续 `chat.job-resume` / 取消 `chat.job-cancel`），不可改名。
 */
import { computed } from 'vue'
import type { AgentJob, AgentJobStatus } from '@aurora/shared'
import AppButton from '../../shared/components/AppButton.vue'
import { PENDING_REASON_TEXT } from '../../shared/composables/useChat.js'
import { ListChecks } from '@aurora/shared/browser'

const props = defineProps<{ jobs: AgentJob[] }>()

const emit = defineEmits<{
  (event: 'resume', id: string): void
  (event: 'cancel', id: string): void
}>()

/**
 * 状态徽标：文案 + 全局 `.badge` 的语义色（theme.css 既有类，不新增全局样式）。
 * 运行中与排队中保持中性填充：它们不是「结果」，用语义色反而会让整列一直在闪。
 */
const STATUS_VIEW: Record<AgentJobStatus, { label: string; badge: string }> = {
  queued: { label: '排队中', badge: 'badge' },
  running: { label: '进行中', badge: 'badge' },
  paused: { label: '已暂停', badge: 'badge warn' },
  done: { label: '已完成', badge: 'badge ok' },
  error: { label: '出错', badge: 'badge error' },
  aborted: { label: '已取消', badge: 'badge' },
}

/** 待办清单最多显示几条（余量折成一行「还有 N 项」，长清单不占满右栏） */
const TODO_LIMIT = 5
/** 已完成步骤只回看最近几步（时间线是「刚发生了什么」，不是完整审计日志） */
const STEP_LIMIT = 3

/** 只有暂停中的任务才有「继续」（续跑入口的唯一门控） */
function canResume(job: AgentJob): boolean {
  return job.status === 'paused'
}

/** 在跑 / 暂停 / 排队的任务都可以取消（已结束的没有可取消的东西） */
function canCancel(job: AgentJob): boolean {
  return job.status === 'running' || job.status === 'paused' || job.status === 'queued'
}

/** 暂停原因文案：与 `done` 事件的提示**共用同一份**（`useChat` 导出），避免两处措辞漂移 */
function pendingText(job: AgentJob): string | null {
  const reason = job.pendingReason
  if (reason === undefined) return null
  return PENDING_REASON_TEXT[reason]
}

/** 待办：整表快照，只显示前几条；`completed` 在模板里划掉 */
function visibleTodos(job: AgentJob): AgentJob['todos'] {
  return job.todos.slice(0, TODO_LIMIT)
}

function hiddenTodoCount(job: AgentJob): number {
  return Math.max(0, job.todos.length - TODO_LIMIT)
}

/** 最近几步（新的在前）：`stepsDone` 是按发生顺序追加的 */
function recentSteps(job: AgentJob): AgentJob['stepsDone'] {
  return job.stepsDone.slice(-STEP_LIMIT).reverse()
}

/** token 用量：`maxTotalTokens === 0` 表示不限（Schema 语义，别显示成 `0/0`） */
function tokenLabel(job: AgentJob): string {
  const { usedTokens, maxTotalTokens } = job.budget
  return maxTotalTokens === 0 ? `${usedTokens} / 不限` : `${usedTokens} / ${maxTotalTokens}`
}

/** 轮次：与 StatusDot / 会话列表同一套等宽数字排版 */
function roundLabel(job: AgentJob): string {
  return `第 ${job.round}/${job.maxRounds} 轮`
}

/** `updatedAt`（ISO 串）→ 本地时间：当天只给时刻，跨天带上月日；解析不出来就原样回显 */
function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number): string => String(value).padStart(2, '0')
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  const now = new Date()
  if (date.toDateString() === now.toDateString()) return time
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${time}`
}

/** 面板头的小结：一眼看清有几条在跑 / 有几条等续跑（空态时整行不渲染） */
const summary = computed(() => {
  const running = props.jobs.filter((job) => job.status === 'running').length
  const paused = props.jobs.filter((job) => job.status === 'paused').length
  const parts: string[] = []
  if (running > 0) parts.push(`${running} 条进行中`)
  if (paused > 0) parts.push(`${paused} 条待继续`)
  return parts.join(' · ')
})
</script>

<template>
  <section class="job-panel" data-field="chat.job-panel">
    <header class="panel-head">
      <ListChecks :size="14" :stroke-width="1.6" class="panel-icon" aria-hidden="true" />
      <strong class="panel-title">任务</strong>
      <span v-if="props.jobs.length > 0" class="job-count tiny">{{ props.jobs.length }}</span>
      <span class="grow" />
      <span v-if="summary !== ''" class="tiny muted panel-summary">{{ summary }}</span>
    </header>

    <!-- 空态：整块仍然渲染（否则用户不知道这里会显示什么） -->
    <p v-if="props.jobs.length === 0" class="tiny muted job-empty">暂无任务</p>

    <ul v-else class="job-list">
      <li v-for="job in props.jobs" :key="job.id" class="job-item" data-field="chat.job-item">
        <div class="job-head">
          <span :class="STATUS_VIEW[job.status].badge">{{ STATUS_VIEW[job.status].label }}</span>
          <span class="tiny muted job-time">{{ formatTime(job.updatedAt) }}</span>
        </div>

        <!-- 任务原文：多条任务并列时，这是唯一能区分它们的标识 -->
        <p v-if="job.text.trim() !== ''" class="job-text" :title="job.text">{{ job.text }}</p>

        <div class="job-meta tiny muted">
          <span>{{ roundLabel(job) }}</span>
          <span>token {{ tokenLabel(job) }}</span>
          <span v-if="job.budget.autoContinued > 0"
            >已自动续 {{ job.budget.autoContinued }} 轮</span
          >
        </div>

        <!-- 暂停原因：说清「为什么停下、怎么接着跑」，与 done 事件的提示同一份措辞 -->
        <p v-if="pendingText(job) !== null" class="tiny job-pending">{{ pendingText(job) }}</p>

        <ul v-if="job.todos.length > 0" class="job-todos">
          <li
            v-for="todo in visibleTodos(job)"
            :key="todo.id"
            class="tiny todo-row"
            :class="{ done: todo.status === 'completed' }"
          >
            <span class="todo-mark" aria-hidden="true">{{
              todo.status === 'completed' ? '✓' : '·'
            }}</span>
            <span class="todo-text">{{ todo.text }}</span>
          </li>
          <li v-if="hiddenTodoCount(job) > 0" class="tiny muted todo-row">
            还有 {{ hiddenTodoCount(job) }} 项
          </li>
        </ul>

        <!-- 已完成步骤时间线（最近几条）：round + 工具名 + 成败 -->
        <ul v-if="job.stepsDone.length > 0" class="job-steps">
          <li
            v-for="step in recentSteps(job)"
            :key="`${step.round}:${step.tool}:${step.at}`"
            class="tiny step-row"
          >
            <span class="step-round muted">第 {{ step.round }} 轮</span>
            <code class="mono step-tool">{{ step.tool }}</code>
            <span :class="step.ok ? 'step-ok' : 'step-fail'">{{ step.ok ? '成功' : '失败' }}</span>
          </li>
        </ul>

        <p v-if="job.status === 'error' && job.error !== undefined" class="tiny job-error">
          {{ job.error }}
        </p>

        <div v-if="canResume(job) || canCancel(job)" class="job-actions">
          <!-- 续跑入口：只对暂停中的任务出现（其余状态点了没有意义） -->
          <AppButton
            v-if="canResume(job)"
            size="sm"
            variant="primary"
            data-field="chat.job-resume"
            title="从暂停处接着跑这条任务"
            @click="emit('resume', job.id)"
          >
            继续
          </AppButton>
          <AppButton
            v-if="canCancel(job)"
            size="sm"
            variant="ghost"
            data-field="chat.job-cancel"
            title="中止这条任务（已产出的内容与进度保留）"
            @click="emit('cancel', job.id)"
          >
            取消
          </AppButton>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
/* 固定像素宽（跟随右栏实际宽度 `--ctx-w-eff`，2026-10-03 起可拖拽调宽）：
   外层 aside 折叠时宽度收 0，这里保持内容不被压缩换行（与右栏同一口径）。
   ⚠️ 读 `--ctx-w-eff`（实际生效宽度，还受窗口 62% 约束），不要读裸 `--ctx-w`。 */
.job-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: var(--ctx-w-eff, 384px);
  min-width: 0;
  padding: var(--space-3) var(--space-3) 0;
  background: var(--fill-1);
  border-bottom: 1px solid var(--border-subtle);
}

.panel-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
}

.panel-head .grow {
  flex: 1;
  min-width: 0;
}

.panel-icon {
  flex: 0 0 auto;
  color: var(--text-muted);
}

/* 任务条数：中性填充（`.badge` 的底色与面板同为 `--fill-1`，在面板里几乎看不见） */
.job-count {
  flex: 0 0 auto;
  min-width: 18px;
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: var(--fill-3);
  color: var(--text-secondary);
  text-align: center;
  font-variant-numeric: var(--num-tabular);
}

/* 小结是次要信息：让位给标题与计数（264px 宽，长了就省略） */
.panel-summary {
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.job-empty {
  margin: 0;
  padding-bottom: var(--space-3);
}

/* 列表：面板整体按内容增高，条目多了自己在内部滚（不把上下文栏挤没） */
.job-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0 0 var(--space-3);
  list-style: none;
  max-height: 300px;
  overflow-y: auto;
}

.job-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--fill-1);
  box-shadow: var(--shadow-hairline);
}

.job-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.job-time {
  margin-left: auto;
  font-variant-numeric: var(--num-tabular);
}

/* 任务原文：单行省略（完整原文在 title 里） */
.job-text {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
}

.job-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  font-variant-numeric: var(--num-tabular);
}

/* 暂停原因：比普通元信息重一档（它是「要不要点继续」的依据） */
.job-pending {
  margin: 0;
  color: var(--warning-text);
}

.job-todos,
.job-steps {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.todo-row,
.step-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.todo-mark {
  flex: 0 0 auto;
  width: 10px;
  color: var(--text-muted);
  text-align: center;
}

.todo-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 已完成的待办划掉（未完成的保持正常字色） */
.todo-row.done .todo-text {
  text-decoration: line-through;
  color: var(--text-muted);
}

.step-round {
  flex: 0 0 auto;
  font-variant-numeric: var(--num-tabular);
}

.step-tool {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.step-ok {
  flex: 0 0 auto;
  color: var(--ok-text);
}

.step-fail {
  flex: 0 0 auto;
  color: var(--error-text);
}

.job-error {
  margin: 0;
  color: var(--error-text);
}

.job-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-1);
}
</style>
