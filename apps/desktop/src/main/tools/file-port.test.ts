/**
 * `FilePort` 主进程实现的单测（docs/06 §11）。
 *
 * 用 `os.tmpdir()` 下的真实临时目录（每个用例一个随机目录，`afterEach` 递归删除），
 * 因为本文件不 import electron，所以能进 vitest 的 Node 环境。
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
  it('写入后能原样读回，内容与字节数一致', async () => {
    const port = createNodeFilePort()
    const file = join(root, 'note.txt')
    const text = '第一行\nsecond'

    const written = await port.writeText(file, text, 'overwrite')
    expect(written.absolutePath).toBe(resolve(file))
    expect(written.bytes).toBe(Buffer.byteLength(text, 'utf8'))

    const read = await port.readText(file, 65_536)
    expect(read.absolutePath).toBe(resolve(file))
    expect(read.text).toBe(text)
    expect(read.truncated).toBe(false)
    expect(read.bytes).toBe(written.bytes)
  })

  it('空文件可以读回：0 字节、空文本', async () => {
    const port = createNodeFilePort()
    const file = join(root, 'empty.txt')

    const written = await port.writeText(file, '', 'overwrite')
    expect(written.bytes).toBe(0)
    const read = await port.readText(file, 65_536)
    expect(read.text).toBe('')
    expect(read.bytes).toBe(0)
    expect(read.truncated).toBe(false)
  })

  it('父目录不存在时自动创建多级目录', async () => {
    const port = createNodeFilePort()
    const file = join(root, 'a', 'b', 'c', 'deep.txt')

    await port.writeText(file, 'deep', 'overwrite')
    const read = await port.readText(file, 65_536)
    expect(read.text).toBe('deep')
  })

  it('append 追加到已有文件末尾', async () => {
    const port = createNodeFilePort()
    const file = join(root, 'log.txt')

    await port.writeText(file, 'first\n', 'overwrite')
    const appended = await port.writeText(file, 'second\n', 'append')
    expect(appended.bytes).toBe(7)

    const read = await port.readText(file, 65_536)
    expect(read.text).toBe('first\nsecond\n')
    expect(read.bytes).toBe(13)
  })
})

describe('二进制与截断', () => {
  it('前 8 KiB 内出现 NUL 字节时按二进制拒绝', async () => {
    const port = createNodeFilePort()
    const file = join(root, 'blob.bin')
    await fs.writeFile(file, Buffer.from([0x41, 0x00, 0x42]))

    await expect(port.readText(file, 65_536)).rejects.toThrow('二进制')
  })

  it('超过 maxBytes 时截断并标记 truncated', async () => {
    const port = createNodeFilePort()
    const file = join(root, 'big.txt')
    // ASCII 构造：4000 字节 == 4000 字符，避免多字节字符的歧义
    await fs.writeFile(file, 'A'.repeat(4_000), 'utf8')

    const read = await port.readText(file, 1_024)
    expect(read.truncated).toBe(true)
    expect(read.bytes).toBe(1_024)
    expect(read.text).toHaveLength(1_024)
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

    await expect(port.readText(missing, 65_536)).rejects.toThrow(resolve(missing))
    await expect(port.list(join(root, 'nope'), 10)).rejects.toThrow(resolve(root, 'nope'))
  })

  it('把目录当文件读：报错并提示改用 list_dir', async () => {
    const port = createNodeFilePort()

    await expect(port.readText(root, 65_536)).rejects.toThrow('这是目录')
  })
})
