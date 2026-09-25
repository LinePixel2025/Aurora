<script setup lang="ts">
/**
 * 子代理运行轨迹（docs/07 §2.4）。
 *
 * 子代理的对话过程不落会话存储，这份快照是它唯一的对外可见形态：本组件把快照渲染成
 * 「进度条 + 步骤时间线（文本段 / 工具调用）+ 最终报告」。
 *
 * 两个消费方共用：
 * - MessageList 的 `task` 工具卡（`dense`，展开体里的一段）；
 * - 「子代理」独立页面（完整尺寸，含报告全文）。
 *
 * 只读组件：子代理无法从界面干预（它的生命周期跟父对话的这一次工具调用绑定）。
 */
import { computed } from 'vue'
import type { SubagentSnapshot, SubagentStep } from '@aurora/shared'
import { Bot, Check, CircleCheck, CircleX, Clock, LoaderCircle } from '../icons.js'
import { toolIconOf } from '../toolIcons.js'

const props = withDefaults(
  defineProps<{
    snapshot: SubagentSnapshot
    /** 紧凑版（消息流工具卡内）：字号与间距收一档，正文只留一行 */
    dense?: boolean
    /** 是否展示最终报告（页面用 true；卡片里也展示，报告才是子代理的产出） */
    showReport?: boolean
    /**
     * 是否渲染轨迹自带的头行（状态 + 工具调用数 + 耗时）。
     * 子代理页面的运行卡头已经给了这些信息，那里传 false 免得同一行信息出现两遍。
     */
    showHead?: boolean
  }>(),
  { dense: false, showReport: true, showHead: true },
)

/** 运行中 → 已运行时长；结束 → 总耗时 */
const elapsed = computed(() => {
  const end = props.snapshot.endedAt ?? Date.now()
  return Math.max(0, end - props.snapshot.startedAt) / 1000
})

const statusLabel = computed(() => {
  if (props.snapshot.status === 'running') return '进行中'
  if (props.snapshot.status === 'success') return '已完成'
  return '失败'
})

/** 工具步骤已完成数（进度条分母用步骤数，不用时间 —— 子代理的步骤数不可预知） */
const doneSteps = computed(
  () =>
    props.snapshot.steps.filter((step) => step.kind === 'tool' && step.state !== 'running').length,
)

const progressPercent = computed(() => {
  if (props.snapshot.status !== 'running') return 100
  const total = props.snapshot.toolCalls
  if (total === 0) return 8
  return Math.max(8, Math.min(96, Math.round((doneSteps.value / total) * 100)))
})

/** 步骤标签：工具步骤显示工具名，文本步骤显示首行摘录 */
function stepLabel(step: SubagentStep): string {
  if (step.kind === 'tool') return step.name ?? '工具'
  return (step.text ?? '').replace(/\s+/g, ' ').trim()
}
</script>

<template>
  <div class="trace" :class="[`s-${snapshot.status}`, { dense }]">
    <div v-if="showHead" class="trace-head">
      <Bot :size="dense ? 13 : 15" :stroke-width="1.7" aria-hidden="true" />
      <span class="tiny trace-status">{{ statusLabel }}</span>
      <span class="tiny muted">{{ snapshot.toolCalls }} 次工具调用</span>
      <span class="grow" />
      <Clock :size="12" :stroke-width="1.6" aria-hidden="true" class="muted" />
      <span class="tiny muted">{{ elapsed.toFixed(1) }}s</span>
    </div>

    <!--
      进度条：运行中是不定长滑动（步骤总数不可预知），结束后走满。
      刻意不用百分比文案冒充精确进度 —— 子代理的步数无法预知。
    -->
    <div class="trace-bar" role="progressbar" :aria-valuenow="progressPercent">
      <i :style="{ width: `${progressPercent}%` }" />
      <i v-if="snapshot.status === 'running'" class="slide" />
    </div>

    <ol v-if="snapshot.steps.length > 0" class="trace-steps">
      <li v-for="step in snapshot.steps" :key="step.id" class="trace-step">
        <span class="trace-mark" :class="[step.kind, step.state ?? 'done']" aria-hidden="true">
          <component
            :is="step.kind === 'tool' ? toolIconOf(step.name ?? '') : Bot"
            :size="12"
            :stroke-width="1.7"
          />
        </span>
        <div class="trace-body">
          <span v-if="step.kind === 'tool'" class="trace-name mono tiny">{{
            step.name ?? '工具'
          }}</span>
          <span v-else class="trace-text tiny">{{ stepLabel(step) }}</span>
          <span v-if="step.summary !== undefined" class="trace-summary tiny muted">{{
            step.summary
          }}</span>
        </div>
        <LoaderCircle
          v-if="step.kind === 'tool' && step.state === 'running'"
          class="trace-spin spin"
          :size="12"
          :stroke-width="1.7"
          aria-hidden="true"
        />
        <CircleCheck
          v-else-if="step.kind === 'tool' && step.state === 'success'"
          :size="12"
          :stroke-width="1.7"
          class="trace-ok"
          aria-hidden="true"
        />
        <CircleX
          v-else-if="step.kind === 'tool' && step.state === 'error'"
          :size="12"
          :stroke-width="1.7"
          class="trace-err"
          aria-hidden="true"
        />
        <Check v-else :size="11" :stroke-width="2" class="trace-ok" aria-hidden="true" />
      </li>
    </ol>
    <p v-else class="tiny muted trace-empty">等待子代理产出…</p>

    <template v-if="showReport && (snapshot.report ?? '') !== ''">
      <span class="tiny muted trace-label">报告</span>
      <p class="trace-report" :data-field="'chat.subagent-report'">{{ snapshot.report }}</p>
    </template>
  </div>
</template>

<style scoped>
.trace {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.trace-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  color: var(--text-secondary);
}

.trace.s-running .trace-head svg {
  color: var(--aurora-blue);
}

.trace.s-success .trace-head svg {
  color: var(--status-ok);
}

.trace.s-error .trace-head svg {
  color: var(--status-error);
}

.trace-status {
  color: var(--text-primary);
  font-weight: 580;
}

/* 进度条：底槽 + 前景；运行中再叠一条滑动块表示"还在动" */
.trace-bar {
  position: relative;
  height: 3px;
  border-radius: 2px;
  background: var(--fill-3);
  overflow: hidden;
}

.trace-bar > i {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 2px;
  background: var(--aurora-gradient);
  transition: width var(--dur-slow) var(--ease-standard);
}

.trace-bar > i.slide {
  width: 45%;
  background: var(--aurora-gradient);
  animation: aurora-track var(--dur-pulse) var(--ease-smooth) infinite;
  opacity: 0.55;
}

.trace-steps {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

.trace-step {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  min-width: 0;
  animation: aurora-think-line var(--dur-base) var(--ease-spring) both;
}

.trace-mark {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: var(--fill-2);
  color: var(--text-secondary);
}

.trace-mark.tool {
  background: color-mix(in srgb, var(--aurora-blue) 14%, transparent);
  color: var(--aurora-blue);
}

.trace-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1 1 auto;
}

.trace-name {
  color: var(--text-primary);
}

.trace-text {
  color: var(--text-secondary);
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.trace-summary {
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.trace-spin {
  flex: 0 0 auto;
  margin-top: 3px;
  color: var(--aurora-blue);
}

.trace-ok {
  flex: 0 0 auto;
  margin-top: 3px;
  color: var(--status-ok);
}

.trace-err {
  flex: 0 0 auto;
  margin-top: 3px;
  color: var(--status-error);
}

.trace-label {
  margin-top: var(--space-1);
}

.trace-report {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--fill-1);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 320px;
  overflow-y: auto;
}

.trace-empty {
  margin: 0;
}

/* 紧凑版（消息流工具卡内） */
.dense .trace-head {
  gap: var(--space-1);
}

.dense .trace-report {
  max-height: 200px;
  font-size: var(--text-xs);
}
</style>
