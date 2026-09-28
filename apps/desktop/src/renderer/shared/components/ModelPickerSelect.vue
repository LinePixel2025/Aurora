<script setup lang="ts">
/**
 * 模型下拉（对话窗输入区专用的紧凑版，docs/07 §2.3）。
 *
 * 读写的是 `llm.providers.<active>.model`——它与设置页「AI 模型」卡的「模型名」输入框、
 * 以及「模型列表」编辑区里的「当前使用」标记是**同一份数据**（`model` 是唯一生效值，
 * `modelList` 只是候选）。因此本组件不保存本地状态：值始终来自 props（配置 = 单一事实来源），
 * 选择只 `emit` 出去，落盘由调用方完成（分组级局部更新要求原样回传全部 provider，
 * 且不能带回渲染层的空 `apiKeyEnc`——那些坑都在调用方 `chat/App.vue` 的 `updateActiveProvider()` 里踩过并写明了）。
 *
 * 与 `ThinkingLevelSelect.vue` 的分工：那个管 `reasoningEffort`，这个管 `model`；
 * 两者的尺寸 / 边框 / 聚焦样式逐字对齐，才像同一条工具带上的两个控件。
 *
 * 尺寸：高度与输入区按钮同为 40px、基准宽度 110px，要和 420px 宽的交互窗输入区里的发送按钮同行。
 * `data-field` 挂在 `<select>` 自己身上：capture 探针按它定位后**直接读 / 写 `.value`**。
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 当前生效模型（`llm.providers.<active>.model`）；空串 = 还没填 */
    modelValue: string
    /** 候选模型 id 列表（`llm.providers.<active>.modelList`） */
    models: string[]
    disabled?: boolean
    title?: string
  }>(),
  { disabled: false, title: '' },
)

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

/**
 * 悬浮提示：**完整**模型 id + 调用方给的说明。
 *
 * 模型 id（如 `deepseek-chat`、`qwen2.5-72b-instruct`）在 110px 的窄控件里必然被省略号截断，
 * 而这恰恰是用户要确认的信息 —— 截断后只靠前半段认不出是哪个模型（docs/07 §5.4：
 * 「能压缩的说明不占版面」不等于「关键信息可以看不全」，看全的路径要留在手边）。
 */
const hoverTitle = computed(() => {
  const full = props.modelValue === '' ? '未选择模型' : props.modelValue
  return props.title === '' ? full : `${full}｜${props.title}`
})

interface ModelOption {
  value: string
  label: string
  disabled: boolean
}

/**
 * 选项 = 候选去重（保持原有顺序）后按需在最前面插一条「越界 / 占位」项。
 *
 * - 空串候选直接丢掉：它只会和「未选择模型」占位项同值打架（`option[value=""]` 会出现两条）。
 * - 当前值不在候选里（含候选为空）：**如实显示它是什么**并标注「（不在列表中）」，
 *   而不是悄悄替换成候选里的第一个——那等于替用户改了模型，且设置页还显示着旧值。
 * - 当前值为空串：插一条「未选择模型」占位；它**永远不可选**（它是「没有值」的可视化，
 *   不是一个能选中的模型），候选为空时它是唯一选项，正好把控件留成可见的禁用态入口。
 */
const options = computed<ModelOption[]>(() => {
  const list: ModelOption[] = []
  const seen = new Set<string>()
  for (const id of props.models) {
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    list.push({ value: id, label: id, disabled: false })
  }
  if (props.modelValue !== '' && !seen.has(props.modelValue)) {
    list.unshift({
      value: props.modelValue,
      label: `${props.modelValue}（不在列表中）`,
      disabled: false,
    })
  }
  if (props.modelValue === '') {
    list.unshift({ value: '', label: '未选择模型', disabled: true })
  }
  return list
})

/**
 * 用 `:value` + `change` 而不是 `v-model`：这里只把「用户选了什么」报给父级，
 * 不回写本地副本（配置回传后由 `modelValue` 驱动显示，避免两份状态打架）。
 * 「值没变就不写盘」由父级判断（它才知道配置里的当前值），这里不做拦截。
 */
function onChange(event: Event): void {
  emit('update:modelValue', (event.target as HTMLSelectElement).value)
}
</script>

<template>
  <select
    class="input model-picker"
    data-field="chat.model"
    aria-label="模型"
    :value="modelValue"
    :disabled="disabled"
    :title="hoverTitle"
    @change="onChange"
  >
    <option
      v-for="option in options"
      :key="option.value"
      :value="option.value"
      :disabled="option.disabled"
    >
      {{ option.label }}
    </option>
  </select>
</template>

<style scoped>
/**
 * 紧凑下拉，视觉与 `ThinkingLevelSelect.vue` 保持同一套（同高、同边框与聚焦环）。
 * `.input` 这个类名只为与设置页的控件叫法对齐——它的样式定义在 `settings.css` 的
 * `.settings .input` 作用域内，在对话窗**不生效**，实际外观全部由这里给出。
 *
 * 宽度是**固定 110px**（长模型名省略号，不撑破输入区），因为模型 id 的长度差异很大，
 * 自适应宽度会让整行随选择跳动。`flex: 0 1 110px` 与 `min-width: 72px` 是 420px 宽下的
 * 兜底：`.composer-bar` 里流式时会多出一个「停止」按钮，此时全长（两个标签 + 两个下拉 +
 * 停止 + 发送）会略微超出可用宽度，收缩顺序必须是「提示文本（`.picker-hint`，shrink 100）
 * → 本控件（最多让出 38px）」——两个标签与发送按钮都不收缩，
 * **发送按钮绝不能被挤出行外**（这是这一行最容易破的版）。非流式时本控件始终是 110px。
 */
.model-picker {
  flex: 0 1 110px;
  width: 110px;
  min-width: 72px;
  max-width: 130px;
  height: var(--control-h-md);
  padding: 0 var(--space-1);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  color: var(--text-secondary);
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

.model-picker:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--text-primary);
}

/* 聚焦时用主题语义环，保留键盘聚焦可见性。 */
.model-picker:focus-visible {
  border-color: var(--focus-ring);
  background: var(--fill-2);
  box-shadow: 0 0 0 1px var(--accent-ring);
}

/* 无可用 provider 时保持可见但禁用（用户抱怨的是「找不到按钮」，藏起来会让抱怨复现） */
.model-picker:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
