import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClassificationRecord } from '@aurora/shared'
import { CLASSIFICATION_FILE_NAME, ClassificationHistory } from './classification-history.js'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aurora-cls-hist-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function record(id: string, overrides: Partial<ClassificationRecord> = {}): ClassificationRecord {
  return {
    id,
    occurredAt: new Date(0).toISOString(),
    path: `D:\\感知\\${id}.pdf`,
    fileName: `${id}.pdf`,
    ext: 'pdf',
    sizeBytes: 10,
    subject: '数学',
    confidence: 0.9,
    reason: '测试',
    source: 'rule',
    ...overrides,
  }
}

describe('ClassificationHistory', () => {
  it('首次 init：无文件，返回空且不抛错', async () => {
    const history = new ClassificationHistory({ dir })
    const report = await history.init()
    expect(report).toEqual({ loaded: 0, corrupted: false })
    expect(history.list()).toEqual([])
  })

  it('追加后落盘，重启后可读回（新的在前）', async () => {
    const history = new ClassificationHistory({ dir, debounceMs: 0 })
    await history.init()
    history.append(record('a', { occurredAt: new Date(1000).toISOString() }))
    history.append(record('b', { occurredAt: new Date(2000).toISOString() }))
    await history.flush()

    const reopened = new ClassificationHistory({ dir })
    const report = await reopened.init()
    expect(report.loaded).toBe(2)
    expect(reopened.list().map((item) => item.id)).toEqual(['b', 'a'])
  })

  it('同一 id 重复 append 只保留一条（更新语义）', async () => {
    const history = new ClassificationHistory({ dir, debounceMs: 0 })
    await history.init()
    history.append(record('a', { subject: '数学' }))
    history.append(record('a', { subject: '物理' }))
    await history.flush()
    expect(history.list()).toHaveLength(1)
    expect(history.list()[0]?.subject).toBe('物理')
  })

  it('update 就地修补并返回新记录', async () => {
    const history = new ClassificationHistory({ dir, debounceMs: 0 })
    await history.init()
    history.append(record('a'))
    const updated = history.update('a', { movedTo: 'D:\\分类\\数学\\a.pdf' })
    expect(updated?.movedTo).toBe('D:\\分类\\数学\\a.pdf')
    expect(history.get('a')?.movedTo).toBe('D:\\分类\\数学\\a.pdf')
    await history.flush()
  })

  it('update 未知 id 返回 undefined', async () => {
    const history = new ClassificationHistory({ dir, debounceMs: 0 })
    await history.init()
    expect(history.update('ghost', { subject: 'x' })).toBeUndefined()
  })

  it('超过上限时丢弃最旧记录', async () => {
    const history = new ClassificationHistory({ dir, debounceMs: 0, max: 3 })
    await history.init()
    for (const id of ['a', 'b', 'c', 'd', 'e']) history.append(record(id))
    expect(history.list().map((item) => item.id)).toEqual(['e', 'd', 'c'])
    await history.flush()
  })

  it('文件损坏：备份原文件并重建为空', async () => {
    await writeFile(join(dir, CLASSIFICATION_FILE_NAME), '{ 这不是 JSON', 'utf8')
    const history = new ClassificationHistory({ dir })
    const report = await history.init()
    expect(report.corrupted).toBe(true)
    expect(report.loaded).toBe(0)
    expect(history.list()).toEqual([])
  })

  it('记录数组里的非法元素被过滤掉', async () => {
    await writeFile(
      join(dir, CLASSIFICATION_FILE_NAME),
      JSON.stringify({ version: 1, records: [record('good'), { nope: true }, null, 42] }),
      'utf8',
    )
    const history = new ClassificationHistory({ dir })
    const report = await history.init()
    expect(report.loaded).toBe(1)
    expect(history.list()[0]?.id).toBe('good')
  })

  it('records 不是数组时按空处理（不抛错）', async () => {
    await writeFile(
      join(dir, CLASSIFICATION_FILE_NAME),
      JSON.stringify({ version: 1, records: 'oops' }),
      'utf8',
    )
    const history = new ClassificationHistory({ dir })
    expect((await history.init()).loaded).toBe(0)
  })

  it('clear 清空流水并落盘', async () => {
    const history = new ClassificationHistory({ dir, debounceMs: 0 })
    await history.init()
    history.append(record('a'))
    await history.flush()
    history.clear()
    await history.flush()

    const reopened = new ClassificationHistory({ dir })
    expect((await reopened.init()).loaded).toBe(0)
  })

  it('corrected() 只返回用户修正过的记录（规则重建的依据）', async () => {
    const history = new ClassificationHistory({ dir, debounceMs: 0 })
    await history.init()
    history.append(record('a', { corrected: true }))
    history.append(record('b'))
    history.append(record('c', { corrected: true }))
    expect(
      history
        .corrected()
        .map((item) => item.id)
        .sort(),
    ).toEqual(['a', 'c'])
    await history.flush()
  })

  it('落盘内容包含版本号', async () => {
    const history = new ClassificationHistory({ dir, debounceMs: 0 })
    await history.init()
    history.append(record('a'))
    await history.flush()
    const raw = JSON.parse(await readFile(join(dir, CLASSIFICATION_FILE_NAME), 'utf8')) as {
      version: number
    }
    expect(raw.version).toBe(1)
  })

  it('debounce 模式下 flush 必须真正落盘', async () => {
    const history = new ClassificationHistory({ dir, debounceMs: 5000 })
    await history.init()
    history.append(record('a'))
    // 未 flush 前不应有文件（或内容为空）
    await history.flush()
    const raw = JSON.parse(await readFile(join(dir, CLASSIFICATION_FILE_NAME), 'utf8')) as {
      records: unknown[]
    }
    expect(raw.records).toHaveLength(1)
  })

  it('目标目录不存在时自动创建', async () => {
    const nested = join(dir, 'deep', 'nested')
    const history = new ClassificationHistory({ dir: nested, debounceMs: 0 })
    await history.init()
    history.append(record('a'))
    await history.flush()
    expect((await readFile(join(nested, CLASSIFICATION_FILE_NAME), 'utf8')).length).toBeGreaterThan(
      0,
    )
  })
})
