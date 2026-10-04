/**
 * FileJobStore —— Job 的文件持久化（docs/06 §4.1）。
 *
 * 用途：把每条 job 的生命周期（轮次 / 工具步 / 用量 / 游标 / 待办快照）落盘，
 * 让「自动续跑」在**重启之后**仍然从正确的轮次、正确的额度继续（docs/06 §5）。
 *
 * 落盘布局（唯一形状口径）：`<dir>/<sessionId>.json`，内容
 * `{ "version": JOBS_FILE_VERSION, "jobs": AgentJob[] }`
 * —— 一个会话一个文件，同会话的多个 job 按创建顺序排列（新创建的在数组后面）。
 * `sessionId` 走白名单归一（`[A-Za-z0-9_-]`，其余字符归一为 `_`，空 → `default`）防路径穿越。
 *
 * 持久化约定（与 `session/store.ts`、`tools/todo-port.ts` 同一套，但有两处**刻意不同**）：
 * - 懒加载 + 300ms 防抖原子写 + `flush()`（退出前调用）；
 * - 同一 `sessionId` 的写**串行化**（per-session promise 链），不会两次写互相覆盖；
 * - 损坏（JSON 解析失败 / 顶层形状不对）→ 备份为 `<sessionId>.corrupt-<ts>.json`（最多 3 份）
 *   后按空表继续，**不抛**；
 * - 任何 fs 异常一律降级（`get` → undefined、`list` → []、`update` → undefined、
 *   `create` 失败仍返回传入的 job 只记 warn），**永不抛**给调用方；
 * - 差异一：`ensureLoaded` 用 **in-flight promise map**。`todo-port.ts` 那种
 *   「先置 loaded 再 await 读盘」会在并发首读时让第二个调用直接拿到**空表**
 *   （先返回空、随后才被读盘结果替换），本轮明确不照抄。
 * - 差异二：`update` **按 id 定位**（`jobs.findIndex(j => j.id === id)`），
 *   不做「线性扫全部会话找某个字段」的全表遍历——那是 O(会话数 × job 数) 的白工，
 *   而且会把 patch 误落到别的 job 上。
 *
 * 纯 Node：文件系统经 `FileSystemPort` 注入，不 import electron / DOM，可完整单测。
 */
import { join } from 'node:path'
import { createNoopLogger, nodeFileSystem, type FileSystemPort, type Logger } from '@aurora/shared'
import {
  JOBS_FILE_VERSION,
  type AgentJob,
  type AgentJobStatus,
  type JobPendingReason,
  type JobStep,
  type JobTodoSnapshot,
} from './types.js'

export const JOBS_WRITE_DEBOUNCE_MS = 300
/** 损坏备份上限（同 SessionStore / FileTodoPort） */
const MAX_CORRUPT_BACKUPS = 3
/** `list` 缺省返回条数（续跑入口的候选列表通常只看最近几条） */
export const DEFAULT_JOB_LIST_LIMIT = 50

export interface FileJobStoreOptions {
  /** 存储目录（主进程注入 `<userData>/jobs`） */
  dir: string
  fs: FileSystemPort
  logger?: Logger
  /** 防抖写盘间隔，缺省 300ms；测试可传 0 立即写 */
  writeDebounceMs?: number
  /** 时钟注入（测试友好：让 `updatedAt` 确定可预期，不必等墙钟走毫秒） */
  clock?: () => Date
}

export interface JobListQuery {
  sessionId?: string
  status?: AgentJobStatus
  /** 缺省 50；非正数 = 不限制（与 SessionStore 的 limit 口径一致） */
  limit?: number
}

export interface JobStore {
  create(job: AgentJob): Promise<AgentJob>
  get(id: string): Promise<AgentJob | undefined>
  list(query?: JobListQuery): Promise<AgentJob[]>
  /** 只回 `paused`（续跑入口），按 `updatedAt` 倒序 */
  listResumable(): Promise<AgentJob[]>
  /** 按 id 定位并浅合并补丁（**不要**线性扫全部会话找别的字段；返回更新后的 job） */
  update(id: string, patch: JobPatch): Promise<AgentJob | undefined>
  flush(): Promise<void>
}

/**
 * 补丁的字段是「显式允许清空」的：`{ error: undefined }` 会**删掉**该键
 * （暂停恢复后要清掉上一次的错误），而「没出现在补丁里的键」一律不动。
 */
export interface JobPatch {
  status?: AgentJobStatus
  round?: number
  maxRounds?: number
  stepsDone?: JobStep[]
  todos?: JobTodoSnapshot[]
  cursor?: { nextRound: number; note?: string }
  // budget 也做一层浅合并：调用方只改 usedTokens 时不必自己拼出整个对象，
  // 更不会因为漏字段把持久化的 autoContinued 冲掉（那正是本节要防的 bug）。
  budget?: Partial<AgentJob['budget']>
  pendingReason?: JobPendingReason | undefined
  error?: string | undefined
  updatedAt?: string
}

export function createFileJobStore(options: FileJobStoreOptions): JobStore {
  return new FileJobStore(options)
}

/** 单个会话的内存态：懒加载、防抖定时器、串行写链都在这里 */
interface SessionState {
  jobs: AgentJob[]
  /** 是否已从磁盘装载过（装载失败时为 false，下次访问会重试读盘） */
  loaded: boolean
  /** 在途的首次读盘；并发调用共享它（"并发首读不返回空"的关键） */
  loading?: Promise<void>
  dirty: boolean
  /** 在途的写（per-session 串行链的尾节点） */
  writing?: Promise<void>
  timer?: NodeJS.Timeout
}

class FileJobStore implements JobStore {
  private readonly dir: string
  private readonly fs: FileSystemPort
  private readonly logger: Logger
  private readonly writeDebounceMs: number
  private readonly clock: () => Date
  private readonly states = new Map<string, SessionState>()
  /** 目录是否已确保存在（首次写盘前 mkdirp 一次；失败时保持 false 以便重试） */
  private dirEnsured = false

  constructor(options: FileJobStoreOptions) {
    this.dir = options.dir
    this.fs = options.fs ?? nodeFileSystem
    this.logger = options.logger ?? createNoopLogger()
    this.writeDebounceMs = options.writeDebounceMs ?? JOBS_WRITE_DEBOUNCE_MS
    this.clock = options.clock ?? ((): Date => new Date())
  }

  get directory(): string {
    return this.dir
  }

  /** 落盘一条新 job；**任何 fs 异常都不抛**（返回传入的 job，只记 warn） */
  async create(job: AgentJob): Promise<AgentJob> {
    const sessionId = normalizeSessionId(job.sessionId)
    try {
      const stored = withSessionId(job, sessionId)
      this.mutate(sessionId, (jobs) => {
        jobs.push(cloneJob(stored))
      })
      return cloneJob(stored)
    } catch (error) {
      this.logger.warn('job 落盘失败，已降级为仅在内存中可见', {
        jobId: job.id,
        sessionId,
        error: messageOf(error),
      })
      return job
    }
  }

  async get(id: string): Promise<AgentJob | undefined> {
    if (id.trim() === '') return undefined
    try {
      for (const sessionId of await this.sessionIds()) {
        await this.ensureLoaded(sessionId)
        const found = this.stateOf(sessionId).jobs.find((job) => job.id === id)
        if (found !== undefined) return cloneJob(found)
      }
      return undefined
    } catch (error) {
      this.logger.warn('读取 job 失败，按不存在返回', { jobId: id, error: messageOf(error) })
      return undefined
    }
  }

  async list(query: JobListQuery = {}): Promise<AgentJob[]> {
    try {
      const jobs = await this.collect(query.sessionId)
      const filtered =
        query.status === undefined ? jobs : jobs.filter((job) => job.status === query.status)
      return applyLimit(filtered, query.limit)
    } catch (error) {
      this.logger.warn('列出 job 失败，按空列表返回', { error: messageOf(error) })
      return []
    }
  }

  /**
   * 续跑入口：只回 `paused`。
   *
   * 不加 `limit`：候选集本来就是"被中断的少数几条"，截断反而会让某条永远续不上；
   * 排序与 `list` 同口径（`updatedAt` 倒序，最近被中断的排最前）。
   */
  async listResumable(): Promise<AgentJob[]> {
    try {
      const jobs = await this.collect()
      return jobs.filter((job) => job.status === 'paused')
    } catch (error) {
      this.logger.warn('列出可续跑 job 失败，按空列表返回', { error: messageOf(error) })
      return []
    }
  }

  /** 按 id 定位并应用补丁；找不到返回 undefined（**不抛**） */
  async update(id: string, patch: JobPatch): Promise<AgentJob | undefined> {
    if (id.trim() === '') return undefined
    try {
      for (const sessionId of await this.sessionIds()) {
        await this.ensureLoaded(sessionId)
        const state = this.stateOf(sessionId)
        const index = state.jobs.findIndex((job) => job.id === id)
        if (index < 0) continue
        const current = state.jobs[index]
        if (current === undefined) return undefined
        const next = applyPatch(current, patch, this.clock().toISOString())
        state.jobs[index] = next
        this.markDirty(sessionId)
        return cloneJob(next)
      }
      return undefined
    } catch (error) {
      this.logger.warn('更新 job 失败，按未更新返回', { jobId: id, error: messageOf(error) })
      return undefined
    }
  }

  /**
   * 立即落盘（退出前 / 单测使用）。
   *
   * 与 SessionStore 同一套「反复排空」语义：先取消防抖定时器并等在途写入排队完成，
   * 再对仍然脏的会话重试，最后再等一次在途写入 ——
   * 因此"写失败 → flush 重试"是可靠语义（脏标记保留），而不是碰时序运气。
   */
  async flush(): Promise<void> {
    for (const state of this.states.values()) {
      if (state.timer) {
        clearTimeout(state.timer)
        state.timer = undefined
      }
    }
    await Promise.all([...this.states.values()].map((state) => settle(state.writing)))
    for (const [sessionId, state] of [...this.states]) {
      if (!state.dirty) continue
      await this.writeNow(sessionId)
    }
    await Promise.all([...this.states.values()].map((state) => settle(state.writing)))
  }

  /** 取消待写的防抖定时器（进程退出 / 单测收尾用；不落盘，落盘走 `flush`） */
  dispose(): void {
    for (const state of this.states.values()) {
      if (!state.timer) continue
      clearTimeout(state.timer)
      state.timer = undefined
    }
  }

  // ───────────────────────── 读取 ─────────────────────────

  private stateOf(sessionId: string): SessionState {
    let state = this.states.get(sessionId)
    if (state === undefined) {
      state = { jobs: [], loaded: false, dirty: false }
      this.states.set(sessionId, state)
    }
    return state
  }

  /**
   * 确保某会话已装载（in-flight promise map）。
   *
   * 关键点（相对 `todo-port.ts` 的两处修正）：
   * - 并发调用共享同一次在途读盘，谁都不会拿到"装载还没回来"的空表；
   * - **失败时不置 `loaded`**：否则一次读盘抖动就把该会话永久钉在"空表"上，
   *   后续 `create` 写出的文件里就只剩新增的那条 job（静默丢进度）。
   *   这里的"失败"专指**读/解析异常**——文件不存在是正常状态，算装载成功。
   */
  private async ensureLoaded(sessionId: string): Promise<void> {
    const state = this.stateOf(sessionId)
    if (state.loaded) return
    if (state.loading !== undefined) return state.loading
    const attempt = this.load(sessionId)
    state.loading = attempt
    try {
      await attempt
    } finally {
      // 只清掉自己那一次（期间可能有新的装载顶上）
      if (state.loading === attempt) state.loading = undefined
    }
  }

  private async load(sessionId: string): Promise<void> {
    const state = this.stateOf(sessionId)
    const jobs = await this.readFromDisk(sessionId)
    // **合并而不是整体替换**：读盘期间可能有 `create` / `update` 已经同步改过内存
    // （改动不等装载，见 `mutate`），整体替换会把它悄悄丢掉。
    // 盘上的 job 排在前（它们更早），装载期间的改动追加在后 —— 与"新创建的在数组后面"同口径。
    state.jobs = [...jobs, ...state.jobs]
    state.loaded = true
  }

  /**
   * 读一个会话的 jobs 文件。
   *
   * 宽容口径（docs/06 §4.1）：
   * - 文件不存在 → 空表（首次运行，**不是**错误，也不建文件）；
   * - 读取异常（EIO / 权限…）→ **抛出**，由 `ensureLoaded` 保证"下次访问重试"：
   *   这里返回空表会被当成装载成功，把该会话永久钉在空表上；
   * - JSON 解析失败 / `jobs` 不是数组 → 备份为 `<sessionId>.corrupt-<ts>.json` 后按空表继续
   *   （文件结构已不可信，但内容已留档；备份成功 = 装载成功，不必再重试）；
   * - 单条 job 形状不对 → 只丢弃那一条（不为一条坏记录把整个文件的进度全备份丢掉）。
   */
  private async readFromDisk(sessionId: string): Promise<AgentJob[]> {
    const path = jobFilePath(this.dir, sessionId)
    let raw: string
    try {
      raw = await this.fs.readFile(path)
    } catch (error) {
      if (await this.isAbsent(path)) return [] // 文件不存在：首次运行
      throw error
    }

    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isRecord(parsed) || !Array.isArray(parsed['jobs'])) {
        throw new Error('jobs 不是数组')
      }
      const version = parsed['version']
      if (version !== JOBS_FILE_VERSION) {
        this.logger.debug('job 文件版本与当前不一致，按宽容口径继续读取', {
          sessionId,
          fileVersion: version,
          currentVersion: JOBS_FILE_VERSION,
        })
      }
      const jobs: AgentJob[] = []
      for (const entry of parsed['jobs']) {
        const job = toAgentJob(entry, sessionId)
        if (job === undefined) {
          this.logger.warn('job 记录形状非法，已跳过该条', { sessionId })
          continue
        }
        jobs.push(job)
      }
      return jobs
    } catch (error) {
      this.logger.warn('job 文件解析失败，已备份并按空表继续', {
        sessionId,
        error: messageOf(error),
      })
      await this.backupCorrupt(sessionId, path)
      return []
    }
  }

  /** 文件是否**确实不存在**（区分"读失败"与"还没写过"；`exists` 自身异常按不存在处理） */
  private async isAbsent(path: string): Promise<boolean> {
    try {
      return !(await this.fs.exists(path))
    } catch {
      return true
    }
  }

  /**
   * 参与读取的会话 id：内存里已有的（点查询过的）∪ 磁盘上已有文件的。
   *
   * 少了磁盘那一半，"重启后列出全部 job"就永远只看得见被点开过的会话。
   */
  private async sessionIds(): Promise<string[]> {
    const ids = new Set<string>(this.states.keys())
    try {
      for (const name of await this.fs.readdir(this.dir)) {
        if (!name.endsWith('.json') || name.includes('.corrupt-')) continue
        ids.add(name.slice(0, -'.json'.length))
      }
    } catch {
      /* 目录不存在：只用内存里的会话 */
    }
    return [...ids]
  }

  /** 收集（并排序）job 列表：`updatedAt` 倒序，供 `list` / `listResumable` 共用 */
  private async collect(sessionId?: string): Promise<AgentJob[]> {
    const ids = sessionId === undefined ? await this.sessionIds() : [normalizeSessionId(sessionId)]
    const collected: AgentJob[] = []
    for (const id of ids) {
      await this.ensureLoaded(id)
      for (const job of this.stateOf(id).jobs) collected.push(cloneJob(job))
    }
    // 同 `updatedAt` 时用 `createdAt` 兜底：排序必须是确定的，否则同一份数据两次 `list`
    // 可能给出不同顺序（界面上表现为列表"自己抖动"）
    return collected.sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        right.createdAt.localeCompare(left.createdAt) ||
        right.id.localeCompare(left.id),
    )
  }

  // ───────────────────────── 写入 ─────────────────────────

  /** 记脏 + 排一次写（调用前必须已 `ensureLoaded`，否则会把盘上数据冲掉） */
  private markDirty(sessionId: string): void {
    const state = this.stateOf(sessionId)
    state.dirty = true
    this.scheduleWrite(sessionId)
  }

  /**
   * 内存态改动 + 排队落盘。
   *
   * **改动是同步完成的，不等装载**：首次访问（还没有内存态）时先点火读盘，再同步改内存，
   * 读盘的合并由 `writeNow` 在**落盘之前**等待（先落盘会把磁盘上已有的 job 抹掉）。
   * 反过来说，"先 await 装载、再改内存"看着更直观，却会留下一个空窗：
   * 期间并发进来的 `list` / `get` 会读到改动之前的状态 —— 也就是「刚创建的 job 看不见」。
   * 这也是本节相对 `todo-port.ts` 要修的第二个坑（第一个是 `ensureLoaded` 的并发首读）。
   */
  private mutate(sessionId: string, run: (jobs: AgentJob[]) => void): void {
    const state = this.stateOf(sessionId)
    if (!state.loaded) {
      // 点火读盘但不阻塞改动；失败只留痕（`loaded` 仍为 false，下次访问会重试）
      void this.ensureLoaded(sessionId).catch((error: unknown) => {
        this.logger.warn('装载 job 文件失败，稍后重试', { sessionId, error: messageOf(error) })
      })
    }
    run(state.jobs)
    this.markDirty(sessionId)
  }

  private scheduleWrite(sessionId: string, delayMs = this.writeDebounceMs): void {
    const state = this.stateOf(sessionId)
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    if (delayMs <= 0) {
      // 不 await：调用方立刻拿到结果，写结果由串行链自行收敛（失败保持脏标记，下次重试）
      this.writeNow(sessionId)
      return
    }
    const timer = setTimeout(() => {
      state.timer = undefined
      this.writeNow(sessionId)
    }, delayMs)
    timer.unref?.() // 只有 job 待写时不该拖住进程退出
    state.timer = timer
  }

  /**
   * 串行排队写盘：排到队时才读取最新内存快照，因此不会写旧内容；
   * 多个来源（防抖定时器 / flush / update）天然合并为一次写。
   *
   * 同样先 `ensureLoaded`：不能在装载完成前落盘 —— 那时内存里是空表，
   * 一写就把磁盘上这个会话的全部 job 抹掉（"先 create 再 list"的并发用例正是抓这个）。
   */
  private writeNow(sessionId: string): Promise<void> {
    const state = this.stateOf(sessionId)
    if (!state.dirty) return settle(state.writing)
    const previous = state.writing
    const attempt = (async (): Promise<void> => {
      // 排在队里才读内存快照：因此写的一定是最新内容（不会把旧快照盖上去）
      if (previous !== undefined) await previous
      await this.ensureLoaded(sessionId)
      if (!state.dirty) return
      state.dirty = false
      const payload = { version: JOBS_FILE_VERSION, jobs: state.jobs }
      try {
        await this.ensureDir()
        await this.fs.writeFileAtomic(jobFilePath(this.dir, sessionId), serialize(payload))
      } catch (error) {
        state.dirty = true // 保持脏标记：下次 flush / 防抖会重试，写失败绝不静默丢进度
        this.logger.error('job 文件写入失败，稍后重试', {
          sessionId,
          error: messageOf(error),
        })
      }
    })()
    // 同步把链尾换成新的 attempt（不能让链尾停在被吞掉错误的包装上），
    // 这样 `flush()` / 下一次 `writeNow` 等到的都是真正的那次写。
    state.writing = attempt
    void attempt.then(
      () => {
        if (state.writing === attempt) state.writing = undefined
      },
      () => {
        if (state.writing === attempt) state.writing = undefined
      },
    )
    return settle(attempt)
  }

  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return
    await this.fs.mkdirp(this.dir)
    this.dirEnsured = true
  }

  // ───────────────────────── 损坏恢复 ─────────────────────────

  private async backupCorrupt(sessionId: string, path: string): Promise<void> {
    try {
      // 13 位毫秒时间戳（到 2286 年都是定宽）：定宽才能靠字典序排出新旧
      const backup = join(this.dir, `${sessionId}.corrupt-${this.clock().getTime()}.json`)
      await this.fs.rename(path, backup)
      await this.pruneBackups(sessionId)
    } catch (error) {
      this.logger.warn('备份损坏的 job 文件失败', { sessionId, error: messageOf(error) })
    }
  }

  /** 损坏备份最多留 3 份（`.corrupt-` 前缀里带时间戳，字典序即新旧序） */
  private async pruneBackups(sessionId: string): Promise<void> {
    try {
      const entries = (await this.fs.readdir(this.dir))
        .filter((name) => name.startsWith(`${sessionId}.corrupt-`) && name.endsWith('.json'))
        .sort()
      while (entries.length > MAX_CORRUPT_BACKUPS) {
        const oldest = entries.shift()
        if (oldest === undefined) break
        await this.fs.remove(join(this.dir, oldest))
      }
    } catch {
      /* 清理失败不影响主流程 */
    }
  }
}

// ───────────────────────── 纯函数 ─────────────────────────

/**
 * 会话 id 白名单归一（与 `session/store.ts` 的 `normalizeSessionId` 同款口径）：
 * 只允许 `[A-Za-z0-9_-]`，其余字符归一为 `_`，空 → `'default'`（jobs 与会话是两套数据，
 * 缺省落点用 `default.json`，不去蹭会话的 `settings`）。**防路径穿越**：`../../x` → `______x`。
 */
function normalizeSessionId(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return 'default'
  const cleaned = trimmed.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
  return cleaned === '' ? 'default' : cleaned
}

export function jobFilePath(dir: string, sessionId: string): string {
  return join(dir, `${normalizeSessionId(sessionId)}.json`)
}

/** 浅合并补丁：**只改补丁里出现的键**（`cursor` / `budget` 再浅合并一层），`updatedAt` 自动更新 */
function applyPatch(job: AgentJob, patch: JobPatch, now: string): AgentJob {
  const next: AgentJob = {
    ...job,
    ...('status' in patch ? { status: patch.status ?? job.status } : {}),
    ...('round' in patch && patch.round !== undefined ? { round: patch.round } : {}),
    ...('maxRounds' in patch && patch.maxRounds !== undefined
      ? { maxRounds: patch.maxRounds }
      : {}),
    ...('stepsDone' in patch && patch.stepsDone !== undefined
      ? { stepsDone: patch.stepsDone.map(copyStep) }
      : {}),
    ...('todos' in patch && patch.todos !== undefined ? { todos: patch.todos.map(copyTodo) } : {}),
    ...('cursor' in patch && patch.cursor !== undefined ? { cursor: { ...patch.cursor } } : {}),
    ...('budget' in patch && patch.budget !== undefined
      ? { budget: { ...job.budget, ...patch.budget } }
      : {}),
    updatedAt: patch.updatedAt ?? now,
  }
  // 可选字段：补丁里显式给了 undefined = 清掉（如恢复后清 error），没给则保持原值
  if ('pendingReason' in patch) {
    if (patch.pendingReason === undefined) delete next.pendingReason
    else next.pendingReason = patch.pendingReason
  }
  if ('error' in patch) {
    if (patch.error === undefined) delete next.error
    else next.error = patch.error
  }
  return next
}

/** 落盘前把内存对象转成纯数据（不把调用方持有的引用写进 payload） */
function serialize(payload: { version: number; jobs: readonly AgentJob[] }): string {
  const plain = {
    version: payload.version,
    jobs: payload.jobs.map((job) => toPlainJob(job)),
  }
  return `${JSON.stringify(plain, null, 2)}\n`
}

function toPlainJob(job: AgentJob): AgentJob {
  return {
    ...job,
    stepsDone: job.stepsDone.map(copyStep),
    todos: job.todos.map(copyTodo),
    cursor: { ...job.cursor },
    budget: { ...job.budget },
  }
}

function cloneJob(job: AgentJob): AgentJob {
  return toPlainJob(job)
}

function withSessionId(job: AgentJob, sessionId: string): AgentJob {
  return job.sessionId === sessionId ? job : { ...job, sessionId }
}

function copyStep(step: JobStep): JobStep {
  return { round: step.round, tool: step.tool, ok: step.ok, at: step.at }
}

function copyTodo(todo: JobTodoSnapshot): JobTodoSnapshot {
  return { id: todo.id, text: todo.text, status: todo.status }
}

function applyLimit(jobs: readonly AgentJob[], limit?: number): AgentJob[] {
  const effective = limit ?? DEFAULT_JOB_LIST_LIMIT
  // 与 SessionStore 同口径：非正数 = 不限制
  return effective > 0 ? jobs.slice(0, effective) : [...jobs]
}

function settle(task: Promise<void> | undefined): Promise<void> {
  return task === undefined ? Promise.resolve() : task.catch(() => undefined)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ───────────────────────── 形状守卫（读侧宽容） ─────────────────────────

const STATUSES: readonly AgentJobStatus[] = [
  'queued',
  'running',
  'paused',
  'done',
  'error',
  'aborted',
]
const PENDING_REASONS: readonly JobPendingReason[] = ['max-rounds', 'budget', 'aborted']
/**
 * 允许从磁盘读回的 origin 白名单。
 *
 * **必须与 `AgentJob['origin']`（`@aurora/shared` 的 `ipc/types.ts`）逐字对齐**：
 * 少一个取值，那类 job 就会在 `toAgentJob` 里被判非法整条跳过 —— `get` / `list` /
 * `listResumable` 从此永远看不到它们（paused 的自动化 / 远程任务无法续跑），
 * 而同一文件里合法 job 的一次 `update` 还会把这些被跳过的条目从磁盘上抹掉。
 * 写入侧（主进程 `agent-host.ts`）用 `as` 强转放行任何字符串，落盘没有校验兜底，
 * 所以这道读侧白名单是唯一的形状闸门。同步护栏见 `store.test.ts` 的
 * 「origin 白名单与 shared 联合类型一致」用例。
 */
const ORIGINS: readonly AgentJob['origin'][] = [
  'chat',
  'edge-bar',
  'resume',
  'center',
  'automation',
  'file-awareness',
]

/**
 * 磁盘形状 → `AgentJob`：**必填字段缺一不可**，可选字段宽容（缺 / 类型不对就丢掉），
 * 数字字段做有限性检查（`NaN` / `Infinity` 落盘后回读会变成 `null`）。
 */
function toAgentJob(value: unknown, sessionId: string): AgentJob | undefined {
  if (!isRecord(value)) return undefined
  const id = value['id']
  const status = value['status']
  const origin = value['origin']
  if (typeof id !== 'string' || id === '') return undefined
  if (!isStatus(status) || !isOrigin(origin)) return undefined
  if (typeof value['text'] !== 'string') return undefined

  const storedSessionId = value['sessionId']
  const cursor = isRecord(value['cursor']) ? value['cursor'] : {}
  const budget = isRecord(value['budget']) ? value['budget'] : {}
  const job: AgentJob = {
    id,
    // 文件名即会话归属：文件里的 `sessionId` 与它不一致时以文件名为准（防手工挪动后错位）
    sessionId:
      typeof storedSessionId === 'string' && normalizeSessionId(storedSessionId) === sessionId
        ? storedSessionId
        : sessionId,
    status,
    origin,
    text: value['text'],
    round: toCount(value['round'], 0),
    maxRounds: toCount(value['maxRounds'], 0),
    stepsDone: toSteps(value['stepsDone']),
    todos: toTodos(value['todos']),
    cursor: {
      nextRound: toCount(cursor['nextRound'], 0),
      ...(typeof cursor['note'] === 'string' ? { note: cursor['note'] } : {}),
    },
    budget: {
      maxTotalTokens: toCount(budget['maxTotalTokens'], 0),
      usedTokens: toCount(budget['usedTokens'], 0),
      // 这一项的持久化正是本层的核心价值：读不到就只能归零，等于重启后又发一份额度
      autoContinued: toCount(budget['autoContinued'], 0),
    },
    createdAt: toTimestamp(value['createdAt']),
    updatedAt: toTimestamp(value['updatedAt']),
  }
  const requestId = value['requestId']
  if (typeof requestId === 'string') job.requestId = requestId
  const pendingReason = value['pendingReason']
  if (isPendingReason(pendingReason)) job.pendingReason = pendingReason
  const error = value['error']
  if (typeof error === 'string') job.error = error
  return job
}

function toSteps(value: unknown): JobStep[] {
  if (!Array.isArray(value)) return []
  const steps: JobStep[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const tool = entry['tool']
    if (typeof tool !== 'string') continue
    steps.push({
      round: toCount(entry['round'], 0),
      tool,
      ok: entry['ok'] === true,
      at: toTimestamp(entry['at']),
    })
  }
  return steps
}

function toTodos(value: unknown): JobTodoSnapshot[] {
  if (!Array.isArray(value)) return []
  const todos: JobTodoSnapshot[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const id = entry['id']
    const text = entry['text']
    const status = entry['status']
    if (typeof id !== 'string' || typeof text !== 'string') continue
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue
    todos.push({ id, text, status })
  }
  return todos
}

function toCount(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function toTimestamp(value: unknown): string {
  return typeof value === 'string' && value !== '' ? value : new Date(0).toISOString()
}

function isStatus(value: unknown): value is AgentJobStatus {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
}

function isPendingReason(value: unknown): value is JobPendingReason {
  return typeof value === 'string' && (PENDING_REASONS as readonly string[]).includes(value)
}

function isOrigin(value: unknown): value is AgentJob['origin'] {
  return typeof value === 'string' && (ORIGINS as readonly string[]).includes(value)
}
