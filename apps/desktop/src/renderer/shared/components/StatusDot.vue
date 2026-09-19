<script setup lang="ts">
/**
 * AI 状态灯（docs/07 §1/§2.2）：闲置灰 → 运行中呼吸蓝 → 有未读橙 → 异常红。
 *
 * 运行态是低频呼吸（1.8s，不做高频闪烁：常驻托盘工具里闪烁会变成干扰）；
 * `prefers-reduced-motion` 下降级为静态色。props 不变。
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
  box-shadow: 0 0 0 3px rgba(86, 132, 255, 0.16);
  animation: breathe 1.8s ease-in-out infinite;
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
    opacity: 0.5;
    transform: scale(0.9);
  }
  50% {
    opacity: 1;
    transform: scale(1.12);
  }
}

@media (prefers-reduced-motion: reduce) {
  .dot-running {
    animation: none;
    opacity: 1;
    transform: none;
  }
}
</style>
