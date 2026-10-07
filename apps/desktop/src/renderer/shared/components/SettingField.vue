<script setup lang="ts">
/**
 * 设置项一行：标签 + 说明 + 控件插槽（label / hint / control 三行栅格）。
 *
 * 文本输入与选择框统一高度，输入类控件共用圆角与紧聚焦环；
 * props 与插槽用法保持不变。
 */
withDefaults(
  defineProps<{
    label: string
    hint?: string
    required?: boolean
    /** 只含按钮的字段用 div：label 会把整行 hover / click 代理给内部按钮。 */
    as?: 'label' | 'div'
  }>(),
  { as: 'label', hint: '', required: false },
)

/**
 * `<label>` 会把点击转发给内部第一个可标注控件。只含按钮的字段（如 Center 的
 * 「登录账户」）若保留这条默认行为，点标签文字 / 说明也会执行按钮；这里只拦这种代理，
 * 普通输入框 / 选择框仍保留点击标签聚焦的便利。
 */
function onClick(event: MouseEvent): void {
  const root = event.currentTarget
  const target = event.target
  if (!(root instanceof HTMLLabelElement) || !(target instanceof Element)) return
  if (target.closest('button') !== null) return
  const firstLabelable = root.querySelector<HTMLElement>(
    'input:not([type="hidden"]), select, textarea, button',
  )
  if (firstLabelable instanceof HTMLButtonElement) event.preventDefault()
}
</script>

<template>
  <component :is="as" class="field" @click="onClick">
    <span class="label">
      {{ label }}
      <span v-if="required" class="required">*</span>
    </span>
    <span v-if="hint" class="hint">{{ hint }}</span>
    <span class="control">
      <slot />
    </span>
  </component>
</template>

<style scoped>
.field {
  display: grid;
  grid-template-columns: minmax(140px, 200px) 1fr;
  grid-template-areas:
    'label control'
    'hint control';
  gap: 2px var(--space-4);
  align-items: center;
  padding: var(--space-2) 0;
}

.label {
  grid-area: label;
  color: var(--text-primary);
  font-weight: var(--weight-medium);
  align-self: center;
}

.required {
  color: var(--status-error);
  margin-left: 2px;
}

.hint {
  grid-area: hint;
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.control {
  grid-area: control;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

/* 输入控件统一外观：分层填充 + 聚焦时 1px 紧环 */
.control :deep(input[type='text']),
.control :deep(input[type='password']),
.control :deep(input[type='number']),
.control :deep(select) {
  width: 100%;
  height: 36px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  color: var(--text-primary);
  outline: none;
  transition:
    border-color var(--transition-fast),
    box-shadow var(--transition-fast),
    background var(--transition-fast);
}

.control :deep(input[type='text']:hover),
.control :deep(input[type='password']:hover),
.control :deep(input[type='number']:hover),
.control :deep(select:hover) {
  border-color: var(--border-strong);
}

.control :deep(textarea) {
  width: 100%;
  min-height: 72px;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  color: var(--text-primary);
  font-family: inherit;
  line-height: var(--leading-normal);
  outline: none;
  resize: vertical;
  transition:
    border-color var(--transition-fast),
    box-shadow var(--transition-fast),
    background var(--transition-fast);
}

.control :deep(input[type='text']:focus),
.control :deep(input[type='password']:focus),
.control :deep(input[type='number']:focus),
.control :deep(select:focus),
.control :deep(textarea:focus) {
  border-color: var(--aurora-blue);
  background: var(--fill-2);
  box-shadow: 0 0 0 1px var(--accent-ring);
}

/* 复选框：沿用系统外观但统一强调色，避免各页各自写死 */
.control :deep(input[type='checkbox']) {
  width: 16px;
  height: 16px;
  border-radius: var(--radius-xs);
  accent-color: var(--aurora-blue);
  cursor: pointer;
}
</style>
