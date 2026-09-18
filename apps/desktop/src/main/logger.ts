/**
 * 日志（docs/02 §7）：按天写入 `userData/logs/aurora-YYYY-MM-DD.log`，
 * 保留 7 天，所有输出统一脱敏（docs/06 §10、docs/08 §2）。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { redactKeys, type Logger, type LogLevel } from '@aurora/shared'

export interface FileLoggerOptions {
  dir: string
  level?: LogLevel
  /** 保留天数，默认 7 */
  retentionDays?: number
  /** 同时输出到控制台（dev 默认 true） */
  console?: boolean
  now?: () => Date
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export class FileLogger implements Logger {
  readonly dir: string
  private readonly level: LogLevel
  private readonly retentionDays: number
  private readonly toConsole: boolean
  private readonly now: () => Date
  private readonly scope: string
  private queue: Promise<void> = Promise.resolve()
  private pending: string[] = []
  private flushTimer: NodeJS.Timeout | undefined
  private initialized = false

  constructor(options: FileLoggerOptions, scope = '') {
    this.dir = options.dir
    this.level = options.level ?? 'info'
    this.retentionDays = options.retentionDays ?? 7
    this.toConsole = options.console ?? false
    this.now = options.now ?? (() => new Date())
    this.scope = scope
  }

  child(scope: string): Logger {
    return new FileLogger(
      {
        dir: this.dir,
        level: this.level,
        retentionDays: this.retentionDays,
        console: this.toConsole,
        now: this.now,
      },
      this.scope === '' ? scope : `${this.scope}:${scope}`,
    )
  }

  debug(message: string, meta?: unknown): void {
    this.write('debug', message, meta)
  }

  info(message: string, meta?: unknown): void {
    this.write('info', message, meta)
  }

  warn(message: string, meta?: unknown): void {
    this.write('warn', message, meta)
  }

  error(message: string, meta?: unknown): void {
    this.write('error', message, meta)
  }

  /** 等待日志落盘（退出前调用）。 */
  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    this.enqueue()
    await this.queue
  }

  private write(level: LogLevel, message: string, meta?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return
    const scope = this.scope === '' ? '' : ` [${this.scope}]`
    const detail = meta === undefined ? '' : ` ${safeJson(redactKeys(meta))}`
    const line = `${this.now().toISOString()} ${level.toUpperCase()}${scope} ${message}${detail}`
    if (this.toConsole) {
      const method =
        level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
      method(line)
    }
    this.pending.push(line)
    this.schedule()
  }

  private schedule(): void {
    if (this.flushTimer) return
    const timer = setTimeout(() => {
      this.flushTimer = undefined
      this.enqueue()
    }, 150)
    timer.unref?.()
    this.flushTimer = timer
  }

  private enqueue(): void {
    if (this.pending.length === 0) return
    const lines = this.pending
    this.pending = []
    const file = this.currentFile()
    this.queue = this.queue
      .catch(() => undefined)
      .then(async () => {
        try {
          await fs.mkdir(this.dir, { recursive: true })
          await fs.appendFile(file, `${lines.join('\n')}\n`, 'utf8')
          if (!this.initialized) {
            this.initialized = true
            await this.pruneOldLogs()
          }
        } catch {
          /* 日志失败不能影响主流程 */
        }
      })
  }

  private currentFile(): string {
    return join(this.dir, `aurora-${formatDay(this.now())}.log`)
  }

  private async pruneOldLogs(): Promise<void> {
    try {
      const entries = await fs.readdir(this.dir)
      const logs = entries.filter((name) => /^aurora-\d{4}-\d{2}-\d{2}\.log$/.test(name)).sort()
      while (logs.length > this.retentionDays) {
        const oldest = logs.shift()
        if (oldest) await fs.rm(join(this.dir, oldest), { force: true })
      }
    } catch {
      /* 忽略 */
    }
  }
}

export function formatDay(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
