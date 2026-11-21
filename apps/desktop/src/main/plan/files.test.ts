import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryLogger } from '@aurora/shared'
import { createPlanFileStore, PLAN_READ_MAX_BYTES, type PlanFileStore } from './files.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function setup(): Promise<{ store: PlanFileStore; root: string; tick: () => string }> {
  const root = await mkdtemp(join(tmpdir(), 'aurora-plan-'))
  roots.push(root)
  let now = Date.parse('2026-11-21T10:00:00.000Z')
  const store = createPlanFileStore({
    dir: root,
    logger: createMemoryLogger(),
    clock: () => new Date((now += 1000)),
  })
  return { store, root, tick: () => new Date(now).toISOString() }
}

describe('PlanFileStore（docs/06 §29 计划 Markdown 文件）', () => {
  it('写入 md + index，列表新的在前；read 返回正文与标题', async () => {
    const { store, root } = await setup()
    const first = await store.write({
      sessionId: 'main',
      planId: 'call-1',
      markdown: '# 第一版\n\n内容 A',
      status: 'pending',
    })
    const second = await store.write({
      sessionId: 'main',
      planId: 'call-2',
      markdown: '# 第二版\n\n内容 B',
      status: 'pending',
    })
    expect(first.title).toBe('第一版')
    expect(second.title).toBe('第二版')
    const list = await store.list('main')
    expect(list.map((item) => item.id)).toEqual(['call-2', 'call-1'])
    const content = await store.read('main', 'call-1')
    expect(content.markdown).toContain('内容 A')
    expect(content.status).toBe('pending')

    const sessionDir = join(root, 'main')
    const names = await fs.readdir(sessionDir)
    expect(names.filter((name) => name.endsWith('.md'))).toHaveLength(2)
    expect(names).toContain('index.json')
    const index = JSON.parse(await readFile(join(sessionDir, 'index.json'), 'utf8')) as {
      plans: Array<{ id: string }>
    }
    expect(index.plans[0]?.id).toBe('call-2')
  })

  it('setStatus 更新索引；同状态幂等；未知 id 不报错', async () => {
    const { store } = await setup()
    await store.write({ sessionId: 'main', planId: 'call-1', markdown: '# P', status: 'pending' })
    await store.setStatus('main', 'call-1', 'approved')
    expect((await store.list('main'))[0]?.status).toBe('approved')
    await store.setStatus('main', 'call-1', 'approved')
    await store.setStatus('main', 'missing', 'exited')
    expect((await store.list('main'))[0]?.status).toBe('approved')
  })

  it('索引损坏 / 缺失时扫描 md 重建（状态 unknown，标题取首个 #）', async () => {
    const { store, root } = await setup()
    await store.write({
      sessionId: 'main',
      planId: 'call-1',
      markdown: '# 重建标题\n\n正文',
      status: 'pending',
    })
    const indexPath = join(root, 'main', 'index.json')
    await writeFile(indexPath, '{ not-json', 'utf8')
    const list = await store.list('main')
    expect(list).toHaveLength(1)
    expect(list[0]?.title).toBe('重建标题')
    expect(list[0]?.status).toBe('unknown')
    // read 也要能在索引坏掉后找到文件
    expect((await store.read('main', list[0]!.id)).markdown).toContain('正文')
  })

  it('文件缺失的索引项从列表过滤；read 未知 planId / 超大文件报错', async () => {
    const { store, root } = await setup()
    await store.write({ sessionId: 'main', planId: 'call-1', markdown: '# P', status: 'pending' })
    const names = await fs.readdir(join(root, 'main'))
    const file = names.find((name) => name.endsWith('.md'))
    expect(file).toBeDefined()
    await rm(join(root, 'main', file!))
    expect(await store.list('main')).toEqual([])
    await expect(store.read('main', 'nope')).rejects.toThrow(/不存在/)

    await store.write({ sessionId: 'main', planId: 'call-big', markdown: '# B', status: 'pending' })
    const big = await fs.readdir(join(root, 'main'))
    const bigFile = big.find((name) => name.includes('call-big'))
    expect(bigFile).toBeDefined()
    await writeFile(join(root, 'main', bigFile!), 'x'.repeat(PLAN_READ_MAX_BYTES + 1), 'utf8')
    await expect(store.read('main', 'call-big')).rejects.toThrow(/过大/)
  })

  it('remove 删正文并移出索引；deleteSession 清整个目录', async () => {
    const { store, root } = await setup()
    await store.write({ sessionId: 'main', planId: 'call-1', markdown: '# P', status: 'pending' })
    await store.write({ sessionId: 'quick', planId: 'call-2', markdown: '# Q', status: 'pending' })
    await store.remove('main', 'call-1')
    expect(await store.list('main')).toEqual([])
    await store.deleteSession('quick')
    await expect(fs.stat(join(root, 'quick'))).rejects.toThrow()
  })

  it('会话 id / planId 做白名单清洗，不会写到计划根目录之外', async () => {
    const { store, root } = await setup()
    await store.write({
      sessionId: '../../evil',
      planId: '../call-1',
      markdown: '# 标题\n\n正文',
      status: 'pending',
    })
    // normalizeSessionId('../../evil') = '______evil'
    const sessionDir = join(root, '______evil')
    const names = await fs.readdir(sessionDir)
    expect(names.some((name) => name.endsWith('.md'))).toBe(true)
    for (const name of names) {
      expect(name).not.toContain('..')
      expect(name).not.toContain('\\')
      expect(name).not.toContain('/')
    }
    await expect(store.read('main', '../../evil')).rejects.toThrow()
  })
})
