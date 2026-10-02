<script setup lang="ts">
/**
 * 敏感工具确认卡（docs/12 §5.1）。
 *
 * 与提问卡同一条待办栏、同款交互语言，两处差异是产品语义：
 * 确认卡倒计时 60s 且**超时按拒绝**；批准 / 拒绝与客户端本地卡先到先得（幂等）。
 * 入参摘要按两行截断展示（不堆全量 JSON，也不给「查看全部」的入口）。
 */
import { computed, ref } from 'vue'
import type { ConfirmEntry } from '../../state'
import { resolveConfirm } from '../../state'
import { ShieldAlert } from '@aurora/shared/browser'

const props = defineProps<{
  entry: ConfirmEntry
  /** 剩余毫秒（父级心跳提供；≤0 视为过期） */
  remainingMs: number
}>()

const emit = defineEmits<{ resolved: [] }>()

const busy = ref(false)

const expired = computed(() => props.remainingMs <= 0)
const seconds = computed(() => Math.max(0, Math.ceil(props.remainingMs / 1000)))
const urgent = computed(() => props.remainingMs <= 15_000 && !expired.value)

const inputText = computed(() => {
  const input = props.entry.request.input
  if (input === undefined || input === null) return '（无参数）'
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input, null, 2) ?? String(input)
  } catch {
    return String(input)
  }
})

async function decide(approved: boolean): Promise<void> {
  if (busy.value || expired.value) return
  busy.value = true
  try {
    await resolveConfirm(props.entry, approved)
  } finally {
    busy.value = false
    emit('resolved')
  }
}
</script>

<template>
  <article class="confirm-card" :class="{ urgent, expired }" data-field="chat.confirm-card">
    <header class="head">
      <span class="mark" aria-hidden="true">
        <ShieldAlert :size="14" :stroke-width="1.7" />
      </span>
      <strong class="title">敏感工具执行前需确认</strong>
      <span class="badge">会话 {{ entry.sessionId }}</span>
      <span class="grow" />
      <span v-if="expired" class="countdown expired">已过期</span>
      <span v-else class="countdown" :class="{ urgent }">{{ seconds }} 秒后自动拒绝</span>
    </header>

    <p class="intro">
      工具 <span class="mono">{{ entry.request.toolName }}</span> 属于敏感操作 （文件移动 /
      删除、命令执行、MCP 工具等），需要你确认后才会执行。
    </p>

    <pre class="args mono">{{ inputText }}</pre>

    <footer class="foot">
      <span class="hint">与客户端上的确认卡先到先得</span>
      <span class="grow" />
      <button
        type="button"
        class="btn-danger"
        :disabled="busy || expired"
        data-action="chat.confirm-reject"
        @click="decide(false)"
      >
        拒绝
      </button>
      <button
        type="button"
        class="btn-primary"
        :disabled="busy || expired"
        data-action="chat.confirm-approve"
        @click="decide(true)"
      >
        {{ busy ? '处理中…' : '允许一次' }}
      </button>
    </footer>
  </article>
</template>

<style scoped>
.confirm-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--danger-border);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
  box-shadow: var(--shadow-2);
  animation: aurora-pop-in var(--dur-base) var(--ease-spring) both;
}

.confirm-card.urgent {
  border-color: color-mix(in srgb, var(--status-error) 60%, transparent);
}

.confirm-card.expired {
  opacity: 0.7;
}

.head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.mark {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-xs);
  background: var(--danger-fill);
  color: var(--danger-text);
}

.title {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
}

.grow {
  flex: 1 1 auto;
}

.countdown {
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-variant-numeric: var(--num-tabular);
}

.countdown.urgent,
.countdown.expired {
  color: var(--status-error);
}

.intro {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
}

.mono {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-primary);
}

.args {
  margin: 0;
  max-height: 160px;
  overflow: auto;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--fill-1);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  white-space: pre-wrap;
  word-break: break-word;
}

.foot {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.hint {
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.btn-primary,
.btn-danger {
  min-height: var(--control-h-sm);
  padding: 0 var(--space-3);
  border-radius: var(--radius-pill);
  font-size: var(--text-sm);
  cursor: pointer;
  transition:
    background var(--transition-fast),
    color var(--transition-fast),
    filter var(--transition-fast);
}

.btn-primary {
  border: none;
  background: var(--aurora-blue);
  color: var(--on-accent);
  font-weight: var(--weight-medium);
}

.btn-primary:hover:not(:disabled) {
  filter: brightness(1.08);
}

.btn-danger {
  border: 1px solid var(--border-subtle);
  background: transparent;
  color: var(--text-secondary);
}

.btn-danger:hover:not(:disabled) {
  background: var(--danger-fill);
  color: var(--danger-text);
}

.btn-primary:disabled,
.btn-danger:disabled {
  opacity: 0.55;
  cursor: default;
}

@media (max-width: 720px) {
  .btn-primary,
  .btn-danger {
    min-height: var(--hit-target);
  }
}
</style>
