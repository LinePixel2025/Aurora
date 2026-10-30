<script setup lang="ts">
/**
 * Computer Use 浮层 / HUD（v39，docs/06 §28）。
 *
 * 同一个入口两种窗口：`layer=overlay`（每显示器一扇）画虚拟光标 + 四边流光；
 * `layer=hud` 画底部一行实时操作提示。都不接收鼠标（主进程已 `setIgnoreMouseEvents`），
 * 也都 `setContentProtection(true)`，因此不会出现在 Agent 自己的截图里。
 *
 * 光标位置由主进程 30fps 推送（不是渲染层猜）；用户手动移动鼠标时浮层也会跟上，
 * 这正是「干扰不中断」的可见证据。
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import type { ComputerUseEvent } from '@aurora/shared'

const query = new URLSearchParams(window.location.search)
const layer = query.get('layer') === 'hud' ? 'hud' : 'overlay'
const preview = query.has('preview')
const displayId = Number(query.get('displayId') ?? '')

const active = ref(preview)
const cursor = reactive({ x: 0, y: 0 })
const trail = ref<Array<{ x: number; y: number }>>([])
const ripple = ref<{ x: number; y: number; key: number } | null>(null)
const hudText = ref(preview ? '正在操作 · 点击 (812, 431) · 第 3 / 300 步' : '等待下一步…')
const hudTone = ref<'info' | 'warn'>('info')
const startedAt = ref<number | null>(null)
const elapsed = ref('0:00')
const showCursor = ref(true)
const glow = ref(true)
let trailTimer: ReturnType<typeof setTimeout> | undefined
let rippleTimer: ReturnType<typeof setTimeout> | undefined
let elapsedTimer: ReturnType<typeof setInterval> | undefined
let offEvent: (() => void) | null = null

const isHud = computed(() => layer === 'hud')

function applyVisuals(settings: {
  computerUse?: { showVirtualCursor?: boolean; glow?: boolean; showHud?: boolean }
}): void {
  showCursor.value = settings.computerUse?.showVirtualCursor !== false
  glow.value = settings.computerUse?.glow !== false
  if (isHud.value && settings.computerUse?.showHud === false) active.value = false
}

function setCursor(x: number, y: number): void {
  cursor.x = x
  cursor.y = y
  trail.value = [...trail.value.slice(-3), { x, y }]
  if (trailTimer !== undefined) clearTimeout(trailTimer)
  trailTimer = setTimeout(() => {
    trail.value = []
  }, 180)
}

function showRipple(x: number, y: number): void {
  ripple.value = { x, y, key: Date.now() }
  if (rippleTimer !== undefined) clearTimeout(rippleTimer)
  rippleTimer = setTimeout(() => {
    ripple.value = null
  }, 620)
}

function onEvent(event: ComputerUseEvent): void {
  if (event.type === 'started') {
    if (!preview) active.value = true
    startedAt.value = Date.parse(event.startedAt)
    return
  }
  if (event.type === 'ended') {
    if (!preview) active.value = false
    return
  }
  if (event.type === 'cursor') {
    if (isHud.value || preview) return
    if (Number.isFinite(displayId) && event.displayId !== displayId) return
    setCursor(event.x, event.y)
    return
  }
  if (event.type === 'click') {
    if (isHud.value || preview) return
    if (Number.isFinite(displayId) && event.displayId !== displayId) return
    showRipple(event.x, event.y)
    return
  }
  if (event.type === 'action') {
    if (!isHud.value) return
    hudText.value = `${event.summary} · 第 ${event.step} / ${event.maxSteps} 步`
    hudTone.value = 'info'
    return
  }
  if (event.type === 'notice') {
    if (!isHud.value) return
    hudText.value = event.text
    hudTone.value = event.tone
  }
}

function tick(): void {
  if (startedAt.value === null) {
    elapsed.value = '0:00'
    return
  }
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt.value) / 1000))
  const minutes = Math.floor(seconds / 60)
  elapsed.value = `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

onMounted(() => {
  if (preview) {
    setCursor(Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 2))
    return
  }
  void window.aurora.settings.get().then((result) => {
    if (result.ok) applyVisuals(result.value)
  })
  offEvent = window.aurora.computerUse.onEvent(onEvent)
  void window.aurora.computerUse.status().then((result) => {
    if (!result.ok) return
    active.value = result.value.active
    if (result.value.startedAt !== undefined) {
      startedAt.value = Date.parse(result.value.startedAt)
    }
  })
  elapsedTimer = setInterval(tick, 1000)
  tick()
})

onUnmounted(() => {
  offEvent?.()
  offEvent = null
  if (trailTimer !== undefined) clearTimeout(trailTimer)
  if (rippleTimer !== undefined) clearTimeout(rippleTimer)
  if (elapsedTimer !== undefined) clearInterval(elapsedTimer)
})
</script>

<template>
  <div
    v-if="isHud"
    class="computer-use-hud"
    :class="{ active }"
    data-field="computer-use.hud"
    aria-hidden="true"
  >
    <span class="hud-dot" :class="hudTone" />
    <span class="hud-label">Computer Use</span>
    <span class="hud-text" data-field="computer-use.hud-text">{{ hudText }}</span>
    <span class="hud-time">{{ elapsed }}</span>
  </div>

  <div
    v-else
    class="computer-use-overlay"
    :class="{ active }"
    data-field="computer-use.root"
    aria-hidden="true"
  >
    <div v-if="glow" class="cu-glow" data-field="computer-use.glow">
      <span class="cu-glow-edge top" />
      <span class="cu-glow-edge right" />
      <span class="cu-glow-edge bottom" />
      <span class="cu-glow-edge left" />
    </div>

    <div v-if="showCursor" class="cu-cursor-layer" data-field="computer-use.cursor">
      <span
        v-for="(point, index) in trail"
        :key="`${point.x}-${point.y}-${index}`"
        class="cu-cursor-trail"
        :style="{ left: `${point.x}px`, top: `${point.y}px`, opacity: `${0.26 - index * 0.06}` }"
      />
      <span class="cu-cursor" :style="{ left: `${cursor.x}px`, top: `${cursor.y}px` }">
        <span class="cu-cursor-ring" data-field="computer-use.cursor-ring" />
        <span class="cu-cursor-dot" />
      </span>
      <span
        v-if="ripple"
        :key="ripple.key"
        class="cu-click-ripple"
        :style="{ left: `${ripple.x}px`, top: `${ripple.y}px` }"
      />
    </div>
  </div>
</template>

<style scoped>
.computer-use-overlay {
  position: fixed;
  inset: 0;
  pointer-events: none;
  opacity: 0;
  transition: opacity 240ms var(--ease-standard);
}

.computer-use-overlay.active {
  opacity: 1;
}

.computer-use-overlay.active .cu-glow-edge {
  animation: computer-use-glow-flow 6.4s linear infinite;
}

.computer-use-overlay.active .cu-cursor-ring {
  animation: computer-use-cursor-pulse 2.2s var(--ease-standard) infinite;
}

.cu-glow {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.cu-glow-edge {
  position: absolute;
  background: linear-gradient(
    90deg,
    transparent 0%,
    color-mix(in srgb, var(--aurora-green) 88%, #ffffff) 22%,
    var(--aurora-blue) 50%,
    color-mix(in srgb, var(--aurora-green) 72%, #ffffff) 78%,
    transparent 100%
  );
  background-size: 240% 100%;
  filter: blur(0.4px);
  opacity: 0.92;
  box-shadow:
    0 0 18px 5px color-mix(in srgb, var(--aurora-blue) 42%, transparent),
    0 0 42px 12px color-mix(in srgb, var(--aurora-green) 18%, transparent);
}

.cu-glow-edge.top,
.cu-glow-edge.bottom {
  left: 0;
  right: 0;
  height: 2px;
}

.cu-glow-edge.top {
  top: 0;
}

.cu-glow-edge.bottom {
  bottom: 0;
  transform: scaleX(-1);
}

.cu-glow-edge.left,
.cu-glow-edge.right {
  top: 0;
  bottom: 0;
  width: 2px;
  background: linear-gradient(
    180deg,
    transparent 0%,
    color-mix(in srgb, var(--aurora-green) 62%, #ffffff) 24%,
    var(--aurora-blue) 52%,
    color-mix(in srgb, var(--aurora-green) 48%, #ffffff) 78%,
    transparent 100%
  );
  background-size: 100% 240%;
}

.cu-glow-edge.left {
  left: 0;
}

.cu-glow-edge.right {
  right: 0;
  transform: scaleY(-1);
}

.cu-cursor-layer {
  position: absolute;
  inset: 0;
}

.cu-cursor {
  position: absolute;
  width: 30px;
  height: 30px;
  transform: translate(-50%, -50%);
  transition:
    left 42ms linear,
    top 42ms linear;
  pointer-events: none;
}

.cu-cursor-ring {
  position: absolute;
  inset: 0;
  border-radius: var(--radius-pill);
  border: 1.5px solid color-mix(in srgb, var(--aurora-blue) 82%, #ffffff);
  box-shadow:
    0 0 12px color-mix(in srgb, var(--aurora-blue) 58%, transparent),
    inset 0 0 8px color-mix(in srgb, var(--aurora-green) 44%, transparent);
}

.cu-cursor-dot {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 5px;
  height: 5px;
  margin: -2.5px 0 0 -2.5px;
  border-radius: var(--radius-pill);
  background: #ffffff;
  box-shadow: 0 0 8px color-mix(in srgb, var(--aurora-blue) 80%, transparent);
}

.cu-cursor-trail {
  position: absolute;
  width: 9px;
  height: 9px;
  border-radius: var(--radius-pill);
  background: radial-gradient(
    circle,
    color-mix(in srgb, var(--aurora-blue) 70%, #ffffff) 0%,
    transparent 72%
  );
  transform: translate(-50%, -50%);
  pointer-events: none;
  filter: blur(1.5px);
}

.cu-click-ripple {
  position: absolute;
  width: 16px;
  height: 16px;
  margin: -8px 0 0 -8px;
  border-radius: var(--radius-pill);
  border: 1.5px solid color-mix(in srgb, var(--aurora-green) 70%, #ffffff);
  animation: computer-use-click-ripple 560ms var(--ease-standard) forwards;
  pointer-events: none;
}

.computer-use-hud {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-4);
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-subtle);
  background: color-mix(in srgb, var(--bg-elevated, #1c1c1e) 78%, transparent);
  box-shadow: var(--shadow-2);
  backdrop-filter: blur(18px);
  color: var(--text-primary);
  font-size: var(--text-sm);
  opacity: 0;
  transform: translateY(4px);
  transition:
    opacity 180ms var(--ease-standard),
    transform 180ms var(--ease-standard);
}

.computer-use-hud.active {
  opacity: 1;
  transform: none;
}

.hud-dot {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: var(--radius-pill);
  background: var(--status-running);
  animation: computer-use-hud-heartbeat 1.8s var(--ease-standard) infinite;
}

.hud-dot.warn {
  background: var(--status-unread);
}

.hud-label {
  flex: 0 0 auto;
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-display);
}

.hud-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--text-secondary);
}

.hud-time {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-variant-numeric: var(--num-tabular);
  font-size: var(--text-xs);
}

@keyframes computer-use-glow-flow {
  0% {
    background-position: 0% 50%;
  }
  100% {
    background-position: 240% 50%;
  }
}

@keyframes computer-use-cursor-pulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 0.86;
  }
  50% {
    transform: scale(1.12);
    opacity: 1;
  }
}

@keyframes computer-use-click-ripple {
  0% {
    transform: scale(0.4);
    opacity: 0.9;
  }
  100% {
    transform: scale(3.4);
    opacity: 0;
  }
}

@keyframes computer-use-hud-heartbeat {
  0%,
  100% {
    opacity: 0.55;
    transform: scale(0.9);
  }
  50% {
    opacity: 1;
    transform: scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .computer-use-overlay.active .cu-glow-edge,
  .computer-use-overlay.active .cu-cursor-ring,
  .hud-dot,
  .cu-click-ripple {
    animation: none;
  }
  .cu-cursor {
    transition: none;
  }
}
</style>
