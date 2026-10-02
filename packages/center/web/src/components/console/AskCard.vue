<script setup lang="ts">
/**
 * 提问卡（`ask_user`，docs/12 §5，v0.3.3）。
 *
 * - 与会话内的本地卡**先到先得**：网页端提交后由服务器的 `{ settled }` 回执决定结果，
 *   `settled: false`（本地已作答 / 已超时）如实提示「已失效」并收起，不当错误；
 * - `expiresAt` 是**毫秒时间戳**（不是确认卡的 ISO 串），倒计时由父级的秒级心跳驱动；
 * - 超时（180s）/ 跳过都按「用户未回答」结算 —— Agent 会说明假设后继续，不阻塞流。
 */
import { computed, ref } from 'vue'
import type { AskEntry } from '../../state'
import { resolveAsk } from '../../state'
import { MessageSquare } from '@aurora/shared/browser'

const props = defineProps<{
  entry: AskEntry
  /** 剩余毫秒（父级心跳提供；≤0 视为过期） */
  remainingMs: number
}>()

const emit = defineEmits<{ resolved: [] }>()

const selected = ref<string[]>([])
const freeText = ref('')
const busy = ref(false)
const error = ref('')

const request = computed(() => props.entry.request)
const options = computed(() => request.value.options ?? [])
const expired = computed(() => props.remainingMs <= 0)
const seconds = computed(() => Math.max(0, Math.ceil(props.remainingMs / 1000)))
const urgent = computed(() => props.remainingMs <= 30_000 && !expired.value)

/** 单选：点选项即选中（仍走「提交」这道确认，避免误触）；多选：切换 */
function pick(label: string): void {
  if (expired.value || busy.value) return
  if (!request.value.multiSelect) {
    selected.value = [label]
    return
  }
  const index = selected.value.indexOf(label)
  if (index >= 0) selected.value.splice(index, 1)
  else selected.value.push(label)
}

const answers = computed(() => {
  const free = freeText.value.trim()
  return free === '' ? [...selected.value] : [...selected.value, free]
})

async function submit(skipped = false): Promise<void> {
  if (busy.value) return
  if (!skipped && answers.value.length === 0) {
    error.value = '请选择一个选项或填写回答（也可以直接跳过）'
    return
  }
  busy.value = true
  error.value = ''
  try {
    await resolveAsk(props.entry, skipped ? [] : answers.value, skipped)
  } finally {
    busy.value = false
    emit('resolved')
  }
}
</script>

<template>
  <article class="ask-card" :class="{ urgent, expired }" data-field="chat.ask-user-card">
    <header class="head">
      <span class="mark" aria-hidden="true">
        <MessageSquare :size="14" :stroke-width="1.7" />
      </span>
      <strong class="title">{{ request.header ?? '需要你确认' }}</strong>
      <span class="grow" />
      <span v-if="expired" class="countdown expired">已过期</span>
      <span v-else class="countdown" :class="{ urgent }">{{ seconds }} 秒后按未回答继续</span>
    </header>

    <p class="question" data-field="chat.ask-user-question">{{ request.question }}</p>

    <div v-if="options.length > 0" class="options">
      <button
        v-for="option in options"
        :key="option.label"
        type="button"
        class="option"
        :class="{ picked: selected.includes(option.label) }"
        :disabled="expired || busy"
        data-action="chat.ask-option"
        @click="pick(option.label)"
      >
        <span class="option-label">{{ option.label }}</span>
        <span v-if="option.description" class="option-desc">{{ option.description }}</span>
      </button>
    </div>

    <label class="free">
      <span class="sr-only">自由回答</span>
      <input
        v-model="freeText"
        class="free-input"
        type="text"
        :placeholder="options.length > 0 ? '也可以补充一句（可选）' : '输入你的回答'"
        :disabled="expired || busy"
        data-field="chat.ask-free"
      />
    </label>

    <p v-if="error" class="err">{{ error }}</p>

    <footer class="foot">
      <span class="hint">
        {{ request.multiSelect ? '可多选' : '单选' }} · 与客户端上的卡片先到先得
      </span>
      <span class="grow" />
      <button
        type="button"
        class="btn-ghost"
        :disabled="busy || expired"
        data-action="chat.ask-skip"
        @click="submit(true)"
      >
        跳过
      </button>
      <button
        type="button"
        class="btn-primary"
        :disabled="busy || expired"
        data-action="chat.ask-submit"
        @click="submit(false)"
      >
        {{ busy ? '提交中…' : '提交' }}
      </button>
    </footer>
  </article>
</template>

<style scoped>
.ask-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
  box-shadow: var(--shadow-2);
  animation: aurora-pop-in var(--dur-base) var(--ease-spring) both;
}

.ask-card.urgent {
  border-color: color-mix(in srgb, var(--status-unread) 55%, transparent);
}

.ask-card.expired {
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
  background: color-mix(in srgb, var(--aurora-blue) 16%, transparent);
  color: var(--accent-text);
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

.countdown.urgent {
  color: var(--status-unread);
}

.countdown.expired {
  color: var(--status-error);
}

.question {
  margin: 0;
  color: var(--text-primary);
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
  white-space: pre-wrap;
  word-break: break-word;
}

.options {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.option {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: flex-start;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--fill-1);
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast);
}

.option:hover:not(:disabled) {
  background: var(--fill-2);
}

.option.picked {
  border-color: var(--accent-text);
  background: color-mix(in srgb, var(--aurora-blue) 14%, transparent);
}

.option:disabled {
  opacity: 0.6;
  cursor: default;
}

.option-label {
  font-size: var(--text-sm);
}

.option-desc {
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.free {
  display: flex;
}

.free-input {
  width: 100%;
  height: var(--control-h-sm);
  padding: 0 var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--fill-1);
  color: var(--text-primary);
  font-family: inherit;
  font-size: var(--text-sm);
}

.free-input:focus {
  outline: none;
  border-color: var(--aurora-blue);
  box-shadow: 0 0 0 1px var(--accent-ring);
}

.err {
  margin: 0;
  color: var(--danger-text);
  font-size: var(--text-xs);
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
.btn-ghost {
  min-height: var(--control-h-sm);
  padding: 0 var(--space-3);
  border-radius: var(--radius-pill);
  font-size: var(--text-sm);
  cursor: pointer;
  transition:
    background var(--transition-fast),
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

.btn-ghost {
  border: 1px solid var(--border-subtle);
  background: transparent;
  color: var(--text-secondary);
}

.btn-ghost:hover:not(:disabled) {
  background: var(--fill-2);
  color: var(--text-primary);
}

.btn-primary:disabled,
.btn-ghost:disabled {
  opacity: 0.55;
  cursor: default;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}

@media (max-width: 720px) {
  .option,
  .free-input,
  .btn-primary,
  .btn-ghost {
    min-height: var(--hit-target);
  }
}
</style>
