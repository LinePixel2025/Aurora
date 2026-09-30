<script setup lang="ts">
import { ChevronRight } from '../icons.js'

/**
 * **Agent 执行轨迹**（2026-09 轨迹视觉重构，docs/07 §2.3 / §5.2）。
 *
 * 一条助手消息的「思考 + 工具调用」原来是一段思考旁注加一摞各自带边框的工具卡（`MessageList`
 * 里的内联实现），一屏看下来是"灰色堆叠"。本组件把它收成**一条轨迹**：
 *
 * - **折叠态 = 一行摘要**：无盒子、只有 1px 上下描边与留白（`--border-subtle`），
 *   文案是「已深度思考 · 3 步」这类可读摘要 —— 一屏内的多条历史轨迹各占一行；
 * - **展开态 = 左缘一根连续竖脊 + 节点圆点**：竖脊画在展开体上（`::before`），
 *   工具行的节点圆点骑在竖脊上（见 `AgentToolRow` 的 `.tool-card::before`），
 *   于是"思考 → 第 1 步 → 第 2 步 → …"读起来是一条时间线；
 * - **展开 / 收起走 `name="fade"`，不做高度动画**：轨迹内容在流式期间持续生长，
 *   实测高度的终点只量一次会把后长出来的部分裁掉、过渡类一摘再补跳
 *   （docs/07 §5.2 硬约定②）—— 这里与思考块的流式自动展开是同一类情形；
 * - **运行态只有一处扫光**：折叠摘要行的下缘一条 `aurora-shimmer` 亮带（本组件唯一的
 *   运行态氛围动效）。卡片打底扫光与 `aurora-edge-breathe` 边框呼吸已删，
 *   keyframes 保留在 `theme.css` 里给子代理页 / 自动化页继续使用。
 *
 * 组件只负责"折叠态 / 展开态的呈现"，**不持有任何状态**：
 * `open` 由 `MessageList` 的 `traceOpen(message)` 决定（历史水合默认折叠、流式期间展开、
 * 请求结束自动收起），点击只往上发一个 `toggle`。
 */
withDefaults(
  defineProps<{
    /** 展开态（`MessageList` 的 `traceOpen(message)`） */
    open?: boolean
    /** 折叠态那一行摘要（如「已深度思考 · 3 步」，由 `MessageList` 按消息内容算） */
    summary?: string
    /** 是否仍在运行（流式思考中，或还有工具在跑）：决定摘要行下缘那条扫光 */
    running?: boolean
  }>(),
  { open: false, summary: '执行轨迹', running: false },
)

const emit = defineEmits<{
  /** 点击摘要行：由父级翻转 `traceOpen(message)` 并在跟随态下重新贴底 */
  (event: 'toggle'): void
}>()
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
        指示点：运行中是一枚公转点（复用全局 `.spin`），终态是一枚静态的完成点。
        旋转与扫光是两种不同机制（旋转 vs 平移），同屏不冲突；
        scoped 样式里不能定义跨组件复用的 @keyframes，所以这里只挂全局 `.spin`。
      -->
      <span v-if="running" class="trace-orbit spin" aria-hidden="true" />
      <span v-else class="trace-dot" aria-hidden="true" />
      <span class="trace-summary">{{ summary }}</span>
      <span class="grow" />
      <ChevronRight class="trace-chevron" :size="13" :stroke-width="1.8" aria-hidden="true" />
    </button>

    <!--
      展开体：左缘连续竖脊（工具行的节点圆点骑在这条线上）。

      ⚠️ **展开体始终在 DOM 里，折叠只靠 CSS（`.trace.is-collapsed .trace-body` → `display: none`）**，
      不用 `v-if` / `<Transition>`：折叠态必须让 `.thinking` / `.tool-card` 这些锚点**查得到**。
      capture 的顺序里有一批场景跑在轨迹展开之前（左栏结构、命中区、思考块、工具行展开），
      它们要么数行数、要么直接点开某一行 —— 整块摘掉会让那些断言在折叠态直接失效
      （2026-09-30 实测：`chat-sidebar` 的 `toolCards` 归零、`chat-thinking-block` 报
      「no .thinking block」）。`display: none` 与 `v-if` 在观感上等价：零高度、不参与布局、
      不可聚焦。淡入淡出改由 `MessageList` 的 `.trace-body` 过渡承担（展开时生效）。

      折叠态另挂 `inert`：留在 DOM 里是给**探针与结构断言**用的，不代表那段历史该被读屏器
      与 Tab 键遍历到（`display: none` 已经不参与渲染，但 `inert` 让"整块被折叠"这件事
      对辅助技术是显式的），与 `aria-expanded` 一起表达开合态。
    -->
    <div v-show="open" class="trace-body" :inert="!open">
      <slot />
    </div>
  </div>
</template>

<style scoped>
/*
 * 折叠态：**没有盒子**。上下各一条 1px 描边把轨迹从正文里分出来，左右不留内边距
 * （与消息正文同一左缘，读起来仍是一列）。展开态的竖脊是唯一的纵向结构线。
 */
.trace {
  margin: var(--space-2) 0 var(--space-3);
  border-top: 1px solid var(--border-subtle);
  border-bottom: 1px solid var(--border-subtle);
}

.trace-head {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 26px;
  padding: 2px 0;
  overflow: hidden;
  text-align: left;
  color: var(--text-muted);
  transition: color var(--transition-fast);
}

.trace-head:hover {
  color: var(--text-secondary);
}

.trace.open > .trace-head {
  color: var(--text-secondary);
}

.trace.running > .trace-head {
  color: var(--accent-text);
}

/*
 * 运行态的唯一扫光：沿摘要行下缘自左向右划过（1px 高，`aurora-shimmer`）。
 * 比"整行铺底"克制：轨迹行本身很薄，一条线足够表达"这里在动"。
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

/* 折叠态指示点：一枚静态小圆点（"这条轨迹已经结束了"） */
.trace-dot {
  flex: 0 0 auto;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.7;
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
 * 展开体：左缘连续竖脊。`20px` 的行内边距由 `AgentToolRow` / 思考块承担，
 * 竖脊落在 7px 处 —— 与工具行节点圆点（`left: 4px` + 7px 直径 = 中心 7.5px）对齐。
 * 底部留一档内边距，竖脊不会在最后一行下面多出一截。
 */
.trace-body {
  position: relative;
  padding: var(--space-1) 0 var(--space-2);
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
</style>
