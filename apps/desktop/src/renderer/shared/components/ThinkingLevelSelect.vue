<script setup lang="ts">
/**
 * 思考等级下拉（对话窗输入区专用的紧凑版，docs/07 §2.3）。
 *
 * 读写的是**同一个字段** `llm.providers.<active>.reasoningEffort`（docs/06 §3）——
 * 与设置页「AI 模型」高级参数里的同名下拉没有第二份来源，因此本组件不保存本地状态：
 * 值始终来自 props（配置 = 单一事实来源），选择只 `emit` 出去，落盘由调用方完成
 * （分组级局部更新要求原样回传全部 provider，且不能带回渲染层的空 `apiKeyEnc`——
 * 那些坑都在调用方 `chat/App.vue` 的 `setEffort()` 里踩过并写明了）。
 *
 * `auto` 表示不下发 `reasoning_effort` 字段（兼容性最好），由主进程装配层映射成 `undefined`。
 * option 集合直接取 Schema 的 `REASONING_EFFORT_LEVELS`：以后加等级不会只漏掉这个入口；
 * 文案与 `settings/pages/LlmPage.vue` **逐字一致**——同一个值在两个入口不能有两套说法。
 *
 * 尺寸：高度与输入区按钮同为 40px、宽度自适应（约 96-128px），要和 420px 宽的交互窗输入区里的发送按钮同行。
 * `data-field` 挂在 `<select>` 自己身上：capture 探针按它定位后**直接读 `.value`**。
 */
import { REASONING_EFFORT_LEVELS, type ReasoningEffort } from '@aurora/shared/browser'

withDefaults(defineProps<{ modelValue: ReasoningEffort; disabled?: boolean; title?: string }>(), {
  disabled: false,
  title: '',
})

const emit = defineEmits<{ 'update:modelValue': [value: ReasoningEffort] }>()

/** option 文案：与 `LlmPage.vue` 的下拉逐字一致（`Record` 保证新增等级时必须补文案） */
const LEVEL_LABELS: Record<ReasoningEffort, string> = {
  auto: 'auto（不指定，兼容性最好）',
  low: 'low（更快）',
  medium: 'medium',
  high: 'high（更深入）',
}

/**
 * 用 `:value` + `change` 而不是 `v-model`：这里只把「用户选了什么」报给父级，
 * 不回写本地副本（配置回传后由 `modelValue` 驱动显示，避免两份状态打架）。
 * 「值没变就不写盘」由父级判断（它才知道配置里的当前值），这里不做拦截——
 * DOM 值可能因保存失败而与 props 不一致，拦在这里会把用户重选同一个值也吞掉。
 */
function onChange(event: Event): void {
  emit('update:modelValue', (event.target as HTMLSelectElement).value as ReasoningEffort)
}
</script>

<template>
  <select
    class="input thinking-level"
    data-field="chat.reasoningEffort"
    aria-label="思考等级"
    :value="modelValue"
    :disabled="disabled"
    :title="title"
    @change="onChange"
  >
    <option v-for="level in REASONING_EFFORT_LEVELS" :key="level" :value="level">
      {{ LEVEL_LABELS[level] }}
    </option>
  </select>
</template>

<style scoped>
/**
 * 紧凑下拉。`.input` 这个类名只为与设置页的控件叫法对齐——它的样式定义在
 * `settings.css` 的 `.settings .input` 作用域内，在对话窗**不生效**，实际外观全部由这里给出。
 *
 * `flex: 0 0 auto` 是关键：`.composer-bar` 里被压缩的只能是可省略的 `.meta` 文本，
 * 这个控件与发送按钮都不参与收缩（420px 窗口下不允许换行或把发送按钮挤出去）。
 */
.thinking-level {
  flex: 0 0 auto;
  width: auto;
  min-width: 68px;
  max-width: 128px;
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
  /* 选中项 `auto（不指定，兼容性最好）` 最长：超出就省略号，不撑宽输入区 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition:
    border-color var(--transition-fast),
    background var(--transition-fast),
    color var(--transition-fast);
}

.thinking-level:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--text-primary);
}

/* 聚焦时用主题语义环，保留键盘聚焦可见性。 */
.thinking-level:focus-visible {
  border-color: var(--focus-ring);
  background: var(--fill-2);
  box-shadow: 0 0 0 1px var(--accent-ring);
}

/* 无可用 provider 时保持可见但禁用（用户抱怨的是「找不到按钮」，藏起来会让抱怨复现） */
.thinking-level:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
