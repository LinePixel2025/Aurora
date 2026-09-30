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
})
