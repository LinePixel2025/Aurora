/**
 * 自动化存储（docs/13 §2.1）。
 *
 * 两个数据文件（`<userData>/automations/`）：
 * - `automations.json` —— 自动化定义（用户自建；内置自动化由引擎硬编码，不在这里）；
 * - `history.json` —— 运行历史（全量混排，上限 500 条，超出淘汰最旧）。
 *
 * 持久化约定与 `SessionStore` / `FileJobStore` 同一套：懒加载 + 300ms 防抖原子写 +
 * `flush()`；损坏备份 `.corrupt-<ts>.json` 后重建，任何 fs 异常永不抛。
 * **`ensureLoaded` 必须用 in-flight promise**：先置 loaded 再 await 读盘会让并发首读
 * 拿到空表、随后一次写入覆盖磁盘历史（本仓库已修过两次，禁止改回去）。
 *
 * 纯 Node：文件系统经 `FileSystemPort` 注入，不 import electron，可完整单测。
 */
import { join } from 'node:path'
import { createNoopLogger, nodeFileSystem, type FileSystemPort, type Logger } from '@aurora/shared'
import type {
  AutomationDefinition,
  AutomationMode,
  AutomationRun,
  AutomationRunStatus,
} from '@aurora/shared'

export const AUTOMATIONS_FILE_VERSION = 1
/** 运行历史上限：超出淘汰最旧（docs/13 §2.1） */
export const AUTOMATION_HISTORY_LIMIT = 500
export const AUTOMATIONS_WRITE_DEBOUNCE_MS = 300
/** 损坏备份上限（同 SessionStore / FileJobStore） */
const MAX_CORRUPT_BACKUPS = 3

export interface AutomationStoreOptions {
  /** 存储目录（主进程注入 `<userData>/automations`） */
  dir: string
  fs?: FileSystemPort
  logger?: Logger
  /** 防抖写盘间隔，缺省 300ms；测试可传 0 立即写 */
  writeDebounceMs?: number
  clock?: () => Date
}

export interface AutomationHistoryQuery {
  automationId?: string
  mode?: AutomationMode
  status?: AutomationRunStatus
  /** 缺省 50，上限由调用方裁剪 */
  limit?: number
}

export interface AutomationRunPatch {
  status?: AutomationRunStatus
  finishedAt?: string
  durationMs?: number
  /** Agent 模式：send 接受后补会话 id（历史面板据此回放对话） */
  sessionId?: string
  error?: string | undefined
}

export class AutomationStore {
  private readonly dir: string
  private readonly fs: FileSystemPort
  private readonly logger: Logger
  private readonly writeDebounceMs: number
  private readonly clock: () => Date

  private definitions: AutomationDefinition[] = []
  private runs: AutomationRun[] = []
  private loaded = false
  /** 在途的首次读盘；并发调用共享它（「并发首读不返回空」的关键） */
  private loading?: Promise<void>
  private dirtyDefinitions = false
  private dirtyRuns = false
  private timer?: NodeJS.Timeout
  private writing?: Promise<void>
  private dirEnsured = false
  constructor(options: AutomationStoreOptions) {
    this.dir = options.dir
    this.fs = options.fs ?? nodeFileSystem
    this.logger = options.logger ?? createNoopLogger()
    this.writeDebounceMs = Math.max(0, options.writeDebounceMs ?? AUTOMATIONS_WRITE_DEBOUNCE_MS)
    this.clock = options.clock ?? (() => new Date())
  }

  // ───────────────────────── 定义 ─────────────────────────

  async listDefinitions(): Promise<AutomationDefinition[]> {
    await this.ensureLoaded()
    return this.definitions.map((item) => structuredClone(item))
  }

  async getDefinition(id: string): Promise<AutomationDefinition | undefined> {
    await this.ensureLoaded()
    const found = this.definitions.find((item) => item.id === id)
    return found === undefined ? undefined : structuredClone(found)
  }

  /** 按 id upsert；返回保存后的定义（createdAt / updatedAt 由这里维护）。 */
  async saveDefinition(definition: AutomationDefinition): Promise<AutomationDefinition> {
    await this.ensureLoaded()
    const now = this.clock().toISOString()
    const index = this.definitions.findIndex((item) => item.id === definition.id)
    const stored: AutomationDefinition = { ...structuredClone(definition) }
    if (index === -1) {
      stored.createdAt = now
      stored.updatedAt = now
      this.definitions.push(stored)
    } else {
      const previous = this.definitions[index]
      if (previous !== undefined) stored.createdAt = previous.createdAt
      stored.updatedAt = now
      this.definitions[index] = stored
    }
    this.dirtyDefinitions = true
    this.scheduleWrite()
    return structuredClone(stored)
  }

  /** 删除一份定义；返回是否真的删了（内置 id 由引擎拦截，不经这里）。 */
  async deleteDefinition(id: string): Promise<boolean> {
    await this.ensureLoaded()
    const index = this.definitions.findIndex((item) => item.id === id)
    if (index === -1) return false
    this.definitions.splice(index, 1)
    this.dirtyDefinitions = true
    this.scheduleWrite()
    return true
  }

  // ───────────────────────── 运行历史 ─────────────────────────

  async listRuns(query: AutomationHistoryQuery = {}): Promise<AutomationRun[]> {
    await this.ensureLoaded()
    const filtered = this.runs.filter((run) => {
      if (query.automationId !== undefined && run.automationId !== query.automationId) return false
      if (query.mode !== undefined && run.mode !== query.mode) return false
      if (query.status !== undefined && run.status !== query.status) return false
      return true
    })
    filtered.sort((a, b) => b.triggeredAt.localeCompare(a.triggeredAt))
    const limit = query.limit ?? 50
    return (limit > 0 ? filtered.slice(0, limit) : filtered).map((run) => structuredClone(run))
  }

  async appendRun(run: AutomationRun): Promise<AutomationRun> {
    await this.ensureLoaded()
    const stored = structuredClone(run)
    this.runs.push(stored)
    this.pruneRuns()
    this.dirtyRuns = true
    this.scheduleWrite()
    return structuredClone(stored)
  }

  async updateRun(id: string, patch: AutomationRunPatch): Promise<AutomationRun | undefined> {
    await this.ensureLoaded()
    const index = this.runs.findIndex((run) => run.id === id)
    if (index === -1) return undefined
    const current = this.runs[index]
    if (current === undefined) return undefined
    const next: AutomationRun = { ...structuredClone(current), ...patch }
    if (patch.error === undefined && 'error' in patch) delete next.error
    this.runs[index] = next
    this.dirtyRuns = true
    this.scheduleWrite()
    return structuredClone(next)
  }

  /**
   * 启动补偿（docs/13 §3）：引擎启动时把历史里遗留的 `running` 记录改判 `interrupted`
   * （进程重启后那次运行的监听已不存在，不能永远「进行中」）。返回改判条数。
   */
  async markInterruptedRuns(): Promise<number> {
    await this.ensureLoaded()
    let changed = 0
    for (const run of this.runs) {
      if (run.status !== 'running') continue
      run.status = 'interrupted'
      run.finishedAt = this.clock().toISOString()
      changed += 1
    }
    if (changed > 0) {
      this.dirtyRuns = true
      this.scheduleWrite()
    }
    return changed
  }

  // ───────────────────────── 装载与落盘 ─────────────────────────

  /** 懒加载（in-flight promise 共享）：并发首读共享同一 promise，读盘成功才置 loaded。 */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    if (this.loading !== undefined) return this.loading
    this.loading = (async () => {
      const [definitionFile, historyFile] = await Promise.all([
        this.readFileDefinitions(),
        this.readFileRuns(),
      ])
      this.definitions = definitionFile
      this.runs = historyFile
      this.loaded = true
    })()
    try {
      await this.loading
    } finally {
      this.loading = undefined
    }
  }

  /**
   * 丢弃内存缓存并重新读盘（自测夹具在进程启动后才写文件时用得上）。
   *
   * 存在的理由：`ensureLoaded` 首读即缓存（in-flight promise 语义），而夹具是
   * 主进程启动之后才落盘的 —— 不重读的话「引擎启动时读到空表 → 夹具写了也看不见」。
   * 生产路径不需要它（用户数据在启动前就已存在）。
   */
  async reload(): Promise<void> {
    this.loaded = false
    this.loading = undefined
    this.definitions = []
    this.runs = []
    await this.ensureLoaded()
  }

  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.writing !== undefined) await this.writing
    if (this.dirtyDefinitions) await this.writeFile('automations.json', 'definitions')
    if (this.dirtyRuns) await this.writeFile('history.json', 'runs')
  }

  // ───────────────────────── 内部 ─────────────────────────

  private pruneRuns(): void {
    if (this.runs.length <= AUTOMATION_HISTORY_LIMIT) return
    this.runs.sort((a, b) => a.triggeredAt.localeCompare(b.triggeredAt))
    this.runs = this.runs.slice(this.runs.length - AUTOMATION_HISTORY_LIMIT)
  }

  private scheduleWrite(): void {
    if (this.writeDebounceMs === 0) {
      void this.writeNow()
      return
    }
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.writeNow()
    }, this.writeDebounceMs)
    this.timer.unref?.()
  }

  private async writeNow(): Promise<void> {
    const tail = (previous?: Promise<void>) => {
      const run = (async () => {
        if (this.dirtyDefinitions) await this.writeFile('automations.json', 'definitions')
        if (this.dirtyRuns) await this.writeFile('history.json', 'runs')
      })()
      this.writing =
        previous === undefined
          ? run
          : previous.then(
              () => run,
              () => run,
            )
      return this.writing
    }
    const previous = this.writing
    try {
      await tail(previous)
    } catch (error) {
      this.logger.warn('自动化数据落盘失败', { error: String(error) })
    }
  }

  private async readFileDefinitions(): Promise<AutomationDefinition[]> {
    return (await this.readRawList('automations.json', 'definitions')).filter(isDefinitionLike)
  }

  private async readFileRuns(): Promise<AutomationRun[]> {
    return (await this.readRawList('history.json', 'runs')).filter(isRunLike)
  }

  /** 读一个数据文件的列表字段；文件缺失 / 损坏时备份后返回空数组（不抛）。 */
  private async readRawList(name: string, key: 'definitions' | 'runs'): Promise<unknown[]> {
    const path = join(this.dir, name)
    let raw: string
    try {
      raw = await this.fs.readFile(path)
    } catch {
      return []
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) throw new Error('top-level not object')
      const list = (parsed as Record<string, unknown>)[key]
      if (!Array.isArray(list)) throw new Error(`"${key}" not array`)
      return list
    } catch (error) {
      // 损坏备份后按空表继续（最多 3 份，超出删最旧）
      const backup = `${path}.corrupt-${Date.now()}.json`
      try {
        await this.fs.writeFileAtomic(backup, raw)
        const entries = await this.fs.readdir(this.dir).catch(() => [] as string[])
        const corrupts = entries.filter((entry) => entry.includes('.corrupt-')).sort()
        for (const stale of corrupts.slice(0, Math.max(0, corrupts.length - MAX_CORRUPT_BACKUPS))) {
          await this.fs.remove(join(this.dir, stale))
        }
      } catch {
        // 备份失败也不阻断：数据已丢，重建为空表
      }
      this.logger.warn('自动化数据文件损坏，已备份并重建为空表', {
        file: name,
        error: String(error),
      })
      return []
    }
  }

  private async writeFile(name: string, key: 'definitions' | 'runs'): Promise<void> {
    if (!this.dirEnsured) {
      await this.fs.mkdirp(this.dir).catch(() => {
        // 目录创建失败时下次写入重试
      })
      this.dirEnsured = true
    }
    const payload =
      key === 'definitions'
        ? { version: AUTOMATIONS_FILE_VERSION, definitions: this.definitions }
        : { version: AUTOMATIONS_FILE_VERSION, runs: this.runs }
    await this.fs.writeFileAtomic(join(this.dir, name), JSON.stringify(payload, null, 2))
    if (key === 'definitions') this.dirtyDefinitions = false
    else this.dirtyRuns = false
  }
}

/** 宽容校验：形状不对的条目直接丢弃（不抛、不阻塞其余数据） */
function isDefinitionLike(value: unknown): value is AutomationDefinition {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return (
    typeof item['id'] === 'string' &&
    item['id'] !== '' &&
    typeof item['name'] === 'string' &&
    typeof item['enabled'] === 'boolean' &&
    (item['mode'] === 'agent' || item['mode'] === 'normal') &&
    typeof item['trigger'] === 'object' &&
    item['trigger'] !== null
  )
}

function isRunLike(value: unknown): value is AutomationRun {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return (
    typeof item['id'] === 'string' &&
    item['id'] !== '' &&
    typeof item['automationId'] === 'string' &&
    typeof item['triggeredAt'] === 'string' &&
    (item['mode'] === 'agent' || item['mode'] === 'normal')
  )
}
