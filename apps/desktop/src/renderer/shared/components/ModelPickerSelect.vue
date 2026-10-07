<script setup lang="ts">
/**
 * 模型来源 + 模型双下拉（对话窗输入区专用，docs/07 §2.3）。
 *
 * `selection` 是实际生效的 `(providerId, model)`；没有会话覆盖时由父级传入全局生效值，
 * 但只有用户主动改来源 / 模型时才由父级落盘。组件不保存本地状态，避免和设置 / 会话
 * 两份事实打架。
 *
 * 与 `ThinkingLevelSelect.vue` 的分工：那个管 `reasoningEffort`，这个管 `model`；
 * 两者的尺寸 / 边框 / 聚焦样式逐字对齐，才像同一条工具带上的两个控件。
 * `data-field` 直接挂在两个 `<select>` 上：capture 探针按它定位后直接读写 `.value`。
 */
import { computed } from 'vue'
import {
  modelChoiceKey,
  type ModelPickerChoice,
  type ModelPickerSource,
  type ModelPickerSourceId,
} from '../composables/modelPickerCore.js'

const props = withDefaults(
  defineProps<{
    selection: ModelPickerChoice | null
    sources: ModelPickerSource[]
    sourceId: ModelPickerSourceId | null
    disabled?: boolean
    title?: string
  }>(),
  { disabled: false, title: '' },
)

const emit = defineEmits<{
  'update:source': [value: ModelPickerSourceId]
  'update:selection': [value: ModelPickerChoice]
}>()

const currentSource = computed(
  () => props.sources.find((source) => source.id === props.sourceId) ?? null,
)

const hoverTitle = computed(() => {
  const full =
    props.selection === null
      ? '未选择模型'
      : `${props.selection.providerId} · ${props.selection.model}`
  return props.title === '' ? full : `${full}｜${props.title}`
})

function onSourceChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  if (value === 'center' || value === 'local') emit('update:source', value)
}

function onModelChange(event: Event): void {
  const key = (event.target as HTMLSelectElement).value
  const choice = currentSource.value?.options.find((item) => item.key === key)
  if (choice !== undefined) {
    emit('update:selection', { providerId: choice.providerId, model: choice.model })
  }
}
</script>

<template>
  <div class="model-picker-group">
    <select
      class="input model-picker model-source-picker"
      data-field="chat.modelSource"
      aria-label="模型来源"
      :value="sourceId ?? ''"
      :disabled="disabled || sources.length <= 1"
      title="模型来源"
      @change="onSourceChange"
    >
      <option v-for="source in sources" :key="source.id" :value="source.id">
        {{ source.label }}
      </option>
    </select>
    <select
      class="input model-picker"
      data-field="chat.model"
      aria-label="模型"
      :value="modelChoiceKey(selection)"
      :disabled="disabled || currentSource === null"
      :title="hoverTitle"
      @change="onModelChange"
    >
      <option v-for="option in currentSource?.options ?? []" :key="option.key" :value="option.key">
        {{ option.label }}
      </option>
    </select>
  </div>
</template>

<style scoped>
/**
 * 两个下拉共用一条紧凑芯片线；来源先固定较窄宽度，模型承担长 id 的省略。
 */
.model-picker-group {
  flex: 0 1 auto;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}

/**
 * 紧凑下拉（2026-09-29 减负轮：从「带边框的小按钮」改成「零边框芯片」）。
 * `.input` 这个类名只为与设置页的控件叫法对齐——它的样式定义在 `settings.css` 的
 * `.settings .input` 作用域内，在对话窗**不生效**，实际外观全部由这里给出。
 *
 * 静止态**不画边框、不填底**，只留一行文字与原生箭头；悬停 / 聚焦才浮出一层 `--fill-2`。
 * 权限 / 来源 / 模型 / 思考四枚芯片必须共用这一套尺寸与状态（同高 28px、同 pill 圆角、同悬停底色），
 * 才像同一条工具带上的控件；40px + 逐枚边框的旧样式会把输入卡顶成一条设置工具栏
 * （用户反馈「太丑、元素冗杂」）。
 *
 * 模型宽度固定 120px（长模型名省略号，不撑破输入区），来源宽度固定 96px。
 * `flex` 允许窄窗收缩，但两个控件的 min-width 合起来仍给发送 / 麦克风留出空间。
 */
.model-picker {
  flex: 0 1 120px;
  width: 120px;
  min-width: 76px;
  max-width: 140px;
  height: var(--control-h-xs);
  padding: 0 var(--space-2);
  border-radius: var(--radius-pill);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-muted);
  font-family: inherit;
  font-size: var(--text-xs);
  line-height: 1;
  cursor: pointer;
  outline: none;
  /* 选中项可能是长模型 id（如 deepseek-reasoner）：超出就省略号，不撑宽输入区 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition:
    border-color var(--transition-fast),
    background var(--transition-fast),
    color var(--transition-fast);
}

.model-source-picker {
  flex: 0 0 96px;
  width: 96px;
  min-width: 96px;
  max-width: 108px;
}

.model-picker:hover:not(:disabled) {
  background: var(--fill-2);
  color: var(--text-primary);
}

/* 聚焦时用主题语义环，保留键盘聚焦可见性。 */
.model-picker:focus-visible {
  border-color: var(--focus-ring);
  background: var(--fill-2);
  color: var(--text-primary);
}

/* 无可用 provider 时保持可见但禁用（用户抱怨的是「找不到按钮」，藏起来会让抱怨复现） */
.model-picker:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
