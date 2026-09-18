<script setup lang="ts">
/** 统一按钮：主色渐变 / 次级 / 文本三种形态。 */
withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
    disabled?: boolean
    block?: boolean
    size?: 'sm' | 'md'
  }>(),
  { variant: 'secondary', disabled: false, block: false, size: 'md' },
)
</script>

<template>
  <button
    class="aurora-button"
    :class="[`v-${variant}`, `s-${size}`, { block }]"
    :disabled="disabled"
    type="button"
  >
    <slot />
  </button>
</template>

<style scoped>
.aurora-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  border-radius: var(--radius-sm);
  padding: 8px 14px;
  border: 1px solid transparent;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast),
    transform var(--transition-fast);
  white-space: nowrap;
}

.aurora-button:active:not(:disabled) {
  transform: translateY(1px);
}

.aurora-button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.block {
  width: 100%;
}

.s-sm {
  padding: 5px 10px;
  font-size: 12px;
}

.v-primary {
  background: var(--aurora-gradient);
  color: #08131a;
  font-weight: 600;
}

.v-primary:hover:not(:disabled) {
  filter: brightness(1.06);
}

.v-secondary {
  background: rgba(255, 255, 255, 0.06);
  border-color: var(--border-subtle);
  color: var(--text-primary);
}

.v-secondary:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.11);
}

.v-ghost {
  color: var(--text-secondary);
}

.v-ghost:hover:not(:disabled) {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.06);
}

.v-danger {
  background: rgba(242, 85, 90, 0.14);
  color: #ff9ca0;
  border-color: rgba(242, 85, 90, 0.3);
}

.v-danger:hover:not(:disabled) {
  background: rgba(242, 85, 90, 0.22);
}
</style>
