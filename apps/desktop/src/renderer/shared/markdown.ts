/** 极简 Markdown 渲染（P1 范围：标题 / 列表 / 代码块 / 行内代码 / 加粗）。
 *
 * 为什么不用现成库：P2 要求"Markdown 渲染"先能跑通，P3 会换成完整渲染器；
 * 这里先做最小实现，避免为占位回复引入重量级依赖。
 * 注意：输出经过 HTML 转义，先转义再套用标记，避免 XSS。
 */
export function renderMarkdown(source: string): string {
  const escaped = escapeHtml(source)
  const blocks = escaped.split(/```/)

  return blocks
    .map((block, index) => {
      if (index % 2 === 1) {
        const [firstLine = '', ...rest] = block.split('\n')
        const language = /^[a-zA-Z0-9+#-]*$/.test(firstLine.trim()) ? firstLine.trim() : ''
        const code = language === '' ? block : rest.join('\n')
        return `<pre class="md-code"><code data-lang="${language}">${code.replace(/\n$/, '')}</code></pre>`
      }
      return renderInline(block)
    })
    .join('')
}

function renderInline(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let listOpen = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') {
      if (listOpen) {
        out.push('</ul>')
        listOpen = false
      }
      out.push('<br />')
      continue
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed)
    if (heading) {
      if (listOpen) {
        out.push('</ul>')
        listOpen = false
      }
      const level = heading[1]?.length ?? 1
      out.push(`<h${level + 2} class="md-h">${inline(heading[2] ?? '')}</h${level + 2}>`)
      continue
    }

    const bullet = /^[-*]\s+(.*)$/.exec(trimmed)
    if (bullet) {
      if (!listOpen) {
        out.push('<ul class="md-list">')
        listOpen = true
      }
      out.push(`<li>${inline(bullet[1] ?? '')}</li>`)
      continue
    }

    if (listOpen) {
      out.push('</ul>')
      listOpen = false
    }
    out.push(`<p class="md-p">${inline(trimmed)}</p>`)
  }

  if (listOpen) out.push('</ul>')
  return out.join('')
}

function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '<code class="md-inline">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(https?:\/\/[^\s<]+)/g, '<span class="md-link">$1</span>')
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
