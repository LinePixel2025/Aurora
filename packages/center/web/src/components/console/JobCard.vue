<script setup lang="ts">
/**
 * 任务（Job）状态卡：一条长任务在会话流里的当前状态（docs/06 §4.1）。
 *
 * 长任务可能因「轮次用尽」（v34 起只剩这一种，且是内核的防失控上限）而暂停，
 * 也可能被用户取消 —— 这些都不体现在正文里，只有这张卡说得清：跑到第几轮、
 * 花了多少 token、做过多少步、为什么停下、最近一步是什么。卡是纯展示，
 * 续跑 / 取消在客户端操作。
 */
import { computed } from 'vue'
import type { JobSummary } from '@aurora/shared'
import { jobStatusLabel, pendingReasonLabel } from '../../lib/format'

const props = defineProps<{ job: JobSummary }>()

/** 状态色调：结果态（完成 / 出错）用语义色，过程态（排队 / 运行 / 暂停）保持克制 */
const TONES: Record<string, string> = {
  queued: 'idle',
  running: 'running',
  paused: 'paused',
  done: 'done',
  error: 'error',
  aborted: 'muted',
}

const tone = computed(() => TONES[props.job.status] ?? 'idle')
</script>

<template>
  <article class="job-card" data-field="chat.job-card">
    <header class="head">
      <span class="title">任务清单</span>
      <span class="chip" :class="`tone-${tone}`" data-field="chat.job-status">
        {{ jobStatusLabel(job.status) }}
      </span>
      <span v-if="job.pendingReason" class="chip tone-paused">
        {{ pendingReasonLabel(job.pendingReason) }}
      </span>
    </header>

    <div class="meta">
      <span>第 {{ job.round }} / {{ job.maxRounds }} 轮</span>
      <span>Token {{ job.usedTokens }}</span>
      <span>已执行 {{ job.stepCount }} 步</span>
    </div>

    <p v-if="(job.lastStep ?? '') !== ''" class="last-step">
      第 {{ job.round }} 轮 · {{ job.lastStep }}
    </p>
    <p v-if="(job.error ?? '') !== ''" class="error">{{ job.error }}</p>
  </article>
</template>

<style scoped>
.job-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--fill-1);
}

.head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  min-width: 0;
}

.title {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--text-secondary);
}

.chip {
  flex: 0 0 auto;
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  font-size: var(--text-xs);
  line-height: 16px;
  background: var(--fill-2);
  color: var(--text-secondary);
}

/* 进行中 = 强调色；暂停 = 待跟进；完成 / 出错 = 结果语义色；中止 = 中性 */
.tone-running {
  background: color-mix(in srgb, var(--aurora-blue) 16%, transparent);
  color: var(--accent-text);
}

.tone-paused {
  background: var(--warning-fill);
  color: var(--status-unread);
}

.tone-done {
  background: var(--ok-fill);
  color: var(--status-ok);
}

.tone-error {
  background: var(--error-fill);
  color: var(--status-error);
}

.tone-muted,
.tone-idle {
  color: var(--text-muted);
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-3);
  font-size: var(--text-xs);
  color: var(--text-muted);
  font-variant-numeric: var(--num-tabular);
}

.last-step {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.error {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--error-text);
  overflow-wrap: anywhere;
}
</style>
