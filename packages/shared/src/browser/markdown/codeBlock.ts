/**
 * 代码块输出契约（两端一致，docs/07 §2.3）：
 *
 * ```html
 * <div class="code-block"><button …class="code-copy">…</button>
 *   <pre class="md-code" data-lang="ts"><code class="hljs language-ts">…</code></pre>
 * </div>
 * ```
 *
 * 复制按钮由渲染器**直接产出**（不再是渲染层用字符串正则往 `<pre>` 外包一层）：
 * 桌面与 Center 的复制点击都走各自容器上的**事件委托**，按钮结构两端同一份。
 * 图标是 lucide 的 Copy / Check 路径原样内联 —— 按钮是字符串注入、用不了 Vue 组件。
 */
export const ICON_COPY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>'
export const ICON_CHECK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>'

export const CODE_COPY_BUTTON = `<button type="button" class="code-copy" aria-label="复制代码">${ICON_COPY}<span class="code-copy-label">复制</span></button>`

/** 渲染一个完整代码块（含复制按钮壳）；`body` 必须是**已转义**的 HTML */
export function renderCodeBlock(body: string, lang: string | undefined): string {
  const langAttr =
    lang === undefined || lang === '' ? '' : ` data-lang="${lang.replace(/[^a-zA-Z0-9+#.-]/g, '')}"`
  return (
    `<div class="code-block">${CODE_COPY_BUTTON}` +
    `<pre class="md-code"${langAttr}><code class="hljs">${body}</code></pre></div>`
  )
}
