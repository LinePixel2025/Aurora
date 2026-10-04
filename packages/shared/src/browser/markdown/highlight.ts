/**
 * 语法高亮（P1，docs/07 §2.3）：highlight.js **core + 常用语言子集**。
 *
 * 为什么不用全量 hljs：全量注册 ~190 种语言，bundle 体积与注册耗时都会跟着涨，
 * 而对话输出里 99% 的代码块集中在下面这十几种；需要更多语言时在这里补一行即可。
 * 为什么不用 Shiki：Shiki 按"快照"渲染（异步 + 加载 TextMate 语法），对流式渲染里
 * **逐帧重解析当前消息**的形态太重；hljs 的同步高亮一次 <1ms（50KB 级文本）。
 *
 * 主题配色**不用** hljs 官方主题 CSS（那是定死的亮/暗两份）：token 颜色在 md.css 里
 * 用 `--md-*` 局部变量定义，随两端主题走（Apple 风克制的低饱和配色）。
 */
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

/* 单例只注册一次（模块级副作用，import 即完成 —— 渲染层bundle 里只有这一份）。 */
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('json', json)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('css', css)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('diff', diff)
hljs.registerLanguage('java', java)
hljs.registerLanguage('c', c)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('csharp', csharp)
hljs.registerLanguage('go', go)
hljs.registerLanguage('rust', rust)

/** 常用别名（写代码块的人不会都写全名：ts / py / sh / js…） */
hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' })
hljs.registerAliases(['ts', 'tsx', 'mts', 'cts'], { languageName: 'typescript' })
hljs.registerAliases(['py'], { languageName: 'python' })
hljs.registerAliases(['sh', 'zsh', 'console', 'shell-session'], { languageName: 'bash' })
hljs.registerAliases(['yml'], { languageName: 'yaml' })
hljs.registerAliases(['htm', 'vue', 'svg'], { languageName: 'xml' })
hljs.registerAliases(['cs'], { languageName: 'csharp' })
hljs.registerAliases(['c++'], { languageName: 'cpp' })

/**
 * 高亮一段代码，返回 **已转义** 的 HTML（hljs 的输出就是转义后的，直接进 `<code>`）。
 * 语言未知 / 高亮抛错 / 输入超限时回落为纯转义文本 —— 高亮失败绝不吞掉代码本身。
 *
 * **性能边界（2026-10-04 性能轮）**：
 * - `MAX_HIGHLIGHT_CHARS`：超过就完全不高亮。实测 45KB TypeScript 单次高亮约 145ms，
 *   流式期间整块重跑会让主线程饱和（长代码块是 O(n²) 的主要来源）。
 * - `AUTO_HIGHLIGHT_MAX_CHARS`：语言未知时不再对长文本调 `highlightAuto`（它要遍历
 *   全部注册语言，实测 5KB 就要约 300ms）；只在很短的片段上保留自动识别。
 */

/** 单次高亮的输入上限（字符）；超过直接按纯文本转义 */
export const MAX_HIGHLIGHT_CHARS = 40_000

/** 语言未知时允许 `highlightAuto` 的最大输入（字符）；超过一律纯文本 */
export const AUTO_HIGHLIGHT_MAX_CHARS = 2_000

export function highlightCode(code: string, lang: string | undefined): string {
  if (code.length > MAX_HIGHLIGHT_CHARS) return escapeForCode(code)
  if (lang !== undefined && lang !== '' && hljs.getLanguage(lang) !== undefined) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
    } catch {
      // fall through：语言注册了但某段输入触发解析错误（罕见），按无语言处理
    }
  }
  if (code.length <= AUTO_HIGHLIGHT_MAX_CHARS) {
    try {
      return hljs.highlightAuto(code).value
    } catch {
      /* fall through */
    }
  }
  return escapeForCode(code)
}

/** 与 markdown-it 内部同一套转义口径，兜底用 */
function escapeForCode(code: string): string {
  return code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
