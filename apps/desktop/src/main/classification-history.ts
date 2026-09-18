/**
 * 分类流水存储（docs/05 §3.3、docs/08 §1.2）。
 *
 * 为什么独立文件：分类流水写得很频繁（每个文件一条），放进 `config.json` 会让配置被
 * 反复整体重写，既浪费 I/O 又和设置页的并发更新互相打断。
 *
 * 约定与 `SessionStore` / `SettingsStore` 一致：
 * - 原子写（临时文件 + rename）+ 300ms 写防抖；
 * - 文件损坏 → 备份为 `classification.corrupt-<ts>.json` 并重建为空流水；
 * - 上限 500 条（新的在前），避免文件无限增长。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ClassificationRecord } from '@aurora/shared'

export const CLASSIFICATION_FILE_NAME = 'classification.json'
export const CLASSIFICATION_VERSION = 1
/** 流水上限：超出后丢弃最旧记录 */
export const MAX_RECORDS = 500
const WRITE_DEBOUNCE_MS = 300

interface PersistedShape {
  version: number
  records: ClassificationRecord[]
}

export interface ClassificationHistoryOptions {
  dir: string
  logger?: {
    info(message: string, detail?: Record<string, unknown>): void
    warn(message: string, detail?: Record<string, unknown>): void
    error(message: string, detail?: Record<string, unknown>): void
  }
  debounceMs?: number
  max?: number
}

export class ClassificationHistory {
  private readonly dir: string
  private readonly logger: ClassificationHistoryOptions['logger']
  private readonly debounceMs: number
  private readonly max: number
  private records: ClassificationRecord[] = []
  private timer: NodeJS.Timeout | undefined
  /** 写盘串行链：保证同一时刻只有一次写，且后写的一定是最新快照 */
  private pending: Promise<void> = Promise.resolve()
  private dirty = false

  constructor(options: ClassificationHistoryOptions) {
    this.dir = options.dir
    this.logger = options.logger
    this.debounceMs = options.debounceMs ?? WRITE_DEBOUNCE_MS
    this.max = options.max ?? MAX_RECORDS
  }

  get path(): string {
    return join(this.dir, CLASSIFICATION_FILE_NAME)
  }

  /** 读取流水（新的在前）。文件缺失 / 损坏都不抛错。 */
  async init(): Promise<{ loaded: number; corrupted: boolean }> {
    await fs.mkdir(this.dir, { recursive: true })
    let raw: string
    try {
      raw = await fs.readFile(this.path, 'utf8')
    } catch {
      this.records = []
      return { loaded: 0, corrupted: false }
    }

    try {
      const parsed = JSON.parse(raw) as Partial<PersistedShape>
      const list = Array.isArray(parsed.records) ? parsed.records : []
      this.records = list.filter(isRecord).slice(0, this.max)
      return { loaded: this.records.length, corrupted: false }
    } catch (error) {
      const backup = `${this.path}.corrupt-${Date.now()}`
      await fs.rename(this.path, backup).catch(() => undefined)
      this.logger?.warn('分类流水损坏，已备份并重建', { backup, error: String(error) })
      this.records = []
      return { loaded: 0, corrupted: true }
    }
  }

  /** 全部流水（新的在前）。 */
  list(): ClassificationRecord[] {
    return [...this.records]
  }

  get(id: string): ClassificationRecord | undefined {
    return this.records.find((record) => record.id === id)
  }

  /** 追加一条（自动去重 id）并安排落盘。 */
  append(record: ClassificationRecord): void {
    this.records = [record, ...this.records.filter((item) => item.id !== record.id)].slice(
      0,
      this.max,
    )
    this.scheduleWrite()
  }

  /** 就地更新一条；返回更新后的记录（不存在则返回 undefined）。 */
  update(id: string, patch: Partial<ClassificationRecord>): ClassificationRecord | undefined {
    const index = this.records.findIndex((record) => record.id === id)
    if (index < 0) return undefined
    const next = { ...this.records[index]!, ...patch }
    this.records = [next, ...this.records.filter((_, i) => i !== index)]
    this.scheduleWrite()
    return next
  }

  /** 清空流水（保留规则重建的依据也随之清空）。 */
  clear(): void {
    this.records = []
    this.scheduleWrite()
  }

  /** 用于规则重建：只取用户修正过的记录。 */
  corrected(): ClassificationRecord[] {
    return this.records.filter((record) => record.corrected === true)
  }

  /** 立即落盘并等待完成（退出前调用）。 */
  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    // 串行化：等待在途写，再补写一次未落盘的变更。
    // 不能"看 dirty=false 就返回"：debounceMs=0 时 append 已发起异步写，
    // 直接返回会让调用方以为已落盘，实际最后几条记录丢失。
    await this.pending
    if (this.dirty) await this.write()
    await this.pending
  }

  // ───────────────────────── 内部 ─────────────────────────

  private scheduleWrite(): void {
    this.dirty = true
    if (this.debounceMs === 0) {
      void this.write()
      return
    }
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.write()
    }, this.debounceMs)
    this.timer.unref?.()
  }

  /**
   * 落盘。写入**串行化**（`pending`）：
   * 并发写会共用同一个临时文件路径而互相破坏，且先发起的写完成时会用旧快照
   * 把 `dirty` 清掉，导致更新的变更再也不落盘。
   */
  private async write(): Promise<void> {
    const previous = this.pending
    const run = async (): Promise<void> => {
      await previous.catch(() => undefined)
      if (!this.dirty) return
      // 写入期间若有新的变更，dirty 会被重新置位，本次完成后会再写一次
      this.dirty = false
      const payload: PersistedShape = {
        version: CLASSIFICATION_VERSION,
        records: this.records,
      }
      const temp = `${this.path}.${process.pid}.tmp`
      try {
        await fs.writeFile(temp, JSON.stringify(payload, null, 2), 'utf8')
        await fs.rename(temp, this.path)
      } catch (error) {
        // 失败要恢复 dirty，否则这次变更永久丢失
        this.dirty = true
        this.logger?.error('分类流水写入失败', { error: String(error) })
        await fs.rm(temp, { force: true }).catch(() => undefined)
      }
    }
    const chained = previous.then(run, run)
    this.pending = chained
    await chained
  }
}

function isRecord(value: unknown): value is ClassificationRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['id'] === 'string' &&
    typeof record['path'] === 'string' &&
    typeof record['fileName'] === 'string' &&
    typeof record['subject'] === 'string'
  )
}
