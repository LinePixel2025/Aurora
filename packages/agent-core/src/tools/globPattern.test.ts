/**
 * glob 模式编译器的单测（docs/06 §11.5）。
 *
 * 三组消费方共用这一份实现，因此这里的判据是**契约级**的：
 * 路径模式（`grep.include` / `glob` / 主进程遍历）与文本模式（`run_command` 免确认列表）
 * 各自的通配语义、全串锚定、大小写口径、字面元字符转义、以及非法输入的兜底行为。
 *
 * 纯函数、不碰磁盘。
 */
import { describe, expect, it } from 'vitest'
import { compileGlob, isValidGlobPattern, matchesGlob, MAX_GLOB_LENGTH } from './globPattern.js'

/** 路径模式（缺省）的短写 */
const hit = (pattern: string, value: string): boolean => matchesGlob(pattern, value)
/** 文本模式（`run_command` 免确认列表用）的短写 */
const hitText = (pattern: string, value: string): boolean =>
  matchesGlob(pattern, value, { pathMode: false })

describe('glob 编译器：路径模式（缺省）', () => {
  it('`**/` 命中任意层目录，**含零层**（`**/*.ts` 命中根目录的 `a.ts`）', () => {
    expect(hit('**/*.ts', 'a.ts')).toBe(true)
    expect(hit('**/*.ts', 'a/b/c.ts')).toBe(true)
  })

  it('`src/**/*.ts` 同时命中 `src/a.ts` 与 `src/a/b.ts`', () => {
    expect(hit('src/**/*.ts', 'src/a.ts')).toBe(true)
    expect(hit('src/**/*.ts', 'src/a/b.ts')).toBe(true)
    expect(hit('src/**/*.ts', 'other/a.ts')).toBe(false)
  })

  it('`{ts,tsx}` 交替生效，且不匹配未列出的扩展名', () => {
    expect(hit('*.{ts,tsx}', 'a.ts')).toBe(true)
    expect(hit('*.{ts,tsx}', 'a.tsx')).toBe(true)
    expect(hit('*.{ts,tsx}', 'a.js')).toBe(false)
  })

  it('`?` 恰好匹配一个字符（不匹配零个、也不匹配两个）', () => {
    expect(hit('a?c', 'abc')).toBe(true)
    expect(hit('a?c', 'ac')).toBe(false)
    expect(hit('a?c', 'abbc')).toBe(false)
  })

  it('路径模式下 `*` **不跨**路径分隔符', () => {
    expect(hit('src/*.ts', 'src/a.ts')).toBe(true)
    expect(hit('src/*.ts', 'src/a/b.ts')).toBe(false)
  })

  it('反斜杠与重复分隔符在匹配前归一（Windows 路径可用）', () => {
    expect(hit('src/*.ts', 'src\\a.ts')).toBe(true)
    expect(hit('src/*.ts', 'src//a.ts')).toBe(true)
    // 模式里写反斜杠同样是分隔符
    expect(hit('src\\*.ts', 'src/a.ts')).toBe(true)
  })

  it('整体全串锚定：模式必须覆盖整个值', () => {
    expect(hit('*.ts', 'a.ts')).toBe(true)
    expect(hit('*.ts', 'dir/a.ts')).toBe(false)
    expect(hit('a.ts', 'a.ts.bak')).toBe(false)
    expect(hit('a.ts', 'x/a.ts')).toBe(false)
  })
})

describe('glob 编译器：文本模式（run_command 免确认列表）', () => {
  it('`git status*` 命中带参数的命令串', () => {
    expect(hitText('git status*', 'git status --short')).toBe(true)
    expect(hitText('git status*', 'git status')).toBe(true)
    expect(hitText('git status*', 'git stash')).toBe(false)
  })

  it('全串锚定让 `git *` **不命中** `echo git`', () => {
    expect(hitText('git *', 'echo git')).toBe(false)
    expect(hitText('git *', 'git log')).toBe(true)
  })

  it('文本模式下 `*` 可以跨空格（与路径模式的关键差别）', () => {
    expect(hitText('npm *', 'npm run build --silent')).toBe(true)
  })

  it('文本模式**不**归一反斜杠（反斜杠是命令内容的一部分）', () => {
    // `C:\a\b` 里的反斜杠不该被当成路径分隔符而被换成 `/`
    expect(hitText('*C:\\a*', 'echo C:\\a\\b')).toBe(true)
    expect(hitText('*C:/a*', 'echo C:\\a\\b')).toBe(false)
  })
})

describe('glob 编译器：大小写口径', () => {
  it('缺省大小写不敏感（Windows 口径）', () => {
    expect(hit('GIT*', 'git status')).toBe(true)
    expect(hit('**/*.TS', 'a/b/c.ts')).toBe(true)
    expect(hitText('GIT STATUS', 'git status')).toBe(true)
  })

  it('显式关掉时大小写敏感', () => {
    expect(matchesGlob('GIT*', 'git status', { caseInsensitive: false })).toBe(false)
    expect(matchesGlob('git*', 'git status', { caseInsensitive: false })).toBe(true)
  })
})

describe('glob 编译器：字面元字符必须转义（最易写错的一条）', () => {
  it('`.` 是字面点，不是「任意字符」', () => {
    expect(hit('a.b', 'a.b')).toBe(true)
    expect(hit('a.b', 'axb')).toBe(false)
  })

  it('括号 / 加号 / 方括号等都按字面处理，不抛异常也不当分组', () => {
    expect(hit('a(1).ts', 'a(1).ts')).toBe(true)
    expect(hit('a(1).ts', 'a1.ts')).toBe(false)
    expect(hit('a+b.ts', 'a+b.ts')).toBe(true)
    expect(hit('[x].ts', '[x].ts')).toBe(true)
    expect(hit('a$b', 'a$b')).toBe(true)
    expect(hit('a^b', 'a^b')).toBe(true)
  })

  it('编译产物是锚定的正则，元字符不泄漏成通配', () => {
    expect(compileGlob('a.b').source.startsWith('^')).toBe(true)
    expect(compileGlob('a.b').source.endsWith('$')).toBe(true)
    expect(compileGlob('a.b').test('azb')).toBe(false)
  })
})

describe('glob 编译器：合法性判断与非法输入的兜底', () => {
  it('空串 / 纯空白不合法', () => {
    expect(isValidGlobPattern('')).toBe(false)
    expect(isValidGlobPattern('   ')).toBe(false)
    expect(isValidGlobPattern('\t')).toBe(false)
  })

  it('超长不合法（上限取自导出的常量，不另抄字面量）', () => {
    expect(isValidGlobPattern('a'.repeat(MAX_GLOB_LENGTH))).toBe(true)
    expect(isValidGlobPattern('a'.repeat(MAX_GLOB_LENGTH + 1))).toBe(false)
  })

  it('纯通配**是合法的路径模式**（「必须含字面字符」是免确认列表自己的规则）', () => {
    expect(isValidGlobPattern('*')).toBe(true)
    expect(isValidGlobPattern('**')).toBe(true)
    expect(isValidGlobPattern('?*')).toBe(true)
    expect(isValidGlobPattern('**/*.ts')).toBe(true)
  })

  it('花括号未配对不合法；单侧花括号也判非法', () => {
    expect(isValidGlobPattern('src/{a')).toBe(false)
    expect(isValidGlobPattern('a}')).toBe(false)
    expect(isValidGlobPattern('{a,b}')).toBe(true)
    expect(isValidGlobPattern('a{b}c')).toBe(true)
  })

  it('未配对花括号时 `compileGlob` 不抛异常，按字面处理', () => {
    expect(() => compileGlob('src/{a')).not.toThrow()
    expect(hit('src/{a', 'src/{a')).toBe(true)
    expect(hit('src/{a', 'src/a')).toBe(false)
  })

  it('花括号内不做嵌套：外层在**第一个** `}` 处收口，内层花括号退化成字面量', () => {
    // `x{a,{b}c}` 的外层在第一个 `}` 收口 → 语义是 `x` + (`a` 或 `{b`) + `c` + `}`
    expect(hit('x{a,{b}c}', 'xac}')).toBe(true)
    expect(hit('x{a,{b}c}', 'x{bc}')).toBe(true)
    // 少了收尾的 `}`、或把内层当成交替都对不上（这正是「不支持嵌套」的可观测后果）
    expect(hit('x{a,{b}c}', 'x{b}c}')).toBe(false)
    expect(hit('x{a,{b}c}', 'x{b}c')).toBe(false)
    expect(hit('x{a,{b,c}}', 'xb}')).toBe(false)
  })

  it('交替组内的通配符照常生效', () => {
    expect(hit('*.{ts,tsx}', 'a.ts')).toBe(true)
    expect(hit('a*.{ts,tsx}', 'abc.tsx')).toBe(true)
    expect(hit('a*.{ts,tsx}', 'abc.js')).toBe(false)
  })
})
