/**
 * 文件暂存（docs/12 §2.2 / §5）：客户端经 `center_send_file` 上传的文件落在
 * `<dataDir>/files/`，索引在 `files/index.json`。网页端按 fileId 鉴权下载 / 删除
 * （属主或管理员）。文件 24 小时过期：服务器启动清一次 + 每 15 分钟清一次，
 * 过期即删物理文件与索引条目。
 */
import { createWriteStream, promises as fs } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { join, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import type { Logger } from '@aurora/shared'
import { JsonStore } from './store.js'

/** 文件暂存有效期：24 小时（索引条目的 expiresAt 与清理都用它） */
export const FILE_TTL_MS = 24 * 3600 * 1000
/** 过期清理周期：15 分钟 */
export const FILE_PRUNE_INTERVAL_MS = 15 * 60 * 1000

export interface FileRecord {
  fileId: string
  clientId: string
  name: string
  size: number
  note?: string
  at: string
  /** 过期时间点（= at + 24h）；旧索引缺失时按 at 兜底补算 */
  expiresAt: string
}

export interface FileStoreOptions {
  dataDir: string
  /** 单文件上限（字节）；超出拒绝且不留半截文件 */
  maxFileBytes: number
  logger?: Logger
}

export class FileTooLargeError extends Error {}

export class FileStore {
  private readonly dir: string
  private readonly index: JsonStore<FileRecord[]>
  private records: FileRecord[] = []
  private readonly logger?: Logger

  constructor(private readonly options: FileStoreOptions) {
    this.dir = join(options.dataDir, 'files')
    this.index = new JsonStore<FileRecord[]>(join(this.dir, 'index.json'), () => [], options.logger)
    this.logger = options.logger
  }

  async init(): Promise<void> {
    this.records = await this.index.load()
    // 旧索引（v0.2.x 之前）没有 expiresAt：按 uploadedAt + 24h 兜底补算并落盘
    let backfilled = false
    for (const record of this.records) {
      if (record.expiresAt === undefined) {
        record.expiresAt = new Date(new Date(record.at).getTime() + FILE_TTL_MS).toISOString()
        backfilled = true
      }
    }
    if (backfilled) await this.index.save(this.records)
  }

  list(): FileRecord[] {
    return [...this.records]
  }

  get(fileId: string): FileRecord | undefined {
    return this.records.find((record) => record.fileId === fileId)
  }

  /**
   * 删除一次上传（物理文件 + 索引条目）；返回是否真的删了（404 场景 false）。
   * 物理文件不存在也照常清索引（磁盘被手工清理过不该留下僵尸条目）。
   */
  async remove(fileId: string): Promise<boolean> {
    const record = this.get(fileId)
    if (record === undefined) return false
    this.records = this.records.filter((entry) => entry.fileId !== fileId)
    await this.index.save(this.records)
    const path = this.pathOf(fileId) ?? join(this.dir, `${fileId}-${record.name}`)
    await fs.rm(path, { force: true })
    this.logger?.info('已删除暂存文件', { fileId, clientId: record.clientId, name: record.name })
    return true
  }

  /** 清理全部过期文件（删物理文件 + 索引条目），返回删除的条数。 */
  async pruneExpired(nowMs?: number): Promise<number> {
    const now = nowMs ?? Date.now()
    const expired = this.records.filter((record) => new Date(record.expiresAt).getTime() <= now)
    if (expired.length === 0) return 0
    const expiredIds = new Set(expired.map((record) => record.fileId))
    this.records = this.records.filter((record) => !expiredIds.has(record.fileId))
    await this.index.save(this.records)
    for (const record of expired) {
      const path = this.pathOf(record.fileId) ?? join(this.dir, `${record.fileId}-${record.name}`)
      await fs.rm(path, { force: true })
    }
    this.logger?.info('已清理过期暂存文件', { count: expired.length })
    return expired.length
  }

  pathOf(fileId: string): string | undefined {
    const record = this.get(fileId)
    if (record === undefined) return undefined
    const path = join(this.dir, `${fileId}-${record.name}`)
    // 文件名里可能带路径分隔符（恶意 X-File-Name）——join 后必须仍在暂存目录之内
    const normalized = resolve(path)
    if (!normalized.startsWith(resolve(this.dir) + sep)) return undefined
    return normalized
  }

  /**
   * 保存一次上传（流式写盘，避免大文件撑爆内存）。
   * `name` 只取 basename；非法字符替换为 `_`。
   */
  async save(input: {
    clientId: string
    name: string
    note?: string
    content: Readable
  }): Promise<FileRecord> {
    const base = basenameSafe(input.name)
    const fileId = `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const target = join(this.dir, `${fileId}-${base}`)
    await fs.mkdir(this.dir, { recursive: true })

    let size = 0
    // 超限时 limiter 以 FileTooLargeError 结束 pipeline（见 TransformCounter）：
    // done(error) 走的是标准错误通道，"先 done 再 destroy" 会变成 Premature close
    // 把真实错误盖掉。半截文件在 catch 里删除。
    const limiter = new TransformCounter(this.options.maxFileBytes, (count) => {
      size = count
    })
    try {
      await pipeline(input.content, limiter, createWriteStream(target))
    } catch (error) {
      await fs.rm(target, { force: true })
      throw error
    }

    const at = new Date().toISOString()
    const record: FileRecord = {
      fileId,
      clientId: input.clientId,
      name: base,
      size,
      ...(input.note === undefined || input.note === '' ? {} : { note: input.note }),
      at,
      expiresAt: new Date(new Date(at).getTime() + FILE_TTL_MS).toISOString(),
    }
    this.records.push(record)
    await this.index.save(this.records)
    this.logger?.info('收到客户端文件', {
      clientId: input.clientId,
      name: record.name,
      size: record.size,
    })
    return record
  }
}

import { Transform } from 'node:stream'

/** 统计流经字节数、超限时截断的 Transform（截断后由调用方删除半截文件） */
class TransformCounter extends Transform {
  private count = 0

  constructor(
    private readonly max: number,
    private readonly onCount: (count: number) => void,
  ) {
    super()
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, done: (error?: Error) => void): void {
    if (this.count + chunk.length > this.max) {
      done(new FileTooLargeError(`文件超过上限（${Math.floor(this.max / 1024 / 1024)} MB）`))
      return
    }
    this.count += chunk.length
    this.onCount(this.count)
    this.push(chunk)
    done()
  }
}

function basenameSafe(name: string): string {
  const raw = name.replaceAll('\\', '/').split('/').pop() ?? 'file'
  // 文件名里的控制字符替换成下划线（no-control-regex 豁免：这是刻意的安全清洗）
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim()
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'file' : cleaned
}
