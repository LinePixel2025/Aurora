<script setup lang="ts">
/**
 * 设置项一行：标签 + 说明 + 控件插槽（label / hint / control 三行栅格）。
 *
 * 控件（input / select / textarea / checkbox）统一高度、圆角与聚焦光晕；
 * props 与插槽用法保持不变。
 */
defineProps<{ label: string; hint?: string; required?: boolean }>()
</script>

<template>
  <label class="field">
    <span class="label">
      {{ label }}
      <span v-if="required" class="required">*</span>
    </span>
    <span v-if="hint" class="hint">{{ hint }}</span>
    <span class="control">
      <slot />
    </span>
  </label>
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

/* 输入控件统一外观：深色内嵌底 + 聚焦时品牌蓝描边与光晕 */
.control :deep(input[type='text']),
.control :deep(input[type='password']),
.control :deep(input[type='number']),
.control :deep(select) {
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border-radius: var(--radius-xs);
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

.control :deep(input:focus),
.control :deep(select:focus) {
  border-color: var(--aurora-blue);
  background: var(--fill-2);
  box-shadow: 0 0 0 3px rgba(86, 132, 255, 0.22);
}

.control :deep(textarea) {
  width: 100%;
  min-height: 64px;
  padding: 8px 10px;
  border-radius: var(--radius-xs);
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

.control :deep(textarea:focus) {
  border-color: var(--aurora-blue);
  background: var(--fill-2);
  box-shadow: 0 0 0 3px rgba(86, 132, 255, 0.22);
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
