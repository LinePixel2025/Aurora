<script setup lang="ts">
/**
 * 轨迹容器（docs/07 §2.3 的「执行轨迹」）—— 一条助手消息的「思考 + 工具调用」收进
 * 同一个容器，三段式：
 *
 * 1. **摘要行 = 软胶囊**：`--fill-1` 底、无描边（悬停浮 `--fill-2`）、min-height 30px；
 *    运行中下缘一条 1px `aurora-shimmer` 亮带（轨迹里唯一的扫光，工具行那条是另一处）。
 * 2. **展开体**：左缘 1px 竖脊 + 节点圆点（节点自己画在行上），阅读顺序固定
 *    **思考 → 工具行 → 正文**；限高内滚 + 底缘渐隐。
 * 3. **开合 = grid `0fr ↔ 1fr`**（不是实测高度）：终点 `1fr` 每帧按当下内容现解，
 *    流式期间内容继续长也不会被裁掉；折叠态展开体**仍在 DOM 里**（`inert` + 零高轨道），
 *    探针在折叠态也要读得到块头与正文。
 */
import { computed, ref, watch } from 'vue'
import { ChevronRight, CircleCheck, CircleX } from '@aurora/shared/browser'

const props = defineProps<{
  /** 工具调用步数（摘要文案用） */
  steps: number
  failed: number
  running: boolean
  /** 本条消息的起止时刻（渲染层观测），用来算耗时 */
  startedAt?: number
  endedAt?: number
  /** 用户是否手动展开过（父级持有：自动折叠状态机在父级） */
  open: boolean
}>()

const emit = defineEmits<{ toggle: [] }>()

const scrollEl = ref<HTMLElement | null>(null)
const fadeBottom = ref(false)

const summary = computed(() => {
  const base = props.steps > 0 ? `已深度思考 · ${props.steps} 步` : '已深度思考'
  return props.failed > 0 ? `${base} · ${props.failed} 个失败` : base
})

/** 总用时：秒级一位小数（<10s），更久取整；没有起止时刻（旧历史）不显示。 */
const duration = computed(() => {
  const { startedAt, endedAt } = props
  if (startedAt === undefined || endedAt === undefined) return ''
  const seconds = Math.max(0, (endedAt - startedAt) / 1000)
  return `总用时 ${seconds < 0.1 ? '<0.1' : seconds.toFixed(1)}s`
})

/** 展开体限高内滚：滚动位置不在底部时给下缘渐隐（scrollHeight 读取按需，折叠态不读） */
function updateFade(): void {
  const el = scrollEl.value
  if (el === null) return
  fadeBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight > 4
}

watch(
  () => props.open,
  (open) => {
    if (open) window.requestAnimationFrame(updateFade)
  },
)
</script>

<template>
  <div
    class="trace"
    :class="{ open, running, 'is-collapsed': !open }"
    :data-field="running ? 'chat.trace-live' : 'chat.trace'"
  >
    <button
      type="button"
      class="trace-head"
      :class="{ shimmer: running }"
      :aria-expanded="open"
      data-action="chat.trace-toggle"
      @click="emit('toggle')"
    >
      <span v-if="running" class="trace-orbit spin" aria-hidden="true" />
      <CircleX
        v-else-if="failed > 0"
        class="trace-state t-error"
        :size="14"
        :stroke-width="1.8"
        aria-hidden="true"
      />
      <CircleCheck
        v-else
        class="trace-state t-ok"
        :size="14"
        :stroke-width="1.8"
        aria-hidden="true"
      />
      <span class="trace-summary" data-field="chat.trace-summary">{{ summary }}</span>
      <span class="grow" />
      <span v-if="duration !== ''" class="trace-duration">{{ duration }}</span>
      <ChevronRight class="trace-chevron" :size="13" :stroke-width="1.8" aria-hidden="true" />
    </button>

    <div class="trace-clip" :inert="!open">
      <div class="trace-body">
        <div
          ref="scrollEl"
          class="trace-scroll"
          :class="{ 'fade-bottom': fadeBottom }"
          @scroll.passive="updateFade"
        >
          <slot />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.trace {
  margin: var(--space-2) 0 var(--space-3);
}

.trace-head {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 30px;
  padding: 4px 10px;
  overflow: hidden;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--fill-1);
  color: var(--text-secondary);
  text-align: left;
  cursor: pointer;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.trace-head:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.trace.open > .trace-head {
  color: var(--text-primary);
}

.trace.running > .trace-head {
  color: var(--accent-text);
}

/* 运行中：胶囊下缘一条 1px 亮带（轨迹里唯一的扫光） */
.trace-head.shimmer::after {
  content: '';
  position: absolute;
  inset: auto 0 0;
  height: 1px;
  background: var(--aurora-gradient);
  animation: aurora-shimmer var(--dur-pulse) var(--ease-standard) infinite;
  pointer-events: none;
}

.trace-state.t-ok {
  color: color-mix(in srgb, var(--status-ok) 82%, var(--text-secondary));
}

.trace-state.t-error {
  color: var(--status-error);
}

.trace-orbit {
  position: relative;
  flex: 0 0 auto;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 1px solid color-mix(in srgb, var(--accent-text) 32%, transparent);
}

.trace-orbit::after {
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

.trace-summary {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
}

.grow {
  flex: 1 1 auto;
}

.trace-duration {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-variant-numeric: var(--num-tabular);
}

.trace-chevron {
  flex: 0 0 auto;
  width: 13px;
  height: 13px;
  transition: transform var(--transition-base);
}

.trace.open .trace-chevron {
  transform: rotate(90deg);
}

/* 开合 = grid 轨道过渡：终点 1fr 每帧现解，流式内容继续长也不裁。
   `grid-template-rows` 是布局级属性、每一帧都要重新排版轨道，先提一层合成提示
   （全站只此一处与右栏宽度那处，不铺开）。 */
.trace-clip {
  display: grid;
  grid-template-rows: 0fr;
  will-change: grid-template-rows;
  transition: grid-template-rows var(--dur-base) var(--ease-standard);
}

.trace.open > .trace-clip {
  grid-template-rows: 1fr;
}

.trace-body {
  position: relative;
  min-height: 0;
  overflow: hidden;
}

/* 左缘竖脊：节点圆点骑在它上面（行内 left: 4px、宽度 7px → 中心 7.5px） */
.trace-body::before {
  content: '';
  position: absolute;
  left: 7px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--border-subtle);
}

.trace-scroll {
  position: relative;
  max-height: min(45vh, 480px);
  overflow-y: auto;
  padding: var(--space-1) 0 var(--space-2);
}

.trace-scroll.fade-bottom {
  mask-image: linear-gradient(to bottom, #000 calc(100% - 28px), transparent 100%);
}

@media (max-width: 720px) {
  .trace-head {
    min-height: var(--hit-target);
  }
}
</style>
