/**
 * Aurora 的 Agent 输出 Markdown 渲染器（P1 完整版，docs/07 §2.3）。
 *
 * **安全基线不变**：`html: false` —— 模型原文里的任何 HTML 标签都被转义成纯文本，
 * 输出 HTML 全部由 markdown-it 的 renderer 规则（本文件覆写的白名单结构）产生；
 * 链接 scheme 由 markdown-it 的 `validateLink` 白名单（http/https/ftp/mailto，
 * `javascript:` 一律拒绝）。**绝不允许**跳过这层直接 `v-html` 模型原文。
 *
 * **输出类名契约（两端同一份，改这里必须同步 md.css 与两端样式）**：
 * `.md-p / .md-h / .md-list(.md-ol) / .md-quote / .md-table-wrap>.md-table /
 *  .code-block>.code-copy+.md-code(data-lang)>code.hljs / .md-inline /
 *  a.md-link(target=_blank rel=noopener noreferrer nofollow) / .md-hr /
 *  .md-task / .md-admonition(.md-admonition-*)`。
 *
 * 为什么是 markdown-it：GFM 表格 / 删除线内建、规则可覆写成统一类名、同步渲染
 * （流式时只有"正在长的那条消息"逐帧重解析，50KB 级文本一次 <8ms，历史消息走
 * 视图层缓存不重解析）。
 */
// KaTeX 的样式与字体随包本地化（font-src 'self'，见 docs/06 §10 的 CSP 段）：
// 从**本包**导入，两端宿主不必各自声明依赖（pnpm 严格链接下宿主解析不到它）
import 'katex/dist/katex.min.css'
import MarkdownIt from 'markdown-it'
import type { MarkdownIt as MarkdownItInstance } from 'markdown-it'
import { admonitionPlugin } from './admonition.js'
import { isChartKind, renderChartPlaceholder } from './chart.js'
import { renderCodeBlock } from './codeBlock.js'
import { highlightCode } from './highlight.js'
import { mathPlugin } from './math.js'
import { tasklistPlugin } from './tasklist.js'

/** 标题层级映射：`#`→h3 … `####`→h6（对话正文不需要真的 h1/h2，避免与大标题抢层级） */
function headingTag(level: number): string {
  return `h${Math.min(level + 2, 6)}`
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/** 白名单外链属性：http(s) 才开新页；mailto 等不跟 target */
function externalLinkAttrs(href: string): string {
  const trimmed = href.trim().toLowerCase()
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return ' target="_blank" rel="noopener noreferrer nofollow"'
  }
  return ''
}

const md: MarkdownItInstance = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  breaks: true,
})

// ───────────────────────── 输出契约覆写 ─────────────────────────

md.renderer.rules.paragraph_open = () => '<p class="md-p">'
md.renderer.rules.paragraph_close = () => '</p>\n'

md.renderer.rules.heading_open = (tokens, idx) => {
  const token = tokens[idx]
  const level = token?.tag?.slice(1)
  const parsed = Number.parseInt(level ?? '1', 10)
  return `<${headingTag(Number.isNaN(parsed) ? 1 : parsed)} class="md-h">`
}
md.renderer.rules.heading_close = (tokens, idx) => {
  const token = tokens[idx]
  const level = token?.tag?.slice(1)
  const parsed = Number.parseInt(level ?? '1', 10)
  return `</${headingTag(Number.isNaN(parsed) ? 1 : parsed)}>\n`
}

md.renderer.rules.bullet_list_open = () => '<ul class="md-list">\n'
md.renderer.rules.ordered_list_open = () => '<ol class="md-list md-ol">\n'
md.renderer.rules.blockquote_open = (tokens, idx, options, _env, self) => {
  // class 经 attrJoin 进 attrs（admonition 插件要往同一属性上追加），必须走 renderToken
  tokens[idx]?.attrJoin('class', 'md-quote')
  return self.renderToken(tokens, idx, options)
}
md.renderer.rules.hr = () => '<hr class="md-hr">\n'

md.renderer.rules.table_open = () => '<div class="md-table-wrap"><table class="md-table">\n'
md.renderer.rules.table_close = () => '</table></div>\n'

md.renderer.rules.code_inline = (tokens, idx) => {
  const token = tokens[idx]
  return `<code class="md-inline">${md.utils.escapeHtml(token?.content ?? '')}</code>`
}

/**
 * 围栏代码块：语言标签进 data-lang，正文走 highlight.js（输出已转义）。
 * `mermaid` / `echarts` 是**图表围栏**（P2）：产出可水合的占位结构（源码转义保留，
 * 渲染失败即回退展示源码），真正的渲染在 `hydrate.ts` 里按需异步进行。
 */
md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx]
  if (token === undefined) return ''
  const info = token.info?.trim() ?? ''
  // info 首个空格前是语言名（后面可能是 meta，如 ```js title=a.js —— 尾部原样忽略）
  const lang = info.split(/\s+/)[0] ?? ''
  if (isChartKind(lang)) {
    return renderChartPlaceholder(lang, token.content ?? '', (raw) => md.utils.escapeHtml(raw))
  }
  const highlighted = highlightCode(token.content ?? '', lang === '' ? undefined : lang)
  return renderCodeBlock(highlighted, lang === '' ? undefined : lang)
}

/** 缩进代码块：无语言，正文原样转义 */
md.renderer.rules.code_block = (tokens, idx) => {
  const token = tokens[idx]
  return renderCodeBlock(md.utils.escapeHtml(token?.content ?? ''), undefined)
}

md.renderer.rules.link_open = (tokens, idx, _options, _env, self) => {
  const token = tokens[idx]
  const href = String(token?.attrGet('href') ?? '')
  const extra = externalLinkAttrs(href)
  token?.attrJoin('class', 'md-link')
  const rendered = self.renderToken(tokens, idx, _options)
  return extra === '' ? rendered : rendered.replace(/^<a /, `<a${extra} `)
}

/**
 * 图片**不渲染为 `<img>`**（生产 CSP 的 `img-src 'self' data:` 会拦远程图，看着像坏了）；
 * 降级为链接 chip：点开看原图，alt 文本可读 —— 本地图片走附件 / view_image 管线。
 */
md.renderer.rules.image = (tokens, idx) => {
  const token = tokens[idx]
  const href = String(token?.attrGet('src') ?? '')
  const alt = token?.content ?? ''
  if (href.trim() === '') return md.utils.escapeHtml(alt)
  return (
    `<a class="md-link md-image-link" href="${escapeAttr(href)}"${externalLinkAttrs(href)}>` +
    `${md.utils.escapeHtml(alt === '' ? href : alt)}</a>`
  )
}

// ───────────────────────── 插件 ─────────────────────────

md.use(admonitionPlugin)
md.use(tasklistPlugin)
md.use(mathPlugin)

/**
 * 渲染 Agent 输出的 Markdown 为可安全注入的 HTML（`v-html` 用）。
 *
 * 输入异常（undefined / 非字符串）按空串处理 —— 调用方是流式渲染管线，
 * 丢一条空消息不该把整页炸掉。
 */
export function renderMarkdown(source: string | undefined | null): string {
  if (typeof source !== 'string' || source === '') return ''
  return md.render(source)
}

/** 供测试与两端样式核对：契约类名清单（改输出结构时先改这里） */
export const MARKDOWN_CONTRACT_CLASSES = [
  'md-p',
  'md-h',
  'md-list',
  'md-ol',
  'md-quote',
  'md-table-wrap',
  'md-table',
  'code-block',
  'code-copy',
  'md-code',
  'md-inline',
  'md-link',
  'md-hr',
  'md-task',
  'md-admonition',
  'md-math',
  'md-chart',
  'md-chart-src',
] as const

// 图表水合运行时（P2）：宿主容器创建水合器即可（见 hydrate.ts 的用法与失效分析）
export { createChartHydrator, type ChartHydrator, type ChartHydratorOptions } from './hydrate.js'
export { CHART_KINDS, CHART_SOURCE_LIMITS, type ChartKind } from './chart.js'
