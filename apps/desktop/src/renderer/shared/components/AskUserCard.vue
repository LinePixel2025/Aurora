<script setup lang="ts">
/**
 * Agent 提问卡片（`ask_user`，docs/06 §21 / docs/07 §2.3）。
 *
 * 与「敏感工具确认卡片」同区域、同款交互语言的**协作**入口，但三处语义刻意不同：
 * 1. 超时**不是拒绝**：到点后卡片自己收起，主进程按「用户没回答」继续（不会卡住这一轮）；
 * 2. **可以跳过**：跳过 = 明确告诉 Agent「你自己按假设继续」；
 * 3. 没有「总是允许」这类记忆 —— 提问是一次性的，不是要记住的授权。
 *
 * 交互：选项按钮（多选时勾选后提交；单选时点一下即选中，仍走「回答」这道确认，
 * 免得手滑点错就直接发出去了）+ 自由输入框（给了选项也能自己写）。
 */
import { computed, onUnmounted, ref } from 'vue'
import type { AskUserRequest } from '@aurora/shared'
import AppButton from './AppButton.vue'
import { Check, CornerDownLeft, MessageSquare, SkipForward } from '../icons.js'

const props = defineProps<{ request: AskUserRequest }>()
const emit = defineEmits<{ resolved: [] }>()

const now = ref(Date.now())
const busy = ref(false)
const error = ref<string | null>(null)
const selected = ref<string[]>([])
const freeText = ref('')

const deadline = Number.isFinite(props.request.expiresAt)
  ? props.request.expiresAt
  : Date.now() + 180_000
/** 进度条基准：主进程默认 180s 超时，取卡片创建时刻到截止时刻 */
const totalMs = Math.max(1, deadline - Date.now())

const remainingMs = computed(() => Math.max(0, deadline - now.value))
const remainingSeconds = computed(() => Math.ceil(remainingMs.value / 1000))
const progressPercent = computed(() =>
  Math.min(100, Math.max(0, Math.round((remainingMs.value / totalMs) * 100))),
)
const urgent = computed(() => remainingSeconds.value <= 30)
const options = computed(() => props.request.options ?? [])
const hasOptions = computed(() => options.value.length > 0)
/** 能不能提交：选了选项，或自由输入框里有非空内容 */
const canSubmit = computed(() => selected.value.length > 0 || freeText.value.trim() !== '')

const timer = window.setInterval(() => {
  now.value = Date.now()
  if (now.value >= deadline) {
    window.clearInterval(timer)
    // 主进程已按「未回答」继续：收起卡片，不再回执（回执也会因超时结算而返回 false）
    emit('resolved')
  }
}, 250)

onUnmounted(() => {
  window.clearInterval(timer)
})

function toggleOption(label: string): void {
  if (props.request.multiSelect) {
    selected.value = selected.value.includes(label)
      ? selected.value.filter((item) => item !== label)
      : [...selected.value, label]
    return
  }
  // 单选：点一下就替换选中项（再点一次取消），提交仍走下面的按钮
  selected.value = selected.value[0] === label ? [] : [label]
}

function isSelected(label: string): boolean {
  return selected.value.includes(label)
}

/** 提交：选项 + 自由输入（两者都给时都带上 —— 用户可能是"选 A，但补充一句"） */
async function submit(skipped = false): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = null
  const answers = skipped
    ? []
    : [...selected.value, ...(freeText.value.trim() === '' ? [] : [freeText.value.trim()])]
  const result = await window.aurora.askUser.answer({
    requestId: props.request.requestId,
    answers,
    skipped,
  })
  busy.value = false
  if (!result.ok) {
    error.value = result.message
    return
  }
  // `value === false` = 已超时 / 已结算：主进程那边早有结论，直接收起
  emit('resolved')
}
</script>

<template>
  <article class="ask-user anim-pop" :class="{ urgent }" data-field="chat.ask-user-card">
    <header class="row">
      <MessageSquare :size="14" :stroke-width="1.8" aria-hidden="true" class="ask-icon" />
      <strong class="ask-title">{{ request.header ?? '需要你确认' }}</strong>
      <span class="badge tiny">Agent 提问</span>
      <span class="grow" />
      <span class="tiny countdown" :class="{ urgent }"
        >{{ remainingSeconds }} 秒后按未回答继续</span
      >
    </header>

    <p class="ask-question" data-field="chat.ask-user-question">{{ request.question }}</p>

    <div v-if="hasOptions" class="options" :class="{ multi: request.multiSelect }">
      <button
        v-for="option in options"
        :key="option.label"
        type="button"
        class="option press"
        :class="{ active: isSelected(option.label) }"
        :aria-pressed="isSelected(option.label)"
        @click="toggleOption(option.label)"
      >
        <span class="option-mark" aria-hidden="true">
          <Check v-if="isSelected(option.label)" :size="11" :stroke-width="2.4" />
        </span>
        <span class="option-body">
          <span class="option-label">{{ option.label }}</span>
          <span v-if="option.description" class="tiny muted option-desc">
            {{ option.description }}
          </span>
        </span>
      </button>
    </div>

    <div class="free">
      <input
        v-model="freeText"
        class="free-input"
        type="text"
        :placeholder="hasOptions ? '或直接输入你的回答…' : '输入你的回答…'"
        @keydown.enter="canSubmit && submit()"
      />
    </div>

    <div
      class="progress"
      role="progressbar"
      :aria-valuenow="progressPercent"
      aria-valuemin="0"
      aria-valuemax="100"
    >
      <span :style="{ width: `${progressPercent}%` }" />
    </div>

    <p v-if="error" class="tiny err">{{ error }}</p>

    <footer class="row foot">
      <span class="tiny muted grow">
        {{ request.multiSelect ? '可多选' : hasOptions ? '单选' : '自由回答' }}
        · 跳过 = 让 Agent 按自己的判断继续
      </span>
      <AppButton variant="ghost" size="sm" :disabled="busy" @click="submit(true)">
        <SkipForward :size="13" :stroke-width="1.8" aria-hidden="true" />
        跳过
      </AppButton>
      <AppButton
        variant="primary"
        size="sm"
        :disabled="busy || !canSubmit"
        data-action="chat.ask-user-submit"
        @click="submit(false)"
      >
        <CornerDownLeft :size="13" :stroke-width="1.8" aria-hidden="true" />
        回答
      </AppButton>
    </footer>
  </article>
</template>

<style scoped>
.ask-user {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0 var(--space-4) var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-lg);
  background: var(--bg-overlay);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-2);
}

.ask-user.urgent {
  border-color: var(--danger-border);
}

.row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.ask-icon {
  flex: 0 0 auto;
  color: var(--accent-text);
}

.ask-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-base);
}

.countdown {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-variant-numeric: var(--num-tabular);
}

.countdown.urgent {
  color: var(--status-error);
}

.ask-question {
  margin: 0;
  color: var(--text-primary);
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
  overflow-wrap: anywhere;
}

/* 选项：一列（多选时也一样 —— 多选还要勾选，两列会让"勾了哪个"更难扫） */
.options {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.option {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  text-align: left;
  transition:
    border-color var(--transition-fast),
    background var(--transition-fast);
}

.option:hover {
  background: var(--fill-2);
}

.option.active {
  border-color: var(--aurora-blue);
  background: color-mix(in srgb, var(--aurora-blue) 10%, transparent);
}

.option-mark {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  margin-top: 1px;
  border-radius: 50%;
  border: 1px solid var(--border-strong);
  color: var(--on-accent);
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast);
}

.option.active .option-mark {
  background: var(--aurora-blue);
  border-color: var(--aurora-blue);
}

/* 多选：方角（圆 = 单选、方 = 多选，与系统表单的直觉一致） */
.multi .option-mark {
  border-radius: var(--radius-xs);
}

.option-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.option-label {
  color: var(--text-primary);
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}

.option-desc {
  overflow-wrap: anywhere;
}

.free-input {
  width: 100%;
  min-width: 0;
  height: var(--control-h-sm);
  padding: 0 var(--space-2);
  border-radius: var(--radius-xs);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  color: var(--text-primary);
  font-size: var(--text-sm);
}

.free-input:focus-visible {
  outline: none;
  border-color: var(--aurora-blue);
  box-shadow: 0 0 0 2px var(--accent-ring);
}

.progress {
  height: 3px;
  border-radius: 2px;
  background: var(--fill-3);
  overflow: hidden;
}

.progress > span {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--aurora-gradient);
  transition: width var(--transition-fast);
}

.urgent .progress > span {
  background: var(--status-error);
}

.err {
  margin: 0;
  color: var(--error-text);
}

.foot {
  margin-top: 2px;
}
</style>
