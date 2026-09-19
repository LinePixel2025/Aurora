<script setup lang="ts">
/**
 * 统一按钮：primary（极光渐变）/ secondary（玻璃填充）/ ghost（纯文本）/ danger（危险操作）。
 *
 * 视觉走 theme.css 的令牌与 `.interactive`（悬停上浮 + 按下回缩）；
 * props / emits 与调用方式保持不变。
 */
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
    class="aurora-button interactive"
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
  font-weight: var(--weight-medium);
  white-space: nowrap;
}

.aurora-button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  box-shadow: none;
}

/* 禁用态不吃 `.interactive` 的悬停反馈 */
.aurora-button:disabled:hover {
  transform: none;
}

.block {
  width: 100%;
}

.s-sm {
  padding: 5px 10px;
  font-size: var(--text-sm);
  border-radius: var(--radius-xs);
}

.v-primary {
  background: var(--aurora-gradient);
  color: #08131a;
  font-weight: var(--weight-semibold);
  box-shadow: var(--shadow-1);
}

.v-primary:hover:not(:disabled) {
  filter: brightness(1.06);
}

.v-secondary {
  background: var(--fill-2);
  border-color: var(--border-subtle);
  color: var(--text-primary);
}

.v-secondary:hover:not(:disabled) {
  background: var(--fill-3);
}

.v-ghost {
  color: var(--text-secondary);
}

.v-ghost:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--fill-1);
  box-shadow: none;
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
