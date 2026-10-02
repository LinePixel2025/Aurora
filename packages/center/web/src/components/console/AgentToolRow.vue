<script setup lang="ts">
/**
 * 工具行（docs/07 §2.3 的「工具卡」）—— 与桌面端 `AgentToolRow` 同一套语言：
 *
 * - 行首**一枚**语义图标（`toolIconOf` 查表；MCP 退拼图、未知退扳手）+ 主标题
 *   （`toolLabelOf` 的动宾短语，未登记工具退 mono 工具名）；
 * - 状态只用**颜色 + 圆点**表达（不写「执行中/完成/失败」文字，见 aria-label）；
 * - 结果摘要上提到行首（`--text-muted`，单行省略号），详细入参 / 输出在展开体里；
 * - 运行中：行首一条横向扫光（`aurora-shimmer`）+ 状态点脉冲环；终态一次性确认
 *   （`aurora-confirm` + `aurora-tint-out` 底色淡出）；
 * - 展开体是全站**唯一**走实测高度动画（`--collapse-h`）的地方：内容展开时已稳定。
 */
import { computed, ref } from 'vue'
import type { ToolItem } from '../../state'
import { useCollapseTransition } from '@aurora/shared/browser'
import { ChevronRight, toolIconOf, toolLabelOf } from '@aurora/shared/browser'
import SubagentCard from './SubagentCard.vue'

const props = defineProps<{ tool: ToolItem }>()

const open = ref(false)
const collapseHooks = useCollapseTransition()

const icon = computed(() => toolIconOf(props.tool.name))
/** 语义标题：登记过的工具给「动词 + 关键参数」，未登记回退到 mono 工具名（查表绝不缺映射） */
const label = computed(() => toolLabelOf(props.tool.name, props.tool.input))

/** 展开体的参数块：能给全量 JSON 就给（截断到 4000 字符），否则回落到单行摘要 */
const argsText = computed(() => {
  const input = props.tool.input
  if (input === undefined || input === null) return props.tool.inputSummary || '（无）'
  if (typeof input === 'string') return input
  try {
    const json = JSON.stringify(input, null, 2) ?? ''
    return json.length > 4000 ? `${json.slice(0, 4000)}…` : json
  } catch {
    return props.tool.inputSummary || '（无）'
  }
})

const stateLabel = computed(() =>
  props.tool.state === 'running' ? '执行中' : props.tool.state === 'error' ? '失败' : '完成',
)

/** 耗时（秒，一位小数）：渲染层观测的起止时刻，历史回放条目没有 */
const duration = computed(() => {
  const { startedAt, endedAt } = props.tool
  if (startedAt === undefined || endedAt === undefined) return ''
  const seconds = Math.max(0, (endedAt - startedAt) / 1000)
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`
})

function toggle(): void {
  open.value = !open.value
}
</script>

<template>
  <article
    class="tool-card"
    :class="[
      `t-${tool.state}`,
      { open, settled: tool.state !== 'running', 'has-subagent': tool.subagent !== undefined },
    ]"
    :data-field="tool.subagent === undefined ? undefined : 'chat.task-row'"
  >
    <button
      type="button"
      class="tool-head"
      :class="{ shimmer: tool.state === 'running' }"
      :aria-expanded="open"
      :aria-label="`${tool.name} · ${stateLabel}`"
      data-action="chat.tool-toggle"
      @click="toggle"
    >
      <span class="tool-dot" aria-hidden="true" />
      <span class="tool-icon" aria-hidden="true">
        <component :is="icon" :size="14" :stroke-width="1.7" />
      </span>
      <span v-if="label" class="tool-title">
        {{ label.verb }}
        <span v-if="label.object" class="tool-object">{{ label.object }}</span>
      </span>
      <span v-else class="tool-name">{{ tool.name }}</span>
      <span class="tool-summary" :class="`s-${tool.state}`">
        {{ tool.outputSummary ?? (tool.state === 'running' ? '进行中…' : '—') }}
      </span>
      <span class="grow" />
      <span v-if="duration !== ''" class="tool-time">{{ duration }}</span>
      <ChevronRight class="chevron" :size="13" :stroke-width="1.8" aria-hidden="true" />
    </button>

    <SubagentCard v-if="tool.subagent" :snapshot="tool.subagent" />

    <Transition
      name="collapse"
      @enter="collapseHooks.enter"
      @before-leave="collapseHooks.beforeLeave"
    >
      <div v-if="open" class="tool-body" data-field="chat.tool-body">
        <p class="body-label">参数</p>
        <pre class="tool-args">{{ argsText }}</pre>
        <template v-if="tool.outputSummary">
          <p class="body-label">结果</p>
          <p class="tool-output">{{ tool.outputSummary }}</p>
        </template>
      </div>
    </Transition>
  </article>
</template>

<style scoped>
.tool-card {
  position: relative;
  padding-left: 20px;
  border-radius: var(--radius-xs);
}

/* 节点圆点：骑在轨迹容器的竖脊上（7px，中心对齐竖脊的 7.5px） */
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
  min-height: 28px;
  padding: 4px var(--space-2) 4px 2px;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.tool-head:hover {
  background: var(--fill-1);
  color: var(--text-primary);
}

.tool-card.open .tool-head {
  color: var(--text-primary);
}

/* 运行中：整行一条横向扫光（全场仅此一处 + 轨迹胶囊下缘那条） */
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

.tool-dot {
  position: relative;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
}

/* 状态点：形状固定 6px，三态只换颜色（不写状态文字，见 aria-label） */
.tool-dot::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--status-idle);
  transition: background var(--transition-fast);
}

.t-running .tool-dot::before {
  background: var(--status-running);
}

.t-success .tool-dot::before {
  background: var(--status-ok);
}

.t-error .tool-dot::before {
  background: var(--status-error);
}

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

/* 终态一次性确认：状态点弹一下（reduced-motion 下由共享样式压到 1ms） */
.tool-card.settled .tool-dot {
  animation: aurora-confirm var(--dur-base) var(--ease-spring) both;
}

.tool-icon {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  color: var(--text-muted);
}

.tool-card.open .tool-icon,
.tool-head:hover .tool-icon {
  color: var(--text-secondary);
}

.tool-title,
.tool-name {
  flex: 0 0 auto;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-name {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

/* 关键参数：留在行首但压成 mono 小字，一眼能分清「读了哪个文件 / 跑了什么命令」 */
.tool-object {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.tool-summary {
  min-width: 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-summary.s-error {
  color: var(--danger-text);
}

.tool-summary.s-running {
  color: var(--accent-text);
}

.grow {
  flex: 1 1 auto;
}

.tool-time {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-size: var(--text-xs);
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

/* 终态一次性确认：状态点弹一下 + 行底色淡出 */
.tool-card.settled {
  --trace-tint: var(--aurora-blue);
}

.tool-card.settled.t-error {
  --trace-tint: var(--status-error);
}

.tool-card.settled .tool-head {
  animation: aurora-tint-out var(--dur-tint) var(--ease-standard) both;
}

/*
 * `prefers-reduced-motion`：全局兜底把动画压到 1ms，而 `both` 的**终点会停在起点的底色上**
 * （1ms 内跑完 = 肉眼看到的是一块常驻的高亮底），所以这里直接不提底色；
 * 状态点那一下确认仍保留（终态是常驻语义，不是纯动效）。与桌面端 `AgentToolRow` 同款。
 */
@media (prefers-reduced-motion: reduce) {
  .tool-card.settled .tool-head {
    animation: none;
  }
}

/* 折叠动画要的是裁剪，不是让内容重新排版：展开体里的滚动容器不许被 flex 压缩 */
.tool-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 2px 0 var(--space-1) 2px;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--fill-1);
}

.body-label {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.tool-args {
  margin: 0;
  flex: 0 0 auto;
  max-height: 160px;
  overflow: auto;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  white-space: pre-wrap;
  word-break: break-word;
}

.tool-output {
  margin: 0;
  flex: 0 0 auto;
  max-height: 120px;
  overflow: auto;
  color: var(--text-secondary);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  white-space: pre-wrap;
  word-break: break-word;
}

@media (max-width: 720px) {
  .tool-head {
    min-height: var(--hit-target);
  }

  .tool-title,
  .tool-name {
    max-width: 38%;
  }
}
</style>
