<script setup lang="ts">
/**
 * 提问卡（`ask_user`，docs/12 §5，v0.3.3；本轮改为**数据驱动 + 只读态**）。
 *
 * 两种宿主，一份实现：
 * - 待办栏（`PendingBar`）：该提问所属会话**未打开**时列一条，可答；
 * - 会话流内（`MessageStream`）：跟消息一起排的卡，可答；结算后切成**只读卡**留痕。
 *
 * 交互口径（本轮与桌面端逐条对齐）：
 * - 单选再点已选项 = 取消选中；多选切换；选中项显示勾选标记；
 * - 自由输入框 **Enter 提交**；「提交」在没有任何回答时**禁用**（不再靠错误文案）；
 * - 已结算 / 已过期 = 只读：不渲染输入与按钮，只显示结论（答了什么 / 已跳过 / 已超时 / 已中止）；
 * - `expiresAt` 是**毫秒时间戳**（不是确认卡的 ISO 串），倒计时由父级秒级心跳驱动；
 * - 与客户端上的本地卡**先到先得**：提交后由服务器的 `{ settled }` 回执决定结果。
 */
import { computed, ref } from 'vue'
import type { AskCardItem } from '../../state'
import { resolveAsk } from '../../state'
import { Check, MessageSquare } from '@aurora/shared/browser'

const props = defineProps<{
  /** 卡片数据（实时来自 `ask.request`；历史回放来自会话历史里的 `kind: 'ask'` 条目） */
  ask: AskCardItem
  clientId: string
  sessionId: string
  /** 剩余毫秒（父级心跳提供；≤0 视为过期）。已结算的卡片不使用它 */
  remainingMs?: number
}>()

const emit = defineEmits<{ resolved: [] }>()

/**
 * 一次多问（本轮）：`ask.questions` 存在时按分节渲染，否则单问。
 * 两态共用同一套选中 / 自由输入的读写路径（数组下标 0 就是单问）。
 */
const parts = computed(() =>
  props.ask.questions !== undefined && props.ask.questions.length > 0
    ? props.ask.questions
    : [
        {
          question: props.ask.question,
          ...(props.ask.header === undefined ? {} : { header: props.ask.header }),
          ...(props.ask.options === undefined ? {} : { options: props.ask.options }),
          multiSelect: props.ask.multiSelect,
        },
      ],
)
const multiQuestion = computed(() => parts.value.length > 1)
const allowCustom = computed(() => props.ask.allowCustom !== false)

const selected = ref<string[][]>(parts.value.map(() => []))
const freeText = ref<string[]>(parts.value.map(() => ''))
const busy = ref(false)

const settled = computed(() => props.ask.settled)
const readonly = computed(() => settled.value !== undefined)
const remaining = computed(() => props.remainingMs ?? props.ask.expiresAt - Date.now())
const expired = computed(() => !readonly.value && remaining.value <= 0)
const seconds = computed(() => Math.max(0, Math.ceil(remaining.value / 1000)))
const urgent = computed(() => !readonly.value && !expired.value && remaining.value <= 30_000)

function optionsOf(index: number): { label: string; description?: string }[] {
  return parts.value[index]?.options ?? []
}

/** 进度条（本轮与桌面端对齐）：等待窗口内已过去多少（到期时 100%） */
const progressPercent = computed(() => {
  if (readonly.value || props.ask.expiresAt <= 0) return 100
  const total = 180_000
  const left = Math.max(0, remaining.value)
  return Math.min(100, Math.max(0, Math.round(((total - left) / total) * 100)))
})

function answeredInQuestion(index: number): boolean {
  return (selected.value[index]?.length ?? 0) > 0 || (freeText.value[index] ?? '').trim() !== ''
}
const canSubmit = computed(() => parts.value.some((_, index) => answeredInQuestion(index)))

/** 结算结论的文案（只读态） */
const settledLabel = computed(() => {
  const outcome = settled.value?.outcome
  if (outcome === 'answered') return '已作答'
  if (outcome === 'skipped') return '已跳过'
  if (outcome === 'aborted') return '已中止'
  if (outcome === 'timedOut') return '已超时（按未回答继续）'
  return '已结算'
})

const settledAnswers = computed(() => settled.value?.answers ?? [])
function isAnsweredOption(index: number, label: string): boolean {
  if (!readonly.value) return false
  const grouped = settled.value?.answersByQuestion
  if (grouped !== undefined && multiQuestion.value) return (grouped[index] ?? []).includes(label)
  return settledAnswers.value.includes(label)
}

/** 某一问在只读卡上的答案（多问取分组，单问取扁平列表） */
function answersOfSettled(index: number): string[] {
  const grouped = settled.value?.answersByQuestion
  if (grouped !== undefined && multiQuestion.value) return grouped[index] ?? []
  return index === 0 ? settledAnswers.value : []
}

/** 单选：点已选项 = 取消；点别的 = 换选。多选：切换。 */
function pick(index: number, label: string): void {
  if (expired.value || busy.value || readonly.value) return
  const current = selected.value[index] ?? []
  if (parts.value[index]?.multiSelect !== true) {
    selected.value[index] = current[0] === label ? [] : [label]
    return
  }
  selected.value[index] = current.includes(label)
    ? current.filter((item) => item !== label)
    : [...current, label]
}

/** 某一问的答案（选项 + 自由输入，两者都给时都带上） */
function answersOfQuestion(index: number): string[] {
  const free = (freeText.value[index] ?? '').trim()
  return [...(selected.value[index] ?? []), ...(free === '' ? [] : [free])]
}

async function submit(skipped = false): Promise<void> {
  if (busy.value || readonly.value) return
  if (!skipped && !canSubmit.value) return
  busy.value = true
  const answersByQuestion = skipped
    ? parts.value.map(() => [])
    : parts.value.map((_, index) => answersOfQuestion(index))
  try {
    await resolveAsk(
      { clientId: props.clientId, sessionId: props.sessionId, requestId: props.ask.requestId },
      skipped ? [] : answersByQuestion.flat(),
      skipped,
      multiQuestion.value ? answersByQuestion : undefined,
    )
  } finally {
    busy.value = false
    emit('resolved')
  }
}
</script>

<template>
  <article
    class="ask-card glass-panel"
    :class="{ urgent, expired, settled: readonly }"
    data-field="chat.ask-user-card"
  >
    <header class="head">
      <span class="mark" aria-hidden="true">
        <MessageSquare :size="14" :stroke-width="1.7" />
      </span>
      <strong class="title">{{ ask.header ?? '需要你确认' }}</strong>
      <span class="grow" />
      <span v-if="readonly" class="countdown settled-label" data-field="chat.ask-settled">
        {{ settledLabel }}
      </span>
      <span v-else-if="expired" class="countdown expired">已过期</span>
      <span v-else class="countdown" :class="{ urgent }">{{ seconds }} 秒后按未回答继续</span>
    </header>

    <!-- 剩余时间进度条（与桌面端同款；只读态不再显示过程） -->
    <div v-if="!readonly" class="progress" aria-hidden="true">
      <span class="progress-fill" :style="{ width: `${progressPercent}%` }" />
    </div>

    <p class="question" data-field="chat.ask-user-question">{{ ask.question }}</p>

    <!-- 一次多问：每问一节（问题 + 选项 + 自由输入）；单问就是只有一节的那个特例 -->
    <section
      v-for="(part, index) in parts"
      :key="index"
      class="ask-part"
      :data-field="multiQuestion ? 'chat.ask-user-part' : undefined"
    >
      <p v-if="multiQuestion && part.header" class="part-head">{{ part.header }}</p>
      <p v-if="multiQuestion" class="question part-question">{{ part.question }}</p>

      <div v-if="optionsOf(index).length > 0" class="options">
        <button
          v-for="option in optionsOf(index)"
          :key="option.label"
          type="button"
          class="option"
          :class="{
            picked: (selected[index] ?? []).includes(option.label),
            answered: isAnsweredOption(index, option.label),
          }"
          :disabled="readonly || expired || busy"
          data-action="chat.ask-option"
          @click="pick(index, option.label)"
        >
          <span class="option-mark" aria-hidden="true">
            <Check
              v-if="
                (selected[index] ?? []).includes(option.label) ||
                isAnsweredOption(index, option.label)
              "
              :size="12"
              :stroke-width="2.4"
            />
          </span>
          <span class="option-label">{{ option.label }}</span>
          <span v-if="option.description" class="option-desc">{{ option.description }}</span>
        </button>
      </div>

      <!-- 自由回答（本轮起带 Enter 提交；allowCustom: false 或只读态都不渲染） -->
      <label v-if="!readonly && allowCustom" class="free">
        <span class="sr-only">自由回答</span>
        <input
          v-model="freeText[index]"
          class="free-input"
          type="text"
          :placeholder="optionsOf(index).length > 0 ? '也可以补充一句（可选）' : '输入你的回答'"
          :disabled="expired || busy"
          data-field="chat.ask-free"
          @keydown.enter.prevent="submit(false)"
        />
      </label>

      <!-- 只读态：把当时答了什么如实列出来（留痕的核心） -->
      <div
        v-if="readonly"
        class="settled-answers"
        :data-field="index === 0 ? 'chat.ask-answers' : undefined"
      >
        <span v-if="answersOfSettled(index).length === 0" class="hint">没有作答</span>
        <span v-for="answer in answersOfSettled(index)" :key="answer" class="answer-chip">
          {{ answer }}
        </span>
      </div>
    </section>

    <footer v-if="!readonly" class="foot">
      <span class="hint">
        {{ ask.multiSelect ? '可多选' : '单选' }} · 与客户端上的卡片先到先得
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
        :disabled="busy || expired || !canSubmit"
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
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: var(--glass-panel);
  box-shadow: var(--shadow-2);
  animation: aurora-pop-in var(--dur-base) var(--ease-spring) both;
}

.ask-card.urgent {
  border-color: color-mix(in srgb, var(--status-unread) 55%, transparent);
}

.ask-card.expired,
.ask-card.settled {
  opacity: 0.85;
}

/* 只读的已结算卡：去掉浮起来的观感，让它像一段记录而不是一个待办 */
.ask-card.settled {
  box-shadow: none;
  background: var(--fill-1);
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

.countdown.settled-label {
  color: var(--text-secondary);
}

.progress {
  height: 2px;
  border-radius: var(--radius-pill);
  background: var(--fill-2);
  overflow: hidden;
}

.progress-fill {
  display: block;
  height: 100%;
  background: color-mix(in srgb, var(--aurora-blue) 60%, transparent);
  transition: width var(--transition-base);
}

/* 一次多问的分节（本轮）：节与节之间用细分隔线区分，别让两问的选项看成一串 */
.ask-part {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.ask-part + .ask-part {
  margin-top: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-subtle);
}

.part-head {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
}

.part-question {
  font-size: var(--text-sm);
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
  display: grid;
  grid-template-columns: 16px 1fr;
  gap: 2px var(--space-2);
  align-items: center;
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

/* 只读卡上高亮"当时选了哪个"（与实时态的 picked 同色，但不可点） */
.option.answered {
  border-color: color-mix(in srgb, var(--aurora-blue) 45%, transparent);
  background: color-mix(in srgb, var(--aurora-blue) 10%, transparent);
}

.option:disabled {
  cursor: default;
}

.option-mark {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 1px solid var(--border-subtle);
  color: var(--on-accent);
}

.option.picked .option-mark,
.option.answered .option-mark {
  border-color: var(--aurora-blue);
  background: var(--aurora-blue);
}

.option-label {
  font-size: var(--text-sm);
}

.option-desc {
  grid-column: 2;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.settled-answers {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.answer-chip {
  padding: 0 var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--fill-2);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  line-height: 20px;
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
