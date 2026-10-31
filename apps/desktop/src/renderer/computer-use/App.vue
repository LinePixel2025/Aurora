<script setup lang="ts">
/**
 * Computer Use 浮层 / 操作过程面板（v39，docs/06 §28、docs/07 §7）。
 *
 * 同一个入口两种窗口：
 * - `layer=overlay`（每显示器一扇）：虚拟光标 + 四边流光 + 弥散光晕；
 *   每个动作到来时短暂增亮一档，表示 Agent 正在动手；
 * - `layer=hud`：**顶部**置顶的过程面板，逐条显示「正在做什么」（不显示坐标 / 尺寸 /
 *   输入文字），并把最近几步淡化列在下面。
 *
 * 两者都不接收鼠标（主进程已 `setIgnoreMouseEvents`），也不做内容保护
 *（远程桌面 / 屏幕共享下要能看见）。
 *
 * 光标位置由主进程推送：**这是 Agent 自己的光标**，只在动作层调用 `moveCursor()` 时
 * 沿轨迹移动；用户自己晃鼠标时光环停在原地（2026-10-31 起不再跟随真实指针）。
 * 第一次进入操作态时主进程用真实指针播一次种子，避免第一段滑动从屏幕角落飞出来。
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import type { ComputerUseEvent } from '@aurora/shared'
import { computerUseIcon, type ComputerUseStepView } from '../shared/computer-use-steps.js'

const query = new URLSearchParams(window.location.search)
const layer = query.get('layer') === 'hud' ? 'hud' : 'overlay'
const preview = query.has('preview')
const displayId = Number(query.get('displayId') ?? '')

/** 截图预览的固定过程（只用于 `?preview=1`；真实值来自主进程事件）。 */
const PREVIEW_STEPS: ComputerUseStepView[] = [
  { action: 'mouse.click', summary: '正在点击「保存」', count: 1 },
  { action: 'keyboard.type', summary: '正在输入文字（12 个字符）', count: 1 },
  { action: 'screen.capture', summary: '正在查看屏幕', count: 3 },
  { action: 'window.activate', summary: '正在切换到「记事本」', count: 1 },
]

const active = ref(preview)
const cursor = reactive({ x: 0, y: 0 })
const trail = ref<Array<{ x: number; y: number }>>([])
const ripple = ref<{ x: number; y: number; key: number } | null>(null)
/** 收到过光标位置才开始画：否则第一帧会在窗口左上角闪一个光环。 */
const hasCursor = ref(false)
/** 过程面板：新 → 旧。第一条是「这一步在干什么」。 */
const steps = ref<ComputerUseStepView[]>(preview ? PREVIEW_STEPS.map((step) => ({ ...step })) : [])
const hudTone = ref<'info' | 'warn'>('info')
const actions = ref(preview ? 7 : 0)
const maxSteps = ref(300)
const showCursor = ref(true)
const glow = ref(true)
/** 每个动作到来时短暂置 true，驱动流光增亮 / 当前步骤闪一下。 */
const pulsing = ref(false)
let trailTimer: ReturnType<typeof setTimeout> | undefined
let rippleTimer: ReturnType<typeof setTimeout> | undefined
let pulseTimer: ReturnType<typeof setTimeout> | undefined
let offEvent: (() => void) | null = null

const isHud = computed(() => layer === 'hud')
const currentStep = computed<ComputerUseStepView | undefined>(() => steps.value[0])
const currentText = computed(() => currentStep.value?.summary ?? '等待下一步…')
const currentIcon = computed(() => computerUseIcon(currentStep.value?.action))
/** 只保留最近两步：面板的目标是「这一步在干什么」，历史多了反而抢注意力。 */
const history = computed(() => steps.value.slice(1, 3))

function applyVisuals(settings: {
  computerUse?: { showVirtualCursor?: boolean; glow?: boolean; showHud?: boolean }
}): void {
  showCursor.value = settings.computerUse?.showVirtualCursor !== false
  glow.value = settings.computerUse?.glow !== false
  if (isHud.value && settings.computerUse?.showHud === false) active.value = false
}

function setCursor(x: number, y: number): void {
  hasCursor.value = true
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

/** 每来一个动作，让流光与当前步骤短暂增亮一档（视觉上「正在动手」）。 */
function pulse(): void {
  pulsing.value = true
  if (pulseTimer !== undefined) clearTimeout(pulseTimer)
  pulseTimer = setTimeout(() => {
    pulsing.value = false
  }, 900)
}

/**
 * 记一步。**连续**的同一 action + summary 合并成一条并累加 count（显示 ×N）；
 * 中间隔了别的步骤就保留为新的一条，不丢时间顺序（旧实现是全局去重，会把旧位置抹掉）。
 */
function pushStep(action: string, summary: string): void {
  const text = summary.trim()
  if (text === '') return
  const head = steps.value[0]
  if (head !== undefined && head.action === action && head.summary === text) {
    steps.value = [{ ...head, count: head.count + 1 }, ...steps.value.slice(1)]
    return
  }
  steps.value = [{ action, summary: text, count: 1 }, ...steps.value].slice(0, 4)
}

function onEvent(event: ComputerUseEvent): void {
  if (event.type === 'started') {
    if (!preview) active.value = true
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
    pulse()
    return
  }
  if (event.type === 'action') {
    pulse()
    if (!isHud.value) return
    pushStep(event.action, event.summary)
    actions.value = event.step
    maxSteps.value = event.maxSteps
    hudTone.value = 'info'
    return
  }
  if (event.type === 'notice') {
    if (!isHud.value) return
    pushStep('notice', event.text)
    hudTone.value = event.tone
  }
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
    actions.value = result.value.actions
    maxSteps.value = result.value.maxActions
    // 窗口加载期间可能已经发生了几步：用主进程的过程快照补历史，别让面板从空白开始。
    if (steps.value.length === 0 && result.value.recentActions !== undefined) {
      steps.value = result.value.recentActions
        .map((step) => ({ ...step, count: step.count ?? 1 }))
        .slice(0, 4)
    }
  })
})

onUnmounted(() => {
  offEvent?.()
  offEvent = null
  if (trailTimer !== undefined) clearTimeout(trailTimer)
  if (rippleTimer !== undefined) clearTimeout(rippleTimer)
  if (pulseTimer !== undefined) clearTimeout(pulseTimer)
})
</script>

<template>
  <div
    v-if="isHud"
    class="computer-use-hud"
    :class="{ active, pulsing }"
    data-field="computer-use.hud"
    aria-hidden="true"
  >
    <header class="hud-head">
      <span class="hud-dot" :class="hudTone" />
      <span class="hud-title" data-field="computer-use.hud-title">正在操作</span>
      <span class="hud-count">{{ actions > 0 ? `${actions} / ${maxSteps}` : '准备中' }}</span>
    </header>
    <div class="hud-current">
      <component
        :is="currentIcon"
        class="hud-current-icon"
        :size="15"
        :stroke-width="1.9"
        aria-hidden="true"
      />
      <span class="hud-current-text" data-field="computer-use.hud-text">{{ currentText }}</span>
      <span v-if="(currentStep?.count ?? 1) > 1" class="hud-repeat">
        {{ currentStep?.count }}×
      </span>
    </div>
    <ol v-if="history.length > 0" class="hud-history">
      <li
        v-for="(item, index) in history"
        :key="`${item.action}-${index}`"
        class="hud-history-item"
        data-field="computer-use.hud-step"
      >
        <component
          :is="computerUseIcon(item.action)"
          class="hud-history-icon"
          :size="12"
          :stroke-width="1.8"
          aria-hidden="true"
        />
        <span class="hud-history-text">{{ item.summary }}</span>
        <span v-if="item.count > 1" class="hud-repeat">{{ item.count }}×</span>
      </li>
    </ol>
    <p v-else class="hud-empty">等待下一步…</p>
  </div>

  <div
    v-else
    class="computer-use-overlay"
    :class="{ active, pulsing }"
    data-field="computer-use.root"
    aria-hidden="true"
  >
    <div v-if="glow" class="cu-glow" data-field="computer-use.glow">
      <span class="cu-glow-band" data-field="computer-use.glow-band">
        <span class="cu-glow-bloom" />
        <span class="cu-glow-halo" />
        <span class="cu-glow-line" />
      </span>
    </div>

    <div v-if="showCursor && hasCursor" class="cu-cursor-layer" data-field="computer-use.cursor">
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

.computer-use-overlay.active .cu-cursor-ring {
  animation: computer-use-cursor-pulse 2.2s var(--ease-standard) infinite;
}

/*
 * 流光：与「流光提醒」（banner/GlowBand.vue）**同款**的顶部光谱光带。
 * 品红 → 紫罗兰 → 强调色 → 青 → 琥珀，每层经 color-mix 压到低不透明度 + 大半径模糊，
 * 呈「液态弥散光」而不是硬边彩带；只在屏幕顶端，不再画四边细线。
 * 类名 / 关键帧仍用 computer-use-* 前缀，避免与 banner-glow / awareness-glow 的探针互相误命中。
 */
.cu-glow {
  --cu-rose: #ff6b9d;
  --cu-violet: #bc82f3;
  --cu-cyan: #56d8ff;
  --cu-amber: #ffb347;
  --cu-accent: var(--aurora-blue, #0a84ff);
  --cu-soft: color-mix(in srgb, var(--cu-accent) 42%, #ffffff);
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  opacity: 0;
  transform: translate3d(0, -6px, 0) scaleX(0.94) scaleY(0.9);
  transform-origin: 50% 0;
  transition:
    opacity 320ms var(--ease-standard),
    transform 560ms var(--ease-spring),
    filter 180ms var(--ease-standard);
  will-change: opacity, transform;
}

.computer-use-overlay.active .cu-glow {
  opacity: 1;
  transform: none;
}

.cu-glow-band {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 64px;
  pointer-events: none;
}

.cu-glow-band > span {
  position: absolute;
  top: 0;
  left: -6%;
  width: 112%;
  pointer-events: none;
}

/* Bloom：宽幅弥散光谱底色（大半径模糊 = 液态感） */
.cu-glow-bloom {
  height: 54px;
  background:
    radial-gradient(
      ellipse 32% 90% at 10% 0%,
      color-mix(in srgb, var(--cu-rose) 26%, transparent),
      transparent 72%
    ),
    radial-gradient(
      ellipse 38% 100% at 32% 0%,
      color-mix(in srgb, var(--cu-violet) 30%, transparent),
      transparent 74%
    ),
    radial-gradient(
      ellipse 44% 104% at 52% 0%,
      color-mix(in srgb, var(--cu-accent) 32%, transparent),
      transparent 74%
    ),
    radial-gradient(
      ellipse 36% 96% at 72% 0%,
      color-mix(in srgb, var(--cu-cyan) 28%, transparent),
      transparent 72%
    ),
    radial-gradient(
      ellipse 28% 88% at 90% 0%,
      color-mix(in srgb, var(--cu-amber) 22%, transparent),
      transparent 70%
    );
  filter: blur(26px);
  opacity: 0.62;
  animation: computer-use-glow-breathe 9s ease-in-out -1.8s infinite;
}

/* Halo：主光谱流带（色相沿顶边流转） */
.cu-glow-halo {
  height: 46px;
  background:
    linear-gradient(
      100deg,
      color-mix(in srgb, var(--cu-rose) 28%, transparent) 0%,
      color-mix(in srgb, var(--cu-violet) 34%, transparent) 14%,
      color-mix(in srgb, var(--cu-accent) 36%, transparent) 30%,
      color-mix(in srgb, var(--cu-cyan) 34%, transparent) 46%,
      color-mix(in srgb, var(--cu-soft) 36%, transparent) 58%,
      color-mix(in srgb, var(--cu-accent) 30%, transparent) 70%,
      color-mix(in srgb, var(--cu-amber) 26%, transparent) 86%,
      color-mix(in srgb, var(--cu-rose) 22%, transparent) 100%
    ),
    repeating-linear-gradient(
      94deg,
      transparent 0 15%,
      rgb(255 255 255 / 5%) 16% 20%,
      transparent 22% 38%
    );
  background-size: 200% 100%;
  background-repeat: repeat-x;
  filter: blur(6px);
  opacity: 0.88;
  -webkit-mask-image: linear-gradient(180deg, #000 0%, #000 60%, transparent 100%);
  mask-image: linear-gradient(180deg, #000 0%, #000 60%, transparent 100%);
  animation: computer-use-glow-spectrum 16s linear infinite;
}

/* Line：贴着屏幕第 0 像素的高光带（保证顶边没有空隙） */
.cu-glow-line {
  height: 3px;
  background: linear-gradient(
    100deg,
    color-mix(in srgb, var(--cu-rose) 46%, transparent) 0%,
    color-mix(in srgb, var(--cu-violet) 52%, transparent) 20%,
    color-mix(in srgb, var(--cu-soft) 60%, transparent) 38%,
    color-mix(in srgb, var(--cu-cyan) 50%, transparent) 58%,
    color-mix(in srgb, var(--cu-accent) 52%, transparent) 76%,
    color-mix(in srgb, var(--cu-amber) 40%, transparent) 100%
  );
  background-size: 220% 100%;
  filter: blur(1.5px);
  opacity: 0.9;
  animation: computer-use-glow-spectrum 9.6s linear infinite reverse;
}

/* 每个动作到来时整体增亮一档：用户能看出「刚刚这一步真的执行了」 */
.computer-use-overlay.pulsing .cu-glow {
  filter: brightness(1.24) saturate(1.08);
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

/*
 * 顶部操作过程面板：窗口就是卡片本身（560×116），透明区不拦截鼠标。
 *
 * 设计目标是「安静的状态仪器」而不是聊天卡：
 * - 只留三层信息：状态行 / 当前步骤 / 最近两步；没有分隔线、没有色块；
 * - 唯一的签名元素是贴顶的一条 1px 光谱细线（与屏幕流光同源，不抢注意力）；
 * - 底色用 `--bg-overlay`（浅色档近白、深色档深灰），**不能用不存在的 `--bg-elevated`**
 *   （那个 fallback 是写死的深色，浅色主题下会变成黑板）。
 */
.computer-use-hud {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  padding: 13px 18px 12px;
  border-radius: 18px;
  border: 1px solid color-mix(in srgb, var(--text-primary) 9%, transparent);
  background: color-mix(in srgb, var(--bg-overlay) 88%, transparent);
  box-shadow:
    0 14px 36px -24px color-mix(in srgb, #000 45%, transparent),
    inset 0 1px 0 color-mix(in srgb, #fff 24%, transparent);
  backdrop-filter: blur(24px) saturate(1.4);
  -webkit-backdrop-filter: blur(24px) saturate(1.4);
  color: var(--text-primary);
  overflow: hidden;
  opacity: 0;
  transform: translateY(-5px) scale(0.992);
  transform-origin: 50% 0;
  transition:
    opacity 200ms var(--ease-standard),
    transform 240ms var(--ease-standard),
    border-color 240ms var(--ease-standard);
}

/* 签名：贴着卡片顶边的一缕光谱，和屏幕顶部的流光呼应 */
.computer-use-hud::before {
  content: '';
  position: absolute;
  top: 0;
  left: 24px;
  right: 24px;
  height: 1px;
  background: linear-gradient(
    90deg,
    transparent 0%,
    color-mix(in srgb, var(--aurora-blue) 55%, transparent) 32%,
    color-mix(in srgb, var(--aurora-green) 45%, transparent) 68%,
    transparent 100%
  );
  opacity: 0.5;
  pointer-events: none;
}

.computer-use-hud.active {
  opacity: 1;
  transform: none;
}

.computer-use-hud.pulsing {
  border-color: color-mix(in srgb, var(--aurora-blue) 30%, transparent);
}

.hud-head {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
  height: 16px;
}

.hud-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: var(--radius-pill);
  background: var(--status-running);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--status-running) 12%, transparent);
  animation: computer-use-hud-heartbeat 2s var(--ease-standard) infinite;
}

.hud-dot.warn {
  background: var(--status-unread);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--status-unread) 14%, transparent);
}

.hud-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  letter-spacing: 0.01em;
}

.hud-count {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-variant-numeric: var(--num-tabular);
  font-size: 10.5px;
  letter-spacing: 0.02em;
}

.hud-current {
  margin: 8px 0 0;
  flex: 0 0 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--text-primary);
}

.hud-current-icon {
  flex: 0 0 auto;
  color: var(--aurora-blue);
}

.hud-current-text {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  line-height: 1.3;
  letter-spacing: -0.01em;
}

.computer-use-hud.pulsing .hud-current {
  animation: computer-use-hud-step-flash 720ms var(--ease-standard);
}

.hud-repeat {
  flex: 0 0 auto;
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: var(--fill-1);
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: var(--num-tabular);
  line-height: 16px;
}

.hud-history {
  margin: 6px 0 0;
  padding: 0;
  flex: 0 0 auto;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
  overflow: hidden;
}

.hud-history-item {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.45;
  opacity: 0.82;
}

.hud-history-icon {
  flex: 0 0 auto;
  color: var(--text-muted);
}

.hud-history-text {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.hud-history-item:nth-child(2) {
  opacity: 0.62;
}

.hud-empty {
  margin: 6px 0 0;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.45;
}

@keyframes computer-use-glow-breathe {
  0%,
  100% {
    opacity: 0.5;
    transform: translate3d(-1.5%, 0, 0) scaleX(1.02) scaleY(0.96);
  }
  50% {
    opacity: 0.78;
    transform: translate3d(1.5%, 1px, 0) scaleX(0.99) scaleY(1.05);
  }
}

@keyframes computer-use-glow-spectrum {
  from {
    background-position: 0% 0;
  }
  to {
    background-position: 200% 0;
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

@keyframes computer-use-hud-step-flash {
  0% {
    color: var(--aurora-blue);
    text-shadow: 0 0 12px color-mix(in srgb, var(--aurora-blue) 65%, transparent);
  }
  100% {
    color: var(--text-primary);
    text-shadow: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .computer-use-overlay.active .cu-cursor-ring,
  .cu-glow-bloom,
  .cu-glow-halo,
  .cu-glow-line,
  .hud-dot,
  .hud-current,
  .cu-click-ripple {
    animation: none;
  }
  .cu-cursor {
    transition: none;
  }
}
</style>
