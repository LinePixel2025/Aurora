<script setup lang="ts">
/**
 * 上下文用量条（docs/12 §10 的 Token 用量口径）。
 *
 * 分母 = 当前生效模型的 `contextWindow`（只能从 `config.get` 的 `modelParams[模型]` 拿到，
 * 不在 status 快照里）；分子 = 最新一轮的 `promptTokens`（即该轮的上下文占用）。
 * 两者都缺省时整条不渲染 —— 宁可没有，也不要显示一个算不出来的比例。
 */
import { computed } from 'vue'
import type { ClientEntry, SessionState } from '../../state'

const props = defineProps<{ entry: ClientEntry; session: SessionState }>()

const usage = computed(() => props.entry.usageBySession.get(props.session.sessionId) ?? null)

const contextWindow = computed(() => {
  const llm = props.entry.status?.llm
  if (!llm) return 0
  const provider = props.entry.remoteLlm?.providers[llm.activeProviderId]
  return provider?.contextWindow && provider.contextWindow > 0 ? provider.contextWindow : 0
})

const latest = computed(() => usage.value?.latest ?? null)

/** 预算口径：分母为 0（未取到 contextWindow）时不显示百分比 */
const percent = computed(() => {
  if (contextWindow.value === 0 || latest.value === null) return null
  return Math.min(100, Math.round((latest.value.promptTokens / contextWindow.value) * 100))
})

const visible = computed(() => latest.value !== null)

function formatTokens(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}
</script>

<template>
  <div v-if="visible" class="usage" data-field="chat.usage">
    <span class="usage-main">
      {{ formatTokens(latest?.promptTokens ?? 0) }}
      <template v-if="contextWindow > 0"> / {{ formatTokens(contextWindow) }}</template>
    </span>
    <span v-if="percent !== null" class="usage-pct">占上下文 {{ percent }}%</span>
    <span
      v-if="latest !== null && latest.cachedTokens !== undefined && latest.cachedTokens > 0"
      class="usage-cache"
    >
      缓存命中 {{ formatTokens(latest.cachedTokens) }}
    </span>
    <span class="usage-total">
      本轮 {{ formatTokens(latest?.totalTokens ?? 0) }} · 累计
      {{ formatTokens(usage?.totals.totalTokens ?? 0) }}
    </span>
  </div>
</template>

<style scoped>
.usage {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-variant-numeric: var(--num-tabular);
}

.usage-main {
  color: var(--text-secondary);
}

.usage-pct,
.usage-cache,
.usage-total {
  color: var(--text-muted);
}
</style>
