/**
 * FileTodoPort —— 任务清单持久化（docs/06 §18）。
 *
 * 实现内核的 `TodoPort`：一个会话一份清单，`<dir>/<sessionId>.json`。
 * 子代理（docs/06 §19）的 sessionId 带 `-sub` 后缀，经同一套归一后天然落在
 * 独立清单文件（`<sessionId>-sub.json`）上，与主对话清单互不影响。
 *
 * 与 SessionStore（agent-core `session/store.ts`）同一套持久化约定：
 * - `sessionId` 白名单归一（防路径穿越）；
 * - 懒加载（首次访问读盘）+ 300ms 防抖原子写 + `flush()`（退出前调用）；
 * - 解析失败：备份为 `<sessionId>.corrupt-<ts>.json`（最多 3 份）后按空清单继续
 *   —— 清单不是关键数据，读失败不抛错、只 warn 留痕。
 * - 纯 Node：文件系统经 `FileSystemPort` 注入，不 import electron，可完整单测。
 */
import { join } from 'node:path'
import { nodeFileSystem, type FileSystemPort } from '@aurora/shared'
import type { Logger } from '@aurora/shared'
import { createNoopLogger } from '@aurora/shared'
import { normalizeSessionId, type TodoItem, type TodoPort } from '@aurora/agent-core'

export const TODO_WRITE_DEBOUNCE_MS = 300
/** 损坏备份上限（同 SessionStore） */
const MAX_BACKUPS = 3
const TODO_FILE_VERSION = 1

/** 清单文件结构：version 仅用于将来迁移；todos 是整表快照 */
interface StoredTodos {
  version: typeof TODO_FILE_VERSION
  sessionId: string
  updatedAt: string
  todos: TodoItem[]
}

export interface FileTodoPortOptions {
  /** 清单目录（主进程传 `<userData>/todos`） */
  dir: string
  fs?: FileSystemPort
  logger?: Logger
  /** 防抖写盘间隔，测试可传 0 立即写 */
  writeDebounceMs?: number
  onWriteError?: (error: Error) => void
}

export class FileTodoPort implements TodoPort {
  private readonly dir: string
  private readonly fs: FileSystemPort
  private readonly logger: Logger
  private readonly writeDebounceMs: number
  private readonly onWriteError: ((error: Error) => void) | undefined

  private readonly cache = new Map<string, TodoItem[]>()
  private readonly loaded = new Set<string>()
  /**
   * 首读去重：`id → 读盘中的 promise`（in-flight）。
   *
   * 与 SessionStore 同款：`loaded` 只在**读盘成功之后**登记，读盘期间并发调用复用同一个 promise。
   */
  private readonly loading = new Map<string, Promise<void>>()
  private readonly dirty = new Set<string>()
  private readonly writing = new Map<string, Promise<void>>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  /** 目录是否已确保存在（首次写盘前 mkdirp 一次） */
  private dirEnsured = false

  constructor(options: FileTodoPortOptions) {
    this.dir = options.dir
    this.fs = options.fs ?? nodeFileSystem
    this.logger = options.logger ?? createNoopLogger()
    this.writeDebounceMs = options.writeDebounceMs ?? TODO_WRITE_DEBOUNCE_MS
    this.onWriteError = options.onWriteError
  }

  get directory(): string {
    return this.dir
  }

  /** 读取某会话的任务清单；文件不存在返回空数组，**不创建任何文件**。 */
  async read(sessionId: string): Promise<TodoItem[]> {
    const id = normalizeSessionId(sessionId)
    await this.ensureLoaded(id)
    return [...(this.cache.get(id) ?? [])]
  }

  /** 整表写入某会话的任务清单（todo_write 的整表替换语义），防抖落盘。 */
  async write(sessionId: string, todos: TodoItem[]): Promise<void> {
    const id = normalizeSessionId(sessionId)
    await this.ensureLoaded(id)
    // 浅拷贝入缓存：防止调用方就地改动数组污染缓存快照
    this.cache.set(
      id,
      todos.map((todo) => ({ ...todo })),
    )
    this.dirty.add(id)
    this.scheduleWrite(id)
  }

  /**
   * 删除某会话及其子代理的任务清单。
   *
   * 顺序不能反：先取消待写并排空在途写盘，再失效缓存 / 读盘，最后删文件。
   * 否则防抖写或已经在途的读盘结果会在删除之后把旧清单重新写回来。
   */
  async removeSession(sessionId: string): Promise<void> {
    const id = normalizeSessionId(sessionId)
    await this.removeOne(id)
    if (!id.endsWith('-sub')) await this.removeOne(`${id}-sub`)
  }

  /**
   * 立即落盘（退出前 / 单测使用）。
   *
   * 与 SessionStore 同一套「反复排空」语义：先等在途写入排队完成，
   * 再对仍然脏的会话重试，最后再等一次在途写入——
   * 因此"写失败 → flush 重试"是可靠语义，而不是碰时序运气。
   */
  async flush(): Promise<void> {
    for (const [id, timer] of this.timers) {
      clearTimeout(timer)
      this.timers.delete(id)
    }
    await Promise.all([...this.writing.values()].map((task) => task.catch(() => undefined)))
    for (const id of [...this.dirty]) {
      await this.writeNow(id)
    }
    await Promise.all([...this.writing.values()].map((task) => task.catch(() => undefined)))
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  // ───────────────────────── 内部 ─────────────────────────

  /**
   * 懒加载：并发首读共享同一次读盘（in-flight promise map），**读盘成功后才置 `loaded`**。
   *
   * 为什么不能"先置 loaded 再 await 读盘"（本方法原先的写法）：
   * 在 `loaded.add(id)` 与读盘之间的 await 窗口里，第二个调用者会看到 `loaded` 命中并立刻返回，
   * 但它拿到的 `cache.get(id)` 还是**空清单**。最典型的时序是
   * `Promise.all([read(id), write(id, todos)])`：`read` 发起读盘，`write` 在窗口内基于空快照写盘，
   * 随后读盘结果 `cache.set(id, await ...)` 又把 cache 覆盖回盘上的旧清单
   * （写盘 payload 在排队时才读 cache，于是磁盘上最终也是旧清单）——
   * 表现就是**刚写的待办静默消失**，且只在首次访问该会话时偶发。
   *
   * 现在：读盘中的 promise 放进 `loading` 供并发调用复用（同一 id 只读一次盘）；
   * 读盘成功才登记 `loaded`；`finally` 清掉 map 条目，失败时下次访问重新读盘
   * （读失败降级口径仍由 `readFromDisk` 负责，这里不新造错误）。
   */
  private async ensureLoaded(id: string): Promise<void> {
    if (this.loaded.has(id)) return
    const inFlight = this.loading.get(id)
    // 已有在途读盘：直接复用它，既不重复读盘也不提前置 loaded
    if (inFlight !== undefined) return inFlight
    let task: Promise<void>
    // eslint-disable-next-line prefer-const -- 自引用闭包，见上（TS7022 不允许 const 直接引用自身）
    task = this.loadFromDisk(id, () => this.loading.get(id) === task).finally(() => {
      if (this.loading.get(id) === task) this.loading.delete(id)
    })
    this.loading.set(id, task)
    return task
  }

  /**
   * 真正读盘并装填 `cache`（由 `ensureLoaded` 去重后调用）。
   *
   * 清单是**整表替换**语义，因此不做逐条合并：读盘期间若已有并发写落下新快照
   * （`cache` 里已有该项，含写入的是空清单这种情形），那份新快照整体优先，
   * 绝不能用读回来的旧清单把它盖掉——否则用户刚写的清单会被盘上的旧内容顶掉。
   */
  private async loadFromDisk(id: string, isCurrent: () => boolean): Promise<void> {
    const todos = await this.readFromDisk(id)
    // 读盘期间被 removeSession 删除：不能把已经删掉的清单重新装回缓存。
    if (!isCurrent()) return
    if (!this.cache.has(id)) this.cache.set(id, todos)
    this.loaded.add(id)
  }

  /** 删一个清单文件；调用方负责主会话与 `-sub` 的组合口径。 */
  private async removeOne(id: string): Promise<void> {
    const timer = this.timers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(id)
    }
    this.dirty.delete(id)
    await (this.writing.get(id) ?? Promise.resolve()).catch(() => undefined)
    this.cache.delete(id)
    this.loaded.delete(id)
    // remove() 会删掉在途读盘的身份标记，让读盘完成后的 isCurrent 检查失效。
    this.loading.delete(id)
    await this.fs.remove(todoFilePath(this.dir, id))
  }

  private async readFromDisk(id: string): Promise<TodoItem[]> {
    const path = todoFilePath(this.dir, id)
    let raw: string
    try {
      raw = await this.fs.readFile(path)
    } catch {
      return [] // 首次运行：清单文件尚不存在（read 不创建文件）
    }

    try {
      const parsed: unknown = JSON.parse(raw)
      const todos = (parsed as StoredTodos | null)?.todos
      if (!Array.isArray(todos)) throw new Error('todos 不是数组')
      return todos.filter(isTodoItem)
    } catch (error) {
      this.logger.warn('任务清单文件解析失败，已备份并按空清单继续', {
        sessionId: id,
        error: String(error),
      })
      await this.backupCorrupt(id, path)
      return []
    }
  }

  private async backupCorrupt(id: string, path: string): Promise<void> {
    try {
      const backup = join(this.dir, `${id}.corrupt-${Date.now()}.json`)
      await this.fs.rename(path, backup)
      await this.pruneBackups(id)
    } catch (error) {
      this.logger.warn('备份损坏的任务清单文件失败', { sessionId: id, error: String(error) })
    }
  }

  private async pruneBackups(id: string): Promise<void> {
    try {
      const entries = (await this.fs.readdir(this.dir))
        .filter((name) => name.startsWith(`${id}.corrupt-`))
        .sort()
      while (entries.length > MAX_BACKUPS) {
        const oldest = entries.shift()
        if (oldest !== undefined) await this.fs.remove(join(this.dir, oldest))
      }
    } catch {
      /* 清理失败不影响主流程 */
    }
  }

  private scheduleWrite(id: string, delayMs = this.writeDebounceMs): void {
    if (delayMs <= 0) {
      const existing = this.timers.get(id)
      if (existing) {
        clearTimeout(existing)
        this.timers.delete(id)
      }
      void this.writeNow(id)
      return
    }
    const existing = this.timers.get(id)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.timers.delete(id)
      void this.writeNow(id)
    }, delayMs)
    timer.unref?.()
    this.timers.set(id, timer)
  }

  /**
   * 串行排队写盘：排到队时才读取最新内存快照，因此不会写旧内容。
   * 多个来源（防抖定时器 / flush）天然合并为一次写。
   *
   * 注意：`run` 内部在**检查脏标记之前**不 await 任何东西，
   * 因此同步调用 `scheduleWrite(id, 0)` 后等待微任务排空即可观察到写入结果（单测依赖）。
   */
  private writeNow(id: string): Promise<void> {
    if (!this.dirty.has(id)) return this.writing.get(id) ?? Promise.resolve()
    const run = (this.writing.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        if (!this.dirty.has(id)) return
        this.dirty.delete(id)
        const payload: StoredTodos = {
          version: TODO_FILE_VERSION,
          sessionId: id,
          updatedAt: new Date().toISOString(),
          todos: this.cache.get(id) ?? [],
        }
        try {
          await this.ensureDir()
          await this.fs.writeFileAtomic(
            todoFilePath(this.dir, id),
            `${JSON.stringify(payload, null, 2)}\n`,
          )
        } catch (error) {
          const wrapped = error instanceof Error ? error : new Error(String(error))
          this.dirty.add(id) // 保持脏标记，下次重试
          this.logger.error('任务清单写入失败', { sessionId: id, error: wrapped.message })
          this.onWriteError?.(wrapped)
        }
      })
    this.writing.set(id, run)
    return run
  }

  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return
    await this.fs.mkdirp(this.dir)
    this.dirEnsured = true
  }
}

/** 工厂：主进程装配用（`<userData>/todos`），返回值同时满足 TodoPort 与 flush / directory。 */
export function createFileTodoPort(options: FileTodoPortOptions): FileTodoPort {
  return new FileTodoPort(options)
}

function todoFilePath(dir: string, sessionId: string): string {
  return join(dir, `${normalizeSessionId(sessionId)}.json`)
}

function isTodoItem(value: unknown): value is TodoItem {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate['id'] === 'string' &&
    typeof candidate['content'] === 'string' &&
    (candidate['status'] === 'pending' ||
      candidate['status'] === 'in_progress' ||
      candidate['status'] === 'completed')
  )
}
