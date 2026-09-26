<script setup lang="ts">
/**
 * 子代理页面（2026-09 新增，docs/07 §2.3）。
 *
 * `task` 工具派生的子代理此前在界面上只有主对话里一张工具卡：既看不到过程
 * （子循环的文本 / 工具调用不外传），也看不到产出（报告全文只回给主代理）。
 * 本页面把「本会话的全部子代理运行」集中呈现：状态、耗时、每一步在干什么、最终报告。
 *
 * 数据来源（`useChat().subagentRuns`，computed 已合并两个来源）：
 * - 实时事件（`subagent`，docs/06 §19）—— 运行中就地长步骤；
 * - 消息流里 `task` 工具卡的持久化快照 —— 重启后仍能回看历史运行。
 *
 * 只读页面：子代理的生死跟着父对话那次工具调用，界面不提供干预入口（要中止就中止父请求）。
 */
import { computed, ref } from 'vue'
import type { SubagentRun } from '../../shared/composables/useChat.js'
import { Bot, ChevronRight, Clock, MessageSquare } from '../../shared/icons.js'
import SubagentTrace from '../../shared/components/SubagentTrace.vue'

const props = defineProps<{
  runs: SubagentRun[]
  /** 所属会话标题（页面副标题，让用户知道在看哪个会话的子代理） */
  sessionTitle: string
}>()

const emit = defineEmits<{
  (event: 'back'): void
}>()

/** 已展开「任务指令」的运行（默认收起：报告与轨迹才是主体，指令通常是长文） */
const openedRuns = ref<string[]>([])

function runKey(run: SubagentRun): string {
  return run.callId === '' ? run.taskId : run.callId
}

function isOpen(key: string): boolean {
  return openedRuns.value.includes(key)
}

function toggle(key: string): void {
  openedRuns.value = isOpen(key)
    ? openedRuns.value.filter((item) => item !== key)
    : [...openedRuns.value, key]
}

const runningCount = computed(() => props.runs.filter((run) => run.status === 'running').length)

const totalToolCalls = computed(() => props.runs.reduce((total, run) => total + run.toolCalls, 0))

/** 相对时间：刚刚 / N 分钟前 / 当天时刻 / 月-日（与其他列表口径一致） */
function formatTime(at: number): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  const diff = Date.now() - at
  const minute = 60_000
  if (diff < minute) return '刚刚'
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

/** 单次运行的总耗时（秒，一位小数） */
function elapsedOf(run: SubagentRun): string {
  const end = run.endedAt ?? Date.now()
  return `${(Math.max(0, end - run.startedAt) / 1000).toFixed(1)}s`
}

function statusLabel(status: SubagentRun['status']): string {
  if (status === 'running') return '进行中'
  return status === 'success' ? '已完成' : '失败'
}
</script>

<template>
  <section class="subagent-page" data-field="chat.subagent-page">
    <header class="page-head">
      <Bot :size="16" :stroke-width="1.7" aria-hidden="true" />
      <strong class="page-title">子代理</strong>
      <span class="tiny muted page-sub">{{ props.sessionTitle }}</span>
      <span class="grow" />
      <button
        type="button"
        class="back-btn press"
        data-action="chat.subagent-back"
        @click="emit('back')"
      >
        <MessageSquare :size="13" :stroke-width="1.7" aria-hidden="true" />
        回到对话
      </button>
    </header>

    <div class="page-body">
      <!-- 概览条：一眼看清本会话派了多少、还在跑几个、总共调了多少次工具 -->
      <div v-if="props.runs.length > 0" class="summary" data-field="chat.subagent-summary">
        <span class="tiny"
          >共 <b>{{ props.runs.length }}</b> 次运行</span
        >
        <span v-if="runningCount > 0" class="tiny running-text"> {{ runningCount }} 个进行中 </span>
        <span class="tiny muted">{{ totalToolCalls }} 次工具调用</span>
      </div>

      <article
        v-for="run in props.runs"
        :key="runKey(run)"
        class="run-card anim-rise"
        :class="`s-${run.status}`"
        data-field="chat.subagent-run"
      >
        <div class="run-head">
          <span class="run-dot" :class="run.status" aria-hidden="true" />
          <span class="run-title">{{ run.description }}</span>
          <span class="tiny run-status">{{ statusLabel(run.status) }}</span>
          <span class="tiny muted run-meta">{{ run.toolCalls }} 次工具调用</span>
          <span class="grow" />
          <Clock :size="12" :stroke-width="1.6" aria-hidden="true" class="muted" />
          <span class="tiny muted">{{ formatTime(run.startedAt) }} · {{ elapsedOf(run) }}</span>
          <button
            type="button"
            class="run-toggle"
            :aria-expanded="isOpen(runKey(run))"
            :title="isOpen(runKey(run)) ? '收起指令' : '查看指令'"
            @click="toggle(runKey(run))"
          >
            <ChevronRight
              class="chevron"
              :size="14"
              :stroke-width="1.8"
              :class="{ open: isOpen(runKey(run)) }"
              aria-hidden="true"
            />
          </button>
        </div>

        <!--
          「任务指令」折叠走**纯淡入**，刻意不做高度动画：`.run-prompt` 自己带
          `max-height: 160px; overflow-y: auto`（长指令内部滚动），它的可见高度由**自身样式**
          决定，`--collapse-h` 在它身上没有可表达的东西；而且真要动画它，就得先摘掉它自己的
          `max-height` 才能量到真实内容高（600px 级），动画会冲到 600 再弹回 160。
          这是「过渡根自带 max-height / 本身是滚动容器时不做高度动画」这条口径的实例，见 docs/07 §5.2。
        -->
        <Transition name="fade">
          <p v-if="isOpen(runKey(run))" class="run-prompt">{{ run.prompt }}</p>
        </Transition>

        <!-- 卡头已给状态与耗时，这里不再重复一遍轨迹头行 -->
        <SubagentTrace :snapshot="run" :show-head="false" />
      </article>

      <div v-if="props.runs.length === 0" class="page-empty anim-rise">
        <span class="empty-orb" aria-hidden="true" />
        <p class="empty-title">还没有子代理运行</p>
        <p class="tiny muted">
          当 Agent 需要独立调研、排查或整理多步任务时，会派生一个子代理并行去做；
          <br />
          它的过程与报告会出现在这里。
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.subagent-page {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 auto;
}

.page-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 0 0 auto;
  padding: var(--space-3) var(--space-4) var(--space-2);
  color: var(--text-secondary);
}

.page-title {
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

.page-sub {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.back-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-subtle);
  background: var(--fill-2);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.back-btn:hover {
  background: var(--fill-3);
  color: var(--text-primary);
}

.page-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-2) var(--space-4) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.summary {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 6px var(--space-3);
  border-radius: var(--radius-md);
  background: var(--fill-1);
  border: 1px solid var(--border-subtle);
  color: var(--text-secondary);
}

.running-text {
  color: var(--accent-text);
}

/* 单次运行：一张卡，卡内是轨迹（含报告） */
.run-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  transition: border-color var(--transition-base);
}

.run-card.s-running {
  border-color: color-mix(in srgb, var(--aurora-blue) 40%, transparent);
}

.run-card.s-error {
  border-color: color-mix(in srgb, var(--status-error) 40%, transparent);
}

.run-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

/* 状态点：与全局状态灯同一套语义色 */
.run-dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-muted);
}

.run-dot.running {
  background: var(--aurora-blue);
  animation: aurora-confirm var(--dur-pulse) var(--ease-spring) infinite;
}

.run-dot.success {
  background: var(--status-ok);
}

.run-dot.error {
  background: var(--status-error);
}

.run-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: var(--weight-medium);
  color: var(--text-primary);
}

.run-status {
  flex: 0 0 auto;
  color: var(--text-muted);
}

.run-meta {
  flex: 0 0 auto;
}

.run-toggle {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-xs);
  color: var(--text-muted);
  transition: background var(--transition-fast);
}

.run-toggle:hover {
  background: var(--fill-2);
}

.run-toggle .chevron {
  transition: transform var(--transition-base);
}

.run-toggle .chevron.open {
  transform: rotate(90deg);
}

/* 任务指令：等宽 + 低饱和底色，与报告区分开（一个是我们给的输入，一个是它的产出） */
.run-prompt {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--fill-2);
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: var(--leading-relaxed);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 160px;
  overflow-y: auto;
}

.page-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: 20% var(--space-4) 0;
  text-align: center;
}

.empty-orb {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--aurora-gradient);
  opacity: 0.7;
  box-shadow: var(--shadow-2);
}

.empty-title {
  margin: 0;
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
}
</style>
