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
import { Check, CornerDownLeft, MessageSquare, SkipForward } from '@aurora/shared/browser'

const props = defineProps<{ request: AskUserRequest }>()
const emit = defineEmits<{ resolved: [] }>()

const now = ref(Date.now())
const busy = ref(false)
const error = ref<string | null>(null)

/**
 * 一次多问（本轮，docs/06 §21）：`request.questions` 存在时按分节渲染，
 * 否则就是单问（`questions` 缺省时构造出一个只有一问的列表）—— 两态共用同一套
 * 选中 / 自由输入的读写路径，避免"多问是另一套实现"的漂移。
 */
const parts = computed(() =>
  props.request.questions !== undefined && props.request.questions.length > 0
    ? props.request.questions
    : [
        {
          question: props.request.question,
          ...(props.request.header === undefined ? {} : { header: props.request.header }),
          ...(props.request.options === undefined ? {} : { options: props.request.options }),
          multiSelect: props.request.multiSelect,
        },
      ],
)
const multiQuestion = computed(() => parts.value.length > 1)
/** 是否允许自由文本（`allowCustom: false` 时整张卡不渲染自由输入框） */
const allowCustom = computed(() => props.request.allowCustom !== false)

const deadline = Number.isFinite(props.request.expiresAt)
  ? props.request.expiresAt
  : Date.now() + 180_000
/** 进度条基准：取卡片创建时刻到截止时刻（支持按次配置的 timeoutMs） */
const totalMs = Math.max(1, deadline - Date.now())

const remainingMs = computed(() => Math.max(0, deadline - now.value))
const remainingSeconds = computed(() => Math.ceil(remainingMs.value / 1000))
const progressPercent = computed(() =>
  Math.min(100, Math.max(0, Math.round((remainingMs.value / totalMs) * 100))),
)
const urgent = computed(() => remainingSeconds.value <= 30)

/** 每问的选中项与自由输入（单问时就是长度 1 的数组） */
const selected = ref<string[][]>(parts.value.map(() => []))
const freeText = ref<string[]>(parts.value.map(() => ''))

function optionsOf(index: number): { label: string; description?: string }[] {
  return parts.value[index]?.options ?? []
}

/** 该问有没有作答（选项或自由文本）—— 提交门控按「至少有一问答了」判 */
function answeredInQuestion(index: number): boolean {
  return (selected.value[index]?.length ?? 0) > 0 || (freeText.value[index] ?? '').trim() !== ''
}
const canSubmit = computed(() => parts.value.some((_, index) => answeredInQuestion(index)))

/**
 * 倒计时只显示到秒：每 1s 刷一次读数即可（旧实现 250ms 是 4 倍的无谓重渲染）；
 * 真正的超时收口用一次性 `setTimeout` 精确落在 deadline，不靠 interval 撞时机。
 */
let timer: number | null = null
let expireTimer: number | null = null

function stopTimers(): void {
  if (timer !== null) window.clearInterval(timer)
  timer = null
  if (expireTimer !== null) window.clearTimeout(expireTimer)
  expireTimer = null
}

timer = window.setInterval(() => {
  now.value = Date.now()
}, 1000)
expireTimer = window.setTimeout(
  () => {
    now.value = Date.now()
    stopTimers()
    // 主进程已按「未回答」继续：收起卡片，不再回执（回执也会因超时结算而返回 false）
    emit('resolved')
  },
  Math.max(0, deadline - Date.now()),
)

onUnmounted(stopTimers)

function toggleOption(index: number, label: string): void {
  const current = selected.value[index] ?? []
  if (parts.value[index]?.multiSelect === true) {
    selected.value[index] = current.includes(label)
      ? current.filter((item) => item !== label)
      : [...current, label]
    return
  }
  // 单选：点一下就替换选中项（再点一次取消），提交仍走下面的按钮
  selected.value[index] = current[0] === label ? [] : [label]
}

function isSelected(index: number, label: string): boolean {
  return (selected.value[index] ?? []).includes(label)
}

/** 某一问的答案（选项 + 自由输入；两者都给时都带上 —— 用户可能是"选 A，但补充一句"） */
function answersOfQuestion(index: number): string[] {
  const free = (freeText.value[index] ?? '').trim()
  return [...(selected.value[index] ?? []), ...(free === '' ? [] : [free])]
}

/**
 * 提交：多问时逐问回填 `answersByQuestion`，`answers` 是它的扁平化副本
 * （供旧消费方 / 审计 —— 与主进程 `AskUserService.resolve` 的口径一致）。
 */
async function submit(skipped = false): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = null
  const answersByQuestion = skipped
    ? parts.value.map(() => [])
    : parts.value.map((_, index) => answersOfQuestion(index))
  const answers = skipped ? [] : answersByQuestion.flat()
  const result = await window.aurora.askUser.answer({
    requestId: props.request.requestId,
    answers,
    ...(multiQuestion.value ? { answersByQuestion } : {}),
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

    <!-- 一次多问：每问一节（问题 + 选项 + 自由输入）；单问就是只有一节的那个特例 -->
    <section
      v-for="(part, index) in parts"
      :key="index"
      class="ask-part"
      :data-field="multiQuestion ? 'chat.ask-user-part' : undefined"
    >
      <p v-if="multiQuestion && part.header" class="tiny muted part-head">{{ part.header }}</p>
      <p class="ask-question" :data-field="index === 0 ? 'chat.ask-user-question' : undefined">
        {{ part.question }}
      </p>

      <div v-if="optionsOf(index).length > 0" class="options" :class="{ multi: part.multiSelect }">
        <button
          v-for="option in optionsOf(index)"
          :key="option.label"
          type="button"
          class="option press"
          :class="{ active: isSelected(index, option.label) }"
          :aria-pressed="isSelected(index, option.label)"
          @click="toggleOption(index, option.label)"
        >
          <span class="option-mark" aria-hidden="true">
            <Check v-if="isSelected(index, option.label)" :size="11" :stroke-width="2.4" />
          </span>
          <span class="option-body">
            <span class="option-label">{{ option.label }}</span>
            <span v-if="option.description" class="tiny muted option-desc">
              {{ option.description }}
            </span>
          </span>
        </button>
      </div>

      <div v-if="allowCustom" class="free">
        <input
          v-model="freeText[index]"
          class="free-input"
          type="text"
          :placeholder="optionsOf(index).length > 0 ? '或直接输入你的回答…' : '输入你的回答…'"
          @keydown.enter="canSubmit && submit()"
        />
      </div>
    </section>

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
        {{ multiQuestion ? `${parts.length} 个问题` : request.multiSelect ? '可多选' : '单选' }}
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
  font-weight: var(--weight-medium);
}

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
