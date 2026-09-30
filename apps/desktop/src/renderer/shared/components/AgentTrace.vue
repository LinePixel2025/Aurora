<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { ChevronRight, CircleCheck, CircleX } from '../icons.js'

/**
 * **Agent 执行轨迹**（2026-10-01 视觉重塑：软胶囊 + 时间线，docs/07 §2.3 / §5.2）。
 *
 * 2026-09-30 那版「无盒子一行」的折叠态 affordance 近零（一条灰字 + 上下发丝线不像可点控件），
 * 本版收成**软胶囊**：
 *
 * - **折叠态 = 软胶囊**：`--fill-1` 底 + `--radius-sm` 圆角，无描边（悬停浮 `--fill-2`）。
 *   从左到右：状态图标（运行 = 公转点 / 完成 = `CircleCheck` / 有失败 = `CircleX`）→
 *   摘要文案 → 右侧耗时（可选）→ chevron；
 * - **展开态 = 左缘连续竖脊 + 节点圆点**：竖脊画在展开体上（`::before`），
 *   工具行的节点圆点骑在竖脊上（见 `AgentToolRow` 的 `.tool-card::before`），
 *   于是"思考 → 第 1 步 → 第 2 步 → …"读起来是一条时间线；
 * - **展开 / 收起走 grid `0fr ↔ 1fr` 高度过渡**（`--dur-base`）：终点是 `1fr` ——
 *   **每一帧都按当下内容现解**，流式期间内容再长也不会被裁掉（实测高度动画的病根是
 *   「终点在动画开始那一刻量定」，grid 方案不量高度、从根上避开，docs/07 §5.2 硬约定②）；
 *   `prefers-reduced-motion` 降级为瞬时。**展开体常驻 DOM**：折叠只是 grid 轨道收成 0，
 *   `.thinking` / `.tool-card` 这些探针锚点在折叠态仍查得到（这一条自 2026-09-30 起是硬契约），
 *   `inert` 让"整块被折叠"对辅助技术显式；
 * - **展开体限高内滚**：`max-height: min(45vh, 480px)` —— 几十步的历史不再把整页撑爆，
 *   超出部分在块内滚动；可滚动且未滚到底时底部渐隐（`fade-bottom`），提示"下面还有"。
 *   流式期间的**块内跟随**与思考块同一口径：内容生长时只在"仍在底部"时跟到最新一行，
 *   用户在块内上滚即接管，滚回底部自动恢复 —— 绝不拽正在回看的人。
 *
 * 组件只负责"折叠态 / 展开态的呈现"，**不持有业务状态**：
 * `open` 由 `MessageList` 的 `traceOpen(message)` 决定（历史水合默认折叠、流式期间展开、
 * 请求结束自动收起），点击只往上发一个 `toggle`。
 */
const props = withDefaults(
  defineProps<{
    /** 展开态（`MessageList` 的 `traceOpen(message)`） */
    open?: boolean
    /** 折叠态那一行摘要（如「已深度思考 · 3 步」，由 `MessageList` 按消息内容算） */
    summary?: string
    /** 是否仍在运行（流式思考中，或还有工具在跑）：决定状态图标与胶囊下缘扫光 */
    running?: boolean
    /** 这条轨迹里有没有失败的工具调用：决定终态图标给绿勾还是红叉 */
    failed?: boolean
    /** 本条轨迹的耗时文案（渲染层计时合计；历史水合的行是空串，不伪造） */
    duration?: string
  }>(),
  { open: false, summary: '执行轨迹', running: false, failed: false, duration: '' },
)

const emit = defineEmits<{
  /** 点击摘要行：由父级翻转 `traceOpen(message)` 并在跟随态下重新贴底 */
  (event: 'toggle'): void
}>()

// ────────── 展开体的限高内滚：渐隐 + 流式期间的块内跟随 ──────────

/** 内层滚动容器（`.trace-scroll`）；展开那一帧才量得到，`watch(open)` 里 nextTick 后更新 */
const scrollEl = ref<HTMLElement | null>(null)
/** 内容是否超出限高（决定要不要渐隐） */
const scrollable = ref(false)
/** 是否已滚到底（到底就不渐隐、且流式跟随继续） */
const atBottom = ref(true)

/** 底部渐隐 = 有得滚 + 还没滚到底 */
const fadeBottom = computed(() => scrollable.value && !atBottom.value)

/** 判「还在底部」的容差（px）：与思考块内跟随、消息区跟随同一量级 */
const NEAR_BOTTOM_PX = 4

function isAtBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX
}

/**
 * 重读「可滚动 / 是否到底」，并在跟随态下把内容跟到底。
 *
 * 布局要一帧才稳定（grid 轨道刚翻 1fr、工具行刚插入），所以**调用方负责 nextTick / rAF**。
 * 跟随的判定与思考块内同一条：只在"仍在底部"时跟 —— 程序自己滚出来的 scroll 事件再进
 * `onBodyScroll` 时距离为 0，判定仍是"跟随"，不会自己把自己关掉。
 */
function updateScrollFade(): void {
  const el = scrollEl.value
  // 收起态不做布局读：grid 轨道 0 高时量 scrollHeight 仍会强制布局，
  // 而流式 delta 会频繁触发这里的观察者（爆发密度下是白做功）。
  if (el === null || !props.open) {
    scrollable.value = false
    atBottom.value = true
    return
  }
  scrollable.value = el.scrollHeight > el.clientHeight + 1
  atBottom.value = isAtBottom(el)
  if (props.running && atBottom.value) el.scrollTop = el.scrollHeight
}

function onBodyScroll(): void {
  const el = scrollEl.value
  if (el === null) return
  atBottom.value = isAtBottom(el)
}

// 展开瞬间（open 翻真）与运行态开始都要复查一次；内容**持续生长**靠下面的
// MutationObserver 兜住（scrollHeight 不是响应式数据，watch 不到）。
watch(
  () => [props.open, props.running] as const,
  () => {
    void nextTick(updateScrollFade)
  },
  { immediate: true },
)

/**
 * 内容生长的信号：工具行插入（childList）与思考正文增长（characterData）都会触发。
 * 一条流式 delta 一次回调，回调里只做两次属性读 —— 但 scrollHeight 读取会强制布局，
 * 爆发密度下必须**按帧合并**（rAF 去重），不能每次回调直接读。
 */
let fadeFrame: number | null = null
let fadeObserver: MutationObserver | null = null

function scheduleFadeCheck(): void {
  // 收起态连帧都不排：观察者照发（摘不掉的话代价在回调里），但布局读一次都不做
  if (!props.open) return
  if (fadeFrame !== null) return
  fadeFrame = window.requestAnimationFrame(() => {
    fadeFrame = null
    updateScrollFade()
  })
}

watch(scrollEl, (el, _old, onCleanup) => {
  fadeObserver?.disconnect()
  fadeObserver = null
  if (el === null) return
  fadeObserver = new MutationObserver(scheduleFadeCheck)
  fadeObserver.observe(el, { childList: true, characterData: true, subtree: true })
  onCleanup(() => {
    fadeObserver?.disconnect()
    fadeObserver = null
  })
})

onUnmounted(() => {
  if (fadeFrame !== null) window.cancelAnimationFrame(fadeFrame)
  fadeFrame = null
  fadeObserver?.disconnect()
  fadeObserver = null
})
</script>

<template>
  <div
    class="trace"
    :class="{ open, running, 'is-collapsed': !open }"
    :data-field="running ? 'chat.trace-live' : undefined"
  >
    <button
      type="button"
      class="trace-head"
      :class="{ shimmer: running }"
      :aria-expanded="open"
      @click="emit('toggle')"
    >
      <!--
        状态图标：运行中是一枚公转点（复用全局 `.spin`），终态按成败给绿勾 / 红叉。
        旋转与扫光是两种不同机制（旋转 vs 平移），同屏不冲突；
        scoped 样式里不能定义跨组件复用的 @keyframes，所以这里只挂全局 `.spin`。
      -->
      <span v-if="running" class="trace-orbit spin" aria-hidden="true" />
      <CircleX
        v-else-if="failed"
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
      <span class="trace-summary">{{ summary }}</span>
      <span class="grow" />
      <span v-if="duration !== ''" class="trace-duration">{{ duration }}</span>
      <ChevronRight class="trace-chevron" :size="13" :stroke-width="1.8" aria-hidden="true" />
    </button>

    <!--
      展开体：**常驻 DOM + grid `0fr ↔ 1fr` 折叠**（不用 `v-if` / `<Transition>` / `v-show`）。

      ⚠️ 折叠态必须让 `.thinking` / `.tool-card` 这些锚点**查得到**——capture 的顺序里有一批
      场景跑在轨迹展开之前（左栏结构、命中区、思考块、工具行展开），它们要么数行数、要么直接
      点开某一行，整块摘掉会让那些断言在折叠态直接失效（2026-09-30 实测）。grid 轨道收成 0 与
      `display: none` 观感等价：零高度、不参与布局、随 `inert` 不可聚焦。

      三层结构各司其职：
      `.trace-clip` —— grid 容器，`grid-template-rows: 0fr ↔ 1fr` 过渡（动画在这层）；
      `.trace-body` —— `1fr` 轨道的子项，`min-height: 0 + overflow: hidden` 是 `fr` 轨道
        能收成 0 的前提（子项的自动最小尺寸必须归零），左缘竖脊画在这层；
      `.trace-scroll` —— 限高内滚层（`max-height` + `overflow-y: auto`），渐隐遮罩也在这层。

      折叠态另挂 `inert`：留在 DOM 里是给**探针与结构断言**用的，不代表那段历史该被读屏器
      与 Tab 键遍历到，与 `aria-expanded` 一起表达开合态。
    -->
    <div class="trace-clip" :inert="!open">
      <div class="trace-body">
        <div
          ref="scrollEl"
          class="trace-scroll"
          :class="{ 'fade-bottom': fadeBottom }"
          @scroll.passive="onBodyScroll"
        >
          <slot />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * 折叠态 = 软胶囊：`--fill-1` 底 + `--radius-sm` 圆角，**没有描边**（悬停才浮 `--fill-2`）。
 * 与输入卡三枚控件同一条「静止态零边框」语言（docs/07 §2.3）。
 */
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
  border-radius: var(--radius-sm);
  background: var(--fill-1);
  text-align: left;
  color: var(--text-secondary);
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

/*
 * 运行态的唯一扫光：沿胶囊下缘自左向右划过（1px 高，`aurora-shimmer`）。
 * 比"整行铺底"克制：胶囊本身已有底色，一条线足够表达"这里在动"。
 */
.trace-head.shimmer::after {
  content: '';
  position: absolute;
  inset: auto 0 0;
  height: 1px;
  background: var(--aurora-gradient);
  animation: aurora-shimmer var(--dur-pulse) var(--ease-standard) infinite;
  pointer-events: none;
}

/* 终态状态图标：完成绿 / 有失败红（失败的轨迹要一眼可辨，摘要里另有「N 个失败」） */
.trace-state {
  flex: 0 0 auto;
}

.trace-state.t-ok {
  color: color-mix(in srgb, var(--status-ok) 82%, var(--text-secondary));
}

.trace-state.t-error {
  color: var(--status-error);
}

/* 运行态指示点：低对比度环 + 环上一枚绕心旋转的点（旋转走全局 `.spin`） */
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

/* 耗时：小一档、等宽数字（每秒跳动时宽度不变，胶囊文字不会左右抖） */
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

/*
 * 展开动画：grid `0fr ↔ 1fr`。终点是 `1fr` —— 每一帧都按当下内容现解，
 * 流式期间内容再长也不会被裁掉（不量高度，就没有"量少一截"这回事）。
 * `prefers-reduced-motion` 降级为瞬时（theme.css 的全局兜底压的是时长，这里显式归零更稳）。
 */
.trace-clip {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--dur-base) var(--ease-standard);
}

.trace.open > .trace-clip {
  grid-template-rows: 1fr;
}

@media (prefers-reduced-motion: reduce) {
  .trace-clip {
    transition: none;
  }
}

/*
 * `1fr` 轨道的子项：`min-height: 0` 让自动最小尺寸归零（轨道收成 0 的前提），
 * `overflow: hidden` 负责折叠时的裁剪。左缘连续竖脊画在这层 —— 轨道高度即可见高度，
 * 内容在 `.trace-scroll` 里滚动时，竖脊固定不动，节点圆点骑着它走。
 */
.trace-body {
  position: relative;
  min-height: 0;
  overflow: hidden;
}

.trace-body::before {
  content: '';
  position: absolute;
  left: 7px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--border-subtle);
}

/*
 * 限高内滚：几十步的历史不再把整页撑爆。可滚动且未到底时底部渐隐（`fade-bottom`），
 * 提示"下面还有"；滚到底自动摘掉，最后一行不被遮。
 * ⚠️ 不要写 `overscroll-behavior: contain`：内滚到顶/底之后滚轮**必须链回** `.thread`
 * 继续滚页面 —— contain 会把链断在这里，用户在轨迹体上滚滚轮会被「吃掉」（正是本次要修的
 * 「滚不动」的另一种形态）。
 */
.trace-scroll {
  position: relative;
  max-height: min(45vh, 480px);
  overflow-y: auto;
  padding: var(--space-1) 0 var(--space-2);
}

.trace-scroll.fade-bottom {
  mask-image: linear-gradient(to bottom, #000 calc(100% - 28px), transparent 100%);
}
</style>
