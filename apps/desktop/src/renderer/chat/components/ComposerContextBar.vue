<script setup lang="ts">
/*
 * 上下文详解条（输入框最底部，2026-09 输入框重做：docs/07 §2.3）。
 *
 * 折叠态是一条细状态栏：`上下文 <已用> / <窗口>  <进度条>  <百分比>` + 本会话累计；
 * 展开态在它**上方**弹出一张卡，**只有三行**：本轮输入 / 上下文窗口 / 模型
 * （2026-10-01 UI 细节轮精简：输出、缓存命中、本会话累计/内容四行移除 ——
 * 缓存命中量只保留在折叠条的 `chat.context-cache` 那一段里）。
 *
 * 数据口径（docs/06 §16.2）：`latest.promptTokens` 是**最近一轮请求真实送进去的 token 数**
 * （系统提示词 + 历史 + 本轮内容），也就是「上下文占用」本身；`totals` 是逐轮累加。
 * provider 没回传 `usage` 时 `latest` 为 null —— 此时**不显示进度条与百分比**，
 * 改为如实说明「模型未返回用量」，绝不拿字符数估算冒充 token 数。
 * 分母（上下文窗口）来自**当前生效模型**的 `llm.providers.<active>.modelParams.<模型>`（v23 起
 * 随模型绑定），为 0 = 未知，同样只显示分子、不显示比例。
 *
 * 前缀缓存命中率（docs/06 §21.4）是**另一个分子**：折叠条显示的是**平均缓存命中率**
 * （2026-10-03 起，替换早先的「本次缓存命中」）——分母是 `totals.promptTokens`（本会话
 * 累计送进模型的 prompt，含种子恢复的部分），分子是 `totals.cachedTokens`。按**会话**算
 * 而不是按「本轮」：单轮命中率抖动大，平均值才反映 provider 缓存的真实收益。
 * 「provider 是否回传缓存字段」仍以 `latest.cachedTokens` 是否缺省判定（totals 累计后
 * 无法区分「没回传」与「全没命中」）；未回传时那一段**整段不渲染**（绝不写「缓存命中 0」）。
 *
 * 数值全部来自 props，组件只做格式化与配色，不发任何请求。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { TokenUsage } from '@aurora/shared'
import { formatExactCount, formatTokenCount } from '@aurora/shared/browser'
import { ChevronDown, Gauge } from '@aurora/shared/browser'

const props = withDefaults(
  defineProps<{
    /** 最近一轮的 token 用量；null = 模型没回传用量 */
    latest: TokenUsage | null
    /** 本会话逐轮累计 */
    totals: TokenUsage
    /** 上下文窗口（token）；0 = 未知（不显示比例） */
    contextWindow: number
    /** 展开的详情卡是否打开（受控；由调用方保证与另外两个输入区浮层互斥） */
    open: boolean
    /** 当前生效模型（缺省显示为空） */
    model?: string
    /** 是否正在流式接收（流式中把「本轮」标为进行中） */
    streaming?: boolean
  }>(),
  { model: '', streaming: false },
)

const emit = defineEmits<{ 'update:open': [open: boolean] }>()

const rootEl = ref<HTMLElement | null>(null)

/** 点面板外部 / Esc 收起（与输入框工具行上的权限下拉同一套行为） */
function onDocumentPointerDown(event: PointerEvent): void {
  if (!props.open) return
  const target = event.target
  if (target instanceof Node && rootEl.value?.contains(target) === true) return
  emit('update:open', false)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !props.open) return
  event.stopPropagation()
  emit('update:open', false)
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

/**
 * 平均缓存命中率（0–100 整数，docs/06 §21.4）：
 * 分母 = `totals.promptTokens`（本会话累计送进模型的 prompt），分子 = `totals.cachedTokens`
 * （累计命中量）。provider 回传过缓存字段才显示 —— 判定用 `latest.cachedTokens` 是否缺省
 * （totals 累计后无法区分「没回传」与「全没命中」）；没有累计（prompt 为 0）同样不显示。
 *
 * 上限夹到 100：`cachedTokens` 是**服务端报的命中数**，正常不会超过 prompt，
 * 但桩服务 / 异常网关可能给出不一致的数据，界面不能显示「平均缓存命中 400%」这种荒谬值。
 */
const cachedPercent = computed<number | null>(() => {
  if (props.latest?.cachedTokens === undefined) return null
  const prompt = props.totals.promptTokens
  if (prompt <= 0) return null
  const cached = props.totals.cachedTokens ?? 0
  return Math.min(100, Math.round((cached / prompt) * 100))
})

/**
 * 缓存命中文案（`chat.context-cache` 锚点）；null 时为空串 —— 模板据此**整段不渲染**。
 * 绝对数（累计命中 / 累计输入）在上方详情卡里，折叠条只保留平均值一个数。
 */
const cachedText = computed(() =>
  cachedPercent.value === null ? '' : `平均缓存命中 ${cachedPercent.value}%`,
)
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
            <dt>上下文窗口</dt>
            <dd>
              <template v-if="contextWindow > 0">
                {{ formatExact(contextWindow) }}
                <span class="tiny muted">tokens</span>
              </template>
              <span v-else class="tiny muted">未设置（设置 → AI 模型 → 模型参数）</span>
            </dd>
          </div>
          <div class="ctx-row">
            <dt>模型</dt>
            <dd class="mono">{{ model === '' ? '未配置' : model }}</dd>
          </div>
          <div class="ctx-row">
            <dt>平均缓存命中</dt>
            <dd>
              <template v-if="cachedPercent !== null">
                {{ cachedPercent }}%
                <span class="tiny muted">
                  （{{ formatExact(props.totals.cachedTokens ?? 0) }} /
                  {{ formatExact(props.totals.promptTokens) }} tokens）
                </span>
              </template>
              <span v-else class="tiny muted">模型未回传缓存字段</span>
            </dd>
          </div>
        </dl>
        <p class="tiny muted ctx-note">
          {{
            latest === null
              ? '模型服务未回传 token 用量（部分兼容网关不支持）'
              : '「输入」就是这一轮真正送进模型的上下文长度'
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
          ? '模型未回传 token 用量；点开看本轮输入与窗口设置'
          : '上下文占用与 token 用量；点开看明细'
      "
      @click="emit('update:open', !props.open)"
    >
      <Gauge class="ctx-icon" :size="13" :stroke-width="1.7" aria-hidden="true" />
      <span class="ctx-label tiny">上下文</span>
      <!--
        缓存命中片段嵌在 `chat.context-usage` **里面**（docs/07 §2.3）：探针读这一条的文案时
        要能一并看到「缓存命中」，拆成兄弟节点就读不到了。分隔符放在锚点**外面**，
        让 `chat.context-cache` 的文案就是纯文案本身（没有前导的「·」）。
      -->
      <span class="ctx-value tiny" data-field="chat.context-usage">
        {{ summary }}
        <template v-if="cachedText !== ''">
          <span class="ctx-sep" aria-hidden="true"> · </span>
          <span class="ctx-cache" data-field="chat.context-cache">{{ cachedText }}</span>
        </template>
      </span>
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
/*
 * 与权限下拉同款：刻意**不设** `position: relative`，让详情卡锚在 `.composer-box` 上。
 * 这里是本轮「工具行被盖死」事故的原点 —— 详情卡此前锚在 `.ctx`（工具行**下方**）上向上弹，
 * 底边正好落在工具行内部，把权限 / 模型 / 思考 / 麦克风 / 停止 / 发送整条盖住且不可点。
 */
.ctx {
  border-top: 1px solid var(--border-subtle);
  margin-top: var(--space-1);
}

/* 折叠态：一条贴边的细状态栏，默认透明度低、hover 提亮（不想跟正文抢注意力） */
.ctx-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  /* 24px 下限：整条可点（宽 553px），但原来只有 22px 高 —— 高度低于 WCAG 2.2 SC 2.5.8 的
     24×24 下限时，鼠标在上面按下/抬起稍有位移就会"点空"（`chat-hit-targets` 量出来的违例） */
  min-height: 24px;
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

/* 缓存命中片段：比占用数字再低一档（它是观测值，不该跟占用抢注意力）；数字同样等宽防抖动 */
.ctx-sep,
.ctx-cache {
  color: var(--text-muted);
  white-space: nowrap;
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

/* 详情卡（向上弹、锚在**输入卡**上；与另外两个输入区浮层共用 `--z-flyout`） */
.ctx-card {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 6px);
  z-index: var(--z-flyout);
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
