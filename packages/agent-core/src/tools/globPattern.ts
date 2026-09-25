/**
 * glob 模式编译器（docs/06 §11.5）。
 *
 * 一份实现、三个消费方：`grep` 的 `include` 过滤 / `glob` 工具（`search.ts`）、
 * 主进程递归遍历（`apps/desktop/src/main/tools/file-port.ts`）、
 * `run_command` 免确认模式匹配（`command-allow.ts`）——**不要另写第二份匹配逻辑**。
 *
 * 纯函数、零依赖、可在 Node 里完整单测（`globPattern.test.ts`）。
 *
 * ⚠️ 本文件的**块注释里不许出现** `*` 紧跟 `/` 的字符序列（含写成 `**` + `/` 或 `.*` + `/` 的
 * 正则片段）：那会提前结束块注释，报 `TS1109` 且位置极具误导性。要写这类片段一律用行注释。
 */

/** 模式长度上限（路径模式与命令模式共用） */
export const MAX_GLOB_LENGTH = 200

export interface GlobOptions {
  /**
   * `true`（缺省）：路径模式——`*` 与 `?` **不跨路径分隔符**，模式与输入里的反斜杠都归一为正斜杠；
   * `false`：纯文本模式——`*` 匹配任意字符（含空格与斜杠），反斜杠原样保留（供命令串匹配）。
   */
  pathMode?: boolean
  /** 缺省 `true`（Windows 口径：文件系统大小写不敏感） */
  caseInsensitive?: boolean
}

/**
 * 编译成**全串锚定**的正则。
 *
 * 转换规则与顺序见 `scanGlob` 的行注释（那里用行注释写正则片段，避免块注释被提前结束）。
 * 未配对的花括号按**字面字符**处理（不抛异常）——合法性判断交给 `isValidGlobPattern`。
 */
export function compileGlob(pattern: string, options: GlobOptions = {}): RegExp {
  const pathMode = options.pathMode !== false
  const flags = options.caseInsensitive === false ? '' : 'i'
  return new RegExp(`^${scanGlob(pattern, pathMode, true)}$`, flags)
}

/**
 * 全串匹配。匹配前对 `value` 做归一：`pathMode` 下反斜杠 → 正斜杠、折叠重复的正斜杠；
 * 文本模式**不做任何归一**（命令串里的反斜杠是内容的一部分）。
 */
export function matchesGlob(pattern: string, value: string, options: GlobOptions = {}): boolean {
  return compileGlob(pattern, options).test(normalizeGlobValue(value, options))
}

/**
 * 模式是否「形状合法」：非空、长度不超 `MAX_GLOB_LENGTH`、花括号配对。
 *
 * **不检查「是否含字面字符」** —— 那是 `command-allow.ts` 对免确认列表的额外规则
 * （纯通配的路径模式本身是合法的）。
 */
export function isValidGlobPattern(pattern: string): boolean {
  if (typeof pattern !== 'string') return false
  if (pattern.trim() === '') return false
  if (pattern.length > MAX_GLOB_LENGTH) return false
  return bracesPaired(pattern)
}

/**
 * 逐个字符扫描成**未锚定**的正则源码（顺序敏感，按下面行注释的次序实现）。
 *
 * 用一遍扫描而不是"先整体转义再把通配符换回"，是为了让「双星号 + 斜杠」这条必须在
 * 单星号之前判定的规则天然成立——两遍替换法很容易在这里写错。
 * `allowBraces` 为假时把 `{` 当字面量（花括号内**不做嵌套**，不支持 `{a,{b,c}}`）。
 */
function scanGlob(pattern: string, pathMode: boolean, allowBraces: boolean): string {
  const anyOne = pathMode ? '[^/]' : '.'
  const anyMany = pathMode ? '[^/]*' : '.*'
  let out = ''
  let index = 0
  while (index < pattern.length) {
    const char = pattern[index] ?? ''
    // 路径模式下反斜杠与斜杠都是分隔符（输入值也按正斜杠归一过）
    if (char === '\\' && pathMode) {
      out += '/'
      index += 1
      continue
    }
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        // 规则 2（必须最先处理）：双星号紧跟斜杠 → 任意层目录，**含零层**
        // 编译成 `(?:` + `.*` + `/)?`；不先处理它的话 `src/` 下的「双星号 / 星号」模式会漏掉 `src/a.ts`
        if (pathMode && pattern[index + 2] === '/') {
          out += '(?:.*/)?'
          index += 3
          continue
        }
        // 规则 3：其余双星号 → 任意字符序列
        out += '.*'
        index += 2
        continue
      }
      // 规则 4：单星号 → 路径模式下不跨斜杠，文本模式下任意字符
      out += anyMany
      index += 1
      continue
    }
    // 规则 5：问号 → 恰好一个字符
    if (char === '?') {
      out += anyOne
      index += 1
      continue
    }
    // 规则 6：`{a,b,c}` → 交替组；未配对时按字面字符处理
    if (char === '{' && allowBraces) {
      const close = pattern.indexOf('}', index + 1)
      if (close !== -1) {
        const parts = pattern
          .slice(index + 1, close)
          .split(',')
          .map((part) => scanGlob(part, pathMode, false))
        out += `(?:${parts.join('|')})`
        index = close + 1
        continue
      }
    }
    // 规则 1：其余字符一律按字面处理（正则元字符转义），避免 `a.b` 命中 `axb`
    out += escapeRegexChar(char)
    index += 1
  }
  return out
}

function normalizeGlobValue(value: string, options: GlobOptions): string {
  if (options.pathMode === false) return value
  return value.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
}

/** 花括号是否配对（`}` 出现在 `{` 之前、或结束时深度不为 0 即不配对） */
function bracesPaired(pattern: string): boolean {
  let depth = 0
  for (const char of pattern) {
    if (char === '{') depth += 1
    else if (char === '}') {
      if (depth === 0) return false
      depth -= 1
    }
  }
  return depth === 0
}

/** 转义单个正则元字符 */
function escapeRegexChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char
}
