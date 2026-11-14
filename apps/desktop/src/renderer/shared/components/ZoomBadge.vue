<script setup lang="ts">
/**
 * 全局缩放徽标（2026-11-14，docs/07 §1）：zoomFactor ≠ 1 时右上角常驻一枚克制胶囊，
 * 倍率变化时短暂高亮 1.4s；`pointer-events: none`，不挡任何操作。
 * 七个业务窗口根节点统一挂载；提示条收起态被原生 shape 裁掉不可见（预期），展开态可见。
 * `data-field="window.zoom-badge"` 是 capture 探针（settings-zoom）的定位抓手。
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import { useWindowStore } from '../stores.js'

const windowStore = useWindowStore()
const factor = computed(() => windowStore.state.zoomFactor ?? 1)
const visible = computed(() => factor.value !== 1)
const percent = computed(() => Math.round(factor.value * 100))

const flash = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
watch(factor, () => {
  flash.value = true
  if (timer !== undefined) clearTimeout(timer)
  timer = setTimeout(() => {
    flash.value = false
  }, 1400)
})
onUnmounted(() => {
  if (timer !== undefined) clearTimeout(timer)
})
</script>

<template>
  <Transition name="zoom-badge">
    <div
      v-if="visible"
      class="zoom-badge"
      :class="{ flash }"
      data-field="window.zoom-badge"
      title="Ctrl+0 复位缩放"
      aria-live="polite"
    >
      {{ percent }}%
    </div>
  </Transition>
</template>

<style scoped>
.zoom-badge {
  position: fixed;
  top: 48px;
  right: 12px;
  z-index: 80;
  padding: 2px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-pill);
  background: var(--glass-bar);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
  line-height: 18px;
  pointer-events: none;
  transition:
    color var(--transition-fast),
    border-color var(--transition-fast);
}

.zoom-badge.flash {
  color: var(--text-primary);
  border-color: var(--border-strong);
}

.zoom-badge-enter-active,
.zoom-badge-leave-active {
  transition: opacity var(--transition-fast);
}

.zoom-badge-enter-from,
.zoom-badge-leave-to {
  opacity: 0;
}
</style>
