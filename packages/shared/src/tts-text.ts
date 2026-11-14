/**
 * TTS 朗读文本清洗与分块（docs/06 §13.4 / §13.8，v43）。
 *
 * 纯函数、无 Node / DOM 依赖：主进程（`synthesize` / `test` 入口）与两端渲染层
 * （桌面 `useTts` / Center Web 朗读）共用同一份。**清洗是幂等的**：
 * 渲染层分块前清洗一次、主进程入口再清洗一次，两次 = 一次，不会互相改写。
 *
 * 清洗只删标记不改写内容：代码块 / 图片 / 裸 URL 整删，链接留文字，
 * Markdown 标记剥离。`[excited]` 这类情感标签不是链接语法，原样保留
 * （Qwen-Audio-TTS 支持文本内情感标签，docs/06 §13.7）。
 */

/** 首块目标字符数：刻意小，让「合成完第一块就开播」的等待最短。 */
export const TTS_FIRST_CHUNK_CHARS = 120
/** 后续块目标字符数：远低于 qwen-tts 系单请求 512 Token / 600 字符上限。 */
export const TTS_CHUNK_CHARS = 300

/** 句界字符：分块优先落在这些字符之后（自然句读，播放衔接听起来是正常停顿）。 */
const SENTENCE_BOUNDARIES = '。！？!?；;…'

/**
 * 清洗朗读文本（幂等）。顺序刻意：先删整块（代码围栏 / 图片 / 链接 / URL），
 * 再剥行内标记 —— 反过来会把代码里的 `*` 当强调误剥。
 */
export function cleanTtsText(text: string): string {
  let out = text
  // 围栏代码块整段删除（配对围栏；落单的围栏行随后按行删）
  out = out.replace(/```[\s\S]*?```/g, '')
  out = out.replace(/~~~[\s\S]*?~~~/g, '')
  out = out.replace(/^[ \t]*(```|~~~)[^\n]*$/gm, '')
  // 图片整删（先于链接：![alt](url) 比 [text](url) 多一个 !）
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  // 链接留文字：[text](url) 与参考式 [text][ref]
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  out = out.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
  // 裸 URL：只认 ASCII URL 字符集，遇到中文即停（\S 会把中文一起吞掉）
  out = out.replace(/https?:\/\/[A-Za-z0-9\-._~:/?#@!$&'*+,;=%[\]()]+/g, '')
  // HTML 标签
  out = out.replace(/<[^>\n]+>/g, '')
  // 行内代码：保留内容、去掉反引号
  out = out.replace(/`([^`\n]*)`/g, '$1')
  // 块级行标记：标题 / 引用 / 列表 / 水平线 / 表格分隔行
  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
  out = out.replace(/^[ \t]{0,3}>[ \t]?/gm, '')
  out = out.replace(/^[ \t]*[-*+][ \t]+/gm, '')
  out = out.replace(/^[ \t]*\d+[.)][ \t]+/gm, '')
  out = out.replace(/^[ \t]{0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/gm, '')
  out = out.replace(/^[ \t]*\|[-| :]*\|[ \t]*$/gm, '')
  // 表格竖线 → 空格（单元格之间留个停顿）
  out = out.replace(/\|/g, ' ')
  // 强调 / 删除线：成对标记剥离、内容保留（先双后单，避免 ** 被当成两个 *）
  out = out.replace(/(\*\*|__)([\s\S]*?)\1/g, '$2')
  out = out.replace(/~~([\s\S]*?)~~/g, '$1')
  out = out.replace(/\*([^*\n]+)\*/g, '$1')
  // 单下划线斜体：两侧不能是词字符（保住 snake_case 标识符）
  out = out.replace(/(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/g, '$1')
  // Markdown 转义还原
  out = out.replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, '$1')
  // 空白折叠：换行 → 空格（句读交给标点），连续空白合一
  out = out.replace(/\s*\n\s*/g, ' ')
  out = out.replace(/[ \t]+/g, ' ')
  return out.trim()
}

/**
 * 清洗 → 总量截断到 maxChars → 按句界分块。
 *
 * - 总量上限在**分块前**执行：`maxChars` 是隐私边界（docs/11 §4），
 *   分块只是把「一次出网」变成「多次出网」，总字数不许多；
 * - 首块 ≤ TTS_FIRST_CHUNK_CHARS（任何句界都接受，尽早开播）；
 *   后续块 ≤ TTS_CHUNK_CHARS，句界落在窗口后半才接受（否则硬切，
 *   避免为保句读切出十几字的碎块、徒增请求数）；
 * - 返回的每块都已 trim；空文本 / 全标记文本返回空数组。
 */
export function splitTtsText(text: string, options: { maxChars: number }): string[] {
  const cleaned = cleanTtsText(text)
  const maxChars = Math.max(1, Math.floor(options.maxChars))
  const capped = cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned
  if (capped.trim() === '') return []

  const chunks: string[] = []
  let rest = capped
  let first = true
  while (rest.length > 0) {
    const limit = first ? TTS_FIRST_CHUNK_CHARS : TTS_CHUNK_CHARS
    first = false
    if (rest.length <= limit) {
      chunks.push(rest.trim())
      break
    }
    // 在 [0, limit) 窗口里找最后一个句界（句界字符本身归上一块）
    let cut = -1
    for (let i = limit - 1; i >= 0; i -= 1) {
      if (SENTENCE_BOUNDARIES.includes(rest[i]!)) {
        cut = i + 1
        break
      }
    }
    // 首块接受任何句界；后续块句界太靠前（< 半窗）宁可硬切
    if (cut <= 0 || (chunks.length > 0 && cut < limit / 2)) cut = limit
    const piece = rest.slice(0, cut).trim()
    if (piece !== '') chunks.push(piece)
    rest = rest.slice(cut)
  }
  return chunks.filter((chunk) => chunk !== '')
}