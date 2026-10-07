import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { UsageStore } from './usage.js'

const dirs: string[] = []

async function makeStore(now: () => Date) {
  const dir = await mkdtemp(join(tmpdir(), 'aurora-center-usage-'))
  dirs.push(dir)
  const store = new UsageStore({ dataDir: dir, now })
  await store.init()
  return { dir, store }
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('Center token 用量', () => {
  it('终身总量、按日聚合和用户范围正确', async () => {
    let now = new Date('2026-10-01T10:00:00.000Z')
    const { store } = await makeStore(() => now)
    await store.record({
      userId: 'u1',
      username: 'alice',
      clientId: 'c1',
      model: 'm1',
      promptTokens: 10,
      completionTokens: 5,
      cachedTokens: 2,
    })
    now = new Date('2026-10-02T10:00:00.000Z')
    await store.record({
      userId: 'u2',
      username: 'bob',
      clientId: 'c2',
      model: 'm1',
      promptTokens: 20,
      completionTokens: 7,
    })

    const all = await store.query({ from: '2026-10-01', to: '2026-10-02' })
    expect(all.totals.totalTokens).toBe(42)
    expect(all.daily.map((day) => day.totalTokens)).toEqual([15, 27])
    expect(all.lifetime.requests).toBe(2)

    const alice = await store.query({ from: '2026-10-01', to: '2026-10-02', userId: 'u1' })
    expect(alice.totals.totalTokens).toBe(15)
    expect(alice.lifetime.totalTokens).toBe(15)
    expect(alice.recent[0]?.username).toBe('alice')
  })

  it('清理超过保留期的日文件，但保留终身累计', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z')
    const { dir, store } = await makeStore(() => now)
    await store.record({
      userId: 'u1',
      username: 'alice',
      clientId: 'c1',
      model: 'm1',
      promptTokens: 1,
      completionTokens: 1,
    })
    await writeFile(
      join(dir, 'usage', '2025-01-01.ndjson'),
      `${JSON.stringify({
        id: 'old',
        at: '2025-01-01T00:00:00.000Z',
        userId: 'u1',
        username: 'alice',
        clientId: 'c1',
        model: 'm1',
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      })}\n`,
      'utf8',
    )
    now = new Date('2026-10-01T00:00:00.000Z')
    await store.prune()
    expect((await store.query({ from: '2025-01-01', to: '2025-01-01' })).totals.requests).toBe(0)
    expect((await store.query()).lifetime.requests).toBe(1)
  })
})
