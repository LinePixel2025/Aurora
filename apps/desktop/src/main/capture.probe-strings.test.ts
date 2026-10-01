/**
 * capture.ts 探针字符串的**转义护栏**（2026-09-30）。
 *
 * 起因：探针脚本都是 TS 的 template literal（`` `(async () => { ... })()` ``），
 * 字符串**内部**的注释里写反引号会提前终止它。危险的是它不一定报错：
 * `` （`+` 钮） `` 会被解析成 `` `...（` + ` 钮）...` `` —— 反引号与那个 `+`
 * 被当成**字符串拼接**吃掉，`tsc` 一声不吭，只有编译产物里少几个字符
 * （本轮在 `CHAT_SESSION_GROUPS_*` 上连踩三次：一次 TS1005 报错、两次静默拼接）。
 * AGENTS.md 只记了「会 TS1005」，静默那一半没有护栏；本用例补上。
 *
 * 判据（用 TypeScript 编译器 API，与 `tsc` 同一套解析）：capture.ts 里**不存在**
 * 「template literal 参与 `+` 拼接」的二元表达式 —— 探针字符串一律是纯字面量
 * （需要插值的探针走 `${}`，那不会被误判：`TemplateExpression` 也是模板串，
 * 但 `${}` 两侧是表达式节点，不是 `PlusToken` 拼接）。
 *
 * 纯 Node（本文件不 import electron）：只读源码文本 + 解析 AST，可在 vitest 里直接跑。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const CAPTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'capture.ts')

function isTemplateLiteral(node: ts.Node): boolean {
  return ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)
}

/**
 * 把一个 template literal 还原成**可被 JS 解析器读的源码**：静态片段原样保留，
 * 每个 `${...}` 插值换成一个 `0`（插值本身在运行时才求值，语法检查只需要占位符）。
 *
 * 用途见下面第二条用例：探针是**字符串**，写错了 tsc 看不见。
 */
function toParsableSource(node: ts.TemplateLiteral): string {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  const parts: string[] = [node.head.text]
  for (const span of node.templateSpans) {
    parts.push('0')
    parts.push(span.literal.text)
  }
  return parts.join('')
}

describe('capture.ts 的探针字符串', () => {
  it('没有 template literal 被反引号提前终止（表现为 `+` 字符串拼接）', () => {
    const source = readFileSync(CAPTURE_PATH, 'utf8')
    const file = ts.createSourceFile(
      CAPTURE_PATH,
      source,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    )

    const offenders: string[] = []
    const walk = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
        (isTemplateLiteral(node.left) || isTemplateLiteral(node.right))
      ) {
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
        offenders.push(`第 ${line} 行：${node.getText(file).replace(/\s+/g, ' ').slice(0, 80)}`)
      }
      ts.forEachChild(node, walk)
    }
    walk(file)

    expect(
      offenders,
      '探针是 template literal：字符串内部的注释不能出现反引号（会提前终止字符串，' +
        '被解析成字符串拼接且 tsc 不报错）。注释请改用「」或单引号。',
    ).toEqual([])
  })

  /**
   * 第二条：探针字符串**本身必须能当 JS 解析**。
   *
   * 起因（2026-10-01）：`SETTINGS_FIELDS_SCRIPT` 里删白名单时留下一行多余的 `)`，整段脚本
   * 语法错 —— 但它是字符串，`pnpm typecheck` / `pnpm test` 一路全绿，只有 `AURORA_CAPTURE`
   * 跑到那一张图时才以 `Script failed to execute` 失败（而且此前已经在两次全量截图里红着）。
   *
   * 只查「静态开头是 `(`」的模板串（= 那些 `(() => {…})()` / `(async () => {…})()` 探针）：
   * 本模块里还有图标 SVG、选择器等文本串，它们不是 JS，拿解析器去量只会造出假阳性。
   * 语法错是**解析期**就能判定的，不需要执行（也没有 DOM 可执行）。
   */
  it('探针脚本本身能通过 JS 解析（模板串里的语法错 tsc 看不见）', () => {
    const source = readFileSync(CAPTURE_PATH, 'utf8')
    const file = ts.createSourceFile(
      CAPTURE_PATH,
      source,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    )

    const offenders: string[] = []
    const walk = (node: ts.Node): void => {
      if (isTemplateLiteral(node) && node.getText(file).trimStart().startsWith('`(')) {
        const code = toParsableSource(node as ts.TemplateLiteral)
        const parsed = ts.createSourceFile('probe.ts', code, ts.ScriptTarget.ESNext, true)
        // `parseDiagnostics` 是 `SourceFile` 上的**内部**字段（公开 d.ts 没有它），
        // 但它是"这段文本能不能解析"的唯一现成出口；窄化成只读数组，不用 `any`。
        const diagnostics =
          (parsed as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ??
          []
        if (diagnostics.length > 0) {
          const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
          const first = diagnostics[0]
          offenders.push(
            `第 ${line} 行：${ts.flattenDiagnosticMessageText(first?.messageText ?? '', ' ')}`,
          )
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(file)

    expect(
      offenders,
      '探针是字符串：里面的语法错不会让 tsc / vitest 变红，只会在 AURORA_CAPTURE 里变成' +
        '「Script failed to execute」。两种常见成因：① 多/少一个括号的残渣；' +
        '② 字符串内部的注释写了反引号（提前终止 template literal，剩下的半截被当成代码解析）。' +
        '按上面的行号修掉。',
    ).toEqual([])
  })

  /**
   * 第三条：探针脚本必须能被 **JS 引擎编译**，而不只是「TS 解析器能解析」。
   *
   * 起因（2026-10-01，v24 阿尔泰轮）：探针里写 `replace(/\\s+/g, '')` 与 `replace(/^\\+/, '')`，
   * 本意是 JS 侧拿到 `/\s+/` 与 `/^\+/`，但文件里少写了一层反斜杠 —— template literal
   * 先把 `\+` 吃成 `+`，渲染层收到的是 **`/^+/`**（非法正则）。
   * 关键点：**非法正则不报在解析期** —— `parseDiagnostics` 是空的、上面第二条用例照样绿
   * （TS 只认正则字面量的词法形状，不校验 pattern 是否合法），它只在 V8 编译那段脚本时炸，
   * 症状与语法残留一模一样：报告里一句「Script failed to execute」，无行号、无信息量。
   * 于是这里补最后一道：把**模板层 cook 过**的文本交给 `new Function` 编译一次。
   * 口径与前一条一致，只查 `(` 开头的探针（其余是 SVG 路径 / 选择器文本，不是 JS）。
   */
  it('探针脚本能被 JS 引擎编译（非法正则、转义塌陷这类只在运行期炸）', () => {
    const source = readFileSync(CAPTURE_PATH, 'utf8')
    const file = ts.createSourceFile(
      CAPTURE_PATH,
      source,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    )

    const offenders: string[] = []
    const walk = (node: ts.Node): void => {
      if (isTemplateLiteral(node) && node.getText(file).trimStart().startsWith('`(')) {
        const code = toParsableSource(node as ts.TemplateLiteral)
        try {
          // 只编译不执行：正则字面量在这里被编译，非法 pattern 会抛 SyntaxError
          new Function(code)
        } catch (error) {
          const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
          offenders.push(`第 ${line} 行：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(file)

    expect(
      offenders,
      '这份探针文本在渲染层要当代码跑：请按行号修掉。最常见的成因是**反斜杠少写一层** —— ' +
        '探针是 TS 的 template literal，`\\s` / `\\+` 里的反斜杠会先被模板层吃掉一层，' +
        '文件里必须写 `\\\\s` / `\\\\+` 才能让渲染层收到 `\\s` / `\\+`。' +
        '不想数层数就别在探针里写带反斜杠的正则。',
    ).toEqual([])
  })
})
