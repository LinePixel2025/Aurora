import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { JsonStore } from './store.js'

/**
 * JsonStore 原子写（docs/12 §2.2）。并发回归（2026-09-27 真实事故）：登录的
 * mintClientToken 落盘 ∥ WS hello 的 verifyPairingToken 绑定落盘并发时，共享的
 * `.{名}.{PID}.tmp` 被先走者 rename 掉，后者 rename ENOENT → 登录间歇性 500。
 * 修复 = 同实例 save 串行化 + tmp 名带随机后缀。
 */
describe('JsonStore', () => {
  it('并发 save 不互相踩 tmp（登录 ∥ hello 绑定竞态回归）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aurora-center-store-'))
    const store = new JsonStore<Array<Record<string, string>>>(
      join(dir, 'tokens.json'),
      () => [],
    )
    // 20 个并发 save：修复前高概率第二个 rename ENOENT（tmp 已被第一个 rename 走）
    const writes = Array.from({ length: 20 }, (_, i) =>
      store.save([{ id: `t-${i}` }]).then(() => i),
    )
    await Promise.all(writes)
    // 最终文件可解析、无残留 tmp（每个 tmp 都要么被 rename 要么不该存在）
    const final = JSON.parse(await import('node:fs/promises').then((m) => m.readFile(join(dir, 'tokens.json'), 'utf8')))
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
    const raw = await import('node:fs/promises').then((m) => m.readFile(join(dir, 'users.json'), 'utf8'))
    expect(JSON.parse(raw)).toEqual([{ id: 'a' }, { id: 'b' }])
  })
})
