/**
 * FileJobStore 的单测（docs/06 §4.1）。
 *
 * 全部跑在内存文件系统桩（`MemoryFs`）上，不碰真实磁盘、不跑真实定时器：
 * 防抖用「不 await 就能让定时器不触发」这一确定性质来验证，时间戳用注入时钟。
 *
 * 覆盖本轮明确要修的两处：`ensureLoaded` 的并发首读（不能返回空表）、
 * `update` 必须按 id 定位（不能误改同会话的其它 job）。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMemoryLogger, type FileSystemPort, type Logger } from '@aurora/shared'
import {
  DEFAULT_JOB_LIST_LIMIT,
  JOBS_WRITE_DEBOUNCE_MS,
  createFileJobStore,
  type FileJobStoreOptions,
  type JobStore,
} from './store.js'
import { JOBS_FILE_VERSION, createJob, toJobSummary, type AgentJob } from './types.js'

/** job 目录（固定盘符 + 反斜杠，避免平台分隔符差异影响断言） */
const DIR = 'C:\\aurora-test\\jobs'
const CLOCK_START = '2026-09-26T10:52:31.123Z'

/** 内存文件系统桩：只保留形状，不模拟真实盘 */
class MemoryFs implements FileSystemPort {
  readonly files = new Map<string, string>()
  /** 每次 writeFileAtomic 的目标路径（按调用顺序） */
  readonly writeLog: string[] = []
  failNextWrite = false
  failNextRead = false

  mount(path: string, content: string): void {
    this.files.set(path, content)
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path))
  }

  readFile(path: string): Promise<string> {
    if (this.failNextRead) {
      this.failNextRead = false
      return Promise.reject(new Error('EIO: 模拟读盘失败'))
    }
    const content = this.files.get(path)
    if (content === undefined) return Promise.reject(new Error(`ENOENT: ${path}`))
    return Promise.resolve(content)
  }

  writeFileAtomic(path: string, content: string): Promise<void> {
    this.writeLog.push(path)
    if (this.failNextWrite) {
      this.failNextWrite = false
      return Promise.reject(new Error('EACCES: 模拟写盘失败'))
    }
    this.files.set(path, content)
    return Promise.resolve()
  }

  rename(from: string, to: string): Promise<void> {
    const content = this.files.get(from)
    if (content === undefined) return Promise.reject(new Error(`ENOENT: ${from}`))
    this.files.set(to, content)
    this.files.delete(from)
    return Promise.resolve()
  }

  remove(path: string): Promise<void> {
    this.files.delete(path)
    return Promise.resolve()
  }

  mkdirp(_path?: string): Promise<void> {
    return Promise.resolve()
  }

  /** 列出某目录下的直接子文件名（含子目录名，与真实 readdir 同口径） */
  readdir(path: string): Promise<string[]> {
    const names = new Set<string>()
    for (const file of this.files.keys()) {
      if (dirnameOf(file) === path) {
        names.add(file.slice(path.length + 1))
        continue
      }
      if (!file.startsWith(`${path}\\`)) continue
      const first = file.slice(path.length + 1).split('\\')[0]
      if (first) names.add(first)
    }
    return Promise.resolve([...names])
  }
}

/** 平台安全的 dirname（测试目录固定是反斜杠路径，这里不引 node:path 的歧义） */
function dirnameOf(path: string): string {
  const index = path.lastIndexOf('\\')
  return index <= 0 ? path : path.slice(0, index)
}

/** 可控时钟：每次读**前进 1ms**，于是连续 create 出来的 job 时间戳天然严格递增 */
class ClockController {
  private current: number

  constructor(startIso: string) {
    this.current = new Date(startIso).getTime()
  }

  readonly now = (): Date => {
    const value = new Date(this.current)
    this.current += 1
    return value
  }

  /** 让下一个时间戳再往后跳，用来制造"同一批但 updatedAt 不同"的数据 */
  advance(ms: number): void {
    this.current += ms
  }

  /** 下一次 `now()` 会给出的毫秒值（断言被时钟决定的更新时间时用） */
  get nowMs(): number {
    return this.current
  }
}

interface Harness {
  fs: MemoryFs
  logger: Logger & { entries: string[] }
  clock: ClockController
  /** 带 `dispose`（接口上没有，实现类才有）：用例收尾时取消防抖定时器 */
  store: JobStore & { dispose(): void }
  sessionPath: (sessionId: string) => string
  /** 新建一个 store 实例读同一份内存盘（模拟重启） */
  reopen: (overrides?: Partial<FileJobStoreOptions>) => JobStore & { dispose(): void }
}

function createHarness(overrides: Partial<FileJobStoreOptions> = {}): Harness {
  const fs = new MemoryFs()
  const logger = createMemoryLogger()
  const clock = new ClockController(CLOCK_START)
  const reopen = (extra: Partial<FileJobStoreOptions> = {}): JobStore & { dispose(): void } =>
    createFileJobStore({
      dir: DIR,
      fs,
      logger,
      clock: clock.now,
      writeDebounceMs: 0,
      ...overrides,
      ...extra,
    }) as JobStore & { dispose(): void }
  return {
    fs,
    logger,
    clock,
    store: reopen(),
    sessionPath: (sessionId) => join(DIR, `${sessionId}.json`),
    reopen,
  }
}

/** job 夹具：显式写 `status` / `updatedAt`，让排序类用例完全确定 */
function makeJob(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id: 'job-1',
    sessionId: 's1',
    status: 'running',
    origin: 'chat',
    text: '帮我把这份文档分类',
    round: 0,
    maxRounds: 8,
    stepsDone: [],
    todos: [],
    cursor: { nextRound: 0 },
    budget: { maxTotalTokens: 100000, usedTokens: 0, autoContinued: 0 },
    createdAt: CLOCK_START,
    updatedAt: CLOCK_START,
    ...overrides,
  }
}

/** 直接往内存盘种一份 job 文件（懒加载类用例用） */
function mountJobs(harness: Harness, sessionId: string, jobs: AgentJob[]): void {
  harness.fs.mount(
    harness.sessionPath(sessionId),
    `${JSON.stringify({ version: JOBS_FILE_VERSION, jobs }, null, 2)}\n`,
  )
}

async function readFileJobs(harness: Harness, sessionId: string): Promise<AgentJob[]> {
  const raw = harness.fs.files.get(harness.sessionPath(sessionId))
  if (raw === undefined) return []
  return (JSON.parse(raw) as { jobs: AgentJob[] }).jobs
}

/** 目录下的损坏备份文件名（按字典序 = 新旧序） */
async function backupFiles(harness: Harness): Promise<string[]> {
  return (await harness.fs.readdir(DIR))
    .filter((name) => name.startsWith('s1.corrupt-') && name.endsWith('.json'))
    .sort()
}

function requireName(name: string | undefined): string {
  if (name === undefined) throw new Error('期望有一个备份文件名，实际是 undefined')
  return name
}

function requireJob(job: AgentJob | undefined): AgentJob {
  if (job === undefined) throw new Error('期望取到 job，实际是 undefined')
  return job
}

describe('createJob / toJobSummary', () => {
  it('生成 running、round 0、空进度账本与持久化的 autoContinued', () => {
    const clock = new ClockController(CLOCK_START)
    const job = createJob(
      { sessionId: 's1', text: '你好', maxRounds: 5, maxTotalTokens: 8000, origin: 'chat' },
      { clock: clock.now },
    )
    expect(job.status).toBe('running')
    expect(job.round).toBe(0)
    expect(job.cursor.nextRound).toBe(0)
    expect(job.stepsDone).toEqual([])
    expect(job.budget).toEqual({ maxTotalTokens: 8000, usedTokens: 0, autoContinued: 0 })
    expect(job.createdAt).toBe(CLOCK_START)
    expect(job.updatedAt).toBe(CLOCK_START)
    expect(job.id).toMatch(/^job-[0-9a-z]+-\d+$/)
  })

  it('同一固定时钟下连建多条也不会撞 id', () => {
    const first = createJob(
      { sessionId: 's1', text: 'a', maxRounds: 1, maxTotalTokens: 1, origin: 'chat' },
      { clock: () => new Date(CLOCK_START) },
    )
    const second = createJob(
      { sessionId: 's1', text: 'b', maxRounds: 1, maxTotalTokens: 1, origin: 'chat' },
      { clock: () => new Date(CLOCK_START) },
    )
    expect(first.id).not.toBe(second.id)
  })

  it('toJobSummary 只带小对象字段，lastStep 取最近一步', () => {
    const job = makeJob({
      stepsDone: [
        { round: 0, tool: 'read_file', ok: true, at: CLOCK_START },
        { round: 1, tool: 'run_command', ok: false, at: CLOCK_START },
      ],
      todos: [{ id: 't1', text: '分类', status: 'in_progress' }],
      budget: { maxTotalTokens: 500, usedTokens: 120, autoContinued: 2 },
      error: '上一次失败了',
    })
    const summary = toJobSummary(job)
    expect(summary).toEqual({
      id: 'job-1',
      sessionId: 's1',
      status: 'running',
      round: 0,
      maxRounds: 8,
      usedTokens: 120,
      maxTotalTokens: 500,
      autoContinued: 2,
      stepCount: 2,
      lastStep: 'run_command ✗',
      updatedAt: CLOCK_START,
      error: '上一次失败了',
    })
    // 全量字段不出现在小对象里（列表与事件推送不该背 todos / stepsDone）
    expect('todos' in summary).toBe(false)
    expect('stepsDone' in summary).toBe(false)
  })
})

describe('FileJobStore', () => {
  it('往返：create → get 拿到同一份，list 也能看到它', async () => {
    const harness = createHarness()
    const job = makeJob({ id: 'job-round-trip' })
    await harness.store.create(job)
    await harness.store.flush()

    expect(await harness.store.get(job.id)).toEqual(job)
    const listed = await harness.store.list()
    expect(listed.map((item) => item.id)).toEqual([job.id])
    expect(listed[0]).toEqual(job)
  })

  it('懒加载：新建 store 后先 list() 就能读到磁盘上已有的文件', async () => {
    const harness = createHarness()
    const seeded = makeJob({ id: 'job-seeded', status: 'paused' })
    mountJobs(harness, 's1', [seeded])

    const listed = await harness.store.list()
    expect(listed.map((item) => item.id)).toEqual(['job-seeded'])
    expect(await harness.store.get('job-seeded')).toEqual(seeded)
  })

  it('文件不存在：按空表读取且不创建文件（首次运行不是错误）', async () => {
    const harness = createHarness()
    await expect(harness.store.list()).resolves.toEqual([])
    await expect(harness.store.get('job-none')).resolves.toBeUndefined()
    expect(harness.fs.files.size).toBe(0)
    expect(harness.fs.writeLog).toEqual([])
    // 读失败也不该冒出 error 级日志（首次运行是正常路径）
    expect(harness.logger.entries.some((entry) => entry.startsWith('[error]'))).toBe(false)
  })

  it('读盘失败不留下"永久空表"：下一次访问重新读盘', async () => {
    const harness = createHarness()
    const seeded = makeJob({ id: 'job-on-disk' })
    mountJobs(harness, 's1', [seeded])
    harness.fs.failNextRead = true

    // 第一次读盘失败 → 降级为空表，但**不锁定** loaded，也不建文件
    await expect(harness.store.list()).resolves.toEqual([])
    expect(harness.fs.files.has(harness.sessionPath('s1'))).toBe(true)

    // 第二次访问重试读盘：盘上的 job 必须回来（否则后续 create 会把整份文件覆盖成一条）
    await expect(harness.store.list()).resolves.toEqual([seeded])

    // 此时再写：盘上原有的 job 与新 job 都在（不是"覆盖成只剩新增的那条"）
    const extra = makeJob({ id: 'job-added' })
    await harness.store.create(extra)
    await harness.store.flush()
    expect((await readFileJobs(harness, 's1')).map((job) => job.id)).toEqual([
      'job-on-disk',
      'job-added',
    ])
  })

  it('并发首读不返回空：list() 与 create() 同时发起时 list 依然看得到', async () => {
    const harness = createHarness()
    mountJobs(harness, 's1', [makeJob({ id: 'job-seeded' })])
    const job = createJob(
      { sessionId: 's1', text: '并发', maxRounds: 4, maxTotalTokens: 1000, origin: 'chat' },
      { clock: harness.clock.now },
    )

    const [listed] = await Promise.all([harness.store.list(), harness.store.create(job)])

    // 懒加载用 in-flight promise 共享同一次读盘：list 拿到的是**盘上已有的**内容，
    // 而不是"装载还没回来 → 空表"（todo-port 那种"先置 loaded 再 await"就是空表）
    expect(listed.length).toBeGreaterThan(0)
    expect(listed.map((item) => item.id)).toContain('job-seeded')
    // 并发 create 的那条在内存里已经可见（改动是同步的，不等装载）
    expect((await harness.store.list()).map((item) => item.id).sort()).toEqual(
      ['job-seeded', job.id].sort(),
    )
  })

  it('防抖：create 后内存态可见但未落盘，flush() 之后底层写入被调用过', async () => {
    const harness = createHarness({ writeDebounceMs: JOBS_WRITE_DEBOUNCE_MS })
    const job = makeJob({ id: 'job-debounced' })
    try {
      await harness.store.create(job)
      // 内存态立刻可见
      expect(await harness.store.get(job.id)).toEqual(job)
      // 300ms 防抖窗口内没有发生写盘（这些断言之间只排空微任务，真实定时器不会到点）
      expect(harness.fs.writeLog).toEqual([])
      expect(harness.fs.files.has(harness.sessionPath('s1'))).toBe(false)

      await harness.store.flush()

      expect(harness.fs.writeLog).toEqual([harness.sessionPath('s1')])
      expect(await readFileJobs(harness, 's1')).toEqual([job])
    } finally {
      harness.store.dispose()
    }
  })

  it('写失败降级：flush 不抛且保留脏标记，下一次 flush 能成功', async () => {
    const harness = createHarness()
    const job = makeJob({ id: 'job-retry' })
    // 这个 store 用超长防抖：改动只留在内存，落盘完全由 flush 控制（断言才不受时序影响）
    const store = harness.reopen({ writeDebounceMs: 60_000 })
    try {
      await store.create(job)
      await store.update(job.id, { round: 1 })
      expect(harness.fs.writeLog).toEqual([])

      harness.fs.failNextWrite = true
      await expect(store.flush()).resolves.toBeUndefined()

      // 写盘被尝试过（记录留在 writeLog），但内容没进去，而且**没有抛**
      expect(harness.fs.writeLog).toEqual([harness.sessionPath('s1')])
      expect(harness.fs.files.has(harness.sessionPath('s1'))).toBe(false)
      expect(harness.logger.entries.some((entry) => entry.includes('写入失败'))).toBe(true)

      // 脏标记被保留 ⇒ 下一次 flush 重试并真的落地（含刚才那次 update）
      await store.flush()
      expect((await readFileJobs(harness, 's1')).map((item) => item.round)).toEqual([1])
    } finally {
      store.dispose()
    }
  })

  it('损坏恢复：非法 JSON 不抛、返回空表、备份为 .corrupt-<ts>.json 且最多留 3 份', async () => {
    const harness = createHarness()
    harness.fs.mount(harness.sessionPath('s1'), '{ 这不是 JSON')

    await expect(harness.store.list()).resolves.toEqual([])
    expect(harness.fs.files.has(harness.sessionPath('s1'))).toBe(false)
    // 原文件没有丢：内容原样搬进了备份
    const first = await backupFiles(harness)
    expect(first).toHaveLength(1)
    const firstBackup = requireName(first[0])
    expect(firstBackup).toMatch(/^s1\.corrupt-\d{13}\.json$/)
    expect(harness.fs.files.get(join(DIR, firstBackup))).toBe('{ 这不是 JSON')

    // 连续再损坏 3 次：只保留最新 3 份（最早那份被淘汰）
    for (let round = 0; round < 3; round += 1) {
      harness.fs.mount(harness.sessionPath('s1'), `${round}-坏文件`)
      harness.clock.advance(1000) // 备份名里的时间戳定宽（13 位毫秒），字典序 = 新旧序
      const reopened = harness.reopen()
      await expect(reopened.list()).resolves.toEqual([])
    }
    const names = await backupFiles(harness)
    // 留下的恰好是**除第一份之外**的后三份（时间戳严格递增，所以顺序也确定）
    expect(names).toHaveLength(3)
    expect(names.includes(firstBackup)).toBe(false)
    expect(names[0]?.localeCompare(requireName(names[1]))).toBeLessThan(0)
  })

  it('update 按 id 定位：同会话另一个 job 的字段一字未变', async () => {
    const harness = createHarness()
    const left = makeJob({
      id: 'job-A',
      round: 1,
      stepsDone: [{ round: 0, tool: 'read_file', ok: true, at: CLOCK_START }],
    })
    const right = makeJob({
      id: 'job-B',
      round: 2,
      text: '另一条请求',
      status: 'paused',
      pendingReason: 'budget',
      budget: { maxTotalTokens: 100000, usedTokens: 777, autoContinued: 1 },
      cursor: { nextRound: 2, note: '等额度' },
      todos: [{ id: 't1', text: 'B 的清单', status: 'pending' }],
    })
    await harness.store.create(left)
    await harness.store.create(right)

    const updated = requireJob(await harness.store.update('job-A', { round: 5 }))

    expect(updated.round).toBe(5)
    const after = requireJob(await harness.store.get('job-B'))
    expect(after).toEqual(right)
    // 落盘那一份同样只有 A 被改（别把 patch 误落到同会话的 B 上）
    await harness.store.flush()
    const stored = await readFileJobs(harness, 's1')
    expect(stored.map((job) => job.id)).toEqual(['job-A', 'job-B'])
    expect(stored[1]).toEqual(right)
  })

  it('update 只改补丁里出现的键（cursor / budget 浅合并、可选字段可清空）', async () => {
    const harness = createHarness()
    const job = makeJob({
      id: 'job-patch',
      status: 'paused',
      pendingReason: 'budget',
      error: '额度用尽',
      cursor: { nextRound: 3, note: '继续第 3 轮' },
      budget: { maxTotalTokens: 900, usedTokens: 300, autoContinued: 1 },
    })
    await harness.store.create(job)
    // update 的 updatedAt 取注入时钟，推进时钟才能断言"确实被刷新了"
    harness.clock.advance(1000)
    const before = harness.clock.nowMs

    const updated = requireJob(
      await harness.store.update('job-patch', {
        budget: { usedTokens: 450 },
        pendingReason: undefined,
        error: undefined,
      }),
    )

    // 浅合并：没给的 budget 字段保持原值（尤其 autoContinued 不能被冲掉）
    expect(updated.budget).toEqual({ maxTotalTokens: 900, usedTokens: 450, autoContinued: 1 })
    expect(updated.cursor).toEqual({ nextRound: 3, note: '继续第 3 轮' })
    expect(updated.status).toBe('paused')
    expect(updated.maxRounds).toBe(job.maxRounds)
    expect(updated.pendingReason).toBeUndefined()
    expect(updated.error).toBeUndefined()
    expect(updated.updatedAt).toBe(new Date(before).toISOString())
    expect(updated.updatedAt).not.toBe(job.updatedAt)
  })

  it('update 找不到 id → undefined；create 写盘失败 → 不抛且仍返回传入的 job', async () => {
    const harness = createHarness()
    expect(await harness.store.update('job-missing', { round: 1 })).toBeUndefined()
    expect(await harness.store.get('job-missing')).toBeUndefined()

    harness.fs.failNextWrite = true
    const job = makeJob({ id: 'job-fs-error' })
    await expect(harness.store.create(job)).resolves.toEqual(job)
    await expect(harness.store.flush()).resolves.toBeUndefined()
    expect(harness.logger.entries.some((entry) => entry.includes('[error]'))).toBe(true)
  })

  it('listResumable 只返回 paused，并按 updatedAt 倒序', async () => {
    const harness = createHarness()
    mountJobs(harness, 's1', [
      makeJob({ id: 'job-running', status: 'running', updatedAt: '2026-09-26T10:00:00.000Z' }),
      makeJob({ id: 'job-paused-old', status: 'paused', updatedAt: '2026-09-26T09:00:00.000Z' }),
      makeJob({ id: 'job-done', status: 'done', updatedAt: '2026-09-26T11:00:00.000Z' }),
      makeJob({ id: 'job-paused-new', status: 'paused', updatedAt: '2026-09-26T12:00:00.000Z' }),
      makeJob({ id: 'job-error', status: 'error', updatedAt: '2026-09-26T13:00:00.000Z' }),
    ])

    const resumable = await harness.store.listResumable()
    expect(resumable.map((job) => job.id)).toEqual(['job-paused-new', 'job-paused-old'])
  })

  it('list 支持 sessionId / status / limit 过滤（limit 在排序之后生效）', async () => {
    const harness = createHarness()
    mountJobs(harness, 's1', [
      makeJob({ id: 'job-a', status: 'running', updatedAt: '2026-09-26T10:00:00.000Z' }),
      makeJob({ id: 'job-b', status: 'done', updatedAt: '2026-09-26T12:00:00.000Z' }),
      makeJob({ id: 'job-c', status: 'paused', updatedAt: '2026-09-26T11:00:00.000Z' }),
    ])
    mountJobs(harness, 's2', [
      makeJob({
        id: 'job-d',
        sessionId: 's2',
        status: 'running',
        updatedAt: '2026-09-26T09:00:00.000Z',
      }),
    ])

    // sessionId
    const onlyS2 = await harness.store.list({ sessionId: 's2' })
    expect(onlyS2.map((job) => job.id)).toEqual(['job-d'])
    // status
    const running = await harness.store.list({ status: 'running' })
    expect(running.map((job) => job.id)).toEqual(['job-a', 'job-d'])
    // 缺省倒序 + 缺省 limit
    const all = await harness.store.list()
    expect(all.map((job) => job.id)).toEqual(['job-b', 'job-c', 'job-a', 'job-d'])
    expect(DEFAULT_JOB_LIST_LIMIT).toBe(50)
    // limit 截的是"排序之后"的头部
    const two = await harness.store.list({ limit: 2 })
    expect(two.map((job) => job.id)).toEqual(['job-b', 'job-c'])
    // 非正数 = 不限制
    expect((await harness.store.list({ limit: 0 })).length).toBe(4)
    // 组合过滤
    const combined = await harness.store.list({ sessionId: 's1', status: 'running', limit: 1 })
    expect(combined.map((job) => job.id)).toEqual(['job-a'])
  })

  it('autoContinued 持久化：换一个 store 实例读同一份文件仍是 2', async () => {
    const harness = createHarness()
    const job = makeJob({ id: 'job-budget' })
    await harness.store.create(job)
    await harness.store.update(job.id, { budget: { autoContinued: 2 } })
    await harness.store.flush()

    const restarted = harness.reopen()
    const reloaded = requireJob(await restarted.get(job.id))
    expect(reloaded.budget.autoContinued).toBe(2)
    expect((await restarted.list()).find((item) => item.id === job.id)?.budget.autoContinued).toBe(
      2,
    )
  })

  it('路径穿越：sessionId 归一后写不出 <dir> 之外', async () => {
    const harness = createHarness()
    const job = makeJob({ id: 'job-escape', sessionId: '../../escape' })

    await harness.store.create(job)
    await harness.store.flush()

    const expected = join(DIR, '______escape.json')
    expect(harness.fs.writeLog).toEqual([expected])
    // 落盘的会话归属也是归一后的 id（原样存进去下次读就会指到别的文件）
    const stored = await readFileJobs(harness, '______escape')
    expect(stored).toEqual([{ ...job, sessionId: '______escape' }])
    // 落盘时归一，但不改调用方手里的那个对象
    expect(job.sessionId).toBe('../../escape')
    // 归一后的文件名不含任何分隔符 / 上跳段
    const name = harness.sessionPath('______escape').slice(DIR.length + 1)
    expect(name.includes('/')).toBe(false)
    expect(name.includes('\\')).toBe(false)
    expect(name.includes('..')).toBe(false)
    // 原始穿越路径没有被创建，写入也都留在 DIR 里
    expect(harness.fs.files.has('C:\\aurora-test\\escape.json')).toBe(false)
    for (const path of harness.fs.writeLog) expect(path.startsWith(`${DIR}\\`)).toBe(true)
    // 归一后的 id 仍然能按会话读回来
    expect(
      (await harness.store.list({ sessionId: '../../escape' })).map((item) => item.id),
    ).toEqual(['job-escape'])
  })
})

/**
 * origin 白名单与 shared 联合类型的同步护栏（P1-10）。
 *
 * 写入侧（主进程 `agent-host.ts`）用 `as` 强转放行任何字符串，落盘没有校验；
 * 读侧的 `ORIGINS` 白名单是唯一的形状闸门 —— 少一个取值，那类 job 就在
 * `toAgentJob` 里被判非法**整条跳过**，从 `get` / `list` / `listResumable` 里彻底消失
 * （paused 的自动化 / 远程任务再也续不上）。
 */
describe('FileJobStore · origin 白名单（P1-10）', () => {
  /**
   * 编译期护栏：`Record<AgentJob['origin'], true>` 的键集合必须**恰好等于**联合类型的
   * 取值集合（少一个键 TS 报错，多一个不在联合里的键同样报错）。
   * 下面的运行时断言再把这份键集合逐个过一遍「落盘 → 重启 → 读回」。
   */
  const ORIGIN_TABLE: Record<AgentJob['origin'], true> = {
    chat: true,
    'edge-bar': true,
    resume: true,
    center: true,
    automation: true,
    'file-awareness': true,
  }
  const SHARED_ORIGINS = Object.keys(ORIGIN_TABLE) as Array<AgentJob['origin']>

  it('六个取值逐字对齐 shared（少一个就会被读侧整条跳过）', () => {
    expect(SHARED_ORIGINS).toHaveLength(6)
    expect([...SHARED_ORIGINS].sort()).toEqual(
      ['automation', 'center', 'chat', 'edge-bar', 'file-awareness', 'resume'].sort(),
    )
  })

  it('center / automation 的 job 落盘后重启仍可 get / list 可见', async () => {
    const harness = createHarness()
    for (const origin of SHARED_ORIGINS) {
      await harness.store.create(makeJob({ id: `job-${origin}`, origin, sessionId: `s-${origin}` }))
    }
    await harness.store.flush()

    // 换一个 store 实例读同一份盘（模拟重启）
    const restarted = harness.reopen()
    for (const origin of SHARED_ORIGINS) {
      expect(requireJob(await restarted.get(`job-${origin}`)).origin).toBe(origin)
    }
    const listed = await restarted.list({ limit: 0 })
    expect(listed.map((job) => job.origin).sort()).toEqual([...SHARED_ORIGINS].sort())
  })

  it('center / automation 的 paused job 重启后能续跑（listResumable 看得见）', async () => {
    const harness = createHarness()
    mountJobs(harness, 'center-abc', [
      makeJob({
        id: 'job-center',
        sessionId: 'center-abc',
        origin: 'center',
        status: 'paused',
        pendingReason: 'budget',
      }),
    ])
    mountJobs(harness, 'auto-abc', [
      makeJob({ id: 'job-auto', sessionId: 'auto-abc', origin: 'automation', status: 'paused' }),
    ])

    const restarted = harness.reopen()
    const resumable = await restarted.listResumable()
    expect(resumable.map((job) => job.id).sort()).toEqual(['job-auto', 'job-center'])
  })

  it('白名单之外的 origin 仍整条跳过（闸门没有被放宽）', async () => {
    const harness = createHarness()
    const illegal = { ...makeJob({ id: 'job-illegal' }), origin: 'webhook' }
    mountJobs(harness, 's1', [illegal as unknown as AgentJob])

    await expect(harness.store.list()).resolves.toEqual([])
    expect(harness.logger.entries.some((entry) => entry.includes('形状非法'))).toBe(true)
  })
})
