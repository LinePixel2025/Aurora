import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMemoryLogger, type AutomationDefinition, type AutomationRun } from '@aurora/shared'
import type { FileSystemPort, Logger } from '@aurora/shared'
import { AUTOMATION_HISTORY_LIMIT, AutomationStore } from './store.js'

const DIR = 'C:\\aurora-automation-test'

/**
 * 最小内存文件系统（满足 FileSystemPort，docs/13 §2.1 的存储约定）。
 * readFile 带 1ms 延迟：真实演练「并发首读共享 in-flight promise」的窗口。
 */
class MemoryFs implements FileSystemPort {
  readonly files = new Map<string, string>()

  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }

  async readFile(path: string): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, 1))
    const content = this.files.get(path)
    if (content === undefined) throw new Error(`ENOENT: ${path}`)
    return content
  }

  async writeFileAtomic(path: string, content: string): Promise<void> {
    this.files.set(path, content)
  }

  async rename(from: string, to: string): Promise<void> {
    const content = this.files.get(from)
    if (content === undefined) throw new Error(`ENOENT: ${from}`)
    this.files.set(to, content)
    this.files.delete(from)
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path)
  }

  async mkdirp(): Promise<void> {}

  async readdir(path: string): Promise<string[]> {
    const prefix = path.endsWith('\\') || path.endsWith('/') ? path : `${path}\\`
    const names = new Set<string>()
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue
      const first = file.slice(prefix.length).split(/[\\/]/)[0]
      if (first) names.add(first)
    }
    return [...names]
  }
}

function definition(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: 'am-1',
    name: '早读提醒',
    enabled: true,
    mode: 'normal',
    trigger: { kind: 'daily', params: { at: '08:00' } },
    actions: [{ kind: 'system-notify', params: { title: '早读' } }],
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'am-1',
    automationName: '早读提醒',
    mode: 'normal',
    status: 'success',
    triggeredAt: '2026-03-02T08:00:00.000Z',
    ...overrides,
  }
}

interface StoreSetupOptions {
  seed?: Record<string, string>
  debounceMs?: number
  clock?: () => Date
}

function setup(options: StoreSetupOptions = {}): {
  store: AutomationStore
  fsPort: MemoryFs
  logger: Logger & { entries: string[] }
} {
  const fsPort = new MemoryFs()
  for (const [path, content] of Object.entries(options.seed ?? {})) {
    void fsPort.writeFileAtomic(path, content)
  }
  const logger = createMemoryLogger()
  const store = new AutomationStore({
    dir: DIR,
    fs: fsPort,
    logger,
    writeDebounceMs: options.debounceMs ?? 0,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  })
  return { store, fsPort, logger }
}

describe('AutomationStore · 定义', () => {
  it('saveDefinition 新建补 createdAt / updatedAt，读取往返一致', async () => {
    const now = new Date('2026-03-02T08:00:00.000Z')
    const { store } = setup({ clock: () => now })
    const saved = await store.saveDefinition(definition())
    expect(saved.id).toBe('am-1')
    expect(saved.createdAt).toBe('2026-03-02T08:00:00.000Z')
    expect(saved.updatedAt).toBe('2026-03-02T08:00:00.000Z')

    const list = await store.listDefinitions()
    expect(list).toHaveLength(1)
    expect(list[0]).toEqual(saved)
    // 返回的是拷贝：改返回值不影响存储
    list[0]!.name = '外部改动'
    expect((await store.listDefinitions())[0]?.name).toBe('早读提醒')
  })

  it('saveDefinition 更新保留 createdAt、刷新 updatedAt', async () => {
    let now = new Date('2026-03-02T08:00:00.000Z')
    const { store } = setup({ clock: () => now })
    await store.saveDefinition(definition())
    now = new Date('2026-03-02T09:00:00.000Z')
    const updated = await store.saveDefinition(definition({ name: '改名了' }))
    expect(updated.createdAt).toBe('2026-03-02T08:00:00.000Z')
    expect(updated.updatedAt).toBe('2026-03-02T09:00:00.000Z')
    const list = await store.listDefinitions()
    expect(list).toHaveLength(1)
    expect(list[0]?.name).toBe('改名了')
  })

  it('deleteDefinition：存在返回 true 并移除，不存在返回 false', async () => {
    const { store } = setup()
    await store.saveDefinition(definition())
    expect(await store.deleteDefinition('am-1')).toBe(true)
    expect(await store.listDefinitions()).toEqual([])
    expect(await store.deleteDefinition('am-1')).toBe(false)
  })
})

describe('AutomationStore · 运行历史', () => {
  it('appendRun + listRuns：按触发时间倒序，支持 automationId / mode / status 过滤', async () => {
    const { store } = setup()
    await store.appendRun(run({ id: 'r1', triggeredAt: '2026-03-02T08:00:00.000Z' }))
    await store.appendRun(
      run({
        id: 'r2',
        automationId: 'am-2',
        automationName: '整理笔记',
        mode: 'agent',
        status: 'running',
        triggeredAt: '2026-03-02T08:05:00.000Z',
      }),
    )
    await store.appendRun(
      run({ id: 'r3', status: 'failed', triggeredAt: '2026-03-02T08:10:00.000Z' }),
    )

    expect((await store.listRuns()).map((item) => item.id)).toEqual(['r3', 'r2', 'r1'])
    expect((await store.listRuns({ automationId: 'am-2' })).map((item) => item.id)).toEqual(['r2'])
    expect((await store.listRuns({ mode: 'agent' })).map((item) => item.id)).toEqual(['r2'])
    expect((await store.listRuns({ status: 'failed' })).map((item) => item.id)).toEqual(['r3'])
    expect(await store.listRuns({ automationId: 'nope' })).toEqual([])
  })

  it('写入超过 AUTOMATION_HISTORY_LIMIT(500) 条后只剩最新 500 条', async () => {
    const { store } = setup()
    const total = AUTOMATION_HISTORY_LIMIT + 2
    for (let i = 0; i < total; i += 1) {
      await store.appendRun(
        run({ id: `r${i}`, triggeredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }),
      )
    }
    // limit: 0 = 不过滤条数，返回全部
    const all = await store.listRuns({ limit: 0 })
    expect(all).toHaveLength(AUTOMATION_HISTORY_LIMIT)
    expect(all.some((item) => item.id === 'r0')).toBe(false)
    expect(all.some((item) => item.id === 'r1')).toBe(false)
    expect(all.some((item) => item.id === `r${total - 1}`)).toBe(true)
  })

  it('updateRun 改状态 / 补 sessionId / error: undefined 删键', async () => {
    const { store } = setup()
    await store.appendRun(run({ id: 'r1', mode: 'agent', status: 'running' }))

    const patched = await store.updateRun('r1', { sessionId: 'auto-1' })
    expect(patched?.sessionId).toBe('auto-1')

    const failed = await store.updateRun('r1', {
      status: 'failed',
      finishedAt: '2026-03-02T08:01:00.000Z',
      durationMs: 12,
      error: '模型不可用',
    })
    expect(failed?.status).toBe('failed')
    expect(failed?.error).toBe('模型不可用')

    // error: undefined = 删键（而不是留一个 undefined 值）
    const cleared = await store.updateRun('r1', { error: undefined })
    expect(cleared?.error).toBeUndefined()
    expect(Object.keys(cleared ?? {})).not.toContain('error')

    expect(await store.updateRun('missing', { status: 'success' })).toBeUndefined()
  })

  it('markInterruptedRuns 把 running 改判 interrupted 并补 finishedAt（幂等）', async () => {
    const { store } = setup({ clock: () => new Date('2026-03-02T10:00:00.000Z') })
    await store.appendRun(run({ id: 'r1', status: 'running' }))
    await store.appendRun(run({ id: 'r2', status: 'success' }))
    await store.appendRun(run({ id: 'r3', status: 'running' }))

    expect(await store.markInterruptedRuns()).toBe(2)
    const runs = await store.listRuns({ limit: 0 })
    const interrupted = runs.filter((item) => item.status === 'interrupted')
    expect(interrupted.map((item) => item.id).sort()).toEqual(['r1', 'r3'])
    for (const item of interrupted) {
      expect(item.finishedAt).toBe('2026-03-02T10:00:00.000Z')
    }
    expect(runs.find((item) => item.id === 'r2')?.status).toBe('success')

    // 再跑一遍：没有 running 了，返回 0
    expect(await store.markInterruptedRuns()).toBe(0)
  })
})

describe('AutomationStore · 装载与落盘', () => {
  it('并发首读共享 in-flight promise：两次 listDefinitions 都拿到磁盘数据而不是空', async () => {
    const { store } = setup({
      seed: {
        [join(DIR, 'automations.json')]: JSON.stringify({
          version: 1,
          definitions: [definition()],
        }),
      },
    })
    const [first, second] = await Promise.all([store.listDefinitions(), store.listDefinitions()])
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(first[0]?.id).toBe('am-1')
    expect(second[0]?.id).toBe('am-1')
  })

  it('损坏的 automations.json：备份为 .corrupt- 文件、按空表继续、留告警日志', async () => {
    const { store, fsPort, logger } = setup({
      seed: { [join(DIR, 'automations.json')]: '{ 这不是 JSON' },
    })
    expect(await store.listDefinitions()).toEqual([])
    const entries = await fsPort.readdir(DIR)
    expect(entries.some((name) => name.includes('.corrupt-'))).toBe(true)
    expect(logger.entries.some((line) => line.includes('损坏'))).toBe(true)
  })

  it('形状不对的条目被宽容丢弃，合法条目保留', async () => {
    const { store } = setup({
      seed: {
        [join(DIR, 'automations.json')]: JSON.stringify({
          version: 1,
          definitions: [
            definition(),
            { id: '', name: '缺 id' },
            { id: 'am-bad', name: 42 },
            { id: 'am-bad2' },
          ],
        }),
      },
    })
    const list = await store.listDefinitions()
    expect(list).toHaveLength(1)
    expect(list[0]?.id).toBe('am-1')
  })

  it('flush 后数据落盘（内存 fs 里能读到文件内容）', async () => {
    const { store, fsPort } = setup({ debounceMs: 300 })
    await store.saveDefinition(definition())
    // 防抖窗口内磁盘上还没有
    expect(await fsPort.exists(join(DIR, 'automations.json'))).toBe(false)
    await store.flush()
    const raw = JSON.parse(await fsPort.readFile(join(DIR, 'automations.json'))) as {
      version: number
      definitions: AutomationDefinition[]
    }
    expect(raw.version).toBe(1)
    expect(raw.definitions).toHaveLength(1)
    expect(raw.definitions[0]?.id).toBe('am-1')
    // 历史没有脏数据：不写空 history.json
    expect(await fsPort.exists(join(DIR, 'history.json'))).toBe(false)
  })

  it('落盘后新实例能读回定义与历史（writeDebounceMs: 0 立即写）', async () => {
    const { store, fsPort } = setup()
    await store.saveDefinition(definition())
    await store.appendRun(run())
    expect(await fsPort.exists(join(DIR, 'automations.json'))).toBe(true)
    expect(await fsPort.exists(join(DIR, 'history.json'))).toBe(true)

    const second = new AutomationStore({ dir: DIR, fs: fsPort, writeDebounceMs: 0 })
    expect(await second.listDefinitions()).toHaveLength(1)
    expect((await second.listDefinitions())[0]?.name).toBe('早读提醒')
    const runs = await second.listRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]?.automationId).toBe('am-1')
  })
})
