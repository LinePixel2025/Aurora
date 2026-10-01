/**
 * 数学公式（P2，docs/07 §2.3）：`$...$` 行内与 `$$...$$` 块级，KaTeX 渲染。
 *
 * 安全：`trust: false`（默认，禁止 `\htmlClass` 之类的信任命令）+ `throwOnError: false`
 * （非法公式回落成源码而不是抛错）；KaTeX 自带对输入的转义。**不加载远程资源** ——
 * 字体随 `katex.min.css` 打进 bundle（两端构建各自处理资产）。
 *
 * 回退：解析失败时把 `$…$` 原文按行内代码渲染（可见、可复制），不留空白。
 * 行内规则刻意保守：`$` 后紧跟空白不算公式（「花费 $5 元」这类文本不会被误吃），
 * 收尾 `$` 前是空白也不算 —— 与 GitHub / KaTeX 的常见口径一致。
 */
import katex from 'katex'
import type { MarkdownIt, RendererRule, StateBlock, StateInline } from 'markdown-it'

export const MATH_INLINE_TOKEN = 'md_math_inline'
export const MATH_BLOCK_TOKEN = 'md_math_block'

const DOLLAR = 0x24
const BACKSLASH = 0x5c
const SPACE = 0x20
const TAB = 0x09

/** KaTeX 渲染；失败返回空串（调用方回落源码） */
function renderTex(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      strict: false,
      trust: false,
      output: 'html',
    })
  } catch {
    return ''
  }
}

/** 块级 `$$…$$`：同一行闭合，或跨行直到 `$$` 所在行 */
function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const start = state.bMarks[startLine] ?? 0
  const first = start + (state.tShift[startLine] ?? 0)
  const lineEnd = state.eMarks[startLine] ?? 0
  if (state.src.slice(first, first + 2) !== '$$') return false
  if (state.src.charCodeAt(first + 2) === DOLLAR) return false // `$$$` 不认

  let text = state.src.slice(first + 2, lineEnd)
  let lastLine = startLine
  let found = text.indexOf('$$') >= 0
  if (found) {
    text = text.slice(0, text.indexOf('$$'))
  } else {
    const parts = [text]
    for (let line = startLine + 1; line < endLine; line += 1) {
      const ls = (state.bMarks[line] ?? 0) + (state.tShift[line] ?? 0)
      const le = state.eMarks[line] ?? 0
      const src = state.src.slice(ls, le)
      const close = src.indexOf('$$')
      if (close >= 0) {
        parts.push(src.slice(0, close))
        lastLine = line
        found = true
        break
      }
      parts.push(src)
      lastLine = line
    }
    text = parts.join('\n')
  }
  if (!found) return false
  if (silent) return true

  const token = state.push(MATH_BLOCK_TOKEN, 'div', 0)
  token.content = text.trim()
  token.map = [startLine, lastLine + 1]
  state.line = lastLine + 1
  return true
}

/** 行内 `$…$`（`$` 后 / 收尾 `$` 前不许是空白；`\$` 已由 escape 规则吃掉） */
function mathInline(state: StateInline, silent: boolean): boolean {
  const start = state.pos
  if (state.src.charCodeAt(start) !== DOLLAR) return false
  if (state.src.charCodeAt(start + 1) === DOLLAR) return false
  const firstChar = state.src.charCodeAt(start + 1)
  if (firstChar === SPACE || firstChar === TAB) return false

  const max = state.posMax
  let pos = start + 1
  while (pos < max) {
    const code = state.src.charCodeAt(pos)
    if (code === BACKSLASH) {
      pos += 2
      continue
    }
    if (code === DOLLAR) {
      const prev = state.src.charCodeAt(pos - 1)
      if (prev === SPACE || prev === TAB) {
        pos += 1
        continue
      }
      const tex = state.src.slice(start + 1, pos)
      if (tex.trim() === '') return false
      if (!silent) {
        const token = state.push(MATH_INLINE_TOKEN, 'span', 0)
        token.content = tex
      }
      state.pos = pos + 1
      return true
    }
    pos += 1
  }
  return false
}

export function mathPlugin(md: MarkdownIt): void {
  const inlineRule: RendererRule = (tokens, idx) => {
    const tex = tokens[idx]?.content ?? ''
    const html = renderTex(tex, false)
    if (html === '') {
      return `<code class="md-inline">${md.utils.escapeHtml(`$${tex}$`)}</code>`
    }
    return `<span class="md-math md-math-inline">${html}</span>`
  }

  const blockRule: RendererRule = (tokens, idx) => {
    const tex = tokens[idx]?.content ?? ''
    const html = renderTex(tex, true)
    if (html === '') {
      // 解析失败：原样返回源码块（可复制），不留空白
      return `<pre class="md-code"><code>${md.utils.escapeHtml(`$$\n${tex}\n$$`)}</code></pre>\n`
    }
    return `<div class="md-math md-math-block">${html}</div>\n`
  }

  md.renderer.rules[MATH_INLINE_TOKEN] = inlineRule
  md.renderer.rules[MATH_BLOCK_TOKEN] = blockRule

  md.inline.ruler.after('escape', 'md_math_inline', mathInline)
  md.block.ruler.before('fence', 'md_math_block', mathBlock, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  })
}
