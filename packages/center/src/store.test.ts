import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { JsonStore, renameWithRetry } from './store.js'

/**
 * JsonStore 原子写（docs/12 §2.2）。并发回归（2026-09-27 真实事故）：登录的
 * mintClientToken 落盘 ∥ WS hello 的 verifyClientToken 绑定落盘并发时，共享的
 * `.{名}.{PID}.tmp` 被先走者 rename 掉，后者 rename ENOENT → 登录间歇性 500。
 * 修复 = 同实例 save 串行化 + tmp 名带随机后缀。
 */
describe('JsonStore', () => {
  it('并发 save 不互相踩 tmp（登录 ∥ hello 绑定竞态回归）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aurora-center-store-'))
    const store = new JsonStore<Array<Record<string, string>>>(join(dir, 'tokens.json'), () => [])
    // 20 个并发 save：修复前高概率第二个 rename ENOENT（tmp 已被第一个 rename 走）
    const writes = Array.from({ length: 20 }, (_, i) =>
      store.save([{ id: `t-${i}` }]).then(() => i),
    )
    await Promise.all(writes)
    // 最终文件可解析、无残留 tmp（每个 tmp 都要么被 rename 要么不该存在）
    const final = JSON.parse(
      await import('node:fs/promises').then((m) => m.readFile(join(dir, 'tokens.json'), 'utf8')),
    )
    expect(Array.isArray(final)).toBe(true)
    const leftovers = (await import('node:fs/promises').then((m) => m.readdir(dir))).filter((f) =>
      f.endsWith('.tmp'),
    )
    expect(leftovers).toEqual([])
  })

  it('串行 save 后写覆盖前写（全量快照语义不变）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aurora-center-store-'))
    const store = new JsonStore<Array<{ id: string }>>(join(dir, 'users.json'), () => [])
    await store.save([{ id: 'a' }])
    await store.save([{ id: 'a' }, { id: 'b' }])
    const raw = await import('node:fs/promises').then((m) =>
      m.readFile(join(dir, 'users.json'), 'utf8'),
    )
    expect(JSON.parse(raw)).toEqual([{ id: 'a' }, { id: 'b' }])
  })
})

/**
 * Windows 回归（2026-11-14 实测偶发红）：杀软 / 索引器短暂占用目标文件时，
 * rename 覆盖会瞬时 EPERM / EBUSY；不重试就会让低概率的登录落盘 500 复现。
 */
describe('renameWithRetry', () => {
  it('EPERM / EBUSY 退避重试后成功', async () => {
    const codes = ['EPERM', 'EBUSY']
    let calls = 0
    const rename = async () => {
      calls += 1
      const code = codes[calls - 1]
      if (code !== undefined) {
        const error = new Error('transient') as NodeJS.ErrnoException
        error.code = code
        throw error
      }
    }
    await renameWithRetry('tmp.json', 'target.json', rename)
    expect(calls).toBe(3)
  })

  it('非瞬时错误不重试，原样抛出', async () => {
    let calls = 0
    const rename = async () => {
      calls += 1
      const error = new Error('missing') as NodeJS.ErrnoException
      error.code = 'ENOENT'
      throw error
    }
    await expect(renameWithRetry('tmp.json', 'target.json', rename)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(calls).toBe(1)
  })

  it('重试次数耗尽后抛出最后一次错误', async () => {
    let calls = 0
    const rename = async () => {
      calls += 1
      const error = new Error('locked') as NodeJS.ErrnoException
      error.code = 'EPERM'
      throw error
    }
    await expect(renameWithRetry('tmp.json', 'target.json', rename, 3)).rejects.toMatchObject({
      code: 'EPERM',
    })
    expect(calls).toBe(3)
  })
})
