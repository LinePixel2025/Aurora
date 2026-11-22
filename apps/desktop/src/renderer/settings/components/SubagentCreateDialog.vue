<script setup lang="ts">
/**
 * 「新建子代理」弹窗（v0.8.1，docs/06 §19.6、docs/07 §2.5）。
 *
 * 为什么从页内小表单改成弹窗：原实现是四条纵向输入框挤在区组底部，既没有「这是创建一个
 * 有身份的代理」的分量感，也没地方放说明与 AI 起草。弹窗把创建流程收成一个完整动作：
 *
 * - **让 Aurora 起草**（主推荐路径）：用户写一句话，调 `window.aurora.subagents.draft`，
 *   模型返回 `name` / `description` / `instructions` / `access` 草稿预填下方表单；
 *   **草稿不自动保存** —— 用户改完点「添加子代理」才走 `settings:update` 整数组权威。
 *   生成中禁用按钮、错误就地展示（无模型 / 网络失败 / 输出畸形都有可读文案）；
 * - **手动填写**永远可用：四个字段与列表行的编辑口径一致（名称 / 用途 / 三档权限 / 指令），
 *   带长度上限与计数器；`execute` 档就地提示敏感后果；
 * - 重名只提示、不静默改：id 由父级生成 `custom-N`（名称可重复但会让选型含糊，提醒用户改）。
 *
 * 交互：Esc / 点遮罩 / 取消都会关闭且**不保存**；提交中（`busy`）不允许关闭，避免「看着没反应
 * 又重复点」。焦点打开即落在需求框，生成成功后移到名称框；`aria-modal` + 标题关联。
 */
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import type { SubagentAccess, SubagentConfig } from '@aurora/shared/browser'
import {
  MAX_SUBAGENTS,
  SUBAGENT_ACCESS_LABELS,
  SUBAGENT_ACCESS_LEVELS,
} from '@aurora/shared/browser'
import { LoaderCircle, Sparkles, X } from '@aurora/shared/browser'
import AppButton from '../../shared/components/AppButton.vue'

const props = withDefaults(
  defineProps<{
    /** 已有子代理（重名提示与数量上限用） */
    existing?: readonly SubagentConfig[]
    /** 父级正在保存（禁用关闭 / 提交，防重复） */
    busy?: boolean
  }>(),
  { existing: () => [], busy: false },
)

const emit = defineEmits<{
  (event: 'close'): void
  /** 提交一条新定义；父级负责生成 id、整数组保存与关闭 */
  (
    event: 'submit',
    payload: { name: string; description: string; instructions: string; access: SubagentAccess },
  ): void
}>()

/** 需求示例：点一下直接填进需求框（覆盖「调研 / 实现 / 审查 / 文档」四类常见诉求） */
const BRIEF_EXAMPLES = [
  '只读的代码审查员，检查改动有没有遗漏测试',
  '查日志定位报错的排障助手，只读不改',
  '按目标改代码并跑构建自检的实现助手',
  '把零散资料整理成结构化文档的整理员',
]

const form = reactive({
  name: '',
  description: '',
  instructions: '',
  access: 'read' as SubagentAccess,
})
const brief = ref('')
const drafting = ref(false)
const draftError = ref('')
const briefEl = ref<HTMLTextAreaElement | null>(null)
const nameEl = ref<HTMLInputElement | null>(null)

const existingNames = computed(() =>
  props.existing.map((item) => item.name.trim().toLowerCase()).filter((name) => name !== ''),
)

const duplicateName = computed(() => {
  const name = form.name.trim().toLowerCase()
  return name !== '' && existingNames.value.includes(name)
})

const canDraft = computed(() => brief.value.trim().length >= 4 && !drafting.value && !props.busy)

const canSubmit = computed(
  () =>
    !props.busy &&
    form.name.trim() !== '' &&
    form.description.trim() !== '' &&
    form.instructions.trim() !== '' &&
    props.existing.length < MAX_SUBAGENTS,
)

function close(): void {
  if (props.busy) return
  emit('close')
}

async function runDraft(): Promise<void> {
  const description = brief.value.trim()
  if (description.length < 4 || drafting.value) return
  drafting.value = true
  draftError.value = ''
  try {
    const result = await window.aurora.subagents.draft({ description })
    if (!result.ok) {
      draftError.value = result.message
      return
    }
    form.name = result.value.name
    form.description = result.value.description
    form.instructions = result.value.instructions
    form.access = result.value.access
    await nextTick()
    nameEl.value?.focus()
  } catch (error) {
    draftError.value = `生成草稿失败：${error instanceof Error ? error.message : String(error)}`
  } finally {
    drafting.value = false
  }
}

function useExample(example: string): void {
  brief.value = example
  briefEl.value?.focus()
}

function submit(): void {
  if (!canSubmit.value) return
  emit('submit', {
    name: form.name.trim(),
    description: form.description.trim(),
    instructions: form.instructions.trim(),
    access: form.access,
  })
}

/** Esc 关闭：挂 window 而不是容器 keydown —— 焦点可能在任意字段里 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation()
    close()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  void nextTick(() => briefEl.value?.focus())
})

onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div class="dialog-overlay" data-field="agent.subagents.createDialog" @click.self="close">
      <section
        class="dialog-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="subagent-create-title"
      >
        <header class="dialog-head">
          <span class="dialog-mark" aria-hidden="true">
            <Sparkles :size="15" :stroke-width="1.8" />
          </span>
          <div class="dialog-titles">
            <h2 id="subagent-create-title" class="dialog-title">新建子代理</h2>
            <p class="dialog-sub">给它一个明确的用途，主代理才知道什么时候派它。</p>
          </div>
          <button
            type="button"
            class="icon-btn"
            aria-label="关闭"
            :disabled="props.busy"
            @click="close"
          >
            <X :size="15" :stroke-width="1.8" aria-hidden="true" />
          </button>
        </header>

        <div class="dialog-body">
          <!-- 让 Aurora 起草：一句话需求 → 草稿预填表单（不自动保存） -->
          <section class="draft-box" :class="{ busy: drafting }">
            <div class="draft-head">
              <Sparkles :size="13" :stroke-width="1.8" aria-hidden="true" />
              <span class="draft-title">让 Aurora 起草</span>
              <span class="tiny muted grow">一句话描述，生成的草稿你可以再改</span>
              <LoaderCircle
                v-if="drafting"
                class="spin tiny muted"
                :size="13"
                :stroke-width="1.8"
                aria-hidden="true"
              />
            </div>
            <textarea
              ref="briefEl"
              v-model="brief"
              class="input brief"
              rows="2"
              maxlength="300"
              spellcheck="false"
              placeholder="一句话说清它做什么、什么时候用"
              data-field="agent.subagents.create.brief"
              @keydown.ctrl.enter.prevent="runDraft"
            />
            <div class="draft-actions">
              <div class="examples">
                <button
                  v-for="example in BRIEF_EXAMPLES"
                  :key="example"
                  type="button"
                  class="example-chip"
                  :title="example"
                  @click="useExample(example)"
                >
                  {{ example }}
                </button>
              </div>
              <AppButton
                variant="primary"
                size="sm"
                :disabled="!canDraft"
                data-field="agent.subagents.create.draft"
                @click="runDraft"
              >
                {{ drafting ? '生成中…' : '生成草稿' }}
              </AppButton>
            </div>
            <p v-if="draftError !== ''" class="draft-error" role="alert">{{ draftError }}</p>
          </section>

          <div class="divider"><span>或手动填写</span></div>

          <div class="fields">
            <label class="field">
              <span class="field-head">
                <span class="field-label">名称</span>
                <span class="tiny muted">{{ form.name.length }} / 40</span>
              </span>
              <input
                ref="nameEl"
                v-model="form.name"
                class="input"
                type="text"
                maxlength="40"
                placeholder="例如：代码审查员"
                data-field="agent.subagents.create.name"
              />
              <span class="field-hint">展示名，报告、工具卡徽章与侧栏标题都用它。</span>
            </label>

            <label class="field">
              <span class="field-head">
                <span class="field-label">用途说明</span>
                <span class="tiny muted">{{ form.description.length }} / 200</span>
              </span>
              <textarea
                v-model="form.description"
                class="input"
                rows="2"
                maxlength="200"
                placeholder="什么时候派它？写清适用与不适用的场合。"
                data-field="agent.subagents.create.description"
              />
              <span class="field-hint">主代理据此判断什么时候派它，写清适用场合最有效。</span>
            </label>

            <div class="field">
              <span class="field-label">工具权限</span>
              <div class="access-options" data-field="agent.subagents.create.access">
                <button
                  v-for="level in SUBAGENT_ACCESS_LEVELS"
                  :key="level"
                  type="button"
                  class="access-option"
                  :class="{ active: form.access === level, danger: level === 'execute' }"
                  :aria-pressed="form.access === level"
                  @click="form.access = level"
                >
                  {{ SUBAGENT_ACCESS_LABELS[level] }}
                </button>
              </div>
              <span v-if="form.access === 'execute'" class="field-hint warn">
                可执行命令是最敏感的一档：写入与命令仍会按当前权限档逐次确认。
              </span>
              <span v-else class="field-hint"
                >写入与命令仍按当前权限档逐次确认，不会绕过确认链。</span
              >
            </div>

            <label class="field">
              <span class="field-head">
                <span class="field-label">指令（系统提示词）</span>
                <span class="tiny muted">{{ form.instructions.length }} / 4000</span>
              </span>
              <textarea
                v-model="form.instructions"
                class="input instructions"
                rows="6"
                maxlength="4000"
                spellcheck="false"
                placeholder="写清角色、工作方式与报告要求。"
                data-field="agent.subagents.create.instructions"
              />
              <span class="field-hint">
                写清角色、工作方式与报告要求；「看不到父对话、不向用户提问」由 Aurora 统一追加。
              </span>
            </label>
          </div>

          <p v-if="duplicateName" class="field-hint warn">已有同名子代理，换个名字更清楚。</p>
          <p v-if="props.existing.length >= MAX_SUBAGENTS" class="field-hint warn">
            子代理已达上限 {{ MAX_SUBAGENTS }} 个，先删掉一个再新建。
          </p>
        </div>

        <footer class="dialog-foot">
          <span class="tiny muted">新的子代理默认启用、跟随当前会话模型</span>
          <span class="grow" />
          <AppButton
            size="sm"
            variant="ghost"
            :disabled="props.busy"
            data-field="agent.subagents.create.cancel"
            @click="close"
          >
            取消
          </AppButton>
          <AppButton
            variant="primary"
            size="sm"
            :disabled="!canSubmit"
            data-field="agent.subagents.create.submit"
            @click="submit"
          >
            {{ props.busy ? '保存中…' : '添加子代理' }}
          </AppButton>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
/* 遮罩与卡片：设置窗内的模态层（z-popover，低于 --z-toast：页级 Toast 仍在最上面） */
.dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-popover);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: color-mix(in srgb, #000 46%, transparent);
  backdrop-filter: blur(2px);
}

.dialog-card {
  display: flex;
  flex-direction: column;
  width: min(620px, 100%);
  max-height: min(86vh, 760px);
  border-radius: var(--radius-lg);
  border: 1px solid var(--glass-border-strong);
  background: var(--bg-raised);
  box-shadow: var(--shadow-2);
  overflow: hidden;
  animation: dialog-rise var(--dur-base) var(--ease-spring) both;
}

@keyframes dialog-rise {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.99);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .dialog-card {
    animation: none;
  }
}

.dialog-head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-4) var(--space-4) var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
}

.dialog-mark {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--aurora-gradient);
  color: var(--on-accent);
  box-shadow: var(--shadow-hairline);
}

.dialog-titles {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}

.dialog-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  line-height: var(--leading-tight);
}

.dialog-sub {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.icon-btn {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-xs);
  color: var(--text-muted);
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.icon-btn:hover:not(:disabled) {
  background: var(--fill-1);
  color: var(--text-primary);
}

.icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.dialog-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  overflow-y: auto;
  min-height: 0;
}

/* ── Aurora 起草区：比表单更靠前、用一层浅填充标出「这是 AI 入口」 ── */
.draft-box {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid color-mix(in srgb, var(--aurora-blue) 28%, transparent);
  background: color-mix(in srgb, var(--aurora-blue) 7%, transparent);
}

.draft-box.busy {
  opacity: 0.82;
}

.draft-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--accent-text);
}

.draft-title {
  font-weight: var(--weight-semibold);
  font-size: var(--text-sm);
}

.brief {
  width: 100%;
  min-height: 54px;
  resize: vertical;
  font-family: inherit;
  line-height: var(--leading-normal);
}

.draft-actions {
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.examples {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  flex: 1 1 240px;
  min-width: 0;
}

.example-chip {
  max-width: 100%;
  padding: 2px 9px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  line-height: 18px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.example-chip:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.draft-error {
  margin: 0;
  padding: 6px 9px;
  border-radius: var(--radius-xs);
  background: var(--error-fill);
  color: var(--error-text);
  font-size: var(--text-xs);
}

/* ── 分割线：Aurora 起草 / 手动填写 ── */
.divider {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.divider::before,
.divider::after {
  content: '';
  flex: 1 1 auto;
  height: 1px;
  background: var(--border-subtle);
}

/* ── 表单：标签在上、控件在下（弹窗宽度比设置页窄，SettingField 的两列栅格会挤） ── */
.fields {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.field-label {
  color: var(--text-primary);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}

.field-hint {
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}

.field-hint.warn {
  color: var(--warning-text);
}

.input {
  width: 100%;
  min-height: 34px;
  padding: 6px var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  color: var(--text-primary);
  font-family: inherit;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  outline: none;
  resize: vertical;
  transition:
    border-color var(--transition-fast),
    background var(--transition-fast),
    box-shadow var(--transition-fast);
}

.input:hover {
  border-color: var(--border-strong);
}

.input:focus {
  border-color: var(--aurora-blue);
  background: var(--fill-2);
  box-shadow: 0 0 0 1px var(--accent-ring);
}

.instructions {
  resize: vertical;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.6;
}

/* 三档权限：分段按钮（比下拉更像「选择一种授权」） */
.access-options {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.access-option {
  padding: 4px 10px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  line-height: 18px;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast);
}

.access-option:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.access-option.active {
  border-color: var(--aurora-blue);
  background: color-mix(in srgb, var(--aurora-blue) 16%, transparent);
  color: var(--accent-text);
  font-weight: var(--weight-medium);
}

.access-option.danger.active {
  border-color: color-mix(in srgb, var(--status-error) 55%, transparent);
  background: var(--error-fill);
  color: var(--error-text);
}

.dialog-foot {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border-subtle);
  background: var(--fill-1);
}

.grow {
  flex: 1;
}
</style>
