/**
 * `FilePort` 主进程实现的单测（docs/06 §11、§20）。
 *
 * 用 `os.tmpdir()` 下的真实临时目录（每个用例一个随机目录，`afterEach` 递归删除），
 * 因为本文件不 import electron，所以能进 vitest 的 Node 环境。
 *
 * 行窗口语义（`offsetLines` / `limitLines` / `maxBytes` / CRLF / 扫描上限）逐条钉在这里；
 * 内核侧的渲染与参数钳制在 `packages/agent-core/src/tools/files.test.ts`。
 *
 * 整文件读（`readWholeText`，docs/06 §11.6）与 `edit_file` 的**真实磁盘往返**同样在这里：
 * 那是全仓唯一把「内核的替换逻辑」接到「真实文件字节」上的地方——替换承诺
 * 「除目标片段外逐字节不变」，只有落盘后逐字节比对才证明得了。
 *
 * 搜索层（`findFiles` / `searchText`，docs/06 §11.5）同样用真实临时目录验证：
 * 正斜杠相对路径、忽略目录子树、行号与 CRLF、一行只记一条、二进制与超限文件跳过、
 * 预算触顶（仍返回已收集结果）、`include` 过滤、符号链接环（建不了 symlink 就跳过）。
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
// 常量与内核工具同源（不在这里另抄一份字面量 / 不另写一份替换逻辑）
import {
  DEFAULT_READ_LINES,
  MAX_EDIT_BYTES,
  MAX_READ_LINES,
  MAX_READ_SCAN_BYTES,
  createEditTool,
  type ReadTracker,
} from '@aurora/agent-core'
import { createNodeFilePort } from './file-port.js'

let root = ''

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'aurora-files-test-'))
})

afterEach(async () => {
  if (root !== '') await fs.rm(root, { recursive: true, force: true, maxRetries: 3 })
  root = ''
})

describe('readText / writeText', () => {
  it('写入后能原样读回：行内容、行号、总行数与字节数一致', async () => {
    const port = createNodeFilePort()
    const file = join(root, 'note.txt')
    const text = '第一行\nsecond'

    const written = await port.writeText(file, text, 'overwrite')
    expect(written.absolutePath).toBe(resolve(file))
    expect(written.bytes).toBe(Buffer.byteLength(text, 'utf8'))

    const read = await port.readText(file, { maxBytes: 65_536 })
    expect(read.absolutePath).toBe(resolve(file))
    expect(read.lines).toEqual([
      { number: 1, text: '第一行' },
      { number: 2, text: 'second' },
    ])
    expect(read.totalLines).toBe(2)
    expect(read.totalBytes).toBe(written.bytes)
    expect(read.truncated).toBe(false)
    expect(read.scanLimitHit).toBe(false)
    // 窗口字节数 = 各行字节数之和 + 行间换行符 1 字节（末尾不加换行）
    expect(read.bytes).toBe(Buffer.byteLength('第一行', 'utf8') + 1 + 6)
  })

  it('空文件可以读回：0 行、空窗口、0 字节，且不报错', async () => {
    const port = createNodeFilePort()
    const file = join(root, 'empty.txt')

    const written = await port.writeText(file, '', 'overwrite')
    expect(written.bytes).toBe(0)

    const read = await port.readText(file, { maxBytes: 65_536 })
    expect(read.lines).toEqual([])
    expect(read.totalLines).toBe(0)
    expect(read.totalBytes).toBe(0)
    expect(read.bytes).toBe(0)
    expect(read.truncated).toBe(false)
  })

  it('父目录不存在时自动创建多级目录', async () => {
    const port = createNodeFilePort()
    const file = join(root, 'a', 'b', 'c', 'deep.txt')

    await port.writeText(file, 'deep', 'overwrite')
    const read = await port.readText(file, { maxBytes: 65_536 })
    expect(read.lines).toEqual([{ number: 1, text: 'deep' }])
    expect(read.totalLines).toBe(1)
    expect(read.truncated).toBe(false)
  })

  it('append 追加到已有文件末尾', async () => {
    const port = createNodeFilePort()
    const file = join(root, 'log.txt')

    await port.writeText(file, 'first\n', 'overwrite')
    const appended = await port.writeText(file, 'second\n', 'append')
    expect(appended.bytes).toBe(7)

    const read = await port.readText(file, { maxBytes: 65_536 })
    expect(read.lines).toEqual([
      { number: 1, text: 'first' },
      { number: 2, text: 'second' },
    ])
    expect(read.totalLines).toBe(2)
    expect(read.totalBytes).toBe(13)
    // 文件末尾的那个换行符不算进窗口
    expect(read.bytes).toBe(12)
    expect(read.truncated).toBe(false)
  })
})

describe('readWholeText：整文件读（edit_file 专用）', () => {
  it('逐字节原样读回：CRLF 不被归一、空行与末尾换行都保留', async () => {
    const port = createNodeFilePort()
    const file = join(root, 'whole.txt')
    const raw = Buffer.from('第一行\r\nsecond\r\n\r\n末尾换行保留\r\n', 'utf8')
    await fs.writeFile(file, raw)

    const read = await port.readWholeText(file, MAX_EDIT_BYTES)
    expect(read.absolutePath).toBe(resolve(file))
    expect(read.refused).toBe(false)
    expect(read.bytes).toBe(raw.length)
    // 「逐字节相同」用编码回验：文本再编回 UTF-8 必须与磁盘上的原始字节完全一致
    expect(Buffer.from(read.text, 'utf8').equals(raw)).toBe(true)
    expect(read.text).toContain('\r\n')
    expect(read.text.split('\r\n')).toEqual(['第一行', 'second', '', '末尾换行保留', ''])
  })

  it('超过 maxBytes：refused 为 true、text 为空串、bytes 是文件真实大小；正好等于上限则放行', async () => {
    const port = createNodeFilePort()
    const file = join(root, 'too-big.txt')
    const content = `${'a'.repeat(499)}\n${'b'.repeat(499)}\n`
    await fs.writeFile(file, content, 'utf8')
    expect(Buffer.byteLength(content, 'utf8')).toBe(1_000)

    const refused = await port.readWholeText(file, 999)
    expect(refused.refused).toBe(true)
    // 拒绝发生在读入之前：调用方拿不到任何"半截全文"，只能明确放弃改动
    expect(refused.text).toBe('')
    expect(refused.bytes).toBe(1_000)
    expect(refused.absolutePath).toBe(resolve(file))

    const exact = await port.readWholeText(file, 1_000)
    expect(exact.refused).toBe(false)
    expect(exact.text).toBe(content)
  })

  it('即便 maxBytes 放到极大，超过 MAX_READ_SCAN_BYTES 的文件仍然 refused', async () => {
    const port = createNodeFilePort()
    const file = join(root, 'huge.txt')
    await fs.writeFile(file, 'a'.repeat(MAX_READ_SCAN_BYTES + 1), 'utf8')
    const size = (await fs.stat(file)).size
    expect(size).toBeGreaterThan(MAX_READ_SCAN_BYTES)

    const read = await port.readWholeText(file, Number.MAX_SAFE_INTEGER)
    expect(read.refused).toBe(true)
    expect(read.text).toBe('')
    expect(read.bytes).toBe(size)
  }, 30_000)

  it('含 NUL 字节的文件抛错（按二进制拒绝），错误信息含「二进制」与绝对路径', async () => {
    const port = createNodeFilePort()
    const file = join(root, 'blob.bin')
    // 伪二进制：前后都是能当文本读的内容，只有中间夹一个 NUL
    // （这段序列若被当成 oldString 匹配上，就会以 UTF-8 原文写回 = 静默损坏且不报错）
    await fs.writeFile(file, Buffer.from('HEAD\0TAIL-png-ish', 'utf8'))

    await expect(port.readWholeText(file, MAX_EDIT_BYTES)).rejects.toThrow('二进制')
    await expect(port.readWholeText(file, MAX_EDIT_BYTES)).rejects.toThrow(resolve(file))
  })

  it('目录抛错并提示改用 list_dir，错误信息含绝对路径', async () => {
    const port = createNodeFilePort()
    const dir = join(root, 'a-dir')
    await fs.mkdir(dir)

    await expect(port.readWholeText(dir, MAX_EDIT_BYTES)).rejects.toThrow('这是目录')
    await expect(port.readWholeText(dir, MAX_EDIT_BYTES)).rejects.toThrow(resolve(dir))
  })

  it('不存在的文件抛错，且错误信息含绝对路径', async () => {
    const port = createNodeFilePort()
    const missing = join(root, 'nope', 'missing.txt')

    await expect(port.readWholeText(missing, MAX_EDIT_BYTES)).rejects.toThrow(resolve(missing))
  })
})

/**
 * 极简读前守卫假实现（只服务本文件的往返用例）：三个方法齐备，`mark` 后放行。
 * 装配层那版是带 LRU 上限的会话级实现（`main/tools/index.ts`），这里不需要它。
 */
function createFakeReadTracker(): ReadTracker {
  const read = new Set<string>()
  const key = (sessionId: string, absolutePath: string): string =>
    `${sessionId}\u0000${absolutePath}`
  return {
    has: (sessionId, absolutePath) => read.has(key(sessionId, absolutePath)),
    mark: (sessionId, absolutePath) => {
      read.add(key(sessionId, absolutePath))
    },
    clear: (sessionId, absolutePath) => {
      read.delete(key(sessionId, absolutePath))
    },
  }
}

describe('edit_file 真实磁盘往返（端口 + 内核替换逻辑）', () => {
  it('CRLF 文件替换一行：除目标行外逐字节不变，行尾仍是 CRLF', async () => {
    const port = createNodeFilePort()
    const file = join(root, 'roundtrip.txt')
    const absolutePath = resolve(file)
    // 四行 CRLF + 中文与 emoji（顺带证明 UTF-8 往返不丢字节）+ 末尾换行
    const before = Buffer.from('第一行 🙂\r\nsecond line\r\nTHIRD LINE\r\n末行\r\n', 'utf8')
    await fs.writeFile(file, before)

    const read = await port.readWholeText(file, MAX_EDIT_BYTES)
    expect(read.refused).toBe(false)
    expect(Buffer.from(read.text, 'utf8').equals(before)).toBe(true)

    const tracker = createFakeReadTracker()
    tracker.mark('s1', absolutePath)
    const edit = createEditTool({ files: port, readTracker: tracker })
    const result = await edit.execute(
      { path: absolutePath, oldString: 'second line', newString: 'SECOND LINE 改' },
      { sessionId: 's1' },
    )
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('替换 1 处')

    const after = await fs.readFile(file)
    const expected = Buffer.from('第一行 🙂\r\nSECOND LINE 改\r\nTHIRD LINE\r\n末行\r\n', 'utf8')
    // ① 逐字节：落盘字节与「只改目标行」的预期完全一致
    expect(after.equals(expected)).toBe(true)

    const beforeLines = before.toString('utf8').split('\r\n')
    const afterLines = after.toString('utf8').split('\r\n')
    // ② 差异**只有目标行**一处：按 CRLF 切开后其余行逐字相同，行数不变（没多/少一个空行）
    expect(afterLines).toHaveLength(beforeLines.length)
    const changed = beforeLines
      .map((line, index) => (line === afterLines[index] ? -1 : index))
      .filter((index) => index !== -1)
    expect(changed).toEqual([1])
    expect(beforeLines[1]).toBe('second line')
    expect(afterLines[1]).toBe('SECOND LINE 改')
    // ③ 行尾没有漂移：去掉 CRLF 后不存在任何落单的 \n 或 \r
    expect(after.toString('utf8').replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
    // ④ 总长度变化正好等于目标行的字节差（没有隐藏的增删）
    expect(after.length - before.length).toBe(
      Buffer.byteLength('SECOND LINE 改', 'utf8') - Buffer.byteLength('second line', 'utf8'),
    )
  })
})

describe('行窗口：offsetLines / limitLines', () => {
  it('CRLF 文件：lines[].text 不含 \\r，行号为 1 / 2', async () => {
    const port = createNodeFilePort()
    const file = join(root, 'crlf.txt')
    await fs.writeFile(file, 'a\r\nb\r\n', 'utf8')

    const read = await port.readText(file, { maxBytes: 65_536 })
    expect(read.lines).toEqual([
      { number: 1, text: 'a' },
      { number: 2, text: 'b' },
    ])
    for (const line of read.lines) expect(line.text).not.toContain('\r')
    expect(read.totalLines).toBe(2)
    expect(read.totalBytes).toBe(6)
  })

  it('末行没有换行符时不凭空补空行："a\\nb" → totalLines 2（不是 3）', async () => {
    const port = createNodeFilePort()
    const file = join(root, 'no-trailing.txt')
    await fs.writeFile(file, 'a\nb', 'utf8')

    const read = await port.readText(file, { maxBytes: 65_536 })
    expect(read.totalLines).toBe(2)
    expect(read.lines).toEqual([
      { number: 1, text: 'a' },
      { number: 2, text: 'b' },
    ])
    expect(read.truncated).toBe(false)
  })

  it('末尾有换行符时不产生第 3 行："a\\nb\\n" → totalLines 2', async () => {
    const port = createNodeFilePort()
    const file = join(root, 'trailing.txt')
    await fs.writeFile(file, 'a\nb\n', 'utf8')

    const read = await port.readText(file, { maxBytes: 65_536 })
    expect(read.totalLines).toBe(2)
    expect(read.lines).toEqual([
      { number: 1, text: 'a' },
      { number: 2, text: 'b' },
    ])
  })

  it('文件中真正的空行算一行："a\\n\\n" → ["a", ""]', async () => {
    const port = createNodeFilePort()
    const file = join(root, 'blank-line.txt')
    await fs.writeFile(file, 'a\n\n', 'utf8')

    const read = await port.readText(file, { maxBytes: 65_536 })
    expect(read.totalLines).toBe(2)
    expect(read.lines).toEqual([
      { number: 1, text: 'a' },
      { number: 2, text: '' },
    ])
  })

  it('大文件后半段可读：5000 行文件用 offsetLines=4000 / limitLines=10 取第 4000–4009 行', async () => {
    const port = createNodeFilePort()
    const file = join(root, 'lines.txt')
    const all = Array.from({ length: 5_000 }, (_, index) => `line-${index + 1}`)
    const content = `${all.join('\n')}\n`
    await fs.writeFile(file, content, 'utf8')

    const read = await port.readText(file, {
      offsetLines: 4_000,
      limitLines: 10,
      maxBytes: 65_536,
    })
    // 逐行断言内容，证明读到的确实是第 4000–4009 行（而不是开头那一段）
    expect(read.lines.map((line) => line.number)).toEqual([
      4_000, 4_001, 4_002, 4_003, 4_004, 4_005, 4_006, 4_007, 4_008, 4_009,
    ])
    expect(read.lines.map((line) => line.text)).toEqual(all.slice(3_999, 4_009))
    expect(read.lines).toHaveLength(10)
    expect(read.totalLines).toBe(5_000)
    expect(read.totalBytes).toBe(Buffer.byteLength(content, 'utf8'))
    expect(read.truncated).toBe(true)
  })

  it('offsetLines 越过文件末尾：窗口为空、不算截断、不报错', async () => {
    const port = createNodeFilePort()
    const file = join(root, 'short.txt')
    await fs.writeFile(file, 'a\nb\n', 'utf8')

    const read = await port.readText(file, { offsetLines: 5, maxBytes: 65_536 })
    expect(read.lines).toEqual([])
    expect(read.totalLines).toBe(2)
    expect(read.truncated).toBe(false)
    expect(read.bytes).toBe(0)
  })

  it('offsetLines / limitLines 在端口内取整与钳制（0 → 1，超上限 → MAX_READ_LINES）', async () => {
    const port = createNodeFilePort()
    const file = join(root, 'many.txt')
    const count = MAX_READ_LINES + 1_000
    const content = `${Array.from({ length: count }, (_, index) => `n${index + 1}`).join('\n')}\n`
    await fs.writeFile(file, content, 'utf8')

    const read = await port.readText(file, {
      offsetLines: 0,
      limitLines: MAX_READ_LINES + 99_999,
      maxBytes: 1_000_000,
    })
    expect(read.lines).toHaveLength(MAX_READ_LINES)
    expect(read.lines[0]).toEqual({ number: 1, text: 'n1' })
    expect(read.lines[MAX_READ_LINES - 1]?.number).toBe(MAX_READ_LINES)
    expect(read.totalLines).toBe(count)
    expect(read.truncated).toBe(true)
  })

  it('offsetLines / limitLines 非数字（NaN）时回落到缺省值', async () => {
    const port = createNodeFilePort()
    const file = join(root, 'nan.txt')
    const count = DEFAULT_READ_LINES + 10
    await fs.writeFile(
      file,
      `${Array.from({ length: count }, (_, index) => `n${index + 1}`).join('\n')}\n`,
      'utf8',
    )

    const read = await port.readText(file, {
      offsetLines: Number.NaN,
      limitLines: Number.NaN,
      maxBytes: 1_000_000,
    })
    expect(read.lines).toHaveLength(DEFAULT_READ_LINES)
    expect(read.lines[0]?.number).toBe(1)
    expect(read.lines[DEFAULT_READ_LINES - 1]?.number).toBe(DEFAULT_READ_LINES)
    expect(read.totalLines).toBe(count)
    expect(read.truncated).toBe(true)
  })
})

describe('maxBytes：只约束窗口，第一行强制保留', () => {
  it('maxBytes 很小（1024）时窗口第一行仍被保留，truncated 为 true', async () => {
    const port = createNodeFilePort()
    const file = join(root, 'one-long-line.txt')
    await fs.writeFile(file, `${'A'.repeat(4_000)}\n${'B'.repeat(10)}\n`, 'utf8')

    const read = await port.readText(file, { maxBytes: 1_024 })
    // 第一行单独就超过上限（4000 字节），仍必须带回来，否则模型拿到空结果无从推进
    expect(read.lines).toEqual([{ number: 1, text: 'A'.repeat(4_000) }])
    expect(read.bytes).toBe(4_000)
    expect(read.truncated).toBe(true)
    expect(read.totalLines).toBe(2)
  })

  it('多行窗口按 maxBytes 截断：不超上限、从 offsetLines 处开始、bytes 是实际窗口字节数', async () => {
    const port = createNodeFilePort()
    const file = join(root, 'bytes.txt')
    await fs.writeFile(file, 'aaaa\nbbbb\ncccc\n', 'utf8')

    // 第 2 行 4 字节 + 行间换行 1 字节 + 第 3 行 4 字节 = 9 字节，正好放下
    const fit = await port.readText(file, { offsetLines: 2, limitLines: 10, maxBytes: 9 })
    expect(fit.lines).toEqual([
      { number: 2, text: 'bbbb' },
      { number: 3, text: 'cccc' },
    ])
    expect(fit.bytes).toBe(9)
    expect(fit.truncated).toBe(false)

    const narrow = await port.readText(file, { offsetLines: 2, limitLines: 10, maxBytes: 8 })
    expect(narrow.lines).toEqual([{ number: 2, text: 'bbbb' }])
    expect(narrow.bytes).toBe(4)
    expect(narrow.truncated).toBe(true)
  })
})

describe('扫描上限 MAX_READ_SCAN_BYTES', () => {
  it('超过上限的文件：scanLimitHit 为 true、totalLines 为 undefined、truncated 为 true', async () => {
    const port = createNodeFilePort()
    const file = join(root, 'huge.txt')
    // 每行 4095 字符 + 换行 = 4096 字节；总数比 16 MiB 多一行，
    // 且 16 MiB 的读入边界正好落在行末（能顺带验证行切分不是被截在半个行上）
    const line = `${'a'.repeat(4_095)}\n`
    await fs.writeFile(file, line.repeat(4_097), 'utf8')
    const size = (await fs.stat(file)).size
    expect(size).toBeGreaterThan(MAX_READ_SCAN_BYTES)

    const read = await port.readText(file, { maxBytes: 65_536 })
    expect(read.scanLimitHit).toBe(true)
    // 不允许把 16 MiB 当成全文报一个假的 totalLines
    expect(read.totalLines).toBeUndefined()
    expect(read.truncated).toBe(true)
    expect(read.totalBytes).toBe(size)
    expect(read.lines.length).toBeGreaterThan(1)
    expect(read.lines[0]).toEqual({ number: 1, text: 'a'.repeat(4_095) })
    for (const windowLine of read.lines) expect(windowLine.text).toHaveLength(4_095)
  }, 60_000)

  it('未超过上限的文件 scanLimitHit 为 false 且 totalLines 准确', async () => {
    const port = createNodeFilePort()
    const file = join(root, 'normal.txt')
    await fs.writeFile(file, 'a\nb\nc\n', 'utf8')

    const read = await port.readText(file, { maxBytes: 65_536 })
    expect(read.scanLimitHit).toBe(false)
    expect(read.totalLines).toBe(3)
    expect(read.lines).toHaveLength(3)
  })
})

describe('list', () => {
  it('目录排在前、同类按名称排序，超过 limit 时截断', async () => {
    const port = createNodeFilePort()
    await fs.mkdir(join(root, 'beta'))
    await fs.mkdir(join(root, 'alpha'))
    await fs.writeFile(join(root, 'c.txt'), 'c')
    await fs.writeFile(join(root, 'd.txt'), 'd')
    await fs.writeFile(join(root, 'e.txt'), 'e')

    const all = await port.list(root, 10)
    expect(all.absolutePath).toBe(resolve(root))
    expect(all.truncated).toBe(false)
    const names = all.entries.map((entry) => entry.name).join(',')
    expect(names).toBe('alpha,beta,c.txt,d.txt,e.txt')
    const kinds = all.entries.map((entry) => entry.type).join(',')
    expect(kinds).toBe('dir,dir,file,file,file')
    expect(all.entries[2]?.sizeBytes).toBe(1)
    expect(typeof all.entries[2]?.modifiedAt).toBe('string')

    const limited = await port.list(root, 2)
    expect(limited.truncated).toBe(true)
    expect(limited.entries).toHaveLength(2)
    expect(limited.entries.map((entry) => entry.type).join(',')).toBe('dir,dir')
  })

  it('空目录返回空列表且不截断', async () => {
    const port = createNodeFilePort()
    const empty = join(root, 'empty')
    await fs.mkdir(empty)

    const listed = await port.list(empty, 10)
    expect(listed.entries).toEqual([])
    expect(listed.truncated).toBe(false)
  })
})

describe('错误路径', () => {
  it('不存在的路径抛错，且错误信息里带绝对路径', async () => {
    const port = createNodeFilePort()
    const missing = join(root, 'nope', 'missing.txt')

    await expect(port.readText(missing, { maxBytes: 65_536 })).rejects.toThrow(resolve(missing))
    await expect(port.list(join(root, 'nope'), 10)).rejects.toThrow(resolve(root, 'nope'))
  })

  it('把目录当文件读：报错并提示改用 list_dir，错误信息带绝对路径', async () => {
    const port = createNodeFilePort()

    await expect(port.readText(root, { maxBytes: 65_536 })).rejects.toThrow('这是目录')
    await expect(port.readText(root, { maxBytes: 65_536 })).rejects.toThrow(resolve(root))
  })

  it('前 8 KiB 内出现 NUL 字节时按二进制拒绝，错误信息带绝对路径', async () => {
    const port = createNodeFilePort()
    const file = join(root, 'blob.bin')
    await fs.writeFile(file, Buffer.from([0x41, 0x00, 0x42]))

    await expect(port.readText(file, { maxBytes: 65_536 })).rejects.toThrow('二进制')
    await expect(port.readText(file, { maxBytes: 65_536 })).rejects.toThrow(resolve(file))
  })
})

describe('findFiles：递归找文件名', () => {
  it('嵌套目录下 **/*.ts 返回正斜杠相对路径，且连续两次调用结果一致（顺序确定）', async () => {
    const port = createNodeFilePort()
    await fs.mkdir(join(root, 'src', 'deep'), { recursive: true })
    await fs.writeFile(join(root, 'a.ts'), '')
    await fs.writeFile(join(root, 'src', 'b.ts'), '')
    await fs.writeFile(join(root, 'src', 'deep', 'c.ts'), '')
    await fs.writeFile(join(root, 'src', 'd.js'), '')

    const first = await port.findFiles({ root, pattern: '**/*.ts', maxResults: 50 })
    expect(first.root).toBe(resolve(root))
    // 目录与文件都按名字字典序处理 → 深度优先、天然有序（不需要事后全局排序）
    expect(first.files).toEqual(['a.ts', 'src/b.ts', 'src/deep/c.ts'])
    for (const file of first.files) expect(file).not.toContain('\\')
    expect(first.truncated).toBe(false)
    expect(first.budgetExceeded).toBe(false)
    expect(first.scannedFiles).toBe(4)

    const second = await port.findFiles({ root, pattern: '**/*.ts', maxResults: 50 })
    expect(second.files).toEqual(first.files)
  })

  it('node_modules / .git 子树不被扫到（无结果，且不计入扫描数）', async () => {
    const port = createNodeFilePort()
    await fs.mkdir(join(root, 'node_modules', 'x'), { recursive: true })
    await fs.mkdir(join(root, '.git'), { recursive: true })
    await fs.writeFile(join(root, 'node_modules', 'x', 'y.ts'), 'NEEDLE_hidden')
    await fs.writeFile(join(root, '.git', 'z.ts'), 'NEEDLE_hidden')
    await fs.writeFile(join(root, 'keep.ts'), 'visible')

    const found = await port.findFiles({ root, pattern: '**/*.ts', maxResults: 50 })
    expect(found.files).toEqual(['keep.ts'])
    // 忽略目录是**整棵子树跳过**：里面的文件连扫描数都不算（否则预算会被瞬间吃光）
    expect(found.scannedFiles).toBe(1)

    const searched = await port.searchText({ root, pattern: 'NEEDLE_hidden', maxResults: 50 })
    expect(searched.matches).toEqual([])
    expect(searched.scannedFiles).toBe(1)
  })

  it('搜索根不存在或不是目录时抛错，且错误信息带绝对路径', async () => {
    const port = createNodeFilePort()
    const missing = join(root, 'nope')

    await expect(
      port.findFiles({ root: missing, pattern: '**/*.ts', maxResults: 10 }),
    ).rejects.toThrow(resolve(missing))

    const file = join(root, 'note.txt')
    await fs.writeFile(file, 'x', 'utf8')
    await expect(
      port.findFiles({ root: file, pattern: '**/*.ts', maxResults: 10 }),
    ).rejects.toThrow('不是目录')
    await expect(port.searchText({ root: file, pattern: 'x', maxResults: 10 })).rejects.toThrow(
      resolve(file),
    )
  })
})

describe('searchText：递归搜内容', () => {
  it('行号 1 起始（第 5 行命中），CRLF 文件的命中行不含 \\r', async () => {
    const port = createNodeFilePort()
    await fs.writeFile(join(root, 'lf.txt'), 'l1\nl2\nl3\nl4\ntarget here\nl6\n', 'utf8')
    await fs.writeFile(
      join(root, 'crlf.txt'),
      'c1\r\nc2\r\nc3\r\nc4\r\ntarget here\r\nc6\r\n',
      'utf8',
    )

    const result = await port.searchText({ root, pattern: 'target here', maxResults: 50 })
    expect(result.root).toBe(resolve(root))
    expect(result.matches).toEqual([
      { path: 'crlf.txt', line: 5, text: 'target here' },
      { path: 'lf.txt', line: 5, text: 'target here' },
    ])
    for (const match of result.matches) expect(match.text).not.toContain('\r')
    expect(result.truncated).toBe(false)
    expect(result.skippedBinary).toBe(0)
    expect(result.scannedFiles).toBe(2)
  })

  it('同一行多次命中只记一条', async () => {
    const port = createNodeFilePort()
    await fs.writeFile(join(root, 'repeat.txt'), 'dup dup dup\nnone\n', 'utf8')

    const result = await port.searchText({ root, pattern: 'dup', maxResults: 50 })
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toEqual({ path: 'repeat.txt', line: 1, text: 'dup dup dup' })
  })

  it('二进制文件（含 NUL 字节）被跳过并计入 skippedBinary', async () => {
    const port = createNodeFilePort()
    // 二进制里也有 NEEDLE，但它必须被 NUL 探测挡住
    await fs.writeFile(join(root, 'blob.bin'), Buffer.from('NEEDLE\0binary', 'utf8'))
    await fs.writeFile(join(root, 'text.txt'), 'NEEDLE text\n', 'utf8')

    const result = await port.searchText({ root, pattern: 'NEEDLE', maxResults: 50 })
    expect(result.matches).toEqual([{ path: 'text.txt', line: 1, text: 'NEEDLE text' }])
    expect(result.skippedBinary).toBe(1)
  })

  it('findFiles 只比名字、不受 maxFileScanBytes 约束：超大文件按名字仍然找得到', async () => {
    // 内容扫描阈值不该让一个 2 MiB 的 pnpm-lock.yaml 在 glob 里「按名字也找不到」
    await fs.writeFile(join(root, 'big.json'), `{"marker":"${'x'.repeat(1_500_000)}"}`, 'utf8')
    const port = createNodeFilePort({ maxFileScanBytes: 1_024 })

    const found = await port.findFiles({ root, pattern: '**/*.json', maxResults: 50 })
    expect(found.files).toContain('big.json')

    // 而内容扫描仍然跳过它（同一个上限对 searchText 生效）
    const searched = await port.searchText({ root, pattern: 'marker', maxResults: 50 })
    expect(searched.matches).toEqual([])
  })

  it('超过 maxFileScanBytes 的文件被跳过：其中的标记串不会被找到，且静默不计数', async () => {
    const port = createNodeFilePort({ maxFileScanBytes: 1_024 })
    // 标记串放在**开头**：确认跳过是按大小，而不是"没读到那个位置"
    await fs.writeFile(join(root, 'big.txt'), `NEEDLE_${'x'.repeat(2_048)}\n`, 'utf8')
    await fs.writeFile(join(root, 'small.txt'), 'NEEDLE small\n', 'utf8')

    const result = await port.searchText({ root, pattern: 'NEEDLE', maxResults: 50 })
    expect(result.matches).toEqual([{ path: 'small.txt', line: 1, text: 'NEEDLE small' }])
    // 大文件跳过是**刻意静默**的：计入了扫描数，但不单独开一个"已跳过 N 个大文件"的标注
    expect(result.scannedFiles).toBe(2)
    expect(result.skippedBinary).toBe(0)
    expect(result.budgetExceeded).toBe(false)
  })

  it('include 过滤生效：*.txt 只命中根目录的 txt，嵌套文件要用 **/*.txt', async () => {
    const port = createNodeFilePort()
    await fs.writeFile(join(root, 'hit.txt'), 'NEEDLE in txt\n', 'utf8')
    await fs.writeFile(join(root, 'hit.md'), 'NEEDLE in md\n', 'utf8')
    await fs.mkdir(join(root, 'nested'))
    await fs.writeFile(join(root, 'nested', 'deep.txt'), 'NEEDLE deep\n', 'utf8')

    // `include` 按**相对 root 的路径**全串匹配，`*` 不跨 `/`：所以 `*.txt` 只覆盖根目录一层
    const shallow = await port.searchText({
      root,
      pattern: 'NEEDLE',
      include: '*.txt',
      maxResults: 50,
    })
    expect(shallow.matches).toEqual([{ path: 'hit.txt', line: 1, text: 'NEEDLE in txt' }])

    const deep = await port.searchText({
      root,
      pattern: 'NEEDLE',
      include: '**/*.txt',
      maxResults: 50,
    })
    expect(deep.matches.map((match) => match.path)).toEqual(['hit.txt', 'nested/deep.txt'])
  })
})

describe('搜索预算：触顶仍返回已收集的结果', () => {
  it('searchBudget.maxFiles 收到 3：budgetExceeded 为 true，且前 3 个文件的结果照常返回', async () => {
    const port = createNodeFilePort({ searchBudget: { maxFiles: 3, maxBytes: 1_048_576 } })
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) {
      await fs.writeFile(join(root, name), 'NEEDLE\n', 'utf8')
    }

    const result = await port.searchText({ root, pattern: 'NEEDLE', maxResults: 50 })
    expect(result.budgetExceeded).toBe(true)
    expect(result.scannedFiles).toBe(3)
    // 不是抛错、也不是空结果：预算触顶时返回的是**已收集的结果**（稳定前缀）
    expect(result.matches.map((match) => match.path)).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(result.truncated).toBe(false)
  })

  it('findFiles 同样受预算约束：maxFiles 收到 2 时返回前 2 个匹配文件', async () => {
    const port = createNodeFilePort({ searchBudget: { maxFiles: 2, maxBytes: 1_048_576 } })
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      await fs.writeFile(join(root, name), 'x', 'utf8')
    }

    const result = await port.findFiles({ root, pattern: '**/*.txt', maxResults: 50 })
    expect(result.budgetExceeded).toBe(true)
    expect(result.scannedFiles).toBe(2)
    expect(result.files).toEqual(['a.txt', 'b.txt'])
    expect(result.truncated).toBe(false)
  })
})

describe('符号链接：一律不跟随（防目录环）', () => {
  let loopRoot = ''
  let symlinkError = ''

  beforeAll(async () => {
    loopRoot = await fs.mkdtemp(join(tmpdir(), 'aurora-files-loop-'))
    try {
      // 自指环：<root>/loop -> <root>。遍历若跟随它就会无限递归（永不返回）
      await fs.symlink(loopRoot, join(loopRoot, 'loop'), 'dir')
    } catch (error) {
      // Windows 未开开发者模式 / 非管理员时建 symlink 会抛 EPERM；
      // 这条用例按环境跳过并打印原因，**不让它因环境变红**（docs/06 §11.5 的风险 ②）
      const code = (error as NodeJS.ErrnoException).code
      symlinkError =
        `${code ?? ''} ${error instanceof Error ? error.message : String(error)}`.trim()
    }
  })

  afterAll(async () => {
    if (loopRoot !== '') await fs.rm(loopRoot, { recursive: true, force: true, maxRetries: 3 })
    loopRoot = ''
  })

  it('自指环下 5 秒内返回，且不重复访问同一目录', async (ctx) => {
    if (symlinkError !== '') {
      console.warn(`跳过符号链接环用例：当前环境无法创建符号链接（${symlinkError}）`)
      ctx.skip()
    }
    const port = createNodeFilePort()
    await fs.writeFile(join(loopRoot, 'only.txt'), 'NEEDLE in loop root\n', 'utf8')

    const found = await port.findFiles({ root: loopRoot, pattern: '**/*.txt', maxResults: 50 })
    expect(found.files).toEqual(['only.txt'])
    // 扫描数等于真实文件数：那个指向自己的目录没有（也一次都不该）被再次进入；
    // 若跟随了环，扫描数会一路涨到预算上限并把 budgetExceeded 置为 true
    expect(found.scannedFiles).toBe(1)
    expect(found.budgetExceeded).toBe(false)

    const searched = await port.searchText({ root: loopRoot, pattern: 'NEEDLE', maxResults: 50 })
    expect(searched.matches).toEqual([{ path: 'only.txt', line: 1, text: 'NEEDLE in loop root' }])
    expect(searched.scannedFiles).toBe(1)
    expect(searched.budgetExceeded).toBe(false)
  }, 5_000)
})
