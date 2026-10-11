<script setup lang="ts">
/**
 * 思考等级下拉（对话窗输入区专用的紧凑版，docs/07 §2.3）。
 *
 * 读写的是**同一个字段** `llm.providers.<active>.modelParams.<当前模型>.reasoningEffort`（v23 起按模型绑定，docs/06 §3）——
 * 与设置页「AI 模型」高级参数里的同名下拉没有第二份来源，因此本组件不保存本地状态：
 * 值始终来自 props（配置 = 单一事实来源），选择只 `emit` 出去，落盘由调用方完成
 * （分组级局部更新要求原样回传全部 provider，且不能带回渲染层的空 `apiKeyEnc`——
 * 那些坑都在调用方 `chat/App.vue` 的 `setEffort()` 里踩过并写明了）。
 *
 * `auto` 表示不下发 `reasoning_effort` 字段（兼容性最好），由主进程装配层映射成 `undefined`。
 * option 集合直接取 Schema 的 `REASONING_EFFORT_LEVELS`：以后加等级不会只漏掉这个入口；
 * 文案与 `settings/pages/LlmPage.vue` **逐字一致**——同一个值在两个入口不能有两套说法。
 *
 * 尺寸：与权限 / 模型两枚控件**逐字对齐**（`--control-h-xs` = 28px + pill 圆角 + 静止态零边框，
 * 见 docs/07 §2.3 的输入卡硬口径；2026-09-29 减负轮从 40px 压到 28px），宽度自适应。
 * `data-field` 挂在 `<select>` 自己身上：capture 探针按它定位后**直接读 `.value`**。
 */
import { computed } from 'vue'
import {
  REASONING_EFFORT_LABELS,
  REASONING_EFFORT_LEVELS,
  type ReasoningEffort,
} from '@aurora/shared/browser'

const props = withDefaults(
  defineProps<{ modelValue: ReasoningEffort; disabled?: boolean; title?: string }>(),
  {
    disabled: false,
    title: '',
  },
)

const emit = defineEmits<{ 'update:modelValue': [value: ReasoningEffort] }>()

/**
 * 悬浮提示 = 当前等级的**完整解释** + 调用方给的参数说明
 * （无 provider 时那边给的是「先在设置里配一个模型」的修复路径）。
 */
const hoverTitle = computed(() => {
  const full = REASONING_EFFORT_LABELS[props.modelValue].full
  return props.title === '' ? full : `${full}｜${props.title}`
})

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
    :title="hoverTitle"
    @change="onChange"
  >
    <option v-for="level in REASONING_EFFORT_LEVELS" :key="level" :value="level">
      {{ REASONING_EFFORT_LABELS[level].short }}
    </option>
  </select>
</template>

<style scoped>
/**
 * 紧凑下拉（2026-09-29 减负轮：与 `ModelPickerSelect.vue` 同步改成「零边框芯片」）。
 * `.input` 这个类名只为与设置页的控件叫法对齐——它的样式定义在 `settings.css` 的
 * `.settings .input` 作用域内，在对话窗**不生效**，实际外观全部由这里给出。
 * 两枚下拉的尺寸 / 圆角 / 悬停 / 聚焦样式必须**逐字对齐**（同 28px 高、同 pill 圆角、
 * 同 `--fill-2` 悬停底色），否则同一条工具带上会出现两种控件观感。
 *
 * `flex: 0 1 auto`（可收缩到 `min-width`）：`.composer-bar` 的收缩顺序是
 * 「瞬时提示 → 模型 → 本控件 → 权限芯片」，窄窗下依次让位，
 * 谁都不能把发送按钮挤出行外、更不能溢出输入卡边框。
 * 下限 56px（2026-10-11，原 62px）：主区被压到下限 420px 时，四枚芯片 + 发送要一起
 * 装进 ≈362px；权限芯片不参与收缩，模型组与来源让位更多，本控件再让 6px。
 */
.thinking-level {
  flex: 0 1 auto;
  width: auto;
  min-width: 56px;
  max-width: 96px;
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
  /* 选中项最长是 `medium`：96px 足够完整显示，不再出现被省略号切一半的文案 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition:
    border-color var(--transition-fast),
    background var(--transition-fast),
    color var(--transition-fast);
}

.thinking-level:hover:not(:disabled) {
  background: var(--fill-2);
  color: var(--text-primary);
}

/* 聚焦时用主题语义环，保留键盘聚焦可见性。 */
.thinking-level:focus-visible {
  border-color: var(--focus-ring);
  background: var(--fill-2);
  color: var(--text-primary);
}

/* 无可用 provider 时保持可见但禁用（用户抱怨的是「找不到按钮」，藏起来会让抱怨复现） */
.thinking-level:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
