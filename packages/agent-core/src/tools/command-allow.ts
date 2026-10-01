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
 *
 * 另一处**匹配粒度**的收紧（P2-10，2026-10-01）：命令先按 `;` / 换行拆段，**每一段**都要
 * 命中某个模式才整体放行。文本模式下的 `*` 编译为 `.*`（含空格与分号），不拆段时 `git *`
 * 会放行 `git status; <任意语句>`（整串经 PowerShell `-Command` 执行，多语句合法）——
 * 与上面「一条模式放行全部命令」是同一性质的口子，只是粒度藏在了分隔符里。
 *
 * P2-10 只封了一半（P1，2026-10-01 补齐），两处收紧：
 * 1. **拆段集合补齐 `&&` / `||` / `|`** —— 只看 `;` 与换行时，`git status && del x` /
 *    `git log | more` 仍是单段，`git *` 直接命中；
 * 2. **出现语句构造即整体不命中**（见 `hasStatementComposition`）—— `$(...)` / 反引号 /
 *    `@(...)` / `@{...}` / `%{...}` / 调用运算符 `&` 内部都是**另一条可执行语句**，
 *    它们在**同一个段**里，拆分隔符堵不住；只加 `|` 也会被它们绕过。
 * 这就是审查者指出的根因：问题是**匹配粒度**（字符 vs 语句边界），不是「少拆一个字符」。
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
 * 命令的**分段符**（P2-10）：`;`、换行、`&&`、`||`、`|`。
 *
 * 为什么必须拆段：文本模式下 `*` 编译为 `.*`（含空格与分隔符），全串锚定匹配让
 * `git *` 直接命中 `git status; <任意危险语句>` —— 命令整串经 PowerShell `-Command`
 * 执行时多语句 / 管道合法，用户意图「git 命令免确认」就变成了「任何以 git 起头的命令串免确认」，
 * 与文件头的自述（任何「一条模式放行全部命令」的口子都必须堵死）矛盾。
 * 拆段后**每一段**都要命中某个模式才整体放行，于是「尾部裸 `*`」的前缀模式只放行单段命令。
 *
 * 交替顺序敏感：`||` 必须在 `|` 之前、`&&` 必须成对匹配 —— 否则 `||` 会先被 `|` 拆成
 * 两个空段（虽然空段会被过滤掉，但语义上仍应作为一个边界整体处理）。
 */
const COMMAND_SEPARATORS = /&&|\|\||;|\||\r\n|\n|\r/

/**
 * 命令是否含**语句构造**（P1，2026-10-01）：含则**整条命令一律不免确认**（退回弹卡）。
 *
 * 这条判据的意图是**把匹配粒度从「字符」提升到「语句边界」**。免确认模式是纯文本全串匹配，
 * `*` 编译成 `.*`，所以下面这些构造会被 `.*` 原样吃掉，而它们在 PowerShell 里各自都是
 * 「一条可执行语句」或「多条语句的拼接」：
 * - `$(...)` 子表达式、反引号 `` ` `` 转义 / 行连接（引号内也会被执行）；
 * - `@(...)` 数组子表达式、`@{...}` 哈希表字面量、`%{...}` ForEach-Object 脚本块；
 * - 调用运算符 `&`（`&&` 已是分段符，剩下任何 `&` 都按调用运算符处理，含 `&>` / `2>&1`
 *   这类重定向 —— **宁可多弹一张卡**）。
 *
 * 它们**不与分隔符对齐**（`git status $(del x)` 是一个段），只按分段符拆段堵不住，
 * 所以在此整体判不命中。这仍属「减少打扰」的收窄，不是安全边界（见文件头）。
 */
function hasStatementComposition(command: string): boolean {
  if (command.includes('$(')) return true
  if (command.includes('`')) return true
  if (command.includes('@(')) return true
  if (command.includes('@{')) return true
  if (command.includes('%{')) return true
  // `&&` 是分段符，先剔除成对的两个 `&`；余下任何 `&` 都按调用运算符 / 重定向处理
  if (command.replace(/&&/g, '').includes('&')) return true
  return false
}

/**
 * 是否命中免确认列表：先整体排除语句构造，再把命令按**分段符**拆段，
 * **每一段都命中某个模式**才算整体命中，返回第一段命中的那条模式（供审计日志留痕）；
 * 任一段未命中即返回 `undefined`（弹卡）。
 *
 * **语法非法或纯通配的模式一律跳过，绝不匹配**（纵深防御，与配置层的拒绝是两件事）。
 */
export function matchAllowPatterns(
  command: string,
  patterns: readonly string[],
): string | undefined {
  // 语句构造（子表达式 / 反引号 / 调用运算符等）**整体**不适用免确认
  if (hasStatementComposition(command)) return undefined
  const segments = splitCommand(command)
  if (segments.length === 0) return undefined
  let matched: string | undefined
  for (const segment of segments) {
    const hit = matchSegment(segment, patterns)
    if (hit === undefined) return undefined // 任一段未命中 → 整条命令不免确认
    matched ??= hit
  }
  return matched
}

/** 单段命令的模式匹配（原text匹配逻辑，`pathMode: false`：命令串里的反斜杠是内容） */
function matchSegment(segment: string, patterns: readonly string[]): string | undefined {
  for (const pattern of patterns) {
    if (describeInvalidPattern(pattern) !== undefined) continue
    if (matchesGlob(pattern, segment, { pathMode: false, caseInsensitive: true })) return pattern
  }
  return undefined
}

/** 拆段并去掉空白段（`git status;` 的尾部分号、空行都不参与匹配）；全空白命令得到空数组。 */
function splitCommand(command: string): string[] {
  return command
    .split(COMMAND_SEPARATORS)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '')
}
