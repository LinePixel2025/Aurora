<script setup lang="ts">
/**
 * AI 状态灯（docs/07 §2.1）：闲置灰 → 运行中呼吸蓝 → 有未读橙 → 异常红。
 */
type StatusTone = 'idle' | 'running' | 'unread' | 'error'

const props = withDefaults(defineProps<{ tone?: StatusTone; title?: string; size?: number }>(), {
  tone: 'idle',
  title: '',
  size: 8,
})

const toneClass = `dot-${props.tone}`
</script>

<template>
  <span
    class="status-dot"
    :class="toneClass"
    :style="{ width: `${size}px`, height: `${size}px` }"
    :title="title"
    role="status"
    :aria-label="title || tone"
  />
</template>

<style scoped>
.status-dot {
  display: inline-block;
  border-radius: 50%;
  background: var(--status-idle);
  transition: background var(--transition-base);
}

.dot-running {
  background: var(--status-running);
  animation: breathe 1.4s ease-in-out infinite;
}

.dot-unread {
  background: var(--status-unread);
}

.dot-error {
  background: var(--status-error);
}

@keyframes breathe {
  0%,
  100% {
    opacity: 0.45;
    transform: scale(0.9);
  }
  50% {
    opacity: 1;
    transform: scale(1.15);
  }
}

@media (prefers-reduced-motion: reduce) {
  .dot-running {
    animation: none;
  }
}
</style>
