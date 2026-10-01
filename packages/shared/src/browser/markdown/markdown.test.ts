/**
 * Markdown 渲染器单测（docs/07 §2.3）：输出契约 + XSS 安全基线。
 *
 * 安全基线是最重要的一组：`html:false` + validateLink 白名单 —— 模型原文里的
 * HTML / 事件属性 / 危险 scheme 一律不得以可执行形态出现在输出里。
 */
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './index.js'
import { renderCodeBlock } from './codeBlock.js'

describe('输出契约（两端共用的类名）', () => {
  it('标题：# 映射为 h3 且带 .md-h（对话正文不与大标题抢层级）', () => {
    expect(renderMarkdown('# 标题')).toContain('<h3 class="md-h">标题</h3>')
    expect(renderMarkdown('#### 小节')).toContain('<h6 class="md-h">小节</h6>')
  })

  it('段落 / 行内代码 / 加粗 / 删除线', () => {
    const html = renderMarkdown('正文 **重点** 与 `code` 与 ~~划掉~~')
    expect(html).toContain('<p class="md-p">')
    expect(html).toContain('<strong>重点</strong>')
    expect(html).toContain('<code class="md-inline">code</code>')
    expect(html).toContain('<s>划掉</s>')
  })

  it('无序 / 有序列表：.md-list，有序另加 .md-ol', () => {
    expect(renderMarkdown('- 甲\n- 乙')).toContain('<ul class="md-list">')
    const ol = renderMarkdown('1. 一\n2. 二')
    expect(ol).toContain('<ol class="md-list md-ol">')
  })

  it('GFM 表格：.md-table-wrap 包横向滚动容器，非默认对齐进 th 的 style', () => {
    const html = renderMarkdown('| 左 | 中 |\n| --- | :-: |\n| a | b |')
    expect(html).toContain('<div class="md-table-wrap"><table class="md-table">')
    // markdown-it 只给非默认对齐写 style；左对齐由 md.css 的 th/td 基线提供
    expect(html).toContain('<th>左</th>')
    expect(html).toContain('<th style="text-align:center">中</th>')
    expect(html).toContain('<td>a</td>')
  })

  it('引用块 .md-quote；水平线 .md-hr', () => {
    expect(renderMarkdown('> 引用一句')).toContain('<blockquote class="md-quote">')
    expect(renderMarkdown('---')).toContain('<hr class="md-hr">')
  })

  it('链接：外链 target=_blank + rel 防钓鱼；裸 URL linkify 成 <a class="md-link">', () => {
    const html = renderMarkdown('[官网](https://aurora.example) 与 https://example.com/x')
    expect((html.match(/<a /g) ?? []).length).toBe(2)
    expect((html.match(/target="_blank" rel="noopener noreferrer nofollow"/g) ?? []).length).toBe(2)
    expect((html.match(/class="md-link"/g) ?? []).length).toBe(2)
    expect(html).toContain('href="https://aurora.example"')
  })

  it('代码块：.code-block 复制按钮壳 + data-lang + hljs 高亮 token', () => {
    const html = renderMarkdown('```js\nconst x = 1\n```')
    expect(html).toContain('<div class="code-block">')
    expect(html).toContain('class="code-copy"')
    expect(html).toContain('data-lang="js"')
    expect(html).toContain('<code class="hljs">')
    expect(html).toContain('hljs-keyword')
  })

  it('未知语言的代码块：正文照常转义保留（高亮失败不吞代码）', () => {
    const html = renderMarkdown('```notalang\n<b>&ok</b>\n```')
    // 正文必须原样转义保留（不吞代码、不注入可执行标签）
    expect(html).toContain('&lt;')
    expect(html).toContain('&amp;ok')
    expect(html).not.toContain('<b>')
    expect(html).toContain('data-lang="notalang"')
  })

  it('任务列表：只读 checkbox，[x] 带勾选与删除线类', () => {
    const html = renderMarkdown('- [ ] 待办\n- [x] 已完成')
    expect(html).toContain('<li class="md-task">')
    expect(html).toContain('<input type="checkbox" disabled="">')
    expect(html).toContain('<li class="md-task md-task-done">')
    expect(html).toContain('<input type="checkbox" disabled="" checked="">')
  })

  it('提示块：[!NOTE] → .md-admonition-note + 标题；未知标记走普通引用', () => {
    const html = renderMarkdown('> [!WARNING]\n> 小心操作')
    expect(html).toContain('md-admonition md-admonition-warning')
    expect(html).toContain('<p class="md-admonition-title">Warning</p>')
    expect(html).toContain('小心操作')
    const plain = renderMarkdown('> 普通引用')
    expect(plain).not.toContain('md-admonition')
  })

  it('提示块带尾注标题：`> [!TIP] 注意事项` 的尾注成为标题文本', () => {
    const html = renderMarkdown('> [!TIP] 注意事项\n> 正文')
    expect(html).toContain('<p class="md-admonition-title">注意事项</p>')
    expect(html).toContain('md-admonition-tip')
  })
})

describe('数学公式（P2，KaTeX）', () => {
  it('行内 $...$ 与块级 $$...$$ 渲染为 KaTeX 结构', () => {
    const inline = renderMarkdown('公式 $a^2 + b^2 = c^2$ 结束')
    expect(inline).toContain('<span class="md-math md-math-inline">')
    expect(inline).toContain('class="katex"')
    const block = renderMarkdown(['$$', 'E = mc^2', '$$', ''].join('\n'))
    expect(block).toContain('<div class="md-math md-math-block">')
    expect(block).toContain('katex-display')
  })

  it('非法公式降级不空白：KaTeX 以 katex-error 显示源码（throwOnError:false）', () => {
    const html = renderMarkdown('$' + String.raw`\frac{1}{` + '$ 结尾')
    // 不抛错、原文可见（红字提示），且不允许出现可执行内容
    expect(html).toContain('katex-error')
    expect(html).toContain(String.raw`\frac{1}{`)
    expect(html).not.toContain('<script')
  })

  it('货币写法不误判为公式（$ 后紧跟空白不认）', () => {
    const html = renderMarkdown('这件商品 $ 100 元')
    expect(html).not.toContain('katex')
  })
})

describe('图表占位（P2：mermaid / echarts，真渲染在水合层）', () => {
  it('```mermaid 产出占位结构：源码转义保留 + 工具栏 + pending 态', () => {
    const html = renderMarkdown(
      ['```mermaid', 'flowchart LR', '  A[开始] --> B[结束]', '```', ''].join('\n'),
    )
    expect(html).toContain('class="md-chart" data-chart="mermaid" data-state="pending"')
    expect(html).toContain('class="md-chart-stage"')
    expect(html).toContain('data-chart-action="copy"')
    expect(html).toContain('A[开始] --&gt; B[结束]')
    expect(html).not.toContain('<svg')
  })

  it('```echarts 同款占位；注入尝试被转义（不留可执行标签）', () => {
    const html = renderMarkdown(
      ['```echarts', '{"xAxis":1} <script>alert(1)</script>', '```', ''].join('\n'),
    )
    expect(html).toContain('data-chart="echarts"')
    expect(html).not.toContain('<script>')
  })
})

describe('安全基线（XSS：先转义、后白名单）', () => {
  it('裸 HTML 标签整体转义成纯文本（html:false）', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('链接里的 javascript: scheme 被拒绝（不产出可执行 href）', () => {
    const html = renderMarkdown('[点我](javascript:alert(1))')
    expect(html).not.toContain('href="javascript:')
    // 原文以文本形式可见（转义输出），但不可点击执行
    expect((html.match(/<a /g) ?? []).length).toBe(0)
  })

  it('行内 HTML 借道链接文本 / 表格也不会逃逸', () => {
    const html = renderMarkdown('[a](https://x) <script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('图片不渲染为 <img>（CSP img-src 白名单会拦远程图）：降级为链接 chip', () => {
    const html = renderMarkdown('![示意](https://cdn.example/a.png)')
    expect(html).not.toContain('<img')
    expect(html).toContain('md-image-link')
    expect(html).toContain('href="https://cdn.example/a.png"')
    expect(html).toContain('示意')
  })
})

describe('代码块壳（renderCodeBlock）', () => {
  it('已转义的正文 + 可选语言属性', () => {
    const withLang = renderCodeBlock('<span class="hljs-keyword">const</span>', 'ts')
    expect(withLang).toContain('data-lang="ts"')
    const noLang = renderCodeBlock('plain', undefined)
    expect(noLang).not.toContain('data-lang')
    expect(noLang).toContain('plain')
  })
})

describe('流式与入参健壮性', () => {
  it('空串 / undefined / 非字符串返回空（流式管线不因空消息炸掉）', () => {
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown(undefined)).toBe('')
    expect(renderMarkdown(null)).toBe('')
  })

  it('半截的表格 / 未闭合栅栏按纯文本渲染，不抛错（流式中途的常态）', () => {
    expect(() => renderMarkdown('| a | b |\n| --- |')).not.toThrow()
    expect(() => renderMarkdown('```js\nconst x =')).not.toThrow()
    expect(renderMarkdown('```js\nconst x =')).toContain('md-code')
  })
})
