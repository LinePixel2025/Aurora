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
    size?: 'sm' | 'md' | 'lg'
  }>(),
  { variant: 'secondary', disabled: false, block: false, size: 'md' },
)

/**
 * 鼠标点击后释放焦点：避免指针已经离开时，后续 Enter / Space 再次触发上一次按钮。
 * 键盘激活的 `detail` 为 0，仍保留正常焦点；仅拦截真实指针点击留下的焦点。
 */
function releasePointerFocus(event: MouseEvent): void {
  if (event.detail > 0) (event.currentTarget as HTMLButtonElement).blur()
}
</script>

<template>
  <button
    class="aurora-button interactive"
    :class="[`v-${variant}`, `s-${size}`, { block }]"
    :disabled="disabled"
    type="button"
    @click="releasePointerFocus"
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
  min-height: var(--control-h-md);
  border-radius: var(--radius-pill);
  padding: 0 var(--space-4);
  border: 1px solid transparent;
  font-weight: var(--weight-medium);
  white-space: nowrap;
}

.aurora-button:disabled {
  opacity: 0.42;
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
  min-height: var(--control-h-sm);
  padding: 0 var(--space-3);
  font-size: var(--text-sm);
}

.s-md {
  min-height: var(--control-h-md);
}

.s-lg {
  min-height: var(--control-h-lg);
  padding: 0 var(--space-5);
  font-size: var(--text-lg);
}

.v-primary {
  background: var(--aurora-gradient);
  color: var(--on-accent);
  font-weight: var(--weight-semibold);
  box-shadow: var(--shadow-hairline);
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
  background: var(--danger-fill);
  color: var(--danger-text);
  border-color: var(--danger-border);
}

.v-danger:hover:not(:disabled) {
  background: var(--danger-fill-hover);
}
</style>
