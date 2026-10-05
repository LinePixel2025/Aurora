/**
 * 写前快照端口的**落盘实现**（docs/06 §11.8，v14）。
 *
 * 用途：`write_file` / `edit_file` 在**真正改盘之前**把目标文件当前的内容存一份，
 * 让用户能在界面上把文件回到某一份快照；回滚本身也先打一份快照，所以回滚同样可撤回。
 * 契约（数据形状与端口签名）在 `./types.js`，本文件只负责"怎么存"。
 *
 * 目录布局（**全链路唯一的形状口径**）：
 * ```
 * <dir>/<sessionId>/index.json                 索引：SnapshotRef[]（数组顺序不保证，读取时按时间排）
 * <dir>/<sessionId>/<id>.snap                  一条快照 = 一个内容文件，文件名就是快照 id
 * <dir>/<sessionId>/index.corrupt-<ts>.json    索引损坏时的备份（最多留 3 份）
 * ```
 * - `id = <ISO 时间戳（`:` 与 `.` 换成 `-`）>-<sha256 前 8 位>`，
 *   例 `2026-09-26T10-52-31-123Z-3f9a1c07` ⇒ 同一会话目录下**字典序 = 时间序**；
 *   时间戳里的 `:` 必须换掉，否则 Windows 文件名非法。
 * - **不用原文件名**：同一路径会被改很多次（原名必然撞名），原名还可能含非法字符，
 *   原名只存在索引的 `path` 字段里（绝对路径）。
 * - `contentPath` 是**相对快照根目录 `<dir>`** 的路径（即 `<sessionId>/<id>.snap`），
 *   便于主进程用 `join(dir, contentPath)` 直接定位；`exists: false` 的记录没有内容文件，此时为空串。
 *
 * 几条刻意的取舍（都是踩过坑的地方）：
 * - 懒加载 + 300ms 防抖原子写 + `flush()`：与 `SessionStore` 同一套约定；
 *   但 `ensureLoaded` 用 **in-flight promise**，而不是"先置 loaded 再 await"——
 *   后者会让并发首读拿到**空索引**，随后用空索引覆盖掉磁盘上的历史（同仓库有过这个 bug）。
 * - 同一个 `sessionId` 的索引改动串在一条 promise 链上：并发 capture 不会互相丢条目。
 * - 任何 fs 异常都**只降级不抛**：快照是"写文件"的旁路，它失败不该让写文件整体失败；
 *   调用方据 `skipped` 把降级原因回带进工具结果（不许静默）。
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createNoopLogger, type FileSystemPort, type Logger } from '@aurora/shared'
import type {
  SnapshotCaptureInput,
  SnapshotCaptureResult,
  SnapshotListQuery,
  SnapshotPort,
  SnapshotRef,
  SnapshotSkipReason,
} from './types.js'

/** 单个文件保留的快照条数（环形淘汰） */
export const DEFAULT_KEEP_PER_FILE = 20
/** 单条快照的体积上限（默认 512KiB；超过就跳过而不是截断） */
export const DEFAULT_MAX_SNAPSHOT_BYTES = 524288
/**
 * 单会话快照目录的体积上限（默认 200MiB）。
 * 口径是**每个会话目录**而不是全局：淘汰的粒度就是 `prune(sessionId)`，全局额度要跨会话统计，
 * 会让"删哪一份"变成跨会话的连带影响，超出本端口的职责。
 */
export const DEFAULT_TOTAL_BUDGET_BYTES = 200 * 1024 * 1024
/** 索引防抖写盘间隔（与 SessionStore / TodoPort 同值，便于统一心智） */
export const DEFAULT_WRITE_DEBOUNCE_MS = 300
/** `list` 的缺省条数上限 */
export const DEFAULT_LIST_LIMIT = 50
/** 索引损坏备份的保留份数 */
export const MAX_CORRUPT_BACKUPS = 3

const INDEX_FILE = 'index.json'
const SNAPSHOT_EXT = '.snap'
const CORRUPT_PREFIX = 'index.corrupt-'

/**
 * 注入的 `stat` 的形状。
 *
 * 刻意**不给 `FileSystemPort` 加方法**：那会连带改 3 个实现（nodeFileSystem / 两份内存桩）。
 * 需要"是不是目录 / 符号链接"和 `size` 的只有本端口，所以做成可选注入。
 *
 * 期望语义是 **`lstat`**（不跟随符号链接）：符号链接的 `isFile` 与 `isDirectory` 都是 false，
 * 于是 `!isFile` 的判定把"目录 / 符号链接 / 其它非常规文件"一并挡在快照之外——
 * 追着链接去快照目标文件会让"回到某份快照"变成写到别处，这是不能接受的。
 */
export interface SnapshotStatInfo {
  isFile: boolean
  isDirectory: boolean
  size: number
}

export interface FileSnapshotPortOptions {
  /** 快照根目录（主进程注入 `<userData>/backups`） */
  dir: string
  fs: FileSystemPort
  logger?: Logger
  /** 每个文件保留几条（默认 20；0 = 该文件不保留历史，负数 = 不限制） */
  keepPerFile?: number
  /** 单条快照字节上限（默认 524288；超出返回 `skipped: 'too-large'`） */
  maxSnapshotBytes?: number
  /** 单会话目录字节预算（默认 200MiB；负数 = 不限制） */
  totalBudgetBytes?: number
  /** 索引防抖写盘间隔（默认 300ms；传 0 立即写，单测常用） */
  writeDebounceMs?: number
  /**
   * 可选的 `stat`（`lstat` 语义，见 `SnapshotStatInfo`）。
   *
   * **未注入时的降级**：用 `exists()` + `readFile()` 的字节长度判断——
   * 这样能覆盖"不存在"与"太大"，但**分不出目录 / 符号链接**
   * （读目录会抛 EISDIR，最终落到 `skipped: 'unreadable'`，语义正好一致；
   * 而符号链接会被当普通文件读进来，即跟随了链接——所以生产接线请务必注入它）。
   */
  stat?: (path: string) => Promise<SnapshotStatInfo>
  /**
   * 时钟注入（缺省 `new Date()`）。**测试友好**是唯一目的：
   * 单测要制造单调递增的 `createdAt` 来验证"新的在前"与环形淘汰的先后顺序，
   * 真等墙钟走毫秒会让用例变慢且不确定。
   */
  now?: () => Date
  /** 关闭时 `capture` 直接返回 `{ skipped: 'disabled' }`（历史快照仍可 list / readContent） */
  enabled?: boolean
}

/** 目标探测结果 */
type Probe =
  | { status: 'missing' }
  | { status: 'skipped'; reason: SnapshotSkipReason }
  | { status: 'ok'; content: string | Uint8Array; bytes: number }

/** 单个会话的内存态（懒加载 + 防抖 + 串行链条都在这里） */
interface SessionState {
  refs: SnapshotRef[]
  loaded: boolean
  /** 在途的首次读盘；并发调用共享它（这是"并发首读不返回空索引"的关键） */
  loading?: Promise<void>
  dirty: boolean
  /** 在途的索引写入（串行排队，见 `writeNow`） */
  writing?: Promise<void>
  timer?: NodeJS.Timeout
}

export function createFileSnapshotPort(options: FileSnapshotPortOptions): SnapshotPort {
  return new FileSnapshotPort(options)
}

class FileSnapshotPort implements SnapshotPort {
  private readonly options: FileSnapshotPortOptions
  private readonly dir: string
  private readonly fs: FileSystemPort
  private readonly logger: Logger
  private readonly keepPerFile: number
  private readonly maxSnapshotBytes: number
  private readonly totalBudgetBytes: number
  private readonly writeDebounceMs: number
  private readonly stat: FileSnapshotPortOptions['stat']
  private readonly now: () => Date
  private readonly states = new Map<string, SessionState>()
  /** 每会话的索引改动串行链（见 `enqueue`） */
  private readonly mutations = new Map<string, Promise<void>>()

  constructor(options: FileSnapshotPortOptions) {
    this.options = options
    this.dir = options.dir
    this.fs = options.fs
    this.logger = options.logger ?? createNoopLogger()
    this.keepPerFile = options.keepPerFile ?? DEFAULT_KEEP_PER_FILE
    this.maxSnapshotBytes = options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES
    this.totalBudgetBytes = options.totalBudgetBytes ?? DEFAULT_TOTAL_BUDGET_BYTES
    this.writeDebounceMs = options.writeDebounceMs ?? DEFAULT_WRITE_DEBOUNCE_MS
    this.stat = options.stat
    this.now = options.now ?? ((): Date => new Date())
  }

  /** 每次现读，便于主进程复用同一个 options 对象热改开关（不必重建端口） */
  private get enabled(): boolean {
    return this.options.enabled !== false
  }

  async capture(input: SnapshotCaptureInput): Promise<SnapshotCaptureResult> {
    if (!this.enabled) return { skipped: 'disabled' }
    const sessionId = normalizeSessionId(input.sessionId)
    try {
      const createdAt = this.now()
      const probe = await this.probe(input.path, input.bytes)

      if (probe.status === 'skipped') return { skipped: probe.reason }

      if (probe.status === 'missing') {
        // 记一条"当时这个文件还不存在"：回滚它等于删掉该文件，所以不能因为没有内容就不记
        this.logger.debug('快照目标不存在，记录一条 exists:false 的快照', { path: input.path })
        const ref: SnapshotRef = {
          ...this.baseRef(input, sessionId, createdAt),
          // 没有内容就没有内容散列，id 后缀改用**路径散列**：
          // 同一毫秒里两条"不存在"的记录（不同路径）必须有不同的 id，否则索引里会互相顶掉
          id: `${toFileStamp(createdAt)}-${digest8(`missing:${input.path}`)}`,
          contentPath: '',
          bytes: 0,
          exists: false,
        }
        await this.enqueue(sessionId, async () => {
          await this.appendAndEvict(sessionId, ref)
        })
        return { snapshot: ref }
      }

      const sha256 = createHash('sha256').update(probe.content).digest('hex')
      const id = `${toFileStamp(createdAt)}-${sha256.slice(0, 8)}` // 8 位内容散列：同毫秒不同内容也不会撞 id
      const contentPath = join(sessionId, `${id}${SNAPSHOT_EXT}`)
      // 内容先落盘、成功后才写索引：索引里出现的每一条都必须有内容文件（exists:true 时）
      await this.fs.mkdirp(sessionDirOf(this.dir, sessionId))
      await this.writeSnapshotContent(join(this.dir, contentPath), probe.content)
      const ref: SnapshotRef = {
        ...this.baseRef(input, sessionId, createdAt),
        id,
        contentPath,
        bytes: probe.bytes,
        sha256,
        exists: true,
      }
      await this.enqueue(sessionId, async () => {
        await this.appendAndEvict(sessionId, ref)
      })
      return { snapshot: ref }
    } catch (error) {
      this.logger.warn('写前快照失败，已跳过（不影响本次写文件）', {
        path: input.path,
        sessionId,
        error: messageOf(error),
      })
      return { skipped: 'unreadable' }
    }
  }

  async list(query: SnapshotListQuery): Promise<SnapshotRef[]> {
    try {
      const ids =
        query.sessionId === undefined
          ? await this.listSessionIds()
          : [normalizeSessionId(query.sessionId)]
      const collected: SnapshotRef[] = []
      for (const id of ids) {
        await this.ensureLoaded(id)
        for (const ref of this.stateOf(id).refs) {
          if (query.path !== undefined && ref.path !== query.path) continue
          // 浅拷贝：不让调用方（渲染层 / 工具层）改到内存索引里的对象
          collected.push({ ...ref })
        }
      }
      collected.sort((a, b) => compareRefs(b, a)) // 新的在前
      const limit = query.limit === undefined ? DEFAULT_LIST_LIMIT : query.limit
      // 与 SessionStore 同口径：非正数 = 不限制
      return limit > 0 ? collected.slice(0, limit) : collected
    } catch (error) {
      this.logger.warn('读取快照列表失败，按空列表返回', { error: messageOf(error) })
      return []
    }
  }

  async readContent(
    ref: SnapshotRef,
  ): Promise<{ bytes: Uint8Array; truncated: boolean } | undefined> {
    // `exists: false` 的记录本来就没有内容文件（回滚它 = 删文件），不是错误
    if (!ref.exists || ref.contentPath === '') return undefined
    const candidates = [join(this.dir, ref.contentPath)]
    if (!ref.contentPath.includes('/') && !ref.contentPath.includes('\\')) {
      // 兼容只写文件名的索引：布局里内容文件就在该会话目录下，这条回落只会"多得一份内容"，
      // 不会指错文件（`contentPath` 的口径是相对快照根目录，见文件头）
      candidates.push(join(sessionDirOf(this.dir, ref.sessionId), ref.contentPath))
    }
    for (const path of candidates) {
      try {
        const bytes =
          this.fs.readFileBytes !== undefined
            ? await this.fs.readFileBytes(path)
            : new TextEncoder().encode(await this.fs.readFile(path))
        return { bytes, truncated: ref.truncated === true }
      } catch {
        /* 试下一个候选；都不行就返回 undefined（文件被手动删掉不算异常） */
      }
    }
    return undefined
  }

  async prune(sessionId: string): Promise<{ removed: number }> {
    const id = normalizeSessionId(sessionId)
    try {
      return await this.enqueue(id, async () => {
        await this.ensureLoaded(id)
        const removed = await this.evict(id)
        // 淘汰改了内存索引，即使上层不 capture 也要把它落盘，否则磁盘上还留着已删条目
        if (removed > 0) {
          this.markDirty(id)
          this.scheduleWrite(id)
        }
        return { removed }
      })
    } catch (error) {
      this.logger.warn('快照淘汰失败，已跳过', { sessionId: id, error: messageOf(error) })
      return { removed: 0 }
    }
  }

  async flush(): Promise<void> {
    try {
      // 先把在途的 capture / prune 排空：它们可能还会把某个会话标脏
      await Promise.all([...this.mutations.values()].map((task) => task.catch(() => undefined)))
      for (const state of this.states.values()) {
        if (state.timer) clearTimeout(state.timer)
        state.timer = undefined
      }
      await this.drainWrites()
      for (const [id, state] of this.states) {
        if (state.dirty) await this.writeNow(id)
      }
      await this.drainWrites()
    } catch (error) {
      // flush 也不抛：调用方多在退出路径上，抛了只会打断收尾
      this.logger.warn('快照索引落盘失败', { error: messageOf(error) })
    }
  }

  // ───────────────────────── 目标探测 ─────────────────────────

  /**
   * 探测目标文件：不存在 / 不可读 / 太大 / 可读。
   *
   * 注入 `stat` 时先看元信息再决定读不读——**太大的文件绝不能先读进来再判**，
   * 否则"512KiB 上限"只挡住了落盘、没挡住内存里那几百 MB。
   */
  private async probe(path: string, supplied?: Uint8Array): Promise<Probe> {
    if (supplied !== undefined) {
      if (supplied.byteLength > this.maxSnapshotBytes) {
        return { status: 'skipped', reason: 'too-large' }
      }
      return { status: 'ok', content: supplied, bytes: supplied.byteLength }
    }
    if (this.stat) {
      let info: SnapshotStatInfo
      try {
        info = await this.stat(path)
      } catch {
        return { status: 'missing' } // stat 抛错 = 不存在（ENOENT）或拿不到元信息，都按"当时不存在"记
      }
      if (!info.isFile) {
        // 目录 / 符号链接 / 其它非常规文件：读它没有意义（见 SnapshotStatInfo 的注释）
        this.logger.warn('快照目标不是普通文件，跳过', {
          path,
          isDirectory: info.isDirectory,
        })
        return { status: 'skipped', reason: 'unreadable' }
      }
      if (info.size > this.maxSnapshotBytes) return { status: 'skipped', reason: 'too-large' }
      const content = await this.fs.readFile(path)
      // `bytes` 用**实际读到的内容**长度而不是 stat 的 size：两者之间文件可能已被改写
      return { status: 'ok', content, bytes: byteLength(content) }
    }

    // 降级路径（未注入 stat）：exists + readFile 的长度判断
    const exists = await this.fs.exists(path)
    if (!exists) return { status: 'missing' }
    const content = await this.fs.readFile(path)
    const bytes = byteLength(content)
    if (bytes > this.maxSnapshotBytes) return { status: 'skipped', reason: 'too-large' }
    return { status: 'ok', content, bytes }
  }

  private async writeSnapshotContent(path: string, content: string | Uint8Array): Promise<void> {
    if (typeof content === 'string') {
      await this.fs.writeFileAtomic(path, content)
      return
    }
    if (this.fs.writeFileAtomicBytes === undefined) {
      throw new Error('文件系统端口不支持写二进制快照')
    }
    await this.fs.writeFileAtomicBytes(path, content)
  }

  private baseRef(
    input: SnapshotCaptureInput,
    sessionId: string,
    createdAt: Date,
  ): Omit<SnapshotRef, 'id' | 'contentPath' | 'bytes' | 'exists'> {
    return {
      sessionId,
      path: input.path,
      origin: input.origin,
      createdAt: createdAt.toISOString(),
      ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
      // `append` 只是记下模式（内容是**追加前**的全文），端口层两种模式无差别
      ...(input.mode === undefined ? {} : { mode: input.mode }),
    }
  }

  // ───────────────────────── 索引：内存态 ─────────────────────────

  /**
   * 同一个会话的索引改动走一条 promise 链。
   *
   * 为什么必须串行：`appendAndEvict` 里有 `await fs.remove` 这类挂起点，
   * 两个并发 capture 交错执行时，各自基于"自己看到的 refs"做淘汰与回写就会互相丢条目。
   */
  private enqueue<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(sessionId) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(task)
    // 链上只存"已消化异常"的占位：一个会话一条链，数量随会话数有界
    this.mutations.set(
      sessionId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    )
    return run
  }

  private stateOf(sessionId: string): SessionState {
    let state = this.states.get(sessionId)
    if (!state) {
      state = { refs: [], loaded: false, dirty: false }
      this.states.set(sessionId, state)
    }
    return state
  }

  /**
   * 懒加载某会话的索引。
   *
   * ⚠️ 这里**不能**写成"先 `loaded.add(id)` 再 `await readFromDisk(id)`"（同仓库有过这个 bug）：
   * 那样第二个并发调用者会看到 loaded=true 直接返回，拿到的是**还没填的空索引**，
   * 接着它一 append 就把磁盘上的历史整体覆盖掉。
   * 正确做法是把在途的 promise 挂起来共享：所有并发调用者都等到同一份结果。
   */
  private ensureLoaded(sessionId: string): Promise<void> {
    const state = this.stateOf(sessionId)
    if (state.loaded) return Promise.resolve()
    const inflight = state.loading
    if (inflight) return inflight
    const task = this.readIndex(sessionId)
      .then((refs) => {
        state.refs = refs
        state.loaded = true
      })
      .catch((error: unknown) => {
        // readIndex 自身已尽力兜底；这里再兜一层，保证加载链永远不把异常甩给 capture/list
        this.logger.warn('快照索引加载失败，按空索引继续', {
          sessionId,
          error: messageOf(error),
        })
        state.refs = []
        state.loaded = true
      })
      // 清 in-flight 标记：放在链尾（而不是在 readIndex 的 finally 里），
      // 保证它一定发生在 `state.loading = task` 之后
      .then(() => {
        state.loading = undefined
      })
    state.loading = task
    return task
  }

  private async readIndex(sessionId: string): Promise<SnapshotRef[]> {
    const path = indexPathOf(this.dir, sessionId)
    let raw: string
    try {
      raw = await this.fs.readFile(path)
    } catch {
      return [] // 首次运行：还没有索引文件（读取不创建任何文件）
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      await this.recoverCorruptIndex(sessionId, path, error)
      return []
    }
    if (!Array.isArray(parsed)) {
      // 能解析但不是数组（例如被别的程序写成了对象）：同样按整体损坏处理
      await this.recoverCorruptIndex(sessionId, path, new Error('索引不是数组'))
      return []
    }

    const refs = parsed.filter(isSnapshotRef)
    if (refs.length !== parsed.length) {
      // 个别条目畸形时**保留**能读的那些（只丢坏条目），不像整体损坏那样推倒重来
      this.logger.warn('快照索引存在无法识别的条目，已丢弃', {
        sessionId,
        dropped: parsed.length - refs.length,
      })
    }
    return refs
  }

  /** 索引整体不可信时的统一恢复路径：备份 → 按空索引继续 → 清掉失去引用的内容文件 */
  private async recoverCorruptIndex(
    sessionId: string,
    path: string,
    error: unknown,
  ): Promise<void> {
    this.logger.warn('快照索引解析失败，已备份并按空索引继续', {
      sessionId,
      error: messageOf(error),
    })
    await this.backupCorrupt(sessionId, path)
    // 索引没了 ⇒ 目录里的 `.snap` 全都没有引用，顺手清掉（否则永远留在磁盘上没人认领）
    await this.removeOrphanSnapshots(sessionId)
  }

  private async backupCorrupt(sessionId: string, path: string): Promise<void> {
    const dir = sessionDirOf(this.dir, sessionId)
    // 名字里的时间戳取 13 位毫秒（到 2286 年都是定宽）：定宽才能靠字典序排出新旧
    const backup = join(dir, `${CORRUPT_PREFIX}${this.now().getTime()}.json`)
    try {
      await this.fs.rename(path, backup)
      await this.pruneCorruptBackups(sessionId)
    } catch (error) {
      this.logger.warn('备份损坏的快照索引失败', { sessionId, error: messageOf(error) })
    }
  }

  private async pruneCorruptBackups(sessionId: string): Promise<void> {
    const dir = sessionDirOf(this.dir, sessionId)
    try {
      const entries = (await this.fs.readdir(dir))
        .filter((name) => name.startsWith(CORRUPT_PREFIX))
        .sort()
      while (entries.length > MAX_CORRUPT_BACKUPS) {
        const oldest = entries.shift()
        if (oldest === undefined) break
        await this.fs.remove(join(dir, oldest))
      }
    } catch {
      /* 清理失败不影响主流程 */
    }
  }

  /** 清掉会话目录里没有被索引引用的内容文件（只在索引损坏、按空索引继续时调用） */
  private async removeOrphanSnapshots(sessionId: string): Promise<void> {
    const dir = sessionDirOf(this.dir, sessionId)
    try {
      const entries = await this.fs.readdir(dir)
      let removed = 0
      for (const name of entries) {
        if (!name.endsWith(SNAPSHOT_EXT)) continue
        await this.fs.remove(join(dir, name))
        removed += 1
      }
      if (removed > 0) this.logger.info('已清理无索引引用的孤儿快照', { sessionId, removed })
    } catch (error) {
      this.logger.warn('清理孤儿快照失败', { sessionId, error: messageOf(error) })
    }
  }

  private async listSessionIds(): Promise<string[]> {
    try {
      const entries = await this.fs.readdir(this.dir)
      return entries.filter((name) => name !== INDEX_FILE && !name.includes('.')).sort() // 会话目录名只含 [A-Za-z0-9_-]（见 normalizeSessionId），带 `.` 的条目是根目录里的散落文件
    } catch {
      return [] // 快照根目录还不存在：还没存过任何快照
    }
  }

  private markDirty(sessionId: string): void {
    this.stateOf(sessionId).dirty = true
  }

  /**
   * 追加到内存索引并做一次淘汰（环形 + 总量）。
   *
   * 自己先 `ensureLoaded`：**不能**在没加载完的 `state.refs` 上追加——
   * 随后的懒加载会把 `state.refs` 整个换成磁盘上的内容，刚追加的那条就凭空消失了
   * （单测里"防抖 + list"一条就是靠这个抓出来的）。在 per-session 串行链里调用，因此不会交错。
   */
  private async appendAndEvict(sessionId: string, ref: SnapshotRef): Promise<void> {
    await this.ensureLoaded(sessionId)
    const state = this.stateOf(sessionId)
    // 同 id 重复捕获（同一毫秒 + 同一内容）时替换旧条目，避免索引里出现两条一样的引用
    state.refs = [...state.refs.filter((item) => item.id !== ref.id), ref]
    state.dirty = true
    await this.evict(sessionId)
    this.scheduleWrite(sessionId)
  }

  /**
   * 淘汰：先按 `path` 分组做环形保留，再按目录总量从最旧开始删。
   *
   * 返回从索引里移除的条数（内容文件删除失败也已经从索引移除，只是会告警）。
   */
  private async evict(sessionId: string): Promise<number> {
    const state = this.stateOf(sessionId)
    if (state.refs.length === 0) return 0

    const victims = new Set<string>()

    // 1) 环形：同一个文件的历史里，只留最新的 keepPerFile 条（负数 = 不限制）
    if (this.keepPerFile >= 0) {
      const groups = new Map<string, SnapshotRef[]>()
      for (const ref of state.refs) {
        const bucket = groups.get(ref.path)
        if (bucket) bucket.push(ref)
        else groups.set(ref.path, [ref])
      }
      for (const bucket of groups.values()) {
        if (bucket.length <= this.keepPerFile) continue
        for (const ref of bucket.sort((a, b) => compareRefs(b, a)).slice(this.keepPerFile)) {
          victims.add(ref.id)
        }
      }
    }

    // 2) 总量：只统计**有内容文件**的条目，也只淘汰它们
    //    （删一条 bytes:0 的 `exists:false` 记录对预算毫无帮助，只会白丢"当时不存在"的历史）
    if (this.totalBudgetBytes >= 0) {
      const withContent = state.refs.filter((ref) => !victims.has(ref.id) && ref.contentPath !== '')
      let total = withContent.reduce((sum, ref) => sum + ref.bytes, 0)
      if (total > this.totalBudgetBytes) {
        for (const ref of withContent.sort((a, b) => compareRefs(a, b))) {
          if (total <= this.totalBudgetBytes) break
          victims.add(ref.id)
          total -= ref.bytes
        }
      }
    }

    if (victims.size === 0) return 0

    const removedRefs = state.refs.filter((ref) => victims.has(ref.id))
    // 先重读 state.refs 再过滤：淘汰过程里有 await，期间可能有新条目追加进来（不能被误删）
    state.refs = state.refs.filter((ref) => !victims.has(ref.id))
    for (const ref of removedRefs) {
      if (ref.contentPath === '') continue
      try {
        await this.fs.remove(join(this.dir, ref.contentPath))
      } catch (error) {
        this.logger.warn('删除被淘汰的快照内容文件失败', {
          sessionId,
          contentPath: ref.contentPath,
          error: messageOf(error),
        })
      }
    }
    this.logger.debug('快照淘汰完成', { sessionId, removed: removedRefs.length })
    return removedRefs.length
  }

  // ───────────────────────── 索引：落盘 ─────────────────────────

  private scheduleWrite(sessionId: string): void {
    const state = this.stateOf(sessionId)
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    if (this.writeDebounceMs <= 0) {
      void this.writeNow(sessionId)
      return
    }
    const timer = setTimeout(() => {
      state.timer = undefined
      void this.writeNow(sessionId)
    }, this.writeDebounceMs)
    timer.unref?.() // 只有索引待写时不该拖住进程退出
    state.timer = timer
  }

  /**
   * 串行排队写盘：排到队时才读取最新内存快照，因此不会写旧内容；
   * 多个来源（防抖定时器 / flush / capture）天然合并为一次写。
   *
   * 注意：`run` 内部在**检查脏标记之前**不 await 任何东西，
   * 因此同步 `scheduleWrite` 后立刻 `await this.writeNow(id)` 能观察到本次写入的结果（单测依赖）。
   */
  private writeNow(sessionId: string): Promise<void> {
    const state = this.stateOf(sessionId)
    if (!state.dirty) return state.writing ?? Promise.resolve()
    const run = (state.writing ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        if (!state.dirty) return
        state.dirty = false
        const payload = `${JSON.stringify(state.refs, null, 2)}\n`
        try {
          await this.fs.mkdirp(sessionDirOf(this.dir, sessionId))
          await this.fs.writeFileAtomic(indexPathOf(this.dir, sessionId), payload)
        } catch (error) {
          state.dirty = true // 保持脏标记，下次 flush / 防抖重试（写失败不能静默丢索引）
          this.logger.warn('快照索引写入失败，稍后重试', {
            sessionId,
            error: messageOf(error),
          })
        }
      })
    state.writing = run
    return run
  }

  private async drainWrites(): Promise<void> {
    const pending = [...this.states.values()].map((state) => state.writing)
    await Promise.all(pending.map((task) => task?.catch(() => undefined)))
  }
}

// ───────────────────────── 纯函数 ─────────────────────────

/**
 * 会话 id 白名单归一（与 `session/store.ts` 的 `normalizeSessionId` 同款口径）：
 * 目录名要拼进路径，必须挡住 `..` 与分隔符，否则快照能写到 `<dir>` 之外。
 *
 * 刻意不 import store 里那个：快照端口是被工具层注入的**底层**端口，
 * 反向依赖会话层会形成 `store → tools → snapshots → store` 的循环依赖。
 */
function normalizeSessionId(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 64)
  return cleaned === '' ? 'default' : cleaned
}

function sessionDirOf(root: string, sessionId: string): string {
  return join(root, sessionId)
}

function indexPathOf(root: string, sessionId: string): string {
  return join(sessionDirOf(root, sessionId), INDEX_FILE)
}

/**
 * ISO 时间戳 → 文件名片段：`:` 与 `.` 都换成 `-`。
 * `2026-09-26T10:52:31.123Z` ⇒ `2026-09-26T10-52-31-123Z`（定宽 ⇒ 字典序 = 时间序）。
 */
function toFileStamp(at: Date): string {
  return at.toISOString().replace(/[:.]/g, '-')
}

function compareRefs(a: SnapshotRef, b: SnapshotRef): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  // 同一毫秒再按 id 兜底：id 前缀就是时间戳，等价于按内容散列定序，至少保证结果稳定
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return 0
}

/** 索引条目的形状校验：只保留字段类型正确的条目（个别畸形不该丢掉整份历史） */
function isSnapshotRef(value: unknown): value is SnapshotRef {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  const origin = candidate['origin']
  const contentPath = candidate['contentPath']
  return (
    typeof candidate['id'] === 'string' &&
    candidate['id'] !== '' &&
    typeof candidate['sessionId'] === 'string' &&
    typeof candidate['path'] === 'string' &&
    (origin === 'write_file' ||
      origin === 'edit_file' ||
      origin === 'office_edit' ||
      origin === 'office_export' ||
      origin === 'rollback') &&
    typeof candidate['createdAt'] === 'string' &&
    typeof contentPath === 'string' &&
    // 本端口自己写的 contentPath 永远是 `<sessionId>/<id>.snap`，含 `..` 的一律当畸形条目丢掉
    !contentPath.includes('..') &&
    typeof candidate['bytes'] === 'number' &&
    typeof candidate['exists'] === 'boolean'
  )
}

function byteLength(content: string): number {
  return Buffer.byteLength(content, 'utf8')
}

function digest8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
