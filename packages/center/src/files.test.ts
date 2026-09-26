import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { FileStore, FileTooLargeError } from './files.js'

async function makeStore(maxFileBytes: number): Promise<{ store: FileStore; dir: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'aurora-center-files-'))
  const store = new FileStore({ dataDir, maxFileBytes })
  await store.init()
  return { store, dir: join(dataDir, 'files') }
}

function contentOf(text: string): Readable {
  return Readable.from([Buffer.from(text, 'utf8')])
}

describe('FileStore · 上传暂存', () => {
  it('保存 → 索引可查 → pathOf 落在暂存目录之内', async () => {
    const { store, dir } = await makeStore(1024 * 1024)
    const record = await store.save({
      clientId: 'c1',
      name: '报告.txt',
      note: '备注',
      content: contentOf('你好，Aurora Center'),
    })
    expect(record.size).toBeGreaterThan(0)
    expect(store.get(record.fileId)?.name).toBe('报告.txt')
    const path = store.pathOf(record.fileId)
    expect(path?.startsWith(dir)).toBe(true)
    expect(await readFile(path as string, 'utf8')).toBe('你好，Aurora Center')
  })

  it('文件名带路径分隔符 / 控制字符时被清洗，pathOf 绝不逃出暂存目录', async () => {
    const { store, dir } = await makeStore(1024 * 1024)
    const record = await store.save({
      clientId: 'c1',
      name: '../../../etc/passwd',
      content: contentOf('x'),
    })
    const path = store.pathOf(record.fileId)
    expect(path?.startsWith(dir)).toBe(true)
    expect(record.name).not.toContain('..')
    expect(record.name).not.toContain('/')
    expect(record.name).not.toContain('\\')
  })

  it('超过上限：抛 FileTooLargeError 且不留半截文件', async () => {
    const { store, dir } = await makeStore(8)
    await expect(
      store.save({ clientId: 'c1', name: 'big.bin', content: contentOf('12345678901234567890') }),
    ).rejects.toBeInstanceOf(FileTooLargeError)
    const entries = await readdir(dir)
    expect(entries.filter((name) => !name.startsWith('index'))).toEqual([])
  })

  it('未知 fileId 的 pathOf 返回 undefined', async () => {
    const { store } = await makeStore(1024)
    expect(store.pathOf('f-nope')).toBeUndefined()
  })
})
