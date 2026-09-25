/**
 * `FilePort` 主进程实现的单测（docs/06 §11、§20）。
 *
 * 用 `os.tmpdir()` 下的真实临时目录（每个用例一个随机目录，`afterEach` 递归删除），
 * 因为本文件不 import electron，所以能进 vitest 的 Node 环境。
 *
 * 行窗口语义（`offsetLines` / `limitLines` / `maxBytes` / CRLF / 扫描上限）逐条钉在这里；
 * 内核侧的渲染与参数钳制在 `packages/agent-core/src/tools/files.test.ts`。
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// 常量与内核同源（不在这里另抄一份字面量）
import { DEFAULT_READ_LINES, MAX_READ_LINES, MAX_READ_SCAN_BYTES } from '@aurora/agent-core'
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
