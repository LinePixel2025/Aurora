<script setup lang="ts">
/**
 * Center token 用量页（docs/12 §12.3）。
 *
 * 普通用户只拿本人数据；管理员可用筛选查看全站。图表只画语言模型真实返回的 usage。
 * 结构：快捷区间 + 筛选 → 4 张 KPI 卡（区间总计 / 输入 / 输出 / 缓存命中）→ 趋势图 → 最近请求。
 *
 * 「最近请求」按 **PAGE_SIZE 一页**走服务端分页（`limit` + `offset`）：区间内可能有几千条，
 * 整表倾倒既长又要把全部明细传一遍；`recentTotal` 由服务器给，页数不在前端猜。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { CenterUsageQuery, CenterUsageResponse } from '@aurora/shared'
import { api } from '../lib/api'
import { currentUser, state } from '../state'
import { formatTime, formatTokens } from '../lib/format'

echarts.use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

const data = ref<CenterUsageResponse | null>(null)
const loading = ref(true)
const error = ref('')
const from = ref('')
const to = ref('')
const clientId = ref('')
const model = ref('')
const userId = ref('')
const chartEl = ref<HTMLDivElement | null>(null)
let chart: echarts.ECharts | null = null

const isAdmin = computed(() => currentUser.value?.role === 'admin')
const clientOptions = computed(() => [...state.clients.values()])

/** 设备 id → 展示名（表格里不再裸晒 clientId） */
function clientName(id: string): string {
  return state.clients.get(id)?.client.name ?? id
}

// ── 快捷区间：chips 与日期输入互斥（手改日期 = 自定义区间，chips 退选） ──

type QuickRange = 'all' | '7d' | '30d'
const quick = ref<QuickRange>('all')

function toDateInput(offsetDays: number): string {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  return date.toISOString().slice(0, 10)
}

function pickQuick(range: QuickRange): void {
  quick.value = range
  if (range === 'all') {
    from.value = ''
    to.value = ''
  } else {
    from.value = toDateInput(range === '7d' ? -6 : -29)
    to.value = toDateInput(0)
  }
  applyFilters()
}

function onCustomDate(): void {
  quick.value = 'all'
}

const quickItems: Array<{ key: QuickRange; label: string }> = [
  { key: 'all', label: '全部' },
  { key: '7d', label: '近 7 天' },
  { key: '30d', label: '近 30 天' },
]

// ── 数据加载（明细分页） ──

/** 「最近请求」每页条数：区间明细只按它取一页，翻页再取下一页 */
const PAGE_SIZE = 15

/** 当前页（1 基）；请求成功后才提交，失败时页码与表格都停在原地 */
const page = ref(1)

const recentTotal = computed(() => data.value?.recentTotal ?? 0)
const pageCount = computed(() => Math.max(1, Math.ceil(recentTotal.value / PAGE_SIZE)))

function usageQuery(target: number): CenterUsageQuery {
  return {
    ...(from.value === '' ? {} : { from: from.value }),
    ...(to.value === '' ? {} : { to: to.value }),
    ...(clientId.value === '' ? {} : { clientId: clientId.value }),
    ...(model.value.trim() === '' ? {} : { model: model.value.trim() }),
    ...(isAdmin.value && userId.value !== '' ? { userId: userId.value } : {}),
    limit: PAGE_SIZE,
    offset: (target - 1) * PAGE_SIZE,
  }
}

async function load(target = page.value): Promise<void> {
  loading.value = true
  error.value = ''
  let wanted = Math.max(1, target)
  try {
    let result = await api.usage(usageQuery(wanted))
    // 目标页越界（区间缩小 / 明细被清掉 / 手改过页码）：夹回末页，最多只重取一次
    const pages = Math.max(1, Math.ceil(result.recentTotal / PAGE_SIZE))
    if (result.recentTotal > 0 && wanted > pages) {
      wanted = pages
      result = await api.usage(usageQuery(wanted))
    }
    data.value = result
    page.value = wanted
    await nextTick()
    renderChart()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '加载失败'
  } finally {
    loading.value = false
  }
}

/** 筛选条件变了：回到第 1 页再查（查询按钮 / 快捷区间共用） */
function applyFilters(): void {
  void load(1)
}

function goToPage(target: number): void {
  if (loading.value || target < 1 || target > pageCount.value || target === page.value) return
  void load(target)
}

// ── KPI 派生值：全部带 0 守卫，空数据出「—」而不是 NaN ──

const totals = computed(() => data.value?.totals)
const lifetime = computed(() => data.value?.lifetime)

const totalTokens = computed(() => totals.value?.totalTokens ?? 0)
const shareOfLifetime = computed(() => {
  const life = lifetime.value?.totalTokens ?? 0
  return life > 0 ? `${Math.max(1, Math.round((totalTokens.value / life) * 100))}%` : '—'
})
const shareOfTotal = (part: number): string =>
  totalTokens.value > 0 ? `${Math.round((part / totalTokens.value) * 100)}%` : '—'
const cacheHitRate = computed(() => {
  const prompt = totals.value?.promptTokens ?? 0
  const cached = totals.value?.cachedTokens ?? 0
  return prompt > 0 ? `${Math.round((cached / prompt) * 100)}%` : '—'
})

// ── 图表：主题化配色 / 空态 / 宽度判定 + rAF 节流的 resize ──

function renderChart(): void {
  if (chartEl.value === null) return
  chart ??= echarts.init(chartEl.value, undefined, { renderer: 'canvas' })
  const daily = data.value?.daily ?? []
  const styles = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string): string =>
    styles.getPropertyValue(name).trim() || fallback
  const text = read('--text-secondary', '#64748b')
  const muted = read('--text-muted', '#94a3b8')
  const border = read('--border-subtle', '#e2e8f0')
  const raised = read('--bg-raised', '#1c1c1e')
  const signal = read('--center-signal', '#21c8b7')
  const blue = read('--aurora-blue', '#0a84ff')
  chart.setOption(
    {
      backgroundColor: 'transparent',
      grid: { left: 52, right: 18, top: 18, bottom: 46 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: raised,
        borderColor: border,
        textStyle: { color: text, fontSize: 12 },
        valueFormatter: (value: unknown) => formatTokens(Number(value ?? 0)),
      },
      legend: {
        bottom: 0,
        icon: 'circle',
        itemWidth: 8,
        itemHeight: 8,
        itemGap: 18,
        textStyle: { color: muted, fontSize: 11 },
      },
      xAxis: {
        type: 'category',
        data: daily.map((item) => item.date.slice(5)),
        boundaryGap: false,
        axisLine: { lineStyle: { color: border } },
        axisLabel: { color: muted },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: muted, formatter: (value: number) => formatTokens(value) },
        splitLine: { lineStyle: { color: border } },
      },
      series: [
        {
          name: '输入',
          type: 'line',
          smooth: true,
          showSymbol: false,
          data: daily.map((item) => item.promptTokens),
          lineStyle: { width: 2, color: signal },
          itemStyle: { color: signal },
          areaStyle: {
            opacity: 0.14,
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: signal },
              { offset: 1, color: 'rgba(0,0,0,0)' },
            ]),
          },
        },
        {
          name: '输出',
          type: 'line',
          smooth: true,
          showSymbol: false,
          data: daily.map((item) => item.completionTokens),
          lineStyle: { width: 2, color: blue },
          itemStyle: { color: blue },
          areaStyle: {
            opacity: 0.12,
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: blue },
              { offset: 1, color: 'rgba(0,0,0,0)' },
            ]),
          },
        },
        {
          name: '缓存命中',
          type: 'line',
          smooth: true,
          showSymbol: false,
          data: daily.map((item) => item.cachedTokens),
          lineStyle: { width: 1.5, type: 'dashed', color: muted },
          itemStyle: { color: muted },
        },
      ],
    },
    // 更新查询区间后日期轴可能变短，替换而不是合并旧 series
    { replaceMerge: ['series'] },
  )
}

/*
 * resize 两道闸（历史坑：ResizeObserver 无条件 chart.resize 会在滚动条出现/消失的
 * 宽度抖动里把重绘塞进每帧）：先判宽度真变了，再 rAF 合帧，一帧最多一次重绘。
 */
let lastChartWidth = 0
let resizeFrame = 0
let observer: ResizeObserver | null = null

function watchChartSize(): void {
  if (chartEl.value === null || typeof ResizeObserver === 'undefined') return
  observer ??= new ResizeObserver((entries) => {
    const width = Math.round(entries[0]?.contentRect.width ?? 0)
    if (width === 0 || width === lastChartWidth || resizeFrame !== 0) return
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0
      lastChartWidth = width
      chart?.resize()
    })
  })
  observer.observe(chartEl.value)
}

onMounted(() => {
  void load()
  watchChartSize()
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  if (resizeFrame !== 0) cancelAnimationFrame(resizeFrame)
  resizeFrame = 0
  chart?.dispose()
  chart = null
})
</script>

<template>
  <section class="page usage-page" data-panel="usage-page">
    <header>
      <h1 class="page-title">用量</h1>
      <p class="page-sub">
        {{
          isAdmin
            ? '管理员可查看全站并按设备、模型、用户筛选。'
            : '这里只显示你自己的官方模型用量。'
        }}
      </p>
    </header>

    <p v-if="error" class="ui-error">{{ error }}</p>

    <section class="usage-filters" aria-label="用量筛选">
      <div class="usage-quick" role="group" aria-label="快捷区间">
        <button
          v-for="item in quickItems"
          :key="item.key"
          type="button"
          class="usage-quick-chip"
          :class="{ active: quick === item.key }"
          :data-action="`usage.quick-${item.key}`"
          @click="pickQuick(item.key)"
        >
          {{ item.label }}
        </button>
      </div>
      <input
        v-model="from"
        class="ui-input"
        type="date"
        aria-label="开始日期"
        @change="onCustomDate"
      />
      <span class="usage-range-sep" aria-hidden="true">→</span>
      <input
        v-model="to"
        class="ui-input"
        type="date"
        aria-label="结束日期"
        @change="onCustomDate"
      />
      <select v-if="isAdmin" v-model="clientId" class="ui-input" aria-label="客户端">
        <option value="">全部设备</option>
        <option
          v-for="entry in clientOptions"
          :key="entry.client.clientId"
          :value="entry.client.clientId"
        >
          {{ entry.client.name }}
        </option>
      </select>
      <input
        v-if="isAdmin"
        v-model="userId"
        class="ui-input"
        type="text"
        placeholder="用户 ID（可选）"
        aria-label="用户 ID"
      />
      <input
        v-model="model"
        class="ui-input"
        type="text"
        placeholder="模型（可选）"
        aria-label="模型"
      />
      <button
        class="ui-btn ui-btn--primary"
        type="button"
        :disabled="loading"
        @click="applyFilters"
      >
        {{ loading ? '读取中…' : '查询' }}
      </button>
    </section>

    <section class="usage-cards">
      <article class="usage-card usage-card--total">
        <span>区间总计</span>
        <strong>{{ totalTokens > 0 ? formatTokens(totalTokens) : '—' }}</strong>
        <small>
          {{ totals?.requests.toLocaleString() ?? 0 }} 次请求 · 占终身 {{ shareOfLifetime }}
        </small>
      </article>
      <article class="ui-card usage-card">
        <span>输入</span>
        <strong>{{ totals ? formatTokens(totals.promptTokens) : '—' }}</strong>
        <small>占区间 {{ shareOfTotal(totals?.promptTokens ?? 0) }}</small>
      </article>
      <article class="ui-card usage-card">
        <span>输出</span>
        <strong>{{ totals ? formatTokens(totals.completionTokens) : '—' }}</strong>
        <small>占区间 {{ shareOfTotal(totals?.completionTokens ?? 0) }}</small>
      </article>
      <article class="ui-card usage-card">
        <span>缓存命中</span>
        <strong>{{ totals ? formatTokens(totals.cachedTokens) : '—' }}</strong>
        <small>输入命中 {{ cacheHitRate }}</small>
      </article>
    </section>

    <section class="ui-card usage-chart-card">
      <div ref="chartEl" class="usage-chart" data-field="usage.chart" />
      <p v-if="!loading && (data?.daily.length ?? 0) === 0" class="usage-chart-empty">
        区间内还没有模型调用记录
      </p>
    </section>

    <section class="ui-card usage-table-card">
      <header class="usage-table-head">
        <h2>最近请求</h2>
        <span v-if="recentTotal > 0" class="usage-table-total" data-field="usage.recent-total">
          共 {{ recentTotal.toLocaleString() }} 条
        </span>
      </header>
      <p v-if="(data?.recent.length ?? 0) === 0" class="usage-table-empty">暂无请求记录</p>
      <template v-else>
        <div class="usage-scroll">
          <table class="ui-table ui-table--cards" data-field="usage.recent-table">
            <thead>
              <tr>
                <th>时间</th>
                <th v-if="isAdmin">用户</th>
                <th>设备</th>
                <th>模型</th>
                <th class="usage-end">输入</th>
                <th class="usage-end">输出</th>
                <th class="usage-end">合计</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in data?.recent ?? []" :key="entry.id" data-field="usage.recent-row">
                <td data-label="时间">{{ formatTime(entry.at) }}</td>
                <td v-if="isAdmin" data-label="用户">{{ entry.username }}</td>
                <td data-label="设备">{{ clientName(entry.clientId) }}</td>
                <td class="mono" data-label="模型">{{ entry.model }}</td>
                <td class="usage-end" data-label="输入">
                  {{ entry.promptTokens.toLocaleString() }}
                </td>
                <td class="usage-end" data-label="输出">
                  {{ entry.completionTokens.toLocaleString() }}
                </td>
                <td class="usage-end" data-label="合计">
                  {{ entry.totalTokens.toLocaleString() }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <nav class="usage-pager" data-field="usage.pager" aria-label="最近请求翻页">
          <button
            class="ui-btn ui-btn--ghost"
            type="button"
            data-action="usage.page-first"
            :disabled="loading || page <= 1"
            @click="goToPage(1)"
          >
            首页
          </button>
          <button
            class="ui-btn ui-btn--ghost"
            type="button"
            data-action="usage.page-prev"
            :disabled="loading || page <= 1"
            @click="goToPage(page - 1)"
          >
            上一页
          </button>
          <span class="usage-pager-label" data-field="usage.page-label">
            第 {{ page }} / {{ pageCount }} 页
          </span>
          <button
            class="ui-btn ui-btn--ghost"
            type="button"
            data-action="usage.page-next"
            :disabled="loading || page >= pageCount"
            @click="goToPage(page + 1)"
          >
            下一页
          </button>
          <button
            class="ui-btn ui-btn--ghost"
            type="button"
            data-action="usage.page-last"
            :disabled="loading || page >= pageCount"
            @click="goToPage(pageCount)"
          >
            末页
          </button>
        </nav>
      </template>
    </section>
  </section>
</template>

<style scoped>
.usage-page {
  display: grid;
  gap: var(--space-4);
}

/* ── 筛选区：快捷 chips + 日期区间 + 条件筛选，窄屏换行成组 ── */

.usage-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.usage-quick {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-pill);
  background: var(--fill-1);
}

.usage-quick-chip {
  min-height: 26px;
  padding: 0 var(--space-3);
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.usage-quick-chip:hover {
  color: var(--text-primary);
}

.usage-quick-chip.active {
  background: var(--center-active);
  color: var(--center-signal);
  font-weight: var(--weight-medium);
}

.usage-filters .ui-input {
  width: auto;
  min-width: 140px;
}

.usage-range-sep {
  color: var(--text-muted);
  font-size: var(--text-xs);
  margin: 0 -4px;
}

/* ── KPI 卡：主卡占双列，其余三张等宽 ── */

.usage-cards {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
}

.usage-card {
  display: grid;
  gap: var(--space-1);
  align-content: center;
  padding: var(--space-4);
}

/*
 * 主卡不挂 .ui-card：全局 `#app .ui-card` 是 ID 选择器，会压过 scoped 背景，
 * 主卡的强调底色（青绿渐变 + 玻璃描边）只能自己完整声明。
 */
.usage-card--total {
  grid-column: span 3;
  border: 1px solid var(--glass-border-soft);
  border-radius: var(--radius-md);
  background:
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--center-signal) 10%, transparent),
      transparent 55%
    ),
    var(--center-card);
  box-shadow: inset 0 1px 0 var(--glass-highlight);
}

.usage-card--total strong {
  font-size: 32px;
}

.usage-card span,
.usage-card small {
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.usage-card small {
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.usage-card strong {
  font-variant-numeric: var(--num-tabular);
  font-size: var(--text-2xl);
  letter-spacing: -0.02em;
}

/* ── 图表与表格 ── */

.usage-chart-card,
.usage-table-card {
  padding: var(--space-4);
}

.usage-chart-card {
  position: relative;
}

.usage-chart {
  width: 100%;
  height: 340px;
}

.usage-chart-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  margin: 0;
  color: var(--text-muted);
  font-size: var(--text-sm);
  pointer-events: none;
}

.usage-table-card header {
  margin-bottom: var(--space-3);
}

.usage-table-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.usage-table-total {
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-variant-numeric: var(--num-tabular);
}

/* 分页条：翻页是次要动作，按钮走 ghost；页码用等宽数字避免跳动 */
.usage-pager {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}

.usage-pager-label {
  min-width: 92px;
  color: var(--text-secondary);
  font-size: var(--text-xs);
  font-variant-numeric: var(--num-tabular);
  text-align: center;
}

.usage-table-card h2 {
  margin: 0;
  font-size: var(--text-lg);
}

.usage-table-empty {
  margin: 0;
  padding: var(--space-5) 0;
  color: var(--text-muted);
  font-size: var(--text-sm);
  text-align: center;
}

.usage-scroll {
  overflow-x: auto;
}

.usage-end {
  text-align: right;
  font-variant-numeric: var(--num-tabular);
}

/*
 * ───────── 基础件（本页自持） ─────────
 * 本页此前没带这一套：筛选框与按钮吃的是浏览器原生外观（只有 `#app .ui-*` 的圆角）。
 * 配方与 AdminView / FilesView 同一份；圆角统一交给 style.css 的 `#app` 覆盖，别在这里抢。
 */

.ui-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  height: var(--control-h-sm);
  padding: 0 var(--space-3);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  font-size: var(--text-sm);
  line-height: var(--leading-tight);
  white-space: nowrap;
  cursor: pointer;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast),
    opacity var(--transition-fast),
    transform var(--dur-press) var(--ease-standard);
}

.ui-btn:active:not(:disabled) {
  transform: scale(0.97);
}

.ui-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.ui-btn--primary {
  background: var(--aurora-blue);
  color: var(--on-accent);
}

.ui-btn--primary:hover:not(:disabled) {
  filter: brightness(1.08);
}

.ui-btn--ghost {
  border-color: var(--border-subtle);
}

.ui-btn--ghost:hover:not(:disabled) {
  background: var(--fill-2);
}

.ui-input {
  height: var(--control-h-sm);
  min-width: 0;
  padding: 0 var(--space-3);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--text-sm);
  outline: none;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast),
    box-shadow var(--transition-fast);
}

.ui-input::placeholder {
  color: var(--text-muted);
}

.ui-input:focus {
  border-color: var(--aurora-blue);
  box-shadow: 0 0 0 3px var(--accent-ring);
}

select.ui-input {
  cursor: pointer;
}

.ui-error {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--error-fill);
  color: var(--error-text);
  font-size: var(--text-sm);
}

@media (max-width: 900px) {
  .usage-cards {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .usage-card--total {
    grid-column: span 3;
  }
}

@media (max-width: 720px) {
  .usage-filters .ui-input {
    min-width: 0;
  }

  /* 日期起止各占一半，其余条件铺满整行 */
  .usage-filters .ui-input[aria-label='开始日期'],
  .usage-filters .ui-input[aria-label='结束日期'] {
    flex: 1 1 calc(50% - var(--space-4));
  }

  .usage-filters .ui-input[aria-label='客户端'],
  .usage-filters .ui-input[aria-label='用户 ID'],
  .usage-filters .ui-input[aria-label='模型'] {
    flex: 1 1 100%;
  }

  .usage-filters .ui-btn {
    flex: 1 1 100%;
    min-height: var(--hit-target);
  }

  .usage-cards {
    grid-template-columns: 1fr;
  }

  .usage-card--total {
    grid-column: auto;
  }

  .usage-card {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
  }

  .usage-card strong {
    font-size: var(--text-xl);
  }

  .usage-chart {
    height: 260px;
  }

  .usage-table-card,
  .usage-chart-card {
    padding: var(--space-3);
  }

  /* 分页条：按钮铺开成两列，命中区够大；页码独占一行居中 */
  .usage-pager {
    justify-content: center;
  }

  .usage-pager .ui-btn {
    flex: 1 1 calc(50% - var(--space-2));
    min-height: var(--hit-target);
  }

  .usage-pager-label {
    order: -1;
    flex: 1 1 100%;
    min-width: 0;
    text-align: center;
  }
}
</style>
