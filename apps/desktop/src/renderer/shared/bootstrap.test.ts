/**
 * `bootstrapApp` 的接线顺序护栏（2026-10-10）。
 *
 * 为什么用"读源码判顺序"而不是跑一遍：`bootstrapApp` 依赖 `window.aurora` 与真实 Pinia，
 * 在 node 环境里跑不起来（它也不 import electron / DOM，只是没有可注入的 IPC 端口）。
 * 而这条顺序恰恰是**产品缺陷的根因**：先 `load()` 再 `bind()` 会永久丢掉落在两者之间的
 * `mode:changed`（load 拿到的是切换**前**的快照，丢失的广播没有任何补偿），
 * 而 `mode.set` 在「主进程已是目标值」时是 no-op —— 面板永久停在旧模式。
 *
 * 同款做法见 `apps/desktop/src/main/capture.probe-strings.test.ts`（也是"读源码 + 解析"，
 * 因为被测对象是字符串/顺序这类静态事实）。这里解析成 AST 后按偏移量比较，避免"注释里
 * 恰好也写了这几个字"造成的假阳性。
 *
 * 独立审查（2026-10-10）指出：这条口径此前**没有任何测试**，把 bootstrap.ts 改回旧顺序
 * 2544 条用例仍然全绿，capture 哨兵又只在低概率竞态（历史 1/8）下才红 —— 等于无人守。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const BOOTSTRAP_PATH = join(dirname(fileURLToPath(import.meta.url)), 'bootstrap.ts')

/** 在 `bootstrapApp` 体内找第一次 `X.Y()` 调用的起始偏移；找不到返回 -1 */
function firstCallOffset(file: ts.SourceFile, source: string, objectName: string, propName: string): number {
  let found = -1
  const walk = (node: ts.Node): void => {
    if (found !== -1) return
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === objectName &&
      node.expression.name.text === propName
    ) {
      found = node.getStart(file)
      return
    }
    ts.forEachChild(node, walk)
  }
  walk(file)
  return found
}

describe('bootstrapApp 的接线顺序', () => {
  it('订阅（bind）必须早于加载（load）—— 否则启动期的 mode:changed / settings:changed 会永久丢失', () => {
    const source = readFileSync(BOOTSTRAP_PATH, 'utf8')
    const file = ts.createSourceFile(BOOTSTRAP_PATH, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)

    const bindOffset = firstCallOffset(file, source, 'settings', 'bind')
    const loadOffset = firstCallOffset(file, source, 'settings', 'load')

    // 两个调用都必须存在（改名 / 挪走时先让这条红，再由人决定新口径）
    expect(bindOffset, 'bootstrap.ts 里找不到 settings.bind()').toBeGreaterThan(-1)
    expect(loadOffset, 'bootstrap.ts 里找不到 settings.load()').toBeGreaterThan(-1)
    expect(
      bindOffset,
      '接线顺序反了：settings.load() 出现在 settings.bind() 之前 —— 落在两者之间的广播会永久丢失' +
        '（根因见本文件头注释与 Memory/2026-10-10-flaky-capture-probes.md）',
    ).toBeLessThan(loadOffset)
  })

  it('modes 与 windows 也遵守同一条顺序（不要只改一处）', () => {
    const source = readFileSync(BOOTSTRAP_PATH, 'utf8')
    const file = ts.createSourceFile(BOOTSTRAP_PATH, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)

    const modesBind = firstCallOffset(file, source, 'modes', 'bind')
    const modesLoad = firstCallOffset(file, source, 'modes', 'load')
    const windowsBind = firstCallOffset(file, source, 'windows', 'bind')
    const windowsLoad = firstCallOffset(file, source, 'windows', 'load')

    expect(modesBind).toBeGreaterThan(-1)
    expect(modesLoad).toBeGreaterThan(-1)
    expect(modesBind, 'modes：bind 必须早于 load').toBeLessThan(modesLoad)
    expect(windowsBind).toBeGreaterThan(-1)
    expect(windowsLoad).toBeGreaterThan(-1)
    expect(windowsBind, 'windows：bind 必须早于 load').toBeLessThan(windowsLoad)
  })
})
