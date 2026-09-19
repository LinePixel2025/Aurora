<script setup lang="ts">
/**
 * 轻量 Toast：错误提示与可恢复操作入口（docs/07 §4）。
 *
 * 用分层填充 + 语义色，进场走 `.anim-rise`；props 不变。
 */
withDefaults(defineProps<{ tone?: 'info' | 'warn' | 'error' | 'ok' }>(), { tone: 'info' })
</script>

<template>
  <div class="toast anim-rise" :class="`t-${tone}`" role="alert">
    <slot />
  </div>
</template>

<style scoped>
.toast {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  color: var(--text-secondary);
}

.t-warn {
  border-color: rgba(245, 165, 36, 0.35);
  background: rgba(245, 165, 36, 0.12);
  color: #f7c568;
}

.t-error {
  border-color: rgba(242, 85, 90, 0.35);
  background: rgba(242, 85, 90, 0.12);
  color: #ff9ca0;
}

.t-ok {
  border-color: rgba(56, 209, 150, 0.3);
  background: rgba(56, 209, 150, 0.1);
  color: #6fe0b4;
}
</style>
