<script setup lang="ts">
/**
 * 思考块（docs/07 §2.3）—— 轨迹容器的**第一个节点**，与桌面端同一套语言：
 *
 * - 块头恒为「已深度思考」（不随状态漂移，探针按这段文字取锚点）+ 流式秒数；
 * - 流式期间：轨道点（公转）+ 块头强调色 + 正文尾部光标；
 * - 正文 `max-height: 220px` 内滚，流式增量到达时 rAF 合并后**贴底跟随**
 *   （24px 接管阈值：用户主动上滚就交还控制权，回到阈值内自动恢复）；
 * - 开合走 `fade`（内容仍在生长，实测高度动画对它不适用）。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ChevronRight } from '@aurora/shared/browser'

const props = defineProps<{
  reasoning: string
  streaming: boolean
  /** 该轮思考结束时刻（毫秒）；流式期间用来走秒 */
  lastAt?: number
}>()

const open = ref(false)
const textEl = ref<HTMLElement | null>(null)
const follow = ref(true)
const seconds = ref(0)

/** 接管阈值：距底 ≤ 24px 视为"还在跟随" */
const FOLLOW_THRESHOLD = 24

const label = '已深度思考'

let secondsTimer: number | undefined
let followFrame: number | undefined
let startedAt = 0

function stopSeconds(): void {
  if (secondsTimer !== undefined) {
    window.clearInterval(secondsTimer)
    secondsTimer = undefined
  }
}

function startSeconds(): void {
  stopSeconds()
  startedAt = Date.now()
  seconds.value = 0
  secondsTimer = window.setInterval(() => {
    seconds.value = Math.max(0, (Date.now() - startedAt) / 1000)
  }, 200)
}

/**
 * 流式跟随：只在"跟随态"贴底。读 scrollHeight 会触发重排，所以按帧合并。
 * 用户主动上滚（scroll 后距底超过阈值）立刻交还控制权，不再抢回。
 */
function scheduleFollow(): void {
  if (followFrame !== undefined) return
  followFrame = window.requestAnimationFrame(() => {
    followFrame = undefined
    const el = textEl.value
    if (el === null || !props.streaming || !follow.value) return
    el.scrollTop = el.scrollHeight
  })
}

function onScroll(): void {
  const el = textEl.value
  if (el === null) return
  follow.value = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD
}

watch(
  () => props.streaming,
  (streaming) => {
    if (streaming) {
      startSeconds()
      open.value = true
      follow.value = true
      scheduleFollow()
    } else {
      stopSeconds()
      if (props.lastAt !== undefined) seconds.value = Math.max(0, (props.lastAt - startedAt) / 1000)
    }
  },
  { immediate: true },
)

watch(
  () => props.reasoning,
  () => {
    if (props.streaming) scheduleFollow()
  },
)

onBeforeUnmount(() => {
  stopSeconds()
  if (followFrame !== undefined) window.cancelAnimationFrame(followFrame)
})

/** 秒数展示：整秒足够（<10s 保留一位小数，避免刚开头一直显示 0s） */
const secondsText = computed(() => {
  const value = seconds.value
  return value < 10 ? `${value.toFixed(1)}s` : `${Math.round(value)}s`
})

function toggle(): void {
  open.value = !open.value
  if (open.value) void nextTick(() => scheduleFollow())
}

defineExpose({ open })
</script>

<template>
  <div
    class="thinking"
    :class="{ open, streaming }"
    :data-field="streaming ? 'chat.thinking-live' : undefined"
  >
    <button
      type="button"
      class="thinking-head"
      :aria-expanded="open"
      data-action="chat.thinking-toggle"
      @click="toggle"
    >
      <span v-if="streaming" class="think-orbit spin" aria-hidden="true" />
      <span class="thinking-label" data-field="chat.thinking-label">{{ label }}</span>
      <span v-if="streaming" class="thinking-elapsed">{{ secondsText }}</span>
      <span class="grow" />
      <ChevronRight class="chevron" :size="13" :stroke-width="1.8" aria-hidden="true" />
    </button>

    <Transition name="fade">
      <div v-if="open" class="thinking-body" data-field="chat.thinking-body">
        <p
          ref="textEl"
          class="thinking-text"
          data-field="chat.thinking-text"
          @scroll.passive="onScroll"
        >
          {{ reasoning
          }}<span v-if="streaming" class="streaming-caret thinking-caret" aria-hidden="true" />
        </p>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.thinking {
  position: relative;
  padding-left: 20px;
}

/* 节点圆点：与工具行同几何（7px，骑在竖脊上） */
.thinking::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 10.5px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-muted);
  box-shadow: 0 0 0 3px var(--bg-base);
  transition: background var(--transition-fast);
}

.thinking.streaming::before {
  background: var(--status-running);
}

.thinking-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 28px;
  padding: 4px var(--space-2) 4px 2px;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-muted);
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.thinking-head:hover {
  background: var(--fill-1);
  color: var(--text-secondary);
}

.thinking.streaming > .thinking-head {
  color: var(--accent-text);
}

.thinking.open > .thinking-head > .chevron {
  transform: rotate(90deg);
}

.think-orbit {
  display: inline-block;
  position: relative;
  flex: 0 0 auto;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 1px solid color-mix(in srgb, var(--accent-text) 32%, transparent);
}

.think-orbit::after {
  content: '';
  position: absolute;
  top: -1px;
  left: 50%;
  width: 3px;
  height: 3px;
  margin-left: -1.5px;
  border-radius: 50%;
  background: var(--accent-text);
}

.thinking-label {
  flex: 0 0 auto;
  font-size: var(--text-xs);
}

.thinking-elapsed {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-variant-numeric: var(--num-tabular);
}

.grow {
  flex: 1 1 auto;
}

.chevron {
  flex: 0 0 auto;
  color: var(--text-muted);
  transition: transform var(--transition-base);
}

.thinking-body {
  position: relative;
  padding: 2px 0 var(--space-1);
}

.thinking-text {
  margin: 0;
  max-height: 220px;
  overflow-y: auto;
  color: var(--text-muted);
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
  white-space: pre-wrap;
  word-break: break-word;
}

.thinking-caret {
  color: var(--accent-text);
}

@media (max-width: 720px) {
  .thinking-head {
    min-height: var(--hit-target);
  }
}
</style>
