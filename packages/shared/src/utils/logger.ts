/** 轻量日志抽象：shared / agent-core / modes 只依赖该接口，具体实现（写文件、脱敏）在主进程。 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(message: string, meta?: unknown): void
  info(message: string, meta?: unknown): void
  warn(message: string, meta?: unknown): void
  error(message: string, meta?: unknown): void
  /** 派生带前缀的子日志器，便于按模块过滤。 */
  child(scope: string): Logger
}

export function createNoopLogger(): Logger {
  const noop = (): void => {}
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  }
  return logger
}

/** 收集日志到内存，供单测断言。 */
export function createMemoryLogger(): Logger & { entries: string[] } {
  const entries: string[] = []
  const push = (level: LogLevel, scope: string) => (message: string, meta?: unknown) => {
    const suffix = meta === undefined ? '' : ` ${safeStringify(meta)}`
    entries.push(`[${level}]${scope ? `[${scope}]` : ''} ${message}${suffix}`)
  }
  const make = (scope: string): Logger & { entries: string[] } => ({
    entries,
    debug: push('debug', scope),
    info: push('info', scope),
    warn: push('warn', scope),
    error: push('error', scope),
    child: (childScope: string) => make(scope ? `${scope}:${childScope}` : childScope),
  })
  return make('')
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
