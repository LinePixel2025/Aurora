/**
 * 图表占位产出（P2，docs/07 §2.3）：```mermaid 与 ```echarts 围栏 → 可水合的占位结构。
 *
 * **渲染与解析都在客户端异步进行**（`hydrate.ts`）：这里只产出 DOM 骨架 ——
 * 源码转义后留在 `<pre class="md-chart-src">` 里，天然构成「渲染失败回退源码」的保底
 * （不是空白）；成功由水合方把产物放进 `.md-chart-stage` 并把 `data-state` 置为 ready。
 *
 * 为什么不在渲染器里同步图表：
 * ① mermaid / echarts 是重依赖（数百 KB），正文里九成消息没有图表，进主 bundle 不划算；
 * ② 流式期间同一条消息逐帧重解析，同步渲染会把每帧预算吃光（capture 的 burst 探针能测到）。
 */
export const CHART_KINDS = ['mermaid', 'echarts'] as const
export type ChartKind = (typeof CHART_KINDS)[number]

export function isChartKind(info: string): info is ChartKind {
  return (CHART_KINDS as readonly string[]).includes(info)
}

/** 图表源码上限（字符）：超过只留源码块 + 提示，不喂给渲染器（防布局与内存失控） */
export const CHART_SOURCE_LIMITS: Record<ChartKind, number> = {
  mermaid: 100_000,
  echarts: 256_000,
}

const KIND_LABEL: Record<ChartKind, string> = {
  mermaid: 'Mermaid 图',
  echarts: 'ECharts 图',
}

/**
 * 产出占位结构。`source` 会被**转义**后放进 `<pre>`（与代码块同一套转义口径），
 * 因此 `</pre>` 之类的注入不可能提前终止标签。
 */
export function renderChartPlaceholder(
  kind: ChartKind,
  source: string,
  escape: (raw: string) => string,
): string {
  const label = KIND_LABEL[kind]
  return (
    `<div class="md-chart" data-chart="${kind}" data-state="pending">` +
    `<div class="md-chart-toolbar">` +
    `<span class="md-chart-kind">${label}</span>` +
    `<span class="md-chart-status" role="status"></span>` +
    `<span class="md-chart-actions">` +
    `<button type="button" class="md-chart-btn" data-chart-action="copy">复制源码</button>` +
    `<button type="button" class="md-chart-btn" data-chart-action="download">下载</button>` +
    `<button type="button" class="md-chart-btn" data-chart-action="zoom">大图</button>` +
    `</span></div>` +
    `<div class="md-chart-stage"></div>` +
    `<pre class="md-chart-src"><code>${escape(source)}</code></pre>` +
    `</div>`
  )
}
