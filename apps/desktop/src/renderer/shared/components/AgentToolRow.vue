<script setup lang="ts">
/**
 * Agent 执行轨迹里的**一枚工具行**（2026-09 轨迹视觉重构，docs/07 §2.3 / §5.2）。
 *
 * 它是 `MessageList` 原来那段「工具执行卡片」的内联实现抽出来的组件，语义与探针锚点逐条保留
 * （`.tool-card` / `.tool-head` / `.tool-icon`（每卡恰好一枚）/ `.tool-body`（带内联 `--collapse-h`）
 * / `.tool-args` / `data-field="chat.todo-card|chat.task-card"`），改的是**观感与信息层级**：
 *
 * - **卡 → 行**：不再是一张套着边框的盒子，而是轨迹竖脊上的一行（左缘连续竖脊 + 节点圆点，
 *   见 `AgentTrace.vue`）。这样一屏能读成「一串做过的事」，而不是一摞卡片；
 * - **去掉状态文字**（「执行中 / 完成 / 失败」）：语义交给**状态点色** + `aria-label` 承载
 *   —— 状态文案逐行重复会把轨迹刷成噪声，而视觉上状态点已经在最左边、颜色一眼可分；
 * - **结果摘要上提到行首**：`outputSummary` 挨着工具名显示（单行省略、悬停看全文），
 *   不必展开就知道这一步做出了什么；展开体里仍有完整的结果正文；
 * - **终态一次性确认 + 底色淡出**：状态翻到 success / error 时状态点弹一下
 *   （`aurora-confirm`，由 `settled` 控制只加一次类），行底色走 `aurora-tint-out`（`--dur-tint`）
 *   淡回透明 —— 「刚做完」有个交代，又不留一块常驻的高亮底色。
 *
 * ⚠️ `.tool-body` **保留实测高度动画**（`useCollapseTransition` 的 `@enter` / `@before-leave`
 * + `var(--collapse-h, 70vh)`），这是**与「轨迹容器展开一律走 fade」不同的唯一例外**：
 * capture 的 `CHAT_TOOL_CARD_OPEN_CHECK` 直接断言展开体的内联 `--collapse-h` 存在、
 * 是可解析 px 且与 `scrollHeight` 相差 ≤ 2px（docs/07 §5.2 硬约定①的回归防线），
 * 换成 `name="fade"` 会让那条探针立刻 FAIL；而工具行展开时内容已稳定，
 * 不存在「动画期间还在长」的问题（那才是必须 fade 的场景，见思考块）。
 */
import type { AgentToolCall } from '@aurora/shared'
import type { TodoRow } from '../agentTodo.js'
import { parseTaskInput, parseTodoWriteInput } from '../agentTodo.js'
import { useCollapseTransition } from '@aurora/shared/browser'
import { toolIconOf } from '@aurora/shared/browser'
import { toolLabelOf } from '@aurora/shared/browser'
import { ChevronRight, FilePenLine } from '@aurora/shared/browser'
import AgentTodoList from './AgentTodoList.vue'
import AppTooltip from './AppTooltip.vue'
import StatusDot from './StatusDot.vue'
import SubagentConversation from './SubagentConversation.vue'

withDefaults(
  defineProps<{
    /** 这次工具调用（`AgentToolCall`，`MessageList` 从消息里透传） */
    call: AgentToolCall
    /** 展开体是否展开（状态由 `MessageList` 持有：完成即自动收起，见那边的 `syncTimings`） */
    open?: boolean
    /** 是否已翻到终态（一次性确认动画只放一次，`MessageList` 的 `settledIds`） */
    settled?: boolean
    /** 本次调用的耗时文案（渲染层观察到的那一份；历史水合的行是空串） */
    duration?: string
    /** 探针锚点：todo / task 行各有一个，其余行不带（`undefined` 时 Vue 省略属性） */
    dataField?: string
    /** 生图预览的 dataUrl；未加载 / 加载失败时为 `undefined`（行维持纯文本） */
    imagePreview?: string
  }>(),
  { open: false, settled: false, duration: '', dataField: undefined, imagePreview: undefined },
)

const emit = defineEmits<{ (event: 'toggle'): void }>()

/**
 * 状态文案只用于**无障碍标签**，不再渲染成行内文字（本组件的设计要点之一）。
 * `StatusDot` 是纯视觉点（它的 `aria-label` 跟着 `title`），所以这里显式给一个语义标签。
 */
function stateLabel(state: AgentToolCall['state']): string {
  if (state === 'running') return '执行中'
  if (state === 'success') return '完成'
  return '失败'
}

/** 状态点的语义色：idle 灰 / running 蓝 / error 红；成功的绿色在样式里按 `.t-success` 补 */
function toolTone(state: AgentToolCall['state']): 'idle' | 'running' | 'error' {
  if (state === 'running') return 'running'
  if (state === 'error') return 'error'
  return 'idle'
}

/**
 * 行首摘要（原展开体里的「结果」那一段）：没有结果摘要时 running 给「进行中…」、
 * 终态给破折号 —— 不把状态文案伪装成结果，也不留空白。
 */
function summaryOf(call: AgentToolCall): string {
  const summary = (call.outputSummary ?? '').trim()
  if (summary !== '') return summary
  return call.state === 'running' ? '进行中…' : '—'
}

/**
 * `todo_write` 的结构化视图（docs/07 §2.3）：能解析出条目时工具行升级为任务清单行，
 * 返回 null（参数畸形 / 非 todo_write）则回落通用行——绝不因模型输出畸形而丢一行。
 */
function todosOf(call: AgentToolCall): TodoRow[] | null {
  if (call.name !== 'todo_write') return null
  return parseTodoWriteInput(call.input)
}

/** `task` 的结构化视图：行首显示任务简述，展开体显示完整指令与子代理对话 */
function taskOf(call: AgentToolCall) {
  if (call.name !== 'task') return null
  return parseTaskInput(call.input)
}

/** 工具语义图标（docs/07 §5）：读文件 / 跑命令 / 派子代理一眼可分，未知工具走兜底 */
function toolIcon(call: AgentToolCall) {
  return toolIconOf(call.name)
}

/**
 * 通用行的语义化行首标题（docs/07 §2.3 硬口径④）：「动词 + 关键参数」的可读短语
 * （「运行 pnpm test」）。未登记 / 参数里摘不出东西时回落工具名 —— 行首永远不渲染残缺短语，
 * mono 工具名完整保留在 `.tool-head` 的 `aria-label` 里（语义不丢）。
 */
function titleOf(call: AgentToolCall): string {
  const label = toolLabelOf(call.name, call.input)
  if (label === null) return call.name
  return label.object === undefined ? label.verb : `${label.verb} ${label.object}`
}

/** 子代理行首的步骤数（`task` 以外的行返回 null，不渲染该段） */
function subagentStepCount(call: AgentToolCall): number | null {
  if (call.subagent === undefined) return null
  return call.subagent.steps.length
}

/**
 * 子代理被授予的写权限（2026-09，docs/06 §19）：只有 `write` 才显示徽章。
 * 工具名清单进悬停提示（逐行铺开会把行首挤爆）。
 */
function subagentWriteGranted(call: AgentToolCall): boolean {
  return call.subagent?.permission === 'write'
}

function subagentToolsHint(call: AgentToolCall): string {
  const tools = call.subagent?.tools ?? []
  return tools.length === 0 ? '' : `可用工具：${tools.join('、')}`
}

/** `generate_image` 成功后展示图片预览（行内，一眼看到产物） */
function isGeneratedImage(call: AgentToolCall): boolean {
  return call.name === 'generate_image' && call.state === 'success'
}

/** 参数正文：JSON 缩进 + 800 字截断（模型输出畸形时兜底为字符串，绝不抛错） */
function prettyInput(input: unknown): string {
  if (input === undefined || input === null) return '（无参数）'
  if (typeof input === 'string') return input
  try {
    const text = JSON.stringify(input, null, 2)
    if (text === undefined) return String(input)
    return text.length > 800 ? `${text.slice(0, 800)}\n…（已截断）` : text
  } catch {
    return String(input)
  }
}

/**
 * 展开体的实测高度钩子：与全局 `.collapse-*` 配套（`@enter` 必须在元素插入文档后量，
 * 见 `useCollapseTransition` 的文件头）。**只给 `.tool-body` 用**，理由见组件头注释。
 */
const { enter: collapseEnter, beforeLeave: collapseLeave } = useCollapseTransition()
</script>

<template>
  <article
    class="tool-card"
    :class="[`t-${call.state}`, { open, running: call.state === 'running', settled }]"
    :data-field="dataField"
  >
    <button
      type="button"
      class="tool-head"
      :class="{ shimmer: call.state === 'running' }"
      :aria-expanded="open"
      :aria-label="`${call.name} · ${stateLabel(call.state)}`"
      @click="emit('toggle')"
    >
      <!-- 状态点：唯一的常驻状态语义载体（去掉行内状态文字后的替代：色 + aria-label） -->
      <span class="tool-dot">
        <StatusDot :tone="toolTone(call.state)" :size="6" :class="{ confirm: settled }" />
        <span class="sr-state">{{ stateLabel(call.state) }}</span>
      </span>
      <!-- 工具语义图标：每行恰好一枚（capture 的 CHAT_SIDEBAR_SCRIPT 按这个数断言） -->
      <component
        :is="toolIcon(call)"
        class="tool-icon"
        :size="14"
        :stroke-width="1.7"
        aria-hidden="true"
      />
      <!-- 任务清单行：固定标题 + 条目数（结构化清单常驻行身） -->
      <template v-if="todosOf(call)">
        <span class="tool-title">任务清单</span>
        <span class="tiny muted">{{ todosOf(call)!.length }} 项</span>
      </template>
      <!-- 子代理行：任务简述 + 写权限徽章 + 步骤数 -->
      <template v-else-if="taskOf(call)">
        <span class="tool-title">
          {{ taskOf(call)!.description.trim() !== '' ? taskOf(call)!.description : '子代理' }}
        </span>
        <AppTooltip v-if="subagentWriteGranted(call)" :text="subagentToolsHint(call)">
          <span class="tiny perm-badge">
            <FilePenLine :size="11" :stroke-width="1.8" aria-hidden="true" />
            可读写
          </span>
        </AppTooltip>
        <span v-if="subagentStepCount(call) !== null" class="tiny muted tool-steps">
          {{ subagentStepCount(call) }} 步
        </span>
      </template>
      <!--
        通用行：语义化标题（「运行 pnpm test」）。摘不出短语时回落 mono 工具名
        （保持旧行的等宽观感），两种形态都不会渲染残缺文本。
      -->
      <template v-else>
        <span v-if="titleOf(call) !== call.name" class="tool-title">{{ titleOf(call) }}</span>
        <span v-else class="mono tiny tool-name">{{ call.name }}</span>
      </template>
      <!-- 结果摘要上提到行首一行（悬停看全文），单行省略 -->
      <span class="tiny tool-summary" :class="`s-${call.state}`">{{ summaryOf(call) }}</span>
      <span v-if="duration !== ''" class="tiny muted tool-time">{{ duration }}</span>
      <ChevronRight class="chevron" :size="13" :stroke-width="1.8" aria-hidden="true" />
    </button>

    <!--
      结构化任务清单（todo_write）：常驻行身（不展开就能看到清单状态），
      点击行首展开的仍是原始参数 / 结果。解析失败时这里不渲染，回落纯行首。
    -->
    <AgentTodoList v-if="todosOf(call)" :todos="todosOf(call)!" dense class="tool-todos" />

    <!--
      生图预览（BetaV2）：成功行直接展示图片（懒加载、固定宽高比 + object-fit cover 防抖动）。
      路径提取失败 / imagegen:read 失败时不渲染，行维持「已保存到 …」纯文本。
    -->
    <img
      v-if="isGeneratedImage(call) && imagePreview !== undefined"
      class="tool-image"
      :src="imagePreview"
      alt="生成的图片"
      loading="lazy"
    />

    <Transition name="collapse" @enter="collapseEnter" @before-leave="collapseLeave">
      <div v-if="open" class="tool-body">
        <!--
          子代理行：**独立对话视图**（2026-09，docs/06 §19 / docs/07 §2.3）。
          展开体里直接给完整对话（任务指令 → 正文 → 工具调用与结果 → 最终报告），
          与「子代理」页面用的是同一个组件。
        -->
        <template v-if="call.subagent">
          <span class="tiny muted tool-label">对话</span>
          <SubagentConversation :snapshot="call.subagent" />
        </template>
        <span class="tiny muted tool-label">参数</span>
        <pre class="mono tool-args">{{ prettyInput(call.input) }}</pre>
        <span class="tiny muted tool-label">结果</span>
        <p class="tool-output">{{ call.outputSummary ?? stateLabel(call.state) }}</p>
      </div>
    </Transition>
  </article>
</template>

<style scoped>
/* ── 一行：轨迹竖脊上的一格（竖脊本身画在 AgentTrace 的展开体上） ── */
.tool-card {
  position: relative;
  padding-left: 20px;
  border-radius: var(--radius-xs);
}

/*
 * 轨迹节点圆点：骑在 AgentTrace 的左缘竖脊上（竖脊 x = 7px —— 20px 行内边距里那条线）。
 * 颜色按状态语义：running 蓝 / success 绿 / error 红 / 其余中性。
 */
.tool-card::before {
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

.t-running.tool-card::before {
  background: var(--status-running);
}

.t-success.tool-card::before {
  background: var(--status-ok);
}

.t-error.tool-card::before {
  background: var(--status-error);
}

.tool-head {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  /* 28px：与思考块头同一档（2026-10-01 重塑），密度与 WCAG 命中区的平衡点 */
  min-height: 28px;
  padding: 4px var(--space-2) 4px 2px;
  border-radius: var(--radius-xs);
  text-align: left;
  overflow: hidden;
  transition: background var(--transition-fast);
}

.tool-head:hover {
  background: var(--fill-1);
}

/*
 * 运行中的行：一条低对比度亮带自左向右扫过（`aurora-shimmer`）。
 * 这是**全轨迹唯一保留的扫光**：卡片打底扫光与边框呼吸已删（同一屏多处动效会打架），
 * `theme.css` 里的 `aurora-edge-breathe` / `aurora-shimmer` keyframes 保留给
 * 子代理页与自动化页继续使用。
 */
.tool-head.shimmer::after {
  content: '';
  position: absolute;
  inset: 0;
  width: 100%;
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--aurora-blue) 9%, transparent),
    transparent
  );
  animation: aurora-shimmer var(--dur-pulse) var(--ease-standard) infinite;
  pointer-events: none;
}

/* 状态点：去掉行内状态文字后的语义载体（色 + aria-label） */
.tool-dot {
  position: relative;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 10px;
}

/* 状态文案只给读屏器（视觉上不渲染，语义不丢） */
.sr-state {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* 运行中：状态点外套一枚扩散环（与行首扫光同源不同位） */
.t-running .tool-dot::after {
  content: '';
  position: absolute;
  inset: 0;
  margin: auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  border: 1px solid var(--aurora-blue);
  animation: pulse-ring var(--dur-pulse) var(--ease-standard) infinite;
  pointer-events: none;
}

/* 成功态用 `--status-ok`：StatusDot 只有 idle / running / unread / error 四个语义色 */
.t-success .tool-dot :deep(.status-dot) {
  background: var(--status-ok);
}

/*
 * 终态：一次性确认（状态点弹一下，`settled` 类只加一次）+ 行底色淡出
 * （`aurora-tint-out` / `--dur-tint`：新 keyframes 与新令牌，append-only，不覆盖既有命名）。
 */
.tool-card.settled {
  /* 底色淡出的取色：成功走得稳（强调色），失败给红（只有"出了事"才需要被一眼抓到） */
  --trace-tint: var(--aurora-blue);
}

.tool-card.settled.t-error {
  --trace-tint: var(--status-error);
}

.tool-card.settled .tool-dot :deep(.status-dot) {
  animation: aurora-confirm var(--dur-base) var(--ease-spring) both;
}

.tool-card.settled .tool-head {
  animation: aurora-tint-out var(--dur-tint) var(--ease-standard) both;
}

/*
 * `prefers-reduced-motion`：动画被全局压到 1ms 时 `both` 的终点会**停在起点的底色上**
 * （1ms 内跑完 = 肉眼看到的是一块常驻的高亮底），因此这里直接不提底色。
 * 状态点仍保留（它是常驻语义，不是动效）。
 */
@media (prefers-reduced-motion: reduce) {
  .tool-card.settled .tool-head {
    animation: none;
  }
}

.tool-icon {
  flex: 0 0 auto;
  color: var(--text-muted);
}

.t-running .tool-icon {
  color: var(--aurora-blue);
}

.t-success .tool-icon {
  color: color-mix(in srgb, var(--status-ok) 75%, var(--text-muted));
}

.t-error .tool-icon {
  color: var(--status-error);
}

.tool-name {
  flex: 0 0 auto;
  color: var(--text-secondary);
}

/* 结构化行首标题（任务清单 / 子代理）：比 mono 工具名更像「一条内容」 */
.tool-title {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--text-primary);
}

/*
 * 结果摘要（行首一行）：可伸缩可省略 —— `flex: 1 1 auto` + `min-width: 0` 让它在窄列下
 * 先于工具名让位；颜色比标题浅一档（它是"结果"，不是"标题"）。
 */
.tool-summary {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
}

.t-success .tool-summary {
  color: var(--text-secondary);
}

.t-error .tool-summary {
  color: var(--status-error);
}

/* 常驻行身的结构化清单（todo_write）：与行首对齐（缩进跟随行首的 2px 内边距） */
.tool-todos {
  padding: 0 var(--space-2) var(--space-2) 2px;
}

/* 子代理行首的写权限徽章（只在 `permission: 'write'` 时出现） */
.perm-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: 0 0 auto;
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--aurora-blue) 16%, transparent);
  color: var(--accent-text);
  line-height: 16px;
}

.tool-steps {
  flex: 0 0 auto;
}

.tool-time {
  flex: 0 0 auto;
  font-variant-numeric: var(--num-tabular);
}

.chevron {
  flex: 0 0 auto;
  color: var(--text-muted);
  transition: transform var(--transition-base);
}

.tool-card.open .chevron {
  transform: rotate(90deg);
}

.tool-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  /*
   * 顶部**不留**内边距：`.collapse-*-active` 的 `max-height: 0` 只钳内容盒，
   * 上下 padding 仍占高度 —— 收起态残留的 4px 会在行与行之间留一道空档。
   */
  padding: 0 var(--space-2) var(--space-2) 2px;
}

.tool-label {
  color: var(--text-muted);
}

.tool-args {
  margin: 0;
  max-height: 140px;
  overflow: auto;
  /*
   * 不许被 flex 压扁（`.tool-body` 是 flex 列容器）。
   * 展开动画期间容器身上挂着 `max-height: 0`，flex 会把**可收缩的子项**压到最小：
   * 滚动容器（本元素 `overflow: auto`）的自动最小尺寸解析为 0，于是它从 79px 被压到 13px
   * —— 内容在动画期间被压成一细条、过渡结束才弹回，同时让「实测高度」量少 66px
   * （2026-09-26 实测 401 vs 467）。折叠动画要的是**裁剪**，不是让内容重新排版。
   */
  flex: 0 0 auto;
  padding: 6px 8px;
  border-radius: var(--radius-xs);
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  white-space: pre-wrap;
  word-break: break-word;
}

.tool-output {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

/* 生图预览（BetaV2）：固定宽高比 + cover，加载前后占位一致不抖动 */
.tool-image {
  display: block;
  width: 100%;
  max-width: 320px;
  margin: 0 var(--space-2) var(--space-2) 2px;
  aspect-ratio: 1 / 1;
  max-height: 320px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  object-fit: cover;
  background: var(--fill-2);
}
</style>
