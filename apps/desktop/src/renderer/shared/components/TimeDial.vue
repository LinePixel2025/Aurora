<script setup lang="ts">
/**
 * 时间轮盘：字段行一枚触发器按钮，点击弹出锚定其下方的钟面弹层（见 docs/07 §2.5）。
 *
 * - modelValue 为 "HH:mm" 或 null / 空串（未设置）；仅在「确定」「清除」时 emit，
 *   取消 / Esc / 点外部 / 滚动一律关闭不落盘。
 * - clearable 时弹层提供「清除」（emit null）；课程表节次等必填时刻不开启。
 * - disabled 只作用于触发器（与既有输入框的禁用口径一致，智慧提醒区组 dormant 用）。
 * - 钟面：小时模式外圈 24 刻度（每 15°），分钟模式 12 个 5 分钟刻度、拖动按 1 分钟步进；
 *   选完小时自动切分钟，顶部两段数字可点切换。
 */
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { Clock } from '@aurora/shared/browser'
import AppButton from './AppButton.vue'

const props = withDefaults(
  defineProps<{
    modelValue: string | null
    /** 未设置时触发器上显示的示例时刻（沿用各字段原来的 placeholder 口径） */
    placeholder?: string
    disabled?: boolean
    /** 提供弹层「清除」按钮（emit null） */
    clearable?: boolean
    ariaLabel?: string
  }>(),
  { placeholder: '', disabled: false, clearable: false, ariaLabel: '' },
)

const emit = defineEmits<{ 'update:modelValue': [value: string | null] }>()

const TIME_PATTERN = /^(\d{1,2}):(\d{2})$/

function parseTime(value: string | null): { hour: number; minute: number } | null {
  if (value === null) return null
  const match = TIME_PATTERN.exec(value.trim())
  if (match === null) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

const open = ref(false)
const mode = ref<'hour' | 'minute'>('hour')
const draftHour = ref(0)
const draftMinute = ref(0)
const dragging = ref(false)

const trigger = ref<HTMLButtonElement | null>(null)
const popover = ref<HTMLElement | null>(null)
const face = ref<SVGSVGElement | null>(null)
/** 首帧先量再显（ready 门控），避免弹层在 (0,0) 闪一下 */
const pos = ref({ left: 0, top: 0, ready: false })

const hasValue = computed(() => parseTime(props.modelValue) !== null)
const displayValue = computed(() => (hasValue.value ? (props.modelValue ?? '') : ''))
const display = computed(() => `${pad2(draftHour.value)}:${pad2(draftMinute.value)}`)

// ───────────────────────── 钟面几何 ─────────────────────────

const DIAL_SIZE = 216
const CENTER = DIAL_SIZE / 2
const NUM_R = 88
const POINTER_INNER = 26

/** 0° = 正上方（0 / 00 分），顺时针增长 */
function polar(radius: number, angleDeg: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180
  return { x: CENTER + radius * Math.sin(rad), y: CENTER - radius * Math.cos(rad) }
}

const hourMarks = computed(() =>
  Array.from({ length: 24 }, (_, hour) => ({
    hour,
    ...polar(NUM_R, hour * 15),
    active: hour === draftHour.value,
  })),
)

const minuteMarks = computed(() =>
  Array.from({ length: 12 }, (_, index) => {
    const minute = index * 5
    return { minute, ...polar(NUM_R, minute * 6), active: minute === draftMinute.value }
  }),
)

const pointerAngle = computed(() =>
  mode.value === 'hour' ? draftHour.value * 15 : draftMinute.value * 6,
)
const pointerStart = computed(() => polar(POINTER_INNER, pointerAngle.value))
const pointerEnd = computed(() => polar(NUM_R, pointerAngle.value))

// ───────────────────────── 开合与定位 ─────────────────────────

function place(): void {
  const triggerEl = trigger.value
  const popEl = popover.value
  if (triggerEl === null || popEl === null) return
  const rect = triggerEl.getBoundingClientRect()
  const width = popEl.offsetWidth
  const height = popEl.offsetHeight
  const margin = 6
  const left = Math.min(Math.max(rect.left, 8), Math.max(window.innerWidth - width - 8, 8))
  const below = rect.bottom + margin
  const top =
    below + height <= window.innerHeight - 8 ? below : Math.max(rect.top - height - margin, 8)
  pos.value = { left: Math.round(left), top: Math.round(top), ready: true }
}

function openPopover(): void {
  if (props.disabled || open.value) return
  const parsed = parseTime(props.modelValue)
  const now = new Date()
  draftHour.value = parsed?.hour ?? now.getHours()
  draftMinute.value = parsed?.minute ?? now.getMinutes()
  mode.value = 'hour'
  pos.value = { left: 0, top: 0, ready: false }
  open.value = true
  bindGlobal()
  void nextTick(() => {
    place()
    popover.value?.focus({ preventScroll: true })
  })
}

function close(): void {
  if (!open.value) return
  open.value = false
  unbindGlobal()
  trigger.value?.focus({ preventScroll: true })
}

function confirm(): void {
  emit('update:modelValue', display.value)
  close()
}

function clear(): void {
  emit('update:modelValue', null)
  close()
}

// ───────────────────────── 全局监听（外部点击 / Esc / 滚动关闭） ─────────────────────────

function onDocPointerDown(event: PointerEvent): void {
  const target = event.target
  if (!(target instanceof Node)) return
  if (popover.value?.contains(target)) return
  if (trigger.value?.contains(target)) return
  close()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.stopPropagation()
  close()
}

function onScrollOrResize(): void {
  close()
}

function bindGlobal(): void {
  document.addEventListener('pointerdown', onDocPointerDown, true)
  window.addEventListener('keydown', onKeydown, true)
  window.addEventListener('scroll', onScrollOrResize, true)
  window.addEventListener('resize', onScrollOrResize)
}

function unbindGlobal(): void {
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('scroll', onScrollOrResize, true)
  window.removeEventListener('resize', onScrollOrResize)
}

onBeforeUnmount(unbindGlobal)

// ───────────────────────── 表盘取值（点击 / 拖动） ─────────────────────────

function angleFromEvent(event: PointerEvent): number {
  const faceEl = face.value
  if (faceEl === null) return 0
  const rect = faceEl.getBoundingClientRect()
  const dx = event.clientX - (rect.left + rect.width / 2)
  const dy = event.clientY - (rect.top + rect.height / 2)
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI
  return (deg + 360) % 360
}

function applyPointer(event: PointerEvent): void {
  const angle = angleFromEvent(event)
  if (mode.value === 'hour') {
    draftHour.value = Math.round(angle / 15) % 24
  } else {
    draftMinute.value = Math.round(angle / 6) % 60
  }
}

function onFaceDown(event: PointerEvent): void {
  if (event.button !== 0) return
  dragging.value = true
  ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
  applyPointer(event)
}

function onFaceMove(event: PointerEvent): void {
  if (!dragging.value) return
  applyPointer(event)
}

function onFaceUp(event: PointerEvent): void {
  if (!dragging.value) return
  dragging.value = false
  applyPointer(event)
  if (mode.value === 'hour') mode.value = 'minute'
}

function setMode(next: 'hour' | 'minute'): void {
  mode.value = next
}
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="dial-trigger"
    data-dial-trigger
    :disabled="disabled"
    :aria-label="ariaLabel || undefined"
    aria-haspopup="dialog"
    :aria-expanded="open"
    @click="openPopover"
  >
    <Clock class="dial-icon" :size="14" :stroke-width="1.6" aria-hidden="true" />
    <span class="dial-text" :class="{ empty: !hasValue }">{{
      hasValue ? displayValue : placeholder
    }}</span>
  </button>

  <Teleport to="body">
    <div
      v-if="open"
      ref="popover"
      class="dial-popover"
      data-dial-popover
      role="dialog"
      :aria-label="ariaLabel || undefined"
      :class="{ ready: pos.ready }"
      :style="{ left: `${pos.left}px`, top: `${pos.top}px` }"
      tabindex="-1"
    >
      <div class="dial-display">
        <button
          type="button"
          class="seg"
          :class="{ active: mode === 'hour' }"
          @click="setMode('hour')"
        >
          {{ pad2(draftHour) }}
        </button>
        <span class="colon">:</span>
        <button
          type="button"
          class="seg"
          :class="{ active: mode === 'minute' }"
          @click="setMode('minute')"
        >
          {{ pad2(draftMinute) }}
        </button>
      </div>

      <svg
        ref="face"
        class="dial-face"
        data-dial-face
        :data-dial-face-mode="mode"
        :width="DIAL_SIZE"
        :height="DIAL_SIZE"
        :viewBox="`0 0 ${DIAL_SIZE} ${DIAL_SIZE}`"
        @pointerdown="onFaceDown"
        @pointermove="onFaceMove"
        @pointerup="onFaceUp"
      >
        <circle class="face-ring" :cx="CENTER" :cy="CENTER" :r="NUM_R" />
        <template v-if="mode === 'hour'">
          <g v-for="mark in hourMarks" :key="mark.hour">
            <circle v-if="mark.active" class="mark-pill" :cx="mark.x" :cy="mark.y" r="12" />
            <text
              class="dial-num"
              :class="{ active: mark.active }"
              :x="mark.x"
              :y="mark.y"
              dy="3.5"
            >
              {{ mark.hour }}
            </text>
          </g>
        </template>
        <template v-else>
          <g v-for="mark in minuteMarks" :key="mark.minute">
            <circle v-if="mark.active" class="mark-pill" :cx="mark.x" :cy="mark.y" r="12" />
            <text
              class="dial-num"
              :class="{ active: mark.active }"
              :x="mark.x"
              :y="mark.y"
              dy="3.5"
            >
              {{ pad2(mark.minute) }}
            </text>
          </g>
        </template>
        <line
          class="pointer"
          :x1="pointerStart.x"
          :y1="pointerStart.y"
          :x2="pointerEnd.x"
          :y2="pointerEnd.y"
        />
        <circle class="pointer-dot" :cx="pointerEnd.x" :cy="pointerEnd.y" r="4.5" />
        <circle class="hub" :cx="CENTER" :cy="CENTER" r="2.5" />
      </svg>

      <div class="dial-actions">
        <AppButton v-if="clearable" size="sm" variant="ghost" @click="clear">清除</AppButton>
        <span class="spacer" />
        <AppButton size="sm" variant="ghost" @click="close">取消</AppButton>
        <AppButton size="sm" variant="primary" @click="confirm">确定</AppButton>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 触发器：对齐 SettingField 里输入框的外观（36px / --fill-1 / 紧聚焦环） */
.dial-trigger {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  max-width: 220px;
  height: 36px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--text-sm);
  font-variant-numeric: var(--num-tabular);
  outline: none;
  cursor: pointer;
  transition:
    border-color var(--transition-fast),
    box-shadow var(--transition-fast),
    background var(--transition-fast);
}

.dial-trigger:hover:not(:disabled) {
  border-color: var(--border-strong);
}

.dial-trigger:focus-visible {
  border-color: var(--aurora-blue);
  background: var(--fill-2);
  box-shadow: 0 0 0 1px var(--accent-ring);
}

.dial-trigger:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.dial-icon {
  flex: none;
  color: var(--text-muted);
}

.dial-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dial-text.empty {
  color: var(--text-muted);
}

/* 弹层：锚定触发器下方（放不下翻转上方），首帧量好再显 */
.dial-popover {
  position: fixed;
  z-index: var(--z-popover);
  width: 264px;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--glass-border-soft);
  background: var(--bg-overlay);
  box-shadow: var(--shadow-2);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  opacity: 0;
  pointer-events: none;
}

.dial-popover.ready {
  opacity: 1;
  pointer-events: auto;
}

.dial-popover:focus {
  outline: none;
}

.dial-display {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
}

.seg {
  border: none;
  background: none;
  padding: 0 var(--space-1);
  border-radius: var(--radius-xs);
  font: inherit;
  font-size: 28px;
  font-weight: var(--weight-semibold);
  font-variant-numeric: var(--num-tabular);
  color: var(--text-muted);
  cursor: pointer;
  transition: color var(--transition-fast);
}

.seg.active {
  color: var(--aurora-blue);
}

.colon {
  color: var(--text-muted);
  font-size: 22px;
  font-variant-numeric: var(--num-tabular);
}

.dial-face {
  touch-action: none;
  cursor: pointer;
  user-select: none;
}

.face-ring {
  fill: none;
  stroke: var(--border-subtle);
  stroke-width: 1;
}

.mark-pill {
  fill: var(--aurora-blue);
}

.dial-num {
  fill: var(--text-secondary);
  font-size: 11px;
  font-variant-numeric: var(--num-tabular);
  text-anchor: middle;
  pointer-events: none;
}

.dial-num.active {
  fill: var(--on-accent);
  font-weight: var(--weight-semibold);
}

.pointer {
  stroke: var(--aurora-blue);
  stroke-width: 2;
  stroke-linecap: round;
}

.pointer-dot {
  fill: var(--aurora-blue);
}

.hub {
  fill: var(--text-muted);
}

.dial-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
}

.spacer {
  flex: 1;
}
</style>
