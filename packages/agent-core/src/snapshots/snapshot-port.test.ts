/**
 * 写前快照端口的单测（docs/06 §11.8）。
 *
 * 全部跑在内存文件系统（`TestFileSystem`）+ 假 `stat` + **注入时钟**上：不碰真实磁盘，
 * 也不靠墙钟走毫秒来制造先后顺序（那样"新的在前"与环形淘汰的用例会时快时慢地抖）。
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMemoryLogger, type FileSystemPort, type Logger } from '@aurora/shared'
import { TestFileSystem } from '../testing/fileSystem.js'
import {
  createFileSnapshotPort,
  DEFAULT_KEEP_PER_FILE,
  DEFAULT_LIST_LIMIT,
  DEFAULT_MAX_SNAPSHOT_BYTES,
  DEFAULT_TOTAL_BUDGET_BYTES,
  DEFAULT_WRITE_DEBOUNCE_MS,
  type FileSnapshotPortOptions,
  type SnapshotStatInfo,
} from './snapshot-port.js'
import type { SnapshotCaptureResult, SnapshotPort, SnapshotRef } from './types.js'

/** 快照根目录（与 `SESSION_DIR` 同款：固定盘符 + 反斜杠，避免平台分隔符差异影响断言） */
const DIR = 'C:\\aurora-test\\backups'
/** 被快照的"用户文件"所在目录 */
const DOCS = 'C:\\aurora-test\\docs'
const TARGET = join(DOCS, '报告.txt')
const CLOCK_START = '2026-09-26T10:52:31.123Z'

/** 假 `stat`：`lstat` 语义——目录与符号链接的 isFile 都是 false（见 SnapshotStatInfo 的注释） */
class FakeStat {
  /** 假装是目录的路径 */
  readonly dirs = new Set<string>()
  /** 假装是符号链接的路径 */
  readonly links = new Set<string>()
  private readonly fs: TestFileSystem

  constructor(fs: TestFileSystem) {
    this.fs = fs
  }

  readonly stat = async (path: string): Promise<SnapshotStatInfo> => {
    if (this.links.has(path)) return { isFile: false, isDirectory: false, size: 0 }
    if (this.dirs.has(path)) return { isFile: false, isDirectory: true, size: 0 }
    const content = this.fs.files.get(path)
    if (content === undefined) throw new Error(`ENOENT: ${path}`)
    return { isFile: true, isDirectory: false, size: Buffer.byteLength(content, 'utf8') }
  }
}

/** 单调递增的注入时钟：每次读都前进 1 秒，capture 的 createdAt 因此严格有序 */
function createClock(startIso: string, stepMs = 1000): () => Date {
  let current = new Date(startIso).getTime()
  return () => {
    const value = new Date(current)
    current += stepMs
    return value
  }
}

/**
 * 把 `index.json` 的读取推迟若干毫秒。
 *
 * 为什么需要它：并发用例若只看微任务的自然顺序，"读盘还没回来时另一个 capture 已经开跑"
 * 这个时序会随时序细节变来变去（甚至随 Node 版本翻转）。延迟读盘把它摆成确定性的。
 */
class DelayedIndexReadFs implements FileSystemPort {
  private readonly inner: TestFileSystem
  private readonly delayMs: number

  constructor(inner: TestFileSystem, delayMs: number) {
    this.inner = inner
    this.delayMs = delayMs
  }

  exists(path: string): Promise<boolean> {
    return this.inner.exists(path)
  }

  async readFile(path: string): Promise<string> {
    // 只延迟索引读取：目标文件的探测保持即时，时序才好预期
    if (path.endsWith('index.json')) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    }
    return this.inner.readFile(path)
  }

  writeFileAtomic(path: string, content: string): Promise<void> {
    return this.inner.writeFileAtomic(path, content)
  }

  rename(from: string, to: string): Promise<void> {
    return this.inner.rename(from, to)
  }

  remove(path: string): Promise<void> {
    return this.inner.remove(path)
  }

  mkdirp(): Promise<void> {
    // TestFileSystem.mkdirp 不收参数（目录不进文件表），转发时也就不带 path
    return this.inner.mkdirp()
  }

  readdir(path: string): Promise<string[]> {
    return this.inner.readdir(path)
  }
}

interface Harness {
  fs: TestFileSystem
  logger: Logger & { entries: string[] }
  fakeStat: FakeStat
  port: SnapshotPort
  /** 某会话的快照目录 */
  sessionDir: (sessionId: string) => string
  indexPath: (sessionId: string) => string
  /** 该会话目录下的内容文件名（按名字排序） */
  snapNames: (sessionId: string) => Promise<string[]>
  /** 该会话 index.json 被原子写过的次数 */
  indexWrites: (sessionId: string) => number
  readIndex: (sessionId: string) => Promise<SnapshotRef[]>
}

function createHarness(
  overrides: Partial<FileSnapshotPortOptions> = {},
  seed: Record<string, string> = {},
  /** 让 index.json 的读取延迟这么多毫秒（只有并发用例需要） */
  slowIndexReadMs = 0,
): Harness {
  const inner = new TestFileSystem(seed)
  const fs: FileSystemPort =
    slowIndexReadMs > 0 ? new DelayedIndexReadFs(inner, slowIndexReadMs) : inner
  const logger = createMemoryLogger()
  const fakeStat = new FakeStat(inner)
  const port = createFileSnapshotPort({
    dir: DIR,
    fs,
    logger,
    stat: fakeStat.stat,
    now: createClock(CLOCK_START),
    writeDebounceMs: 0,
    ...overrides,
  })
  const sessionDir = (sessionId: string): string => join(DIR, sessionId)
  const indexPath = (sessionId: string): string => join(sessionDir(sessionId), 'index.json')
  return {
    fs: inner,
    logger,
    fakeStat,
    port,
    sessionDir,
    indexPath,
    snapNames: async (sessionId) =>
      (await inner.readdir(sessionDir(sessionId))).filter((name) => name.endsWith('.snap')).sort(),
    indexWrites: (sessionId) =>
      inner.writeLog.filter((path) => path === indexPath(sessionId)).length,
    readIndex: async (sessionId) =>
      JSON.parse(await inner.readFile(indexPath(sessionId))) as SnapshotRef[],
  }
}

/** 取出 capture 的快照；没产生就让用例带着 skipped 原因失败（而不是 Non-null 断言） */
function requireSnapshot(result: SnapshotCaptureResult): SnapshotRef {
  if (!result.snapshot) throw new Error(`期望产生快照，实际 skipped=${result.skipped ?? '无'}`)
  return result.snapshot
}

/** 读回快照文本（`readContent` 给的是 UTF-8 字节） */
async function readText(port: SnapshotPort, ref: SnapshotRef): Promise<string | undefined> {
  const content = await port.readContent(ref)
  return content === undefined ? undefined : new TextDecoder().decode(content.bytes)
}

/** 预置一条索引条目（懒加载用例用） */
function seededRef(overrides: Partial<SnapshotRef> = {}): SnapshotRef {
  return {
    id: '2026-01-01T00-00-00-000Z-aaaaaaaa',
    sessionId: 's1',
    path: TARGET,
    origin: 'write_file',
    createdAt: '2026-01-01T00:00:00.000Z',
    contentPath: join('s1', '2026-01-01T00-00-00-000Z-aaaaaaaa.snap'),
    bytes: 6,
    sha256: 'a'.repeat(64),
    exists: true,
    ...overrides,
  }
}

describe('createFileSnapshotPort —— 往返', () => {
  it('capture 已存在文件后：list 能列出来、readContent 与写前一致、sha256 与文件名口径都对', async () => {
    const h = createHarness()
    const content = '第一行\n第二行\n'
    h.fs.files.set(TARGET, content)

    const ref = requireSnapshot(
      await h.port.capture({
        sessionId: 's1',
        path: TARGET,
        origin: 'write_file',
        toolCallId: 'call-1',
      }),
    )

    // id = <ISO 时间戳（: 与 . 换成 -）>-<sha256 前 8 位>；不含 `:` 才能在 Windows 上落盘
    expect(ref.id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/)
    expect(ref.id).not.toContain(':')
    expect(ref.createdAt).toBe('2026-09-26T10:52:31.123Z')
    expect(ref.id.startsWith('2026-09-26T10-52-31-123Z-')).toBe(true)

    const sha256 = createHash('sha256').update(content, 'utf8').digest('hex')
    expect(ref.sha256).toBe(sha256)
    expect(ref.id.endsWith(sha256.slice(0, 8))).toBe(true)
    expect(ref.bytes).toBe(Buffer.byteLength(content, 'utf8'))
    expect(ref.exists).toBe(true)
    expect(ref.origin).toBe('write_file')
    expect(ref.toolCallId).toBe('call-1')
    expect(ref.sessionId).toBe('s1')
    expect(ref.path).toBe(TARGET)
    // contentPath 相对快照根目录，内容是**文件名即 id** 的 .snap
    expect(ref.contentPath).toBe(join('s1', `${ref.id}.snap`))
    expect(h.fs.files.get(join(DIR, ref.contentPath))).toBe(content)

    const listed = await h.port.list({ sessionId: 's1' })
    expect(listed).toEqual([ref])

    expect(await readText(h.port, ref)).toBe(content)
    const read = await h.port.readContent(ref)
    expect(read?.truncated).toBe(false)
  })

  it('capture 目标不存在：记一条 exists:false（无内容文件），readContent 给 undefined', async () => {
    const h = createHarness()
    const missing = join(DOCS, '还没建.txt')

    const ref = requireSnapshot(
      await h.port.capture({ sessionId: 's1', path: missing, origin: 'edit_file' }),
    )
    expect(ref.exists).toBe(false)
    expect(ref.contentPath).toBe('')
    expect(ref.bytes).toBe(0)
    expect(ref.sha256).toBeUndefined()
    expect(await h.snapNames('s1')).toEqual([]) // 不产生任何 .snap
    expect(await h.port.readContent(ref)).toBeUndefined()

    await h.port.flush()
    const index = await h.readIndex('s1')
    expect(index).toHaveLength(1)
    expect(index[0]?.exists).toBe(false)
  })

  it('append 只是原样记下的 mode：端口层与 overwrite 无差别，内容是追加前的全文', async () => {
    const h = createHarness()
    h.fs.files.set(TARGET, '追加前')

    const appended = requireSnapshot(
      await h.port.capture({ sessionId: 's1', path: TARGET, origin: 'write_file', mode: 'append' }),
    )
    h.fs.files.set(TARGET, '覆盖后')
    const overwritten = requireSnapshot(
      await h.port.capture({
        sessionId: 's1',
        path: TARGET,
        origin: 'write_file',
        mode: 'overwrite',
      }),
    )

    expect(appended.mode).toBe('append')
    expect(overwritten.mode).toBe('overwrite')
    expect(await readText(h.port, appended)).toBe('追加前')
    expect(await readText(h.port, overwritten)).toBe('覆盖后')
    // append 那条不写 mode 字段时就是不记（缺省 undefined）；落了盘也保持原样
    const bare = requireSnapshot(
      await h.port.capture({ sessionId: 's1', path: TARGET, origin: 'write_file' }),
    )
    expect(bare.mode).toBeUndefined()
    await h.port.flush()
    // 索引数组是按追加顺序存的（读取时才按时间排），这里顺带锁住这一点
    expect((await h.readIndex('s1')).map((item) => item.mode)).toEqual([
      'append',
      'overwrite',
      undefined,
    ])
    expect((await h.port.list({ sessionId: 's1' })).map((item) => item.mode)).toEqual([
      undefined,
      'overwrite',
      'append',
    ])
  })

  it('索引条目按“新的在前”返回（createdAt 倒序）', async () => {
    const h = createHarness()
    h.fs.files.set(TARGET, 'v1')
    const first = requireSnapshot(
      await h.port.capture({ sessionId: 's1', path: TARGET, origin: 'write_file' }),
    )
    h.fs.files.set(TARGET, 'v2')
    const second = requireSnapshot(
      await h.port.capture({ sessionId: 's1', path: TARGET, origin: 'write_file' }),
    )

    await h.port.flush()
    const listed = await h.port.list({ sessionId: 's1' })
    expect(listed.map((item) => item.id)).toEqual([second.id, first.id])
    expect(listed[0]?.id).toBe(second.id)
  })
})

describe('createFileSnapshotPort —— capture 的跳过口径', () => {
  it('enabled:false → disabled，且完全不碰文件系统', async () => {
    const h = createHarness({ enabled: false })
    h.fs.files.set(TARGET, '内容')

    expect(await h.port.capture({ sessionId: 's1', path: TARGET, origin: 'write_file' })).toEqual({
      skipped: 'disabled',
    })
    await h.port.flush()
    expect(h.fs.writeLog).toEqual([])
    // 关掉的只是"产生新快照"：历史仍然可列举（否则用户关一次开关就看不到旧快照了）
    expect(await h.port.list({ sessionId: 's1' })).toEqual([])
  })

  it('size 超 maxSnapshotBytes → too-large（不静默、不落内容文件）', async () => {
    const h = createHarness({ maxSnapshotBytes: 4 })
    h.fs.files.set(TARGET, '0123456789')

    expect(await h.port.capture({ sessionId: 's1', path: TARGET, origin: 'write_file' })).toEqual({
      skipped: 'too-large',
    })
    expect(await h.snapNames('s1')).toEqual([])
    expect(await h.port.list({ sessionId: 's1' })).toEqual([])
  })

  it('目标不是普通文件（目录 / 符号链接）→ unreadable', async () => {
    const h = createHarness()
    h.fakeStat.dirs.add(join(DOCS, '某个目录'))
    h.fakeStat.links.add(join(DOCS, '某个链接'))

    expect(
      await h.port.capture({ sessionId: 's1', path: join(DOCS, '某个目录'), origin: 'write_file' }),
    ).toEqual({ skipped: 'unreadable' })
    expect(
      await h.port.capture({ sessionId: 's1', path: join(DOCS, '某个链接'), origin: 'write_file' }),
    ).toEqual({ skipped: 'unreadable' })
    expect(await h.snapNames('s1')).toEqual([])
  })

  it('未注入 stat 的降级路径：用 exists + readFile 判断存在与大小', async () => {
    const h = createHarness({ stat: undefined, maxSnapshotBytes: 4 })
    h.fs.files.set(TARGET, 'abc') // 3 字节，读得进来

    const ref = requireSnapshot(
      await h.port.capture({ sessionId: 's1', path: TARGET, origin: 'write_file' }),
    )
    expect(ref.exists).toBe(true)
    expect(ref.bytes).toBe(3)
    expect(
      await h.port.capture({ sessionId: 's1', path: join(DOCS, '没有.txt'), origin: 'write_file' }),
    ).toMatchObject({ snapshot: { exists: false } })

    h.fs.files.set(TARGET, '0123456789')
    expect(await h.port.capture({ sessionId: 's1', path: TARGET, origin: 'write_file' })).toEqual({
      skipped: 'too-large',
    })
  })
})

describe('createFileSnapshotPort —— 懒加载与并发', () => {
  it('新建端口后先 list：读到磁盘上已有的索引（懒加载）', async () => {
    const ref = seededRef()
    const h = createHarness({}, { [join(DIR, 's1', 'index.json')]: JSON.stringify([ref]) })
    h.fs.files.set(join(DIR, ref.contentPath), '旧内容')

    const listed = await h.port.list({ sessionId: 's1' })
    expect(listed).toEqual([ref])
    const first = listed[0] as SnapshotRef
    expect(await readText(h.port, first)).toBe('旧内容')
    expect(h.fs.writeLog).toEqual([]) // 只读不写
  })

  it('索引能解析但不是数组：同样按整体损坏处理（备份 + 空索引），list 不抛', async () => {
    const h = createHarness({}, { [join(DIR, 's1', 'index.json')]: '{"snapshots":[]}' })
    expect(await h.port.list({ sessionId: 's1' })).toEqual([])
    expect(h.logger.entries.some((line) => line.includes('快照索引解析失败'))).toBe(true)
    expect(
      (await h.fs.readdir(h.sessionDir('s1'))).filter((name) => name.startsWith('index.corrupt-')),
    ).toHaveLength(1)
  })

  it('并发首读不返回空索引：读盘还没回来时 capture 就开跑，两边都不能丢', async () => {
    const seeded = seededRef()
    // 索引读盘延迟 5ms：capture 一定在"索引还没加载完"的时候就开始跑了
    const h = createHarness({}, { [join(DIR, 's1', 'index.json')]: JSON.stringify([seeded]) }, 5)
    h.fs.files.set(join(DIR, seeded.contentPath), '旧内容')
    h.fs.files.set(TARGET, '新内容')

    const [listed, captured] = await Promise.all([
      h.port.list({ sessionId: 's1' }),
      h.port.capture({ sessionId: 's1', path: TARGET, origin: 'write_file' }),
    ])
    const fresh = requireSnapshot(captured)

    expect(listed.length).toBeGreaterThan(0) // 锁死"并发首读拿到空索引"这个退化
    await h.port.flush()
    // 真正的重点：两个并发方都没被对方覆盖——磁盘索引里旧的 + 新的都在
    const index = await h.readIndex('s1')
    expect(index.map((item) => item.id).sort()).toEqual([seeded.id, fresh.id].sort())
    expect(await readText(h.port, seeded)).toBe('旧内容')
  })

  it('两个并发首读 list 都能看到磁盘上的索引（先置 loaded 再 await 的写法会让第二个拿到空数组）', async () => {
    const ref = seededRef()
    const h = createHarness({}, { [join(DIR, 's1', 'index.json')]: JSON.stringify([ref]) })

    const [a, b] = await Promise.all([
      h.port.list({ sessionId: 's1' }),
      h.port.list({ sessionId: 's1' }),
    ])
    expect(a).toEqual([ref])
    expect(b).toEqual([ref])
  })
})

describe('createFileSnapshotPort —— 防抖与 flush', () => {
  // 防抖间隔故意设得很大：用例要断言的是"还没写"，只要它小于用例自身的耗时就不可能误判
  const LONG_DEBOUNCE = 60_000

  it('capture 后内存态立即可见，但索引落盘被防抖；flush 后才写下去', async () => {
    const h = createHarness({ writeDebounceMs: LONG_DEBOUNCE })
    h.fs.files.set(TARGET, '内容')

    const ref = requireSnapshot(
      await h.port.capture({ sessionId: 's1', path: TARGET, origin: 'write_file' }),
    )
    // 内容文件是 capture 里同步等待写成功的，索引则进了防抖队列
    expect(h.fs.files.get(join(DIR, ref.contentPath))).toBe('内容')
    expect(await h.port.list({ sessionId: 's1' })).toHaveLength(1)
    expect(h.indexWrites('s1')).toBe(0)
    expect(h.fs.files.has(h.indexPath('s1'))).toBe(false)

    await h.port.flush()
    expect(h.indexWrites('s1')).toBe(1)
    expect(await h.readIndex('s1')).toHaveLength(1)
  })

  it('缺省值与契约一致（接线方按这些数字算配额）', async () => {
    const h = createHarness({ writeDebounceMs: undefined, maxSnapshotBytes: undefined })
    expect(DEFAULT_KEEP_PER_FILE).toBe(20)
    expect(DEFAULT_MAX_SNAPSHOT_BYTES).toBe(524288)
    expect(DEFAULT_TOTAL_BUDGET_BYTES).toBe(200 * 1024 * 1024)
    expect(DEFAULT_WRITE_DEBOUNCE_MS).toBe(300)
    expect(DEFAULT_LIST_LIMIT).toBe(50)
    // 缺省防抖 300ms：capture 之后立刻查，索引还没落盘（用一个端口验证默认值真的生效）
    h.fs.files.set(TARGET, '内容')
    await h.port.capture({ sessionId: 's1', path: TARGET, origin: 'write_file' })
    expect(h.indexWrites('s1')).toBe(0)
    await h.port.flush()
    expect(await h.readIndex('s1')).toHaveLength(1)
  })
})

describe('createFileSnapshotPort —— 淘汰', () => {
  it('keepPerFile：同一文件只留最新的 N 条，最旧的 .snap 被删掉', async () => {
    const h = createHarness({ keepPerFile: 2 })
    const refs: SnapshotRef[] = []
    for (let i = 0; i < 5; i += 1) {
      h.fs.files.set(TARGET, `版本-${i}`)
      refs.push(
        requireSnapshot(
          await h.port.capture({ sessionId: 's1', path: TARGET, origin: 'write_file' }),
        ),
      )
    }
    await h.port.flush()

    const listed = await h.port.list({ sessionId: 's1' })
    expect(listed.map((item) => item.id)).toEqual([refs[4]?.id, refs[3]?.id])
    const names = await h.snapNames('s1')
    expect(names).toEqual([`${refs[3]?.id}.snap`, `${refs[4]?.id}.snap`].sort())
    expect(names).not.toContain(`${refs[0]?.id}.snap`)
    // 被淘汰的那份：内容文件已不在，readContent 给 undefined 而不是抛错
    expect(await h.port.readContent(refs[0] as SnapshotRef)).toBeUndefined()
    expect(await h.readIndex('s1')).toHaveLength(2)
  })

  it('环形淘汰按 path 分组：不同文件各自保留自己的条数', async () => {
    const h = createHarness({ keepPerFile: 1 })
    const other = join(DOCS, '另一个.txt')
    for (const target of [TARGET, TARGET, other]) {
      h.fs.files.set(target, `内容-${target}`)
      await h.port.capture({ sessionId: 's1', path: target, origin: 'write_file' })
    }

    const listed = await h.port.list({ sessionId: 's1' })
    expect(listed).toHaveLength(2)
    expect(listed.map((item) => item.path).sort()).toEqual([TARGET, other].sort())
  })

  it('prune(sessionId)：对手写/加载进来的索引做一次淘汰并返回删掉的条数', async () => {
    const refs = [0, 1, 2, 3].map((index) =>
      seededRef({
        id: `2026-01-0${index + 1}T00-00-00-000Z-bbbbbbb${index}`,
        createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
        contentPath: join('s1', `2026-01-0${index + 1}T00-00-00-000Z-bbbbbbb${index}.snap`),
      }),
    )
    const seed: Record<string, string> = { [join(DIR, 's1', 'index.json')]: JSON.stringify(refs) }
    for (const ref of refs) seed[join(DIR, ref.contentPath)] = ref.id
    const h = createHarness({ keepPerFile: 2 }, seed)

    expect(await h.port.prune('s1')).toEqual({ removed: 2 })
    await h.port.flush()
    // 索引数组保持插入顺序，所以"新的在前"看 list（读取时才排序）
    expect((await h.port.list({ sessionId: 's1' })).map((item) => item.id)).toEqual([
      refs[3]?.id,
      refs[2]?.id,
    ])
    expect(await h.readIndex('s1')).toHaveLength(2)
    expect(await h.snapNames('s1')).toHaveLength(2)
    // 再 prune 一次没有可删的了
    expect(await h.port.prune('s1')).toEqual({ removed: 0 })
  })

  it('totalBudgetBytes：超预算时从最旧开始删，直到落回预算内', async () => {
    const h = createHarness({ keepPerFile: 50, totalBudgetBytes: 25 })
    const refs: SnapshotRef[] = []
    for (let i = 0; i < 4; i += 1) {
      h.fs.files.set(TARGET, `012345678${i}`) // 每份 10 字节
      refs.push(
        requireSnapshot(
          await h.port.capture({ sessionId: 's1', path: TARGET, origin: 'write_file' }),
        ),
      )
    }
    await h.port.flush()

    const listed = await h.port.list({ sessionId: 's1' })
    expect(listed.map((item) => item.id)).toEqual([refs[3]?.id, refs[2]?.id])
    expect(listed.reduce((sum, item) => sum + item.bytes, 0)).toBeLessThanOrEqual(25)
    const names = await h.snapNames('s1')
    expect(names).toEqual([`${refs[2]?.id}.snap`, `${refs[3]?.id}.snap`].sort())
    expect(names).not.toContain(`${refs[0]?.id}.snap`)
  })
})

describe('createFileSnapshotPort —— 索引损坏恢复', () => {
  /** 早年（2026-01）的备份文件：定宽时间戳，字典序排在注入时钟（2026-09）之前 */
  const earlyBackup = (day: number): string => `index.corrupt-${Date.UTC(2026, 0, day)}.json`

  it('非法 JSON：不抛、按空索引继续、备份成 index.corrupt-*.json（最多 3 份）', async () => {
    const seed: Record<string, string> = {
      [join(DIR, 's1', 'index.json')]: '{ 这不是 JSON',
      [join(DIR, 's1', earlyBackup(1))]: '更早的损坏 1',
      [join(DIR, 's1', earlyBackup(2))]: '更早的损坏 2',
      [join(DIR, 's1', earlyBackup(3))]: '更早的损坏 3',
    }
    const h = createHarness({}, seed)

    expect(await h.port.list({ sessionId: 's1' })).toEqual([])
    expect(h.logger.entries.some((line) => line.includes('快照索引解析失败'))).toBe(true)

    const names = (await h.fs.readdir(h.sessionDir('s1'))).sort()
    const backups = names.filter((name) => name.startsWith('index.corrupt-'))
    expect(backups).toHaveLength(3) // 4 份时按时间删掉最旧的那份
    expect(backups).not.toContain(earlyBackup(1))
    const newest = backups[backups.length - 1] as string
    // 备份是 rename 过来的：损坏内容原样保留，没被丢掉
    expect(await h.fs.readFile(join(h.sessionDir('s1'), newest))).toBe('{ 这不是 JSON')

    // 第二次 list 走内存态，不会再产生第四份备份
    expect(await h.port.list({ sessionId: 's1' })).toEqual([])
    expect(
      (await h.fs.readdir(h.sessionDir('s1'))).filter((name) => name.startsWith('index.corrupt-')),
    ).toHaveLength(3)
  })

  it('损坏恢复时清掉孤儿 .snap；索引完好时不动没被引用的内容文件', async () => {
    const orphan = join(DIR, 's1', '2026-01-02T00-00-00-000Z-cccccccc.snap')
    const h = createHarness({}, { [join(DIR, 's1', 'index.json')]: 'boom', [orphan]: '孤儿' })
    expect(await h.port.list({ sessionId: 's1' })).toEqual([])
    expect(await h.snapNames('s1')).toEqual([])
    expect(h.logger.entries.some((line) => line.includes('孤儿快照'))).toBe(true)

    const kept = seededRef()
    const stray = join(DIR, 's1', '2026-01-03T00-00-00-000Z-dddddddd.snap')
    const h2 = createHarness(
      {},
      {
        [join(DIR, 's1', 'index.json')]: JSON.stringify([kept]),
        [join(DIR, kept.contentPath)]: '旧内容',
        [stray]: '没被索引引用',
      },
    )
    expect(await h2.port.list({ sessionId: 's1' })).toHaveLength(1)
    expect(await h2.snapNames('s1')).toHaveLength(2) // 清理只发生在损坏恢复路径
  })

  it('个别畸形条目只丢那一条，能读的历史照常保留', async () => {
    const good = seededRef()
    const broken = [
      null,
      { id: 'x' },
      { ...good, origin: 'unknown' },
      { ...good, id: 'y', contentPath: join('..', '..', 'evil.snap') },
    ]
    const h = createHarness(
      {},
      { [join(DIR, 's1', 'index.json')]: JSON.stringify([good, ...broken]) },
    )

    expect(await h.port.list({ sessionId: 's1' })).toEqual([good])
    expect(h.logger.entries.some((line) => line.includes('无法识别的条目'))).toBe(true)
  })
})

describe('createFileSnapshotPort —— 写失败只降级不抛', () => {
  it('内容文件写失败：capture 返回 skipped 而不是抛错，下一次仍可用', async () => {
    const h = createHarness()
    h.fs.files.set(TARGET, '内容')
    h.fs.failNextWrite = true

    expect(await h.port.capture({ sessionId: 's1', path: TARGET, origin: 'write_file' })).toEqual({
      skipped: 'unreadable',
    })
    expect(await h.port.list({ sessionId: 's1' })).toEqual([])
    expect(h.logger.entries.some((line) => line.includes('写前快照失败'))).toBe(true)

    const ref = requireSnapshot(
      await h.port.capture({ sessionId: 's1', path: TARGET, origin: 'write_file' }),
    )
    await h.port.flush()
    expect(await h.port.list({ sessionId: 's1' })).toEqual([ref])
  })

  it('索引写失败：flush 不抛、脏标记留着，下一次 flush 补写成功', async () => {
    // 防抖很大 ⇒ 那次失败一定发生在 flush 里（而不是定时器里），断言才有确定性
    const h = createHarness({ writeDebounceMs: 60_000 })
    h.fs.files.set(TARGET, '内容')
    const ref = requireSnapshot(
      await h.port.capture({ sessionId: 's1', path: TARGET, origin: 'write_file' }),
    )

    h.fs.failNextWrite = true
    await h.port.flush()
    expect(h.fs.files.has(h.indexPath('s1'))).toBe(false)
    expect(h.logger.entries.some((line) => line.includes('快照索引写入失败'))).toBe(true)
    expect(await h.port.list({ sessionId: 's1' })).toEqual([ref]) // 内存态没丢

    await h.port.flush()
    expect(await h.readIndex('s1')).toEqual([ref])
  })
})

describe('createFileSnapshotPort —— 查询与会话目录', () => {
  it('list：缺省跨会话且新的在前，可按 sessionId / path / limit 过滤', async () => {
    const h = createHarness()
    const other = join(DOCS, '另一个.txt')
    h.fs.files.set(other, 'B')
    const inS2 = requireSnapshot(
      await h.port.capture({ sessionId: 's2', path: other, origin: 'write_file' }),
    )
    h.fs.files.set(TARGET, 'A1')
    const inS1 = requireSnapshot(
      await h.port.capture({ sessionId: 's1', path: TARGET, origin: 'write_file' }),
    )
    h.fs.files.set(TARGET, 'A2')
    const newest = requireSnapshot(
      await h.port.capture({ sessionId: 's1', path: TARGET, origin: 'edit_file' }),
    )

    expect((await h.port.list({})).map((item) => item.id)).toEqual([newest.id, inS1.id, inS2.id])
    expect((await h.port.list({ sessionId: 's2' })).map((item) => item.id)).toEqual([inS2.id])
    expect((await h.port.list({ path: TARGET })).map((item) => item.id)).toEqual([
      newest.id,
      inS1.id,
    ])
    expect((await h.port.list({ limit: 1 })).map((item) => item.id)).toEqual([newest.id])
    expect(await h.port.list({ sessionId: '从未存在' })).toEqual([])
    expect(await h.port.list({ limit: 0 })).toHaveLength(3) // 与 SessionStore 同口径：非正数 = 不限制
  })

  it('会话 id 走白名单归一：`..` 与分隔符不能把快照写到根目录之外', async () => {
    const h = createHarness()
    h.fs.files.set(TARGET, '内容')

    const ref = requireSnapshot(
      await h.port.capture({ sessionId: '../../escape', path: TARGET, origin: 'write_file' }),
    )
    expect(ref.sessionId).not.toContain('..')
    expect(ref.contentPath).not.toContain('..')
    expect(h.fs.files.has(join(h.sessionDir(ref.sessionId), `${ref.id}.snap`))).toBe(true)
    // 除被快照的目标文件外，记忆文件系统里不该出现根目录之外的新文件
    expect([...h.fs.files.keys()].filter((path) => !path.startsWith(DIR))).toEqual([TARGET])
    expect(await h.port.list({ sessionId: '../../escape' })).toEqual([ref])
  })

  it('readContent：文件被手动删掉 → undefined（不抛）', async () => {
    const h = createHarness()
    h.fs.files.set(TARGET, '内容')
    const ref = requireSnapshot(
      await h.port.capture({ sessionId: 's1', path: TARGET, origin: 'write_file' }),
    )

    h.fs.files.delete(join(DIR, ref.contentPath))
    expect(await h.port.readContent(ref)).toBeUndefined()
    expect(await h.port.readContent(seededRef({ exists: false, contentPath: '' }))).toBeUndefined()
  })
})
