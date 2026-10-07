<script setup lang="ts">
/**
 * Center token 用量页（docs/12 §12.3）。
 *
 * 普通用户只拿本人数据；管理员可用筛选查看全站。图表只画语言模型真实返回的 usage。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { CenterUsageResponse } from '@aurora/shared'
import { api } from '../lib/api'
import { currentUser, state } from '../state'
import { formatTime } from '../lib/format'

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

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    data.value = await api.usage({
      ...(from.value === '' ? {} : { from: from.value }),
      ...(to.value === '' ? {} : { to: to.value }),
      ...(clientId.value === '' ? {} : { clientId: clientId.value }),
      ...(model.value.trim() === '' ? {} : { model: model.value.trim() }),
      ...(isAdmin.value && userId.value !== '' ? { userId: userId.value } : {}),
    })
    await nextTick()
    renderChart()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '加载失败'
  } finally {
    loading.value = false
  }
}

function renderChart(): void {
  if (chartEl.value === null) return
  chart ??= echarts.init(chartEl.value, undefined, { renderer: 'canvas' })
  const daily = data.value?.daily ?? []
  const styles = getComputedStyle(document.documentElement)
  const text = styles.getPropertyValue('--text-secondary').trim() || '#64748b'
  const muted = styles.getPropertyValue('--text-muted').trim() || '#94a3b8'
  const border = styles.getPropertyValue('--border-subtle').trim() || '#e2e8f0'
  chart.setOption({
    backgroundColor: 'transparent',
    grid: { left: 48, right: 18, top: 42, bottom: 30 },
    tooltip: { trigger: 'axis' },
    legend: { top: 4, textStyle: { color: text } },
    xAxis: {
      type: 'category',
      data: daily.map((item) => item.date.slice(5)),
      boundaryGap: false,
      axisLine: { lineStyle: { color: border } },
      axisLabel: { color: muted },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: muted },
      splitLine: { lineStyle: { color: border } },
    },
    series: [
      {
        name: '输入',
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: daily.map((item) => item.promptTokens),
      },
      {
        name: '输出',
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: daily.map((item) => item.completionTokens),
      },
      {
        name: '缓存命中',
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: daily.map((item) => item.cachedTokens),
      },
    ],
  })
}

function resize(): void {
  chart?.resize()
}

onMounted(() => {
  void load()
  window.addEventListener('resize', resize)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', resize)
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

    <section class="usage-filters">
      <input v-model="from" class="ui-input" type="date" aria-label="开始日期" />
      <input v-model="to" class="ui-input" type="date" aria-label="结束日期" />
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
      <button class="ui-btn ui-btn--primary" type="button" :disabled="loading" @click="load">
        {{ loading ? '读取中…' : '查询' }}
      </button>
    </section>

    <section class="usage-cards">
      <article class="ui-card usage-card">
        <span>终身总量</span>
        <strong>{{ data?.lifetime.totalTokens.toLocaleString() ?? '—' }}</strong>
        <small>{{ data?.lifetime.requests.toLocaleString() ?? 0 }} 次请求</small>
      </article>
      <article class="ui-card usage-card">
        <span>区间输入</span>
        <strong>{{ data?.totals.promptTokens.toLocaleString() ?? '—' }}</strong>
        <small>{{ data?.range.from }} → {{ data?.range.to }}</small>
      </article>
      <article class="ui-card usage-card">
        <span>区间输出</span>
        <strong>{{ data?.totals.completionTokens.toLocaleString() ?? '—' }}</strong>
        <small>缓存命中 {{ data?.totals.cachedTokens.toLocaleString() ?? 0 }}</small>
      </article>
    </section>

    <section class="ui-card usage-chart-card">
      <div ref="chartEl" class="usage-chart" data-field="usage.chart" />
    </section>

    <section class="ui-card usage-table-card">
      <header>
        <h2>最近请求</h2>
      </header>
      <div class="usage-scroll">
        <table class="ui-table">
          <thead>
            <tr>
              <th>时间</th>
              <th v-if="isAdmin">用户</th>
              <th>设备</th>
              <th>模型</th>
              <th>输入</th>
              <th>输出</th>
              <th>合计</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in data?.recent ?? []" :key="entry.id">
              <td>{{ formatTime(entry.at) }}</td>
              <td v-if="isAdmin">{{ entry.username }}</td>
              <td>{{ entry.clientId }}</td>
              <td class="mono">{{ entry.model }}</td>
              <td>{{ entry.promptTokens.toLocaleString() }}</td>
              <td>{{ entry.completionTokens.toLocaleString() }}</td>
              <td>{{ entry.totalTokens.toLocaleString() }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </section>
</template>

<style scoped>
.usage-page {
  display: grid;
  gap: var(--space-4);
}

.ui-card {
  background: var(--glass-surface);
  border: 1px solid var(--glass-border-soft);
  border-radius: var(--radius-md);
  box-shadow: inset 0 1px 0 var(--glass-highlight);
}

.ui-input {
  height: var(--control-h-sm);
  min-width: 0;
  padding: 0 var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--fill-1);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--text-sm);
  outline: none;
}

.ui-input:focus {
  border-color: var(--aurora-blue);
  box-shadow: 0 0 0 3px var(--accent-ring);
}

.ui-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: var(--control-h-sm);
  padding: 0 var(--space-3);
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  font-size: var(--text-sm);
  cursor: pointer;
}

.ui-btn--primary {
  background: var(--aurora-blue);
  color: var(--on-accent);
}

.ui-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.ui-error {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--error-fill);
  color: var(--error-text);
  font-size: var(--text-sm);
}

.ui-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}

.ui-table th,
.ui-table td {
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
  text-align: left;
  white-space: nowrap;
}

.ui-table th {
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
}

.usage-filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.usage-filters .ui-input {
  width: auto;
  min-width: 150px;
}

.usage-cards {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
}

.usage-card {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-4);
}

.usage-card span,
.usage-card small {
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.usage-card strong {
  font-size: var(--text-2xl);
  font-variant-numeric: var(--num-tabular);
}

.usage-chart-card,
.usage-table-card {
  padding: var(--space-4);
}

.usage-chart {
  width: 100%;
  height: 340px;
}

.usage-table-card header {
  margin-bottom: var(--space-3);
}

.usage-table-card h2 {
  margin: 0;
  font-size: var(--text-lg);
}

.usage-scroll {
  overflow-x: auto;
}

@media (max-width: 800px) {
  .usage-cards {
    grid-template-columns: 1fr;
  }

  .usage-chart {
    height: 280px;
  }
}
</style>
