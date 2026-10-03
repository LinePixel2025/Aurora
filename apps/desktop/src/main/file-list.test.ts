/**
 * 右栏「文件」tab 的目录列表（2026-10-03，docs/07 §2.3）：
 * 用**真实临时目录**测（读盘 + 边界 realpath 校验没有值得替换的抽象层）。
 */
import { promises as nodeFs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildFileList, FILE_LIST_MAX_ENTRIES } from './file-list.js'

let base = ''
let outside = ''

beforeAll(async () => {
  base = await nodeFs.mkdtemp(join(tmpdir(), 'aurora-filelist-'))
  outside = await nodeFs.mkdtemp(join(tmpdir(), 'aurora-filelist-out-'))
  await nodeFs.mkdir(join(base, 'src'), { recursive: true })
  await nodeFs.mkdir(join(base, 'assets'), { recursive: true })
  await nodeFs.writeFile(join(base, 'readme.md'), '# 标题', 'utf8')
  // 数字感知排序：lesson2 必须排在 lesson10 前面
  await nodeFs.writeFile(join(base, 'lesson2.txt'), 'a', 'utf8')
  await nodeFs.writeFile(join(base, 'lesson10.txt'), 'b', 'utf8')
  await nodeFs.writeFile(join(outside, 'secret.txt'), 'x', 'utf8')
})

afterAll(async () => {
  if (base !== '') await nodeFs.rm(base, { recursive: true, force: true })
  if (outside !== '') await nodeFs.rm(outside, { recursive: true, force: true })
})

function port(root?: string) {
  return { rootOf: () => root }
}

describe('buildFileList（右栏文件管理器）', () => {
  it('缺省列出边界根本身：目录在前、同类按名称数字感知升序', async () => {
    const result = await buildFileList(port(base), { sessionId: 's1' })
    expect(result.root).toBe(base)
    expect(result.dir).toBe(base)
    expect(result.entries.map((entry) => entry.name)).toEqual([
      'assets',
      'src',
      'lesson2.txt',
      'lesson10.txt',
      'readme.md',
    ])
    expect(result.entries[0]?.kind).toBe('dir')
    const readme = result.entries.find((entry) => entry.name === 'readme.md')
    expect(readme?.path).toBe(join(base, 'readme.md'))
    expect(readme?.bytes).toBeGreaterThan(0)
  })

  it('可以列出子目录（`dir` 回填请求的目录，`root` 仍是边界根）', async () => {
    const result = await buildFileList(port(base), { sessionId: 's1', path: join(base, 'src') })
    expect(result.dir).toBe(join(base, 'src'))
    expect(result.root).toBe(base)
    expect(result.entries).toEqual([])
  })

  it('边界根之外的目录拒绝；根不可用直接拒绝（不退回无边界）', async () => {
    await expect(buildFileList(port(base), { sessionId: 's1', path: outside })).rejects.toThrow(
      /边界之外/,
    )
    await expect(buildFileList(port(undefined), { sessionId: 's1' })).rejects.toThrow(
      /没有可用的工作目录/,
    )
  })

  it('列出文件 / 不存在的路径都如实报错', async () => {
    await expect(
      buildFileList(port(base), { sessionId: 's1', path: join(base, 'readme.md') }),
    ).rejects.toThrow(/不是目录/)
    await expect(
      buildFileList(port(base), { sessionId: 's1', path: join(base, 'nope') }),
    ).rejects.toThrow(/不存在/)
  })

  it('超过上限截断并标记 truncated', async () => {
    const many = await nodeFs.mkdtemp(join(tmpdir(), 'aurora-filelist-many-'))
    try {
      for (let index = 0; index < FILE_LIST_MAX_ENTRIES + 3; index += 1) {
        await nodeFs.writeFile(join(many, `f${String(index).padStart(4, '0')}.txt`), '', 'utf8')
      }
      const result = await buildFileList(port(many), { sessionId: 's1' })
      expect(result.entries).toHaveLength(FILE_LIST_MAX_ENTRIES)
      expect(result.truncated).toBe(true)
    } finally {
      await nodeFs.rm(many, { recursive: true, force: true })
    }
  })
})
