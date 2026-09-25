/**
 * `run_command` 的**免确认模式列表**匹配器与校验（docs/06 §11.7）。
 *
 * 语义：命中列表的命令**不再弹确认卡片**，直接执行；未命中的照旧逐次确认。
 * 这是「减少打扰」**不是**「安全加固」——列表本身不增加任何权限，只是少问一次。
 *
 * 纯函数、复用 `globPattern.ts`（**不另写第二份匹配逻辑**）、可在 Node 里完整单测。
 *
 * ## 安全边界（本文件存在的理由）
 *
 * 「免确认列表」等价于**摘掉终端工具自己的确认闸门**，所以任何"一条模式放行全部命令"的口子
 * 都必须堵死。两处纵深防御，**缺一不可**：
 * 1. 配置层（`schema.ts` 的 Zod refine）：保存时就拒绝非法模式，用户在设置页能立刻看到原因；
 * 2. 匹配层（本文件的 `describeInvalidPattern`）：**匹配时再判一次** ——
 *    用户手改 `config.json` 塞进一个纯通配模式时，配置层可能被绕过（旧配置文件、
 *    外部工具写入），匹配层是最后一道。
 *
 * 特别地：**含 `{` 或 `}` 的模式一律拒绝**。原因不是"花括号不好用"，而是一条已核实的
 * 绕过路径：`{a,*}` 去掉通配符与空白后还剩 `a`，能骗过"至少含一个具体字符"的检查，
 * 但它编译成 `(?:a|.*)` —— **匹配任意命令**，等于一行就关掉整个确认闸门。
 * 因此规则收紧为：**命令模式只允许字面字符 + `*` + `?`，出现任何其它元字符（含花括号）即非法**。
 */
import { isValidGlobPattern, matchesGlob } from './globPattern.js'

/** 模式条数上限（与 `AgentToolsSchema.terminal.allowPatterns` 的 `.max(100)` 同源） */
export const MAX_ALLOW_PATTERNS = 100
/** 单条模式长度上限（与 Schema 的 `.max(200)` 同源） */
export const MAX_ALLOW_PATTERN_LENGTH = 200

/**
 * 模式是否可用：非空、未超长、glob 语法合法，且**至少含一个非通配、非空白字符**。
 *
 * 返回中文原因（给设置页 / 审计日志看）；合法返回 `undefined`。
 */
export function describeInvalidPattern(pattern: string): string | undefined {
  if (typeof pattern !== 'string') return '模式必须是字符串'
  if (pattern.trim() === '') return '模式不能为空'
  if (pattern.length > MAX_ALLOW_PATTERN_LENGTH) {
    return `模式过长（上限 ${MAX_ALLOW_PATTERN_LENGTH} 字符）`
  }
  // 先整类拒绝花括号：`{a,*}` 能绕过下面那条"至少含一个具体字符"的检查（见文件头）
  if (/[{}]/.test(pattern)) return '命令模式不支持花括号交替'
  if (!isValidGlobPattern(pattern)) return '模式语法不合法'
  // 去掉 `*` / `?` 与空白后什么都不剩 = 纯通配 = 放行全部命令
  if (pattern.replace(/[*?\s]/g, '') === '') {
    return '模式必须至少包含一个具体字符，纯通配等于放行全部命令'
  }
  return undefined
}

/**
 * 是否命中免确认列表：任一模式**全串**匹配即命中，返回**被命中的那条模式**（供审计日志留痕）；
 * 不命中返回 `undefined`。
 *
 * **语法非法或纯通配的模式一律跳过，绝不匹配**（纵深防御，与配置层的拒绝是两件事）。
 */
export function matchAllowPatterns(
  command: string,
  patterns: readonly string[],
): string | undefined {
  for (const pattern of patterns) {
    if (describeInvalidPattern(pattern) !== undefined) continue
    // 文本模式：命令串里的反斜杠是内容不是路径分隔符（`pathMode: false`）
    if (matchesGlob(pattern, command, { pathMode: false, caseInsensitive: true })) return pattern
  }
  return undefined
}
