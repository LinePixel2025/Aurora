/**
 * 图表水合（P2，docs/07 §2.3）：把 `chart.ts` 产出的占位渲染成真图。
 *
 * 设计要点（每一条都对应一类真实失效）：
 * 1. **懒加载 + 分包**：`import('mermaid')` / `import('echarts/core')` 按需动态加载，
 *    正文里没有图表时这两坨（数百 KB）不下载；两端构建各自产出 chunk。
 * 2. **按源码缓存**：流式期间同一条消息逐帧重解析（`v-html` 整块替换），占位会被反复
 *    重建 —— 缓存键是 `kind + 源码`，命中时直接克隆上次的产物，不重跑渲染器。
 * 3. **进入视口才渲染**：IntersectionObserver（rootMargin 200px）避免长对话里几十张图
 *    在挂载瞬间一起渲染。
 * 4. **失败回退源码**：`data-state="failed"` + 工具栏右侧状态文案，源码块保持可见
 *    （CSS 只在 ready 时收起源码）—— 永远不留空白。
 * 5. **尺寸上限**：超过 `CHART_SOURCE_LIMITS` 的源码直接标记失败并说明，不喂渲染器。
 * 6. **主题**：mermaid 主题与水合时 `options.theme()` 一致（dark → 'dark'）；
 *    ECharts 走自身默认主题。两端各自的宿主在主题切换时重建水合器即可。
 *
 * ECharts 只吃 **JSON 配置**（`JSON.parse` 失败即失败文案）：模型给不了函数，
 * 天然不存在「执行任意 JS」的路径。
 */
import { CHART_SOURCE_LIMITS, type ChartKind } from './chart.js'
// 动态 import 的类型别名：`typeof import('mermaid')` 这种内联写法会被
// @typescript-eslint/consistent-type-imports 判错，改成具名 `import type`（语义等价）
import type mermaid from 'mermaid'
import type * as echartsCore from 'echarts/core'

type MermaidModule = typeof mermaid
type EchartsCoreModule = typeof echartsCore

export interface ChartHydratorOptions {
  /** 当前主题（mermaid 主题跟随；默认 'light'） */
  theme?: () => 'light' | 'dark'
  /** 通知外部：某张图渲染成功 / 失败（探针与调试用） */
  onStateChange?: (info: { kind: ChartKind; state: 'ready' | 'failed'; reason?: string }) => void
}

export interface ChartHydrator {
  /** 主动扫一遍（MutationObserver 也会自动触发） */
  scan(): void
  dispose(): void
}

const MERMAID_THEME = { light: 'default', dark: 'dark' } as const

/** 渲染产物缓存（源码 → HTML 片段或 echarts 配置）。上限 32 条，FIFO 淘汰。 */
const artifactCache = new Map<string, { html: string } | { spec: Record<string, unknown> }>()
const CACHE_LIMIT = 32

function cacheGet(key: string): { html: string } | { spec: Record<string, unknown> } | undefined {
  const hit = artifactCache.get(key)
  if (hit !== undefined) {
    // 命中即刷新顺序（LRU 行为）
    artifactCache.delete(key)
    artifactCache.set(key, hit)
  }
  return hit
}

function cacheSet(key: string, value: { html: string } | { spec: Record<string, unknown> }): void {
  if (artifactCache.size >= CACHE_LIMIT) {
    const oldest = artifactCache.keys().next().value
    if (oldest !== undefined) artifactCache.delete(oldest)
  }
  artifactCache.set(key, value)
}

let mermaidLoader: Promise<MermaidModule> | null = null

async function loadMermaid(): Promise<MermaidModule> {
  mermaidLoader ??= import('mermaid').then((mod) => mod.default)
  return mermaidLoader
}

let echartsLoader: Promise<EchartsCoreModule> | null = null

async function loadEcharts(): Promise<EchartsCoreModule> {
  echartsLoader ??= Promise.all([
    import('echarts/core'),
    import('echarts/charts'),
    import('echarts/components'),
    import('echarts/renderers'),
  ]).then(([core, charts, components, renderers]) => {
    core.use([
      charts.LineChart,
      charts.BarChart,
      charts.PieChart,
      charts.ScatterChart,
      charts.RadarChart,
      components.GridComponent,
      components.TooltipComponent,
      components.LegendComponent,
      components.TitleComponent,
      components.DatasetComponent,
      components.MarkLineComponent,
      renderers.CanvasRenderer,
    ])
    return core
  })
  return echartsLoader
}

let mermaidSeq = 0

/** 创建水合器：宿主容器（消息区）内所有 `.md-chart` 占位都会被处理 */
export function createChartHydrator(
  container: HTMLElement,
  options: ChartHydratorOptions = {},
): ChartHydrator {
  let disposed = false
  let scanScheduled = false
  /**
   * 本次待扫的子树根：`null` = 全量扫描（初始 / 外部 `scan()`）。
   * 流式期间 `v-html` 每帧替换正文，MutationObserver 只把**新增节点**交进来，
   * 避免对整棵消息树反复 `querySelectorAll`（长对话下是每帧 O(DOM) 的隐性开销）。
   */
  let pendingRoots: Element[] | null = null

  const visible = new WeakSet<Element>()
  const observed = new WeakSet<Element>()

  const intersection =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue
              visible.add(entry.target)
              intersection?.unobserve(entry.target)
              void hydrate(entry.target as HTMLElement)
            }
          },
          { rootMargin: '200px 0px' },
        )
      : null

  const mutation = new MutationObserver((records) => {
    const roots: Element[] = []
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (node.nodeType === Node.ELEMENT_NODE) roots.push(node as Element)
      }
    }
    // 没有新增元素的 mutation（纯文本 / 属性变化）不需要扫描图表占位。
    if (roots.length > 0) scheduleScan(roots)
  })

  function scheduleScan(roots?: Element[]): void {
    if (disposed || scanScheduled) return
    scanScheduled = true
    pendingRoots = roots === undefined ? null : roots
    // rAF 合并：流式期间每帧都会触发 mutation，同一帧只扫一次
    const run = (): void => {
      scanScheduled = false
      const roots = pendingRoots
      pendingRoots = null
      if (!disposed) scan(roots)
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
    else window.setTimeout(run, 16)
  }

  const CHART_PENDING_SELECTOR = '.md-chart[data-state="pending"]'

  function scan(roots: Element[] | null = null): void {
    // Array.from：lib 里没有 DOM.Iterable，NodeList 不能直接 for...of
    const nodes: HTMLElement[] = []
    if (roots === null) {
      nodes.push(...Array.from(container.querySelectorAll<HTMLElement>(CHART_PENDING_SELECTOR)))
    } else {
      for (const root of roots) {
        if (root instanceof HTMLElement && root.matches(CHART_PENDING_SELECTOR)) nodes.push(root)
        for (const node of Array.from(root.querySelectorAll<HTMLElement>(CHART_PENDING_SELECTOR))) {
          nodes.push(node)
        }
      }
    }
    for (const node of nodes) {
      if (observed.has(node)) continue
      observed.add(node)
      if (intersection === null) {
        void hydrate(node)
      } else {
        intersection.observe(node)
      }
    }
  }

  async function hydrate(node: HTMLElement): Promise<void> {
    if (disposed || node.dataset['state'] !== 'pending') return
    // 不在视口内（IntersectionObserver 已登记，等它回调）
    if (intersection !== null && !visible.has(node)) {
      intersection.observe(node)
      return
    }
    const kind = node.dataset['chart']
    if (kind !== 'mermaid' && kind !== 'echarts') {
      markFailed(node, `未知图表类型：${String(kind)}`)
      return
    }
    const source = node.querySelector('.md-chart-src code')?.textContent ?? ''
    if (source.trim() === '') {
      markFailed(node, '图表源码为空')
      return
    }
    if (source.length > CHART_SOURCE_LIMITS[kind]) {
      markFailed(node, `源码超过 ${CHART_SOURCE_LIMITS[kind]} 字符上限，已按源码展示`)
      return
    }

    node.dataset['state'] = 'rendering'
    try {
      if (kind === 'mermaid') await hydrateMermaid(node, kind, source)
      else await hydrateEcharts(node, kind, source)
    } catch (error) {
      markFailed(node, error instanceof Error ? error.message : String(error))
    }
  }

  async function hydrateMermaid(node: HTMLElement, kind: ChartKind, source: string): Promise<void> {
    const cacheKey = `${kind}:${MERMAID_THEME[options.theme?.() ?? 'light']}:${source}`
    const cached = cacheGet(cacheKey)
    const stage = node.querySelector<HTMLElement>('.md-chart-stage')
    if (stage === null) return
    if (cached !== undefined && 'html' in cached) {
      stage.innerHTML = cached.html
      markReady(node, kind)
      // 缓存命中：把源码块收起（CSS 以 data-state=ready 控制）
      return
    }

    const mermaid = await loadMermaid()
    if (disposed) return
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: MERMAID_THEME[options.theme?.() ?? 'light'],
      // 字体跟随宿主（避免 mermaid 默认字体与 Apple 风排版打架）
      fontFamily: 'inherit',
    })
    mermaidSeq += 1
    // render 需要唯一 id：图表在流式里会被反复重建，序号保证互不冲突
    const { svg } = await mermaid.render(`md-mermaid-${mermaidSeq}`, source)
    if (disposed) return
    cacheSet(cacheKey, { html: svg })
    stage.innerHTML = svg
    markReady(node, kind)
  }

  async function hydrateEcharts(node: HTMLElement, kind: ChartKind, source: string): Promise<void> {
    const stage = node.querySelector<HTMLElement>('.md-chart-stage')
    if (stage === null) return
    let spec: Record<string, unknown>
    const cacheKey = `${kind}:${source}`
    const cached = cacheGet(cacheKey)
    if (cached !== undefined && 'spec' in cached) {
      spec = cached.spec
    } else {
      const parsed: unknown = JSON.parse(source)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('ECharts 配置必须是 JSON 对象')
      }
      spec = parsed as Record<string, unknown>
      cacheSet(cacheKey, { spec })
    }

    const echarts = await loadEcharts()
    if (disposed) return

    // 尺寸防抖：画布固定高度 320（CSS 同步），宽度跟随容器；避免图表撑高导致布局抖动
    stage.classList.add('md-chart-canvas-host')
    const chart = echarts.init(stage, undefined, { renderer: 'canvas', height: 320 })
    // 配色与文字色跟随宿主令牌（Apple 风克制 + 暗色主题下轴标签可读）：
    // 模型给的 spec 若自带 `color` / `textStyle` 仍以它为准（展开顺序即优先级）。
    // 禁用动画：流式期间反复重建时动画会持续合成帧（capture 的 burst 探针能测到）。
    chart.setOption(
      {
        animation: false,
        color: accentPalette(),
        textStyle: { color: cssVar('--md-muted', '#6e6e73') },
        ...spec,
      },
      { notMerge: true },
    )
    // 容器宽度变化（左右栏开合）时跟随。⚠️ 必须**只在宽度真的变了**才 resize：
    // 流式期间滚动条出现 / 消失会让容器宽度抖动，无条件 resize 会把 ECharts 的重绘
    // 塞进每一帧 —— capture 的 burst 探针实测出 16 次 >50ms 长任务（限 6 次）。
    // 另加 rAF 节流：同一帧内的多次观测合并成一次重绘。
    if (typeof ResizeObserver === 'function') {
      let lastWidth = stage.clientWidth
      let resizeFrame: number | null = null
      const observer = new ResizeObserver(() => {
        const width = stage.clientWidth
        if (width === lastWidth) return
        lastWidth = width
        if (resizeFrame !== null) return
        resizeFrame = window.requestAnimationFrame(() => {
          resizeFrame = null
          if (!disposed) chart.resize()
        })
      })
      observer.observe(stage)
    }
    markReady(node, kind)
  }

  function markReady(node: HTMLElement, kind: ChartKind): void {
    node.dataset['state'] = 'ready'
    const status = node.querySelector('.md-chart-status')
    if (status !== null) status.textContent = ''
    options.onStateChange?.({ kind, state: 'ready' })
  }

  function markFailed(node: HTMLElement, reason: string): void {
    node.dataset['state'] = 'failed'
    const status = node.querySelector('.md-chart-status')
    if (status !== null) status.textContent = `渲染失败，已按源码展示：${reason}`
    options.onStateChange?.({ kind: node.dataset['chart'] as ChartKind, state: 'failed', reason })
  }

  // 工具栏：复制源码 / 下载 / 查看大图（事件委托，图表会被流式重建）
  async function onClick(event: MouseEvent): Promise<void> {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const button = target.closest<HTMLElement>('[data-chart-action]')
    if (button === null) return
    const chart = button.closest<HTMLElement>('.md-chart')
    if (chart === null) return
    const action = button.dataset['chartAction']
    const source = chart.querySelector('.md-chart-src code')?.textContent ?? ''
    const stage = chart.querySelector<HTMLElement>('.md-chart-stage')
    if (action === 'copy') {
      await copyText(source)
      button.textContent = '已复制'
      window.setTimeout(() => {
        button.textContent = '复制源码'
      }, 1400)
      return
    }
    if (action === 'download') {
      downloadChart(chart, stage)
      return
    }
    if (action === 'zoom') {
      openOverlay(stage)
    }
  }

  mutation.observe(container, { childList: true, subtree: true })
  container.addEventListener('click', onClick)
  scan()

  return {
    scan: () => scan(),
    dispose(): void {
      disposed = true
      mutation.disconnect()
      intersection?.disconnect()
      container.removeEventListener('click', onClick)
    },
  }
}

/** 读一个 CSS 变量（在 `.md` 容器上取值：宿主令牌经那里映射成 --md-*） */
function cssVar(name: string, fallback: string): string {
  const container = document.querySelector('.md')
  const scope = container instanceof HTMLElement ? container : document.documentElement
  const value = getComputedStyle(scope).getPropertyValue(name).trim()
  return value === '' ? fallback : value
}

/** 图表调色板：优先应用强调色与状态色（两端令牌名不同，逐个试），再补中性色 */
function accentPalette(): string[] {
  const candidates = [
    cssVar('--aurora-blue', ''),
    cssVar('--accent-text', ''),
    cssVar('--accent', ''),
  ].filter((value) => value !== '')
  const accent = candidates[0] ?? '#0a84ff'
  return [
    accent,
    '#30d158',
    '#ff9f0a',
    '#bf5af2',
    '#5ac8fa',
    '#ff375f',
    cssVar('--md-muted', '#8e8e93'),
  ]
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    } catch {
      return false
    }
  }
}

/** 下载：mermaid → .svg，echarts → .png（canvas.toDataURL） */
function downloadChart(chart: HTMLElement, stage: HTMLElement | null): void {
  if (stage === null) return
  const kind = chart.dataset['chart']
  const svg = stage.querySelector('svg')
  if (kind === 'mermaid' && svg !== null) {
    saveBlob(new Blob([svg.outerHTML], { type: 'image/svg+xml' }), 'chart.svg')
    return
  }
  const canvas = stage.querySelector('canvas')
  if (canvas !== null) {
    const url = canvas.toDataURL('image/png')
    const link = document.createElement('a')
    link.href = url
    link.download = 'chart.png'
    link.click()
  }
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 「查看大图」遮罩：克隆产物（svg）或转成图片（canvas），点击 / Esc 关闭 */
function openOverlay(stage: HTMLElement | null): void {
  if (stage === null) return
  const existing = document.getElementById('md-chart-overlay')
  if (existing !== null) existing.remove()

  const overlay = document.createElement('div')
  overlay.id = 'md-chart-overlay'
  overlay.className = 'md-chart-overlay'
  const box = document.createElement('div')
  box.className = 'md-chart-overlay-box'

  const svg = stage.querySelector('svg')
  const canvas = stage.querySelector('canvas')
  if (svg !== null) {
    const clone = svg.cloneNode(true) as SVGElement
    clone.removeAttribute('width')
    clone.removeAttribute('height')
    clone.style.maxWidth = '92vw'
    clone.style.maxHeight = '88vh'
    box.appendChild(clone)
  } else if (canvas !== null) {
    const img = document.createElement('img')
    img.src = canvas.toDataURL('image/png')
    img.className = 'md-chart-overlay-img'
    box.appendChild(img)
  } else {
    return
  }

  overlay.appendChild(box)
  const close = (): void => {
    overlay.remove()
    document.removeEventListener('keydown', onKey)
  }
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close()
  }
  overlay.addEventListener('click', close)
  document.addEventListener('keydown', onKey)
  document.body.appendChild(overlay)
}
