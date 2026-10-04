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
  border: 1px solid var(--glass-border-soft);
  background: var(--glass-surface);
  box-shadow: inset 0 1px 0 var(--glass-highlight);
  color: var(--text-secondary);
}

.t-warn {
  border-color: color-mix(in srgb, var(--status-unread) 35%, transparent);
  background: var(--warning-fill);
  color: var(--warning-text);
}

.t-error {
  border-color: var(--danger-border);
  background: var(--error-fill);
  color: var(--error-text);
}

.t-ok {
  border-color: color-mix(in srgb, var(--status-ok) 30%, transparent);
  background: var(--ok-fill);
  color: var(--ok-text);
}
</style>
