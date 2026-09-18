<script setup lang="ts">
/** 设置项一行：标签 + 说明 + 控件插槽。 */
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
  align-self: center;
}

.required {
  color: var(--status-error);
  margin-left: 2px;
}

.hint {
  grid-area: hint;
  color: var(--text-muted);
  font-size: 12px;
}

.control {
  grid-area: control;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.control :deep(input[type='text']),
.control :deep(input[type='password']),
.control :deep(input[type='number']),
.control :deep(select) {
  width: 100%;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  background: rgba(0, 0, 0, 0.28);
  outline: none;
  transition: border-color var(--transition-fast);
}

.control :deep(input:focus),
.control :deep(select:focus) {
  border-color: var(--aurora-blue);
}

.control :deep(textarea) {
  width: 100%;
  min-height: 64px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  background: rgba(0, 0, 0, 0.28);
  resize: vertical;
}
</style>
