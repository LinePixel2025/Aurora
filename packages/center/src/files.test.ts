import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { FILE_TTL_MS, FileStore, FileTooLargeError } from './files.js'

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

describe('FileStore · 过期与删除', () => {
  it('保存时写入 expiresAt（= uploadedAt + 24h）', async () => {
    const { store } = await makeStore(1024 * 1024)
    const record = await store.save({ clientId: 'c1', name: 'a.txt', content: contentOf('x') })
    const expected = new Date(record.at).getTime() + FILE_TTL_MS
    expect(new Date(record.expiresAt).getTime()).toBe(expected)
  })

  it('remove：删物理文件 + 索引条目；未知 fileId 返回 false', async () => {
    const { store, dir } = await makeStore(1024 * 1024)
    const keep = await store.save({ clientId: 'c1', name: 'keep.txt', content: contentOf('k') })
    const gone = await store.save({ clientId: 'c1', name: 'gone.txt', content: contentOf('g') })
    expect(await store.remove('f-nope')).toBe(false)
    expect(await store.remove(gone.fileId)).toBe(true)
    expect(store.get(gone.fileId)).toBeUndefined()
    const entries = await readdir(dir)
    expect(entries.some((name) => name.includes(gone.fileId))).toBe(false)
    expect(store.get(keep.fileId)).toBeDefined()
  })

  it('pruneExpired 真实清理：索引里 expiresAt 已过期的条目被删（经落盘 + 重启实例验证）', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'aurora-center-files-prune-'))
    const first = new FileStore({ dataDir, maxFileBytes: 1024 * 1024 })
    await first.init()
    const fresh = await first.save({ clientId: 'c1', name: 'fresh.txt', content: contentOf('f') })
    const stale = await first.save({ clientId: 'c1', name: 'stale.txt', content: contentOf('s') })
    // 直接改 first 的索引并落盘（JsonStore.save 原子写），模拟"stale 已过期"
    const indexFile = join(dataDir, 'files', 'index.json')
    const raw = JSON.parse(await readFile(indexFile, 'utf8')) as Array<{
      fileId: string
      at: string
      expiresAt: string
    }>
    const staleEntry = raw.find((r) => r.fileId === stale.fileId)!
    staleEntry.at = new Date(Date.now() - 25 * 3600 * 1000).toISOString()
    staleEntry.expiresAt = new Date(new Date(staleEntry.at).getTime() + FILE_TTL_MS).toISOString()
    await writeFile(indexFile, JSON.stringify(raw), 'utf8')

    // 新实例（重启）读回篡改后的索引并清理
    const second = new FileStore({ dataDir, maxFileBytes: 1024 * 1024 })
    await second.init()
    expect(await second.pruneExpired()).toBe(1)
    expect(second.get(stale.fileId)).toBeUndefined()
    expect(second.get(fresh.fileId)).toBeDefined()
    const entries = await readdir(join(dataDir, 'files'))
    expect(entries.some((name) => name.includes(stale.fileId))).toBe(false)
    expect(entries.some((name) => name.includes(fresh.fileId))).toBe(true)
  })

  it('init 兜底：旧索引缺 expiresAt 的条目按 uploadedAt + 24h 补算', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'aurora-center-files-backfill-'))
    const dir = join(dataDir, 'files')
    const uploadedAt = new Date(Date.now() - 3600 * 1000).toISOString()
    // 手工种一份 v0.2.x 形状的索引（无 expiresAt）
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'index.json'),
      JSON.stringify([
        { fileId: 'f-old', clientId: 'c1', name: 'old.txt', size: 1, at: uploadedAt },
      ]),
      'utf8',
    )
    const store = new FileStore({ dataDir, maxFileBytes: 1024 * 1024 })
    await store.init()
    const record = store.get('f-old')
    expect(record).toBeDefined()
    expect(new Date(record!.expiresAt).getTime()).toBe(new Date(uploadedAt).getTime() + FILE_TTL_MS)
  })
})
