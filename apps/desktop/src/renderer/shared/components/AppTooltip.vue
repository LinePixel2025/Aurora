<script setup lang="ts">
/**
 * 悬浮提示（2026-09，docs/07 §5.4）：把「可以压缩的说明文案」从版面上挪到悬停提示里。
 *
 * 为什么不用纯 CSS 伪元素：提示常挂在 `overflow: auto` 的容器（弹窗正文 / 列表）内，
 * 绝对定位的伪元素会被裁掉；`title` 原生提示又慢、样式不可控、且在禁用态控件上不弹。
 * 这里 Teleport 到 body + `position: fixed`，按锚点矩形定位并做视口夹取，
 * 因此**不受任何祖先溢出裁剪**（层级取 `--z-tooltip`，高于弹层 `--z-popover`）。
 *
 * 用法：`:text` 直接给字符串；插槽里放被提示的元素（图标钮 / 磁贴 / 文字）。
 * 空字符串不弹（便于调用侧 `v-if` 省略，不必自己判断）。
 *
 * 定位走 `transform`，所以**进场动画只能碰 opacity**（`aurora-pop-in` 之类会写
 * `transform: none`，会把气泡拍回锚点左上角 —— 这是本组件唯一容易踩的坑）。
 */
import { nextTick, onBeforeUnmount, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    text: string
    /** 气泡相对锚点的位置：默认在上方（列表项下方空间常被裁） */
    placement?: 'top' | 'bottom'
    /** 锚点与气泡的间距（px） */
    gap?: number
  }>(),
  { placement: 'top', gap: 8 },
)

const open = ref(false)
const anchor = ref<HTMLElement | null>(null)
const bubble = ref<HTMLElement | null>(null)
const pos = ref({ x: 0, y: 0 })

/** 视口内边距：夹取时留出的最小边距，避免气泡贴边 */
const EDGE = 10

async function show(): Promise<void> {
  const el = anchor.value
  if (el === null || props.text.trim() === '') return
  const rect = el.getBoundingClientRect()
  // 锚点已滚出视口时不弹（长列表里的常规情形）
  if (rect.bottom < 0 || rect.top > window.innerHeight) return
  const x = rect.left + rect.width / 2
  const y = props.placement === 'top' ? rect.top - props.gap : rect.bottom + props.gap
  pos.value = { x, y }
  open.value = true
  window.addEventListener('scroll', hide, true)
  window.addEventListener('resize', hide)
  await nextTick()
  const tip = bubble.value
  if (tip === null) return
  // 量到真实宽度后再夹取：长文案在窄窗口下也不会冲出屏幕
  const half = tip.offsetWidth / 2
  const min = half + EDGE
  const max = window.innerWidth - half - EDGE
  pos.value = { x: Math.min(Math.max(x, min), Math.max(min, max)), y }
}

/** 收回（滚动 / 尺寸变化也走这里：fixed 定位的气泡不会跟着锚点走，留着就是错位浮层） */
function hide(): void {
  open.value = false
  window.removeEventListener('scroll', hide, true)
  window.removeEventListener('resize', hide)
}

onBeforeUnmount(hide)
</script>

<template>
  <span
    ref="anchor"
    class="tip-host"
    @pointerenter="show()"
    @pointerleave="hide()"
    @focusin="show()"
    @focusout="hide()"
  >
    <slot />
  </span>
  <Teleport to="body">
    <Transition name="tip">
      <div
        v-if="open"
        ref="bubble"
        class="app-tip glass-panel"
        :class="placement"
        role="tooltip"
        :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
      >
        {{ text }}
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.tip-host {
  display: inline-flex;
  min-width: 0;
}

.app-tip {
  position: fixed;
  z-index: var(--z-tooltip);
  max-width: min(280px, calc(100vw - 24px));
  padding: 5px var(--space-2);
  border-radius: var(--radius-xs);
  background: var(--glass-panel);
  border: 1px solid var(--glass-border);
  box-shadow: var(--shadow-2);
  color: var(--text-primary);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  text-align: center;
  word-break: break-word;
  pointer-events: none;
}

/* 定位用 translate 承担（left / top 是锚点中线），两个方向只差 100% 的位移 */
.app-tip.top {
  transform: translate(-50%, -100%);
}

.app-tip.bottom {
  transform: translate(-50%, 0);
}

/* 只动 opacity：动画一旦写 transform 就会覆盖上面的定位位移 */
.tip-enter-active,
.tip-leave-active {
  transition: opacity var(--transition-fast);
}

.tip-enter-from,
.tip-leave-to {
  opacity: 0;
}
</style>
