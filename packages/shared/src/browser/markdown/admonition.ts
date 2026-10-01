/**
 * 提示块（admonition，P1）：GitHub Alerts 语法的自写实现，零额外依赖。
 *
 * 识别块引用**首行**的 `[!NOTE]` / `[!TIP]` / `[!WARNING]` / `[!CAUTION]` / `[!IMPORTANT]`
 * （`[!INFO]` 作为 NOTE 的别名）。命中时把整个块引用渲染成
 *
 * ```html
 * <blockquote class="md-quote md-admonition md-admonition-note">
 *   <p class="md-admonition-title">Note</p> …正文…
 * </blockquote>
 * ```
 *
 * 未命中首行标记的块引用照常走 `.md-quote`。实现是 **core 后处理**：检查 blockquote 的
 * token 流、改 class 并插入一个标题 token —— 标题由本插件注册的 renderer 规则渲染
 * （`escapeHtml` 后输出，正文内容不进标题）。不引入 markdown-it-container：
 * 模型输出里 `> [!NOTE]`（GitHub Alerts）的频率远高于 `:::note` 围栏。
 */
import type { MarkdownIt, RendererRule, StateCore } from 'markdown-it'

export const ADMONITION_KINDS = ['note', 'tip', 'warning', 'caution', 'important', 'info'] as const

/** 首行 `[!NOTE]` 之类 + 可选的同行尾注标题；大小写不敏感 */
const PATTERN = /^\[!(NOTE|TIP|WARNING|CAUTION|IMPORTANT|INFO)\]\s*(.*)$/i

/** 渲染后的展示名（info 归并为 note） */
const DISPLAY: Record<string, string> = {
  note: 'Note',
  tip: 'Tip',
  warning: 'Warning',
  caution: 'Caution',
  important: 'Important',
  info: 'Note',
}

const TITLE_TOKEN_TYPE = 'md_admonition_title'

export function admonitionPlugin(md: MarkdownIt): void {
  const titleRule: RendererRule = (tokens, idx) => {
    const token = tokens[idx]
    const text = token?.content ?? ''
    return `<p class="md-admonition-title">${md.utils.escapeHtml(text)}</p>`
  }
  md.renderer.rules[TITLE_TOKEN_TYPE] = titleRule

  md.core.ruler.push('md_admonition', (state: StateCore) => {
    const tokens = state.tokens
    for (let i = 0; i < tokens.length; i += 1) {
      const open = tokens[i]
      if (open === undefined || open.type !== 'blockquote_open') continue
      // 找这个 blockquote 的关闭 token（嵌套时按 depth 对齐）
      let depth = 0
      let closeIndex = -1
      for (let j = i + 1; j < tokens.length; j += 1) {
        const type = tokens[j]?.type
        if (type === 'blockquote_open') depth += 1
        else if (type === 'blockquote_close') {
          if (depth === 0) {
            closeIndex = j
            break
          }
          depth -= 1
        }
      }
      if (closeIndex === -1) continue

      let inlineIndex = -1
      for (let j = i + 1; j < closeIndex; j += 1) {
        if (tokens[j]?.type === 'inline') {
          inlineIndex = j
          break
        }
      }
      const inline = inlineIndex === -1 ? undefined : tokens[inlineIndex]
      if (inline === undefined) continue

      // inline.content 是**原始**文本（渲染前），可以安全匹配
      const lines = inline.content.split('\n')
      const match = PATTERN.exec((lines[0] ?? '').trim())
      if (match === null) continue

      const kind = (match[1] ?? 'note').toLowerCase()
      const canonical = kind === 'info' ? 'note' : kind
      const rest = (match[2] ?? '').trim()
      const titleText = rest === '' ? (DISPLAY[kind] ?? 'Note') : rest

      open.attrJoin('class', `md-admonition md-admonition-${canonical}`)

      // 首行整行吃掉后正文为空：连 paragraph 三件套一起摘掉，不留空 <p>
      const remaining = lines.slice(1).join('\n')
      if (remaining.trim() === '') {
        const openIndex = inlineIndex - 1
        const closeIdx = inlineIndex + 1
        const isParagraph =
          tokens[openIndex]?.type === 'paragraph_open' &&
          tokens[closeIdx]?.type === 'paragraph_close'
        if (isParagraph) {
          tokens.splice(inlineIndex - 1, 3)
        }
      } else {
        // 渲染走的是已解析的 **children**（改 content 无效）：标记行是纯文本，
        // 必然落在首个 text 子 token 里 —— 在那里把它剥掉。
        const first = inline.children?.[0]
        const firstLine = lines[0] ?? ''
        if (first !== undefined && first.type === 'text' && firstLine !== '') {
          first.content = first.content.replace(firstLine, '')
          const children = inline.children ?? []
          if (first.content.trim() === '') {
            children.shift()
            // 标题后面紧跟的软换行一并去掉，正文直接从标题下开始
            if (children[0]?.type === 'softbreak') children.shift()
          }
        }
      }

      const titleToken = new state.Token(TITLE_TOKEN_TYPE, '', 0)
      titleToken.content = titleText
      tokens.splice(i + 1, 0, titleToken)
    }
  })
}
