/**
 * 搜索类工具 `grep` / `glob`（docs/06 §11.5、§20）。
 *
 * 分层与 `files.ts` / `terminal.ts` 同一套：内核只做参数校验与结果渲染，
 * 真正的递归遍历在主进程（`apps/desktop/src/main/tools/file-port.ts`）经 `FilePort` 注入，
 * 因此本文件保持纯 Node、可在 Node 里完整单测（`search.test.ts`，全程不碰磁盘）。
 *
 * 两个工具都是 `sensitivity: 'safe'`（只读、不弹确认），但**只读不等于无开销**：
 * 它们会递归扫描整个搜索根（自动跳过 `DEFAULT_SEARCH_IGNORE` 里的目录与二进制文件）。
 * 模式匹配一律复用 `globPattern.ts`（**不要另写第二份匹配逻辑**）；
 * 结果上限、单行长度、预算等常量一律来自 `files.ts`（与主进程实现共用一份）。
 *
 * `grep` 另有一道**静态过滤**：拒绝「嵌套无界量词」形态的正则（`describeQuantifierNestingError`）。
 * 它是第一道防线——`grep` 是 `safe` 级（不弹确认），而 `regex.test` 是**同步**调用，
 * 回溯型模式（形如 (a+)+）撞上长重复行时单次 `test` 就能把主进程事件循环占满（窗口无响应）。
 * 第二道是主进程的墙钟预算护栏（`file-port.ts` 的 `SEARCH_TIME_BUDGET_MS`，遍历层面到点即停），
 * 但**单次 `test` 一旦开始就无法打断**，所以这一层静态过滤必须存在。
 *
 * ⚠️ 本文件的**块注释里不许出现**星号紧跟斜杠的字符序列（模式示例一律写进字符串或行注释）：
 * 那会提前结束块注释，报 `TS1109` 且位置极具误导性。
 */
import {
  DEFAULT_SEARCH_MAX_RESULTS,
  MAX_MATCH_LINE_CHARS,
  MAX_SEARCH_MAX_RESULTS,
  outsideGuard,
} from './files.js'
import type { FilePort, FindFilesResult, SearchMatch, SearchTextResult } from './files.js'
import { isValidGlobPattern, MAX_GLOB_LENGTH } from './globPattern.js'
import type { ToolDefinition, ToolResult } from './registry.js'

/** `grep.pattern` 的长度上限：正则源码过长多半是误传（与 glob 模式上限同值，但各自独立） */
export const MAX_GREP_PATTERN_LENGTH = 200

/**
 * 缺省搜索根：静态字符串，或**按会话解析**的取值器（docs/06 §5.1 会话级项目）。
 *
 * 取值器形态供装配层注入「会话绑定的项目根 > 全局当前项目 > workspaceDir > 主目录」
 * 的完整回落链（每次工具执行即时调用）；字符串形态保持向后兼容（单测 / 老调用方）。
 */
export type DefaultSearchRoot = string | ((sessionId: string | undefined) => string)

export interface SearchToolOptions {
  files: FilePort
  /** `agent.tools.search.maxResults`（钳制到 1..MAX_SEARCH_MAX_RESULTS） */
  maxResults: number
  /** 搜索根缺省值（装配层注入**生效工作目录**：docs/06 §5.1 回落链 会话项目 > 项目根 > workspaceDir > 主目录） */
  defaultRoot: DefaultSearchRoot
}

/** 解析缺省搜索根（字符串原样返回，取值器按会话现调） */
function resolveDefaultRoot(defaultRoot: DefaultSearchRoot, sessionId: string | undefined): string {
  return typeof defaultRoot === 'function' ? defaultRoot(sessionId) : defaultRoot
}

/**
 * 搜索类工具：`grep` / `glob`，**恰好 2 个**（由 `agent.tools.search.enabled` 分派）。
 *
 * `maxResults` 在工厂里**钳制一次**，两个工具共用同一个值（`glob.limit` 的上限也取它）。
 */
export function createSearchTools(options: SearchToolOptions): ToolDefinition[] {
  const maxResults = clampMaxResults(options.maxResults)
  return [
    createGrepTool(options.files, maxResults, options.defaultRoot),
    createGlobTool(options.files, maxResults, options.defaultRoot),
  ]
}

/**
 * `grep`：正则内容检索（docs/06 §11.5）。
 *
 * 只回带「路径 + 行号 + 命中行」与条数统计，**不提供计数功能**——
 * 要统计命中数量得用 `run_command`（逐次确认），因此 description 里明确拒掉这个期待。
 * 参数非法（空 / 超长 / 编译不过 / 嵌套无界量词 / `include` 超长）一律 `isError` 且**不触碰端口**。
 */
function createGrepTool(
  files: FilePort,
  maxResults: number,
  defaultRoot: DefaultSearchRoot,
): ToolDefinition {
  return {
    name: 'grep',
    description: [
      '按正则表达式检索文件内容，返回每个命中处的「文件路径 + 行号 + 命中行」；行号与 read_file 的行号前缀同一口径，拿到位置后用 read_file 的 offset 精确读那一段。',
      'path 是搜索根（缺省用配置里的默认工作目录），include 是文件名过滤，支持 *.js / *.{ts,tsx} 这类模式。',
      `会自动跳过 node_modules / .git 等目录与二进制文件；结果条数上限 ${maxResults}，超出会明确标注。`,
      '只读工具，不弹确认。不提供计数功能：要统计命中数量请改用 run_command。',
      '不支持「嵌套无界量词」的写法（如 (a+)+、(a*)*），这类模式在长重复行上会触发灾难性回溯、把主进程卡住，会被直接拒绝；请改用更具体的字符类或先缩小搜索范围。',
      '单次搜索还有时间预算：超时会停止扫描并在结果里标注「结果可能不完整」，那时请缩小 path 或 include 重试。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: `要检索的正则表达式源码（不含分隔符），最长 ${MAX_GREP_PATTERN_LENGTH} 字符`,
        },
        path: {
          type: 'string',
          description:
            '搜索根目录（可为相对路径，结果里回带解析后的绝对路径）；缺省用配置里的默认工作目录',
        },
        include: {
          type: 'string',
          description: `只在这些文件里检索：文件名 glob 过滤，如 *.js / *.{ts,tsx}；最长 ${MAX_GLOB_LENGTH} 字符；缺省不过滤`,
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    sensitivity: 'safe',
    execute: async (input, ctx): Promise<ToolResult> => {
      const record = asRecord(input)
      const pattern = readPatternString(record, 'pattern')
      if (pattern === undefined) {
        return {
          content: '缺少参数 pattern（要检索的正则表达式源码）。',
          isError: true,
          summary: '缺少 pattern 参数',
        }
      }
      if (pattern.length > MAX_GREP_PATTERN_LENGTH) {
        return {
          content: `参数 pattern 超长（上限 ${MAX_GREP_PATTERN_LENGTH} 字符）。`,
          isError: true,
          summary: 'pattern 参数超长',
        }
      }
      const reason = describePatternError(pattern)
      if (reason !== undefined) {
        return {
          content: `正则不合法：${reason}`,
          isError: true,
          summary: '正则不合法',
        }
      }
      // 第一道静态过滤：回溯型正则的 `test` 是同步的，一旦开始就会占满主进程事件循环
      const nesting = describeQuantifierNestingError(pattern)
      if (nesting !== undefined) {
        return {
          content: `正则过于复杂：${nesting}`,
          isError: true,
          summary: '正则含嵌套无界量词',
        }
      }

      const root =
        readOptionalString(record, 'path') ?? resolveDefaultRoot(defaultRoot, ctx.sessionId)
      const include = readOptionalString(record, 'include')
      // 与 `pattern` 的长度上限对称：`include` 也是 glob 模式（同一个 `MAX_GLOB_LENGTH`）
      if (include !== undefined && include.length > MAX_GLOB_LENGTH) {
        return {
          content: `参数 include 超长：文件名模式过长（上限 ${MAX_GLOB_LENGTH} 字符）。`,
          isError: true,
          summary: 'include 参数超长',
        }
      }
      try {
        const result = await files.searchText({
          root,
          pattern,
          maxResults,
          ...(include === undefined ? {} : { include }),
          // 放行标记只在已获批准时带；会话 id 在有会话上下文时总是透传（端口按会话解析边界根）
          ...outsideGuard(ctx),
        })
        return renderGrepResult(result, pattern, maxResults)
      } catch (error) {
        return {
          content: `搜索失败：${describeError(error)}`,
          isError: true,
          summary: '搜索失败',
        }
      }
    },
  }
}

/**
 * `glob`：按文件名模式找文件（docs/06 §11.5）。
 *
 * 模式语法与匹配逻辑全部来自 `globPattern.ts`（`include` 过滤、主进程遍历、
 * `run_command` 免确认列表共用同一份），这里只做「长度 + 花括号配对」的合法性把关。
 */
function createGlobTool(
  files: FilePort,
  maxResults: number,
  defaultRoot: DefaultSearchRoot,
): ToolDefinition {
  return {
    name: 'glob',
    description: [
      '按文件名模式查找文件，返回匹配到的文件路径（只回路径、不回内容；要找文件内容请用 grep）。',
      '模式语法：**/*.js 匹配任意层目录（含当前目录一层）、src/**/*.ts 限定起始目录、{a,b} 表示交替、? 匹配单个字符；整体全串匹配、大小写不敏感，正则元字符按字面处理。',
      'path 是搜索根（缺省用配置里的默认工作目录），limit 控制本次最多返回几个文件。',
      `只读工具，不弹确认；会自动跳过 node_modules / .git 等目录，结果上限 ${maxResults} 个。`,
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: `文件名模式，如 **/*.js / src/**/*.ts / *.{ts,tsx}；最长 ${MAX_GLOB_LENGTH} 字符`,
        },
        path: {
          type: 'string',
          description:
            '搜索根目录（可为相对路径，结果里回带解析后的绝对路径）；缺省用配置里的默认工作目录',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: maxResults,
          description: `最多返回的文件数，取值 1–${maxResults}，缺省为 ${maxResults}`,
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    sensitivity: 'safe',
    execute: async (input, ctx): Promise<ToolResult> => {
      const record = asRecord(input)
      const pattern = readPatternString(record, 'pattern')
      if (pattern === undefined) {
        return {
          content: '缺少参数 pattern（文件名模式，如 **/*.js）。',
          isError: true,
          summary: '缺少 pattern 参数',
        }
      }
      if (pattern.length > MAX_GLOB_LENGTH) {
        return {
          content: `参数 pattern 超长（上限 ${MAX_GLOB_LENGTH} 字符）。`,
          isError: true,
          summary: 'pattern 参数超长',
        }
      }
      if (!isValidGlobPattern(pattern)) {
        return {
          content:
            '参数 pattern 非法：花括号不配对（花括号内不支持嵌套，如 {a,{b,c}} 请拆成两条模式）。',
          isError: true,
          summary: 'pattern 参数非法',
        }
      }
      const limit = resolveClamped(record?.['limit'], 1, maxResults, maxResults)
      if (limit === undefined) {
        return {
          content: `参数 limit 必须是数字（1–${maxResults} 的整数）。`,
          isError: true,
          summary: 'limit 参数非法',
        }
      }

      const root =
        readOptionalString(record, 'path') ?? resolveDefaultRoot(defaultRoot, ctx.sessionId)
      try {
        const result = await files.findFiles({
          root,
          pattern,
          maxResults: limit,
          // 与 grep 同款：放行标记仅已获批准时带，sessionId 按会话透传
          ...outsideGuard(ctx),
        })
        return renderGlobResult(result, pattern, limit)
      } catch (error) {
        return {
          content: `查找文件失败：${describeError(error)}`,
          isError: true,
          summary: '查找文件失败',
        }
      }
    },
  }
}

/**
 * 渲染 `grep` 结果（docs/06 §11.5）：头部 `搜索根：<绝对路径>（匹配 n 处，已扫描 m 个文件）`，
 * 正文每行 `<相对路径>:<行号>: <命中行>`，尾部按需追加三种标注。
 *
 * 搜索根一律回带端口解析后的**绝对路径**（越界不静默的既有口径）；
 * 无命中**不是错误**，只是一句「未找到匹配」——模型据此换模式或换搜索根即可。
 */
function renderGrepResult(
  result: SearchTextResult,
  pattern: string,
  maxResults: number,
): ToolResult {
  const head = `搜索根：${result.root}（匹配 ${result.matches.length} 处，已扫描 ${result.scannedFiles} 个文件）`
  const lines = result.matches.map(renderMatch)
  if (lines.length === 0) lines.push(`未找到匹配「${pattern}」的内容。`)
  // 标注只在端口真的报告了对应情况时出现（预算触顶时端口返回的是**已收集的结果**，不是空结果）
  if (result.truncated) {
    lines.push(`…（结果已达上限 ${maxResults} 条，可能还有更多；请缩小 pattern 或 include）…`)
  }
  if (result.budgetExceeded) {
    lines.push(`…（搜索预算已用完，仅扫描了 ${result.scannedFiles} 个文件，结果可能不完整）…`)
  }
  if (result.skippedBinary > 0) {
    lines.push(`（已跳过 ${result.skippedBinary} 个二进制文件）`)
  }
  return {
    content: [head, lines.join('\n')].join('\n\n'),
    summary: result.matches.length === 0 ? '未找到匹配' : `找到 ${result.matches.length} 处匹配`,
  }
}

/**
 * 渲染 `glob` 结果：头部 `搜索根：<绝对路径>（匹配 n 个文件）`，正文每行一个相对路径。
 * 无命中**不是错误**；`truncated`（达上限）与 `budgetExceeded`（遍历预算触顶）都如实标注，
 * 理由是 `FindFilesResult` 带回的是**已收集的结果**——不标注的话模型会把不完整当完整。
 */
function renderGlobResult(result: FindFilesResult, pattern: string, limit: number): ToolResult {
  const head = `搜索根：${result.root}（匹配 ${result.files.length} 个文件）`
  const lines = [...result.files]
  if (lines.length === 0) lines.push(`未找到匹配「${pattern}」的文件。`)
  if (result.truncated) {
    lines.push(`…（已达上限 ${limit} 个，可能还有更多）…`)
  }
  if (result.budgetExceeded) {
    lines.push(`…（搜索预算已用完，仅扫描了 ${result.scannedFiles} 个文件，结果可能不完整）…`)
  }
  return {
    content: [head, lines.join('\n')].join('\n\n'),
    summary: result.files.length === 0 ? '未找到匹配' : `找到 ${result.files.length} 个文件`,
  }
}

/**
 * `<相对路径>:<行号>: <命中行>`。
 *
 * 同一行**只输出一条**（一行内多次命中由端口去重后只回带一条，内核不展开也不重排）；
 * 行首空白**原样保留**（缩进是定位信息），但超长判断可以用去掉空白后的长度——
 * 纯空白不算内容，没必要为它截断一行。
 */
function renderMatch(match: SearchMatch): string {
  const text = match.text
  if (text.trim().length <= MAX_MATCH_LINE_CHARS) return `${match.path}:${match.line}: ${text}`
  return `${match.path}:${match.line}: ${text.slice(0, MAX_MATCH_LINE_CHARS)}…（本行超长已截断）…`
}

/**
 * 只用 `new RegExp` **校验**正则能不能编译：能编译返回 `undefined`，否则返回可读原因。
 *
 * 内核**不执行**正则（真正执行在主进程的 `searchText` 里），也**不把 RegExp 对象跨端口传**
 * ——端口的 `pattern` 参数始终是原始源码字符串。
 */
function describePatternError(pattern: string): string | undefined {
  try {
    new RegExp(pattern)
    return undefined
  } catch (error) {
    return describeError(error)
  }
}

/**
 * 静态拦掉「嵌套无界量词」形态的正则（第一道过滤）：命中返回可读原因，否则返回 `undefined`。
 *
 * 拒绝条件：某个分组（`(` 与配对的 `)`）**内部**含**无界**量词（`*` / `+` / `{n,}`），
 * **且**该分组自身后面**紧跟**一个**无界**量词。形如 (a+)+ / (a*)* / (x+){2,} 都会被拒。
 *
 * 只判「无界 × 无界」这一种组合，因此**不误伤**这些常见写法：
 * 组内没有量词（(ab)+ / (a|b)+）、组自己没被量化（(a+)）、内层是**有界**量词（(\d{3})+）、
 * 压根没有分组（a+ / .* / [a-z]*）。
 *
 * ⚠️ 这是**启发式**（例如重叠交替写法 ^(a|a)*b$ 这类仍能构造指数级回溯），**不声称完备**：
 * 它只是第一道静态过滤，第二道是主进程 `file-port.ts` 的墙钟预算护栏（遍历层面到点即停）。
 * 之所以必须有这一道，是因为 `regex.test` 是**同步**调用，单次回溯一旦开始就无法打断。
 *
 * 调用前必须已经过 `new RegExp` 校验（括号不配对等由 `describePatternError` 先报）。
 */
function describeQuantifierNestingError(pattern: string): string | undefined {
  if (!hasNestedUnboundedQuantifier(pattern)) return undefined
  return [
    '分组内部的量词不允许再被无界量词修饰（形如 (a+)+ / (a*)* / (x+){2,} 的写法）：',
    '这类模式在长重复行上会灾难性回溯、把主进程卡住，已直接拒绝。',
    '请避免在量词内部再用量词；可改用更具体的字符类或先缩小范围。',
  ].join('')
}

/**
 * 是否存在「分组内部有无界量词，且该分组自己被无界量词修饰」的形态。
 *
 * 一遍扫描 + 一个分组栈（栈里每一项表示「这个还没闭合的分组内部出现过无界量词」）：
 * - 遇到无界量词 → 把**栈上所有**未闭合分组都标记（内层的东西也在外层分组内部）；
 * - 遇到 `)` → 弹出本组的标记，再看紧随其后的字符是不是无界量词，是则命中。
 *
 * 转义（`\+`）与字符类（`[*+]`、`[)]`）内部一律按字面处理，不当作量词或括号。
 */
function hasNestedUnboundedQuantifier(pattern: string): boolean {
  const openGroups: boolean[] = []
  let index = 0
  while (index < pattern.length) {
    const char = pattern[index]
    if (char === '\\') {
      // 转义字符与其后一个字符整体跳过：`\+` 是字面的加号，不是量词
      index += 2
      continue
    }
    if (char === '[') {
      // 字符类内部的一切都是字面字符（`[*+]` 不是量词，`[)]` 也不闭合分组）
      index = skipCharClass(pattern, index)
      continue
    }
    if (char === '(') {
      openGroups.push(false)
      index += 1
      continue
    }
    if (char === ')') {
      const innerHasUnbounded = openGroups.pop() === true
      index += 1
      const outerLength = unboundedQuantifierLengthAt(pattern, index)
      if (innerHasUnbounded && outerLength > 0) return true
      // 分组自己被无界量化：对更外层的分组来说，它同样是一个「内部的无界量词」
      if (outerLength > 0) openGroups.fill(true)
      index += outerLength
      continue
    }
    const length = unboundedQuantifierLengthAt(pattern, index)
    if (length > 0) {
      openGroups.fill(true)
      index += length
      continue
    }
    index += 1
  }
  return false
}

/**
 * 从 `index` 起若是一段**无界**量词（`*` / `+` / `{n,}`）则返回其长度，否则返回 `0`。
 *
 * `{n,}` 必须至少有一个数字：`{,m}` / `{,}` / 未闭合的花括号在非 u 模式下按**字面字符**处理；
 * **有界**量词（`{n}` / `{n,m}`）同样不算无界——`(\d{3})+` 这类常见写法因此不会被误伤。
 */
function unboundedQuantifierLengthAt(pattern: string, index: number): number {
  const char = pattern[index]
  if (char === '*' || char === '+') return 1
  if (char !== '{') return 0
  const matched = UNBOUNDED_BRACE_QUANTIFIER.exec(pattern.slice(index))
  return matched === null ? 0 : matched[0].length
}

/**
 * 跳过一段字符类 `[...]`，返回它右侧第一个字符的下标（未闭合时返回模式末尾）。
 *
 * 按 ECMAScript 口径：`[^]` 是「匹配任意字符的空否定类」（`]` 紧跟 `[^` 就是类结束，
 * 不是字面字符）；类内的 `\]` 是转义，要跳过它、直到出现未被转义的 `]` 才算类结束。
 */
function skipCharClass(pattern: string, start: number): number {
  let index = start + 1
  if (pattern[index] === '^') index += 1
  while (index < pattern.length) {
    if (pattern[index] === '\\') {
      index += 2
      continue
    }
    if (pattern[index] === ']') return index + 1
    index += 1
  }
  return pattern.length
}

/**
 * `{n,}` 形态的无界量词。
 *
 * 不能用 `^\{\d*,\}`：那会把非 u 模式下按字面处理的 `{,}` 也算成量词。
 * 正则片段只写在行注释 / 字符串里，本文件的**块注释里一个都不写**，避免提前结束注释。
 */
const UNBOUNDED_BRACE_QUANTIFIER = /^\{\d+,\}/

/** 工厂里钳制一次 `maxResults`：非数字回落缺省值，其余取整后钳到 `1..MAX_SEARCH_MAX_RESULTS` */
function clampMaxResults(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SEARCH_MAX_RESULTS
  return Math.min(Math.max(Math.floor(value), 1), MAX_SEARCH_MAX_RESULTS)
}

/**
 * 缺省或非法值时给出可读的回落（`undefined` 表示参数类型非法，调用方按校验失败处理）。
 * 与 `files.ts` 的 `resolveClamped` 同一口径（那份未导出，这里保持同款语义）。
 */
function resolveClamped(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number | undefined {
  if (value === undefined || value === null) return Math.min(Math.max(fallback, minimum), maximum)
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(Math.max(Math.floor(value), minimum), maximum)
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  return input as Record<string, unknown>
}

/**
 * `pattern` 一律是字符串且去空白后非空，但**不做 trim**：
 * 正则源码里的首尾空白可能是模式的一部分（行尾空格、锚点前的空格）。
 */
function readPatternString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key]
  if (typeof value !== 'string') return undefined
  return value.trim() === '' ? undefined : value
}

/** 可选字符串参数：非字符串或纯空白一律视为没传（由缺省值接管） */
function readOptionalString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
