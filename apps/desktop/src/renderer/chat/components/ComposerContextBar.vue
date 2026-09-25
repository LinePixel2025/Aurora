<script setup lang="ts">
/*
 * 上下文详解条（输入框最底部，2026-09 输入框重做：docs/07 §2.3）。
 *
 * 折叠态是一条细状态栏：`上下文 <已用> / <窗口>  <进度条>  <百分比>` + 本会话累计；
 * 展开态在它**上方**弹出一张卡，逐项列出这一轮与整个会话的 token 消耗、消息与字符数、
 * 当前模型，以及上下文窗口没填时的修复路径。
 *
 * 数据口径（docs/06 §16.2）：`latest.promptTokens` 是**最近一轮请求真实送进去的 token 数**
 * （系统提示词 + 历史 + 本轮内容），也就是「上下文占用」本身；`totals` 是逐轮累加。
 * provider 没回传 `usage` 时 `latest` 为 null —— 此时**不显示进度条与百分比**，
 * 改为如实说明「模型未返回用量」，绝不拿字符数估算冒充 token 数。
 * 分母（上下文窗口）来自 `llm.providers.<active>.contextWindow`，为 0 = 未知，
 * 同样只显示分子、不显示比例。
 *
 * 数值全部来自 props，组件只做格式化与配色，不发任何请求。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { TokenUsage } from '@aurora/shared'
import { formatExactCount, formatTokenCount } from '@aurora/shared/browser'
import { ChevronDown, Gauge } from '../../shared/icons.js'

const props = withDefaults(
  defineProps<{
    /** 最近一轮的 token 用量；null = 模型没回传用量 */
    latest: TokenUsage | null
    /** 本会话逐轮累计 */
    totals: TokenUsage
    /** 上下文窗口（token）；0 = 未知（不显示比例） */
    contextWindow: number
    /** 当前生效模型（缺省显示为空） */
    model?: string
    /** 本会话可见消息条数 */
    messageCount?: number
    /** 本会话可见消息的字符数（估算量级的参考，标注为字符而不是 token） */
    charCount?: number
    /** 是否正在流式接收（流式中把「本轮」标为进行中） */
    streaming?: boolean
  }>(),
  { model: '', messageCount: 0, charCount: 0, streaming: false },
)

/** 展开的详情卡（默认收起，避免输入区常驻一大块信息） */
const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)

/** 点面板外部 / Esc 收起（与输入框工具行上的权限下拉同一套行为） */
function onDocumentPointerDown(event: PointerEvent): void {
  if (!open.value) return
  const target = event.target
  if (target instanceof Node && rootEl.value?.contains(target) === true) return
  open.value = false
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !open.value) return
  event.stopPropagation()
  open.value = false
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  document.removeEventListener('keydown', onKeydown)
})

/**
 * 数值格式化口径在 `@aurora/shared` 的 `utils/format.ts`（那里有单测）：
 * 折叠态用紧凑写法，详情卡用精确写法。组件这层只做别名，便于模板里短一点。
 */
const formatTokens = formatTokenCount
const formatExact = formatExactCount

/** 占用比例（0–1）；窗口未知或没有用量时返回 null（不编造分母） */
const ratio = computed<number | null>(() => {
  const used = props.latest?.promptTokens ?? 0
  if (props.contextWindow <= 0 || used <= 0) return null
  return Math.min(1, used / props.contextWindow)
})

/** 占用档位：正常 / 偏高 / 接近上限，用于进度条与百分比配色 */
const tone = computed<'ok' | 'warn' | 'high'>(() => {
  const value = ratio.value
  if (value === null) return 'ok'
  if (value >= 0.85) return 'high'
  if (value >= 0.6) return 'warn'
  return 'ok'
})

const percentText = computed(() =>
  ratio.value === null ? '' : `${(ratio.value * 100).toFixed(ratio.value < 0.1 ? 1 : 0)}%`,
)

/** 折叠态主文案：有占用比例时是「已用 / 窗口」，否则只报已用（或说明没有数据） */
const summary = computed(() => {
  if (props.latest === null) return '暂无用量数据'
  const used = formatTokens(props.latest.promptTokens)
  return props.contextWindow > 0 ? `${used} / ${formatTokens(props.contextWindow)}` : used
})
</script>

<template>
  <div ref="rootEl" class="ctx" :class="[tone, { open }]">
    <!-- 详情卡向上弹：这一条贴着窗口底部，向下弹会被裁掉 -->
    <Transition name="pop">
      <div v-if="open" class="ctx-card" data-field="chat.context-detail">
        <p class="ctx-card-title tiny muted">上下文详解</p>
        <dl class="ctx-grid">
          <div class="ctx-row">
            <dt>输入（最近一轮）</dt>
            <dd>
              {{ latest === null ? '—' : formatExact(latest.promptTokens) }}
              <span class="tiny muted">tokens</span>
            </dd>
          </div>
          <div class="ctx-row">
            <dt>输出（最近一轮）</dt>
            <dd>
              {{ latest === null ? '—' : formatExact(latest.completionTokens) }}
              <span class="tiny muted">tokens</span>
            </dd>
          </div>
          <div class="ctx-row">
            <dt>本会话累计</dt>
            <dd>
              {{ formatExact(totals.totalTokens) }}
              <span class="tiny muted">tokens</span>
            </dd>
          </div>
          <div class="ctx-row">
            <dt>上下文窗口</dt>
            <dd>
              <template v-if="contextWindow > 0">
                {{ formatExact(contextWindow) }}
                <span class="tiny muted">tokens</span>
              </template>
              <span v-else class="tiny muted">未设置（设置 → AI 模型 → 上下文窗口）</span>
            </dd>
          </div>
          <div class="ctx-row">
            <dt>本会话内容</dt>
            <dd>
              {{ messageCount }} 条
              <span class="tiny muted">· {{ formatExact(charCount) }} 字符</span>
            </dd>
          </div>
          <div class="ctx-row">
            <dt>模型</dt>
            <dd class="mono">{{ model === '' ? '未配置' : model }}</dd>
          </div>
        </dl>
        <p class="tiny muted ctx-note">
          {{
            latest === null
              ? '模型服务未回传 token 用量（部分兼容网关不支持），这里只统计消息条数与字符数。'
              : '「输入」就是这一轮真正送进模型的上下文长度（系统提示词 + 历史 + 本轮内容），随对话增长。'
          }}
        </p>
      </div>
    </Transition>

    <button
      type="button"
      class="ctx-bar"
      data-field="chat.context"
      :aria-expanded="open"
      :title="
        latest === null
          ? '模型未回传 token 用量；点开看本会话消息与字符数'
          : '上下文占用与 token 用量；点开看明细'
      "
      @click="open = !open"
    >
      <Gauge class="ctx-icon" :size="13" :stroke-width="1.7" aria-hidden="true" />
      <span class="ctx-label tiny">上下文</span>
      <span class="ctx-value tiny" data-field="chat.context-usage">{{ summary }}</span>
      <span v-if="ratio !== null" class="ctx-track" aria-hidden="true">
        <span class="ctx-fill" :style="{ width: `${(ratio * 100).toFixed(1)}%` }" />
      </span>
      <span v-if="percentText !== ''" class="ctx-percent tiny">{{ percentText }}</span>
      <span v-if="streaming" class="ctx-live tiny">实时</span>
      <span class="grow" />
      <span class="tiny muted ctx-total">累计 {{ formatTokens(totals.totalTokens) }}</span>
      <ChevronDown class="ctx-chevron" :size="12" :stroke-width="2" aria-hidden="true" />
    </button>
  </div>
</template>

<style scoped>
.ctx {
  position: relative;
  border-top: 1px solid var(--border-subtle);
  margin-top: var(--space-2);
}

/* 折叠态：一条贴边的细状态栏，默认透明度低、hover 提亮（不想跟正文抢注意力） */
.ctx-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 2px 0;
  border: 0;
  background: transparent;
  color: var(--text-muted);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: color var(--transition-fast);
}

.ctx-bar:hover {
  color: var(--text-secondary);
}

.ctx-bar:focus-visible {
  outline: none;
  color: var(--text-primary);
}

.ctx-icon {
  flex: 0 0 auto;
}

.ctx-label {
  flex: 0 0 auto;
}

/* 数字用等宽数位：token 数每轮都在跳，比例宽会让整条左右抖动 */
.ctx-value {
  flex: 0 0 auto;
  color: var(--text-secondary);
  font-variant-numeric: var(--num-tabular);
}

.ctx-track {
  flex: 0 1 72px;
  min-width: 24px;
  height: 3px;
  border-radius: var(--radius-pill);
  background: var(--fill-3);
  overflow: hidden;
}

.ctx-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--aurora-blue);
  transition: width var(--dur-base) var(--ease-standard);
}

.ctx-percent {
  flex: 0 0 auto;
  font-variant-numeric: var(--num-tabular);
}

/* 占用偏高 / 接近上限：进度条与百分比一起换成警示色（在输入框上就能看出该开新会话了） */
.ctx.warn .ctx-fill {
  background: var(--warning-text);
}

.ctx.warn .ctx-percent {
  color: var(--warning-text);
}

.ctx.high .ctx-fill {
  background: var(--status-error);
}

.ctx.high .ctx-percent {
  color: var(--status-error);
}

/* 流式期间的实时标记：一枚低调的呼吸点，表达「数字还在涨」 */
.ctx-live {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  color: var(--accent-text);
}

.ctx-live::before {
  content: '';
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
  animation: aurora-shimmer var(--dur-pulse) var(--ease-standard) infinite;
}

.ctx-total {
  flex: 0 0 auto;
  font-variant-numeric: var(--num-tabular);
}

.ctx-chevron {
  flex: 0 0 auto;
  transition: transform var(--transition-base);
}

.ctx.open .ctx-chevron {
  transform: rotate(180deg);
}

/* 详情卡（向上弹） */
.ctx-card {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 6px);
  z-index: 20;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-strong);
  background: var(--bg-raised);
  box-shadow: var(--shadow-2);
}

.ctx-card-title {
  margin: 0 0 var(--space-2);
}

.ctx-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px var(--space-3);
  margin: 0;
}

.ctx-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
  min-width: 0;
}

.ctx-row dt {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.ctx-row dd {
  flex: 0 0 auto;
  margin: 0;
  color: var(--text-primary);
  font-size: var(--text-sm);
  font-variant-numeric: var(--num-tabular);
}

.ctx-note {
  margin: var(--space-2) 0 0;
  line-height: var(--leading-normal);
}

.pop-enter-active,
.pop-leave-active {
  transition:
    opacity var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-spring);
}

.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: translateY(4px) scale(0.985);
}
</style>
