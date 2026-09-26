/**
 * 文件暂存（docs/12 §2.2 / §5）：客户端经 `center_send_file` 上传的文件落在
 * `<dataDir>/files/`，索引在 `files/index.json`。网页端按 fileId 鉴权下载
 * （属主或管理员）。Center 不做转存清理（v1 非目标，docs/12 §11）。
 */
import { createWriteStream, promises as fs } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { join, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import type { Logger } from '@aurora/shared'
import { JsonStore } from './store.js'

export interface FileRecord {
  fileId: string
  clientId: string
  name: string
  size: number
  note?: string
  at: string
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
    this.index = new JsonStore<FileRecord[]>(
      join(this.dir, 'index.json'),
      () => [],
      options.logger,
    )
    this.logger = options.logger
  }

  async init(): Promise<void> {
    this.records = await this.index.load()
  }

  list(): FileRecord[] {
    return [...this.records]
  }

  get(fileId: string): FileRecord | undefined {
    return this.records.find((record) => record.fileId === fileId)
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
    let oversized = false
    const limiter = new TransformCounter(this.options.maxFileBytes, (count) => {
      size = count
    })
    limiter.onOverflow = () => {
      oversized = true
    }
    try {
      await pipeline(input.content, limiter, createWriteStream(target))
    } catch (error) {
      await fs.rm(target, { force: true })
      throw error
    }
    if (oversized) {
      await fs.rm(target, { force: true })
      throw new FileTooLargeError(
        `文件超过上限（${Math.floor(this.options.maxFileBytes / 1024 / 1024)} MB）`,
      )
    }

    const record: FileRecord = {
      fileId,
      clientId: input.clientId,
      name: base,
      size,
      ...(input.note === undefined || input.note === '' ? {} : { note: input.note }),
      at: new Date().toISOString(),
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

  onOverflow: () => void = () => {}

  override _transform(chunk: Buffer, _enc: BufferEncoding, done: () => void): void {
    if (this.count + chunk.length > this.max) {
      this.onOverflow()
      // 丢弃剩余数据并正常收尾：调用方靠 onOverflow 标记决定删除与报错
      this.count = this.max
      this.onCount(this.count)
      done()
      this.destroy()
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
  const cleaned = raw.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim()
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'file' : cleaned
}
