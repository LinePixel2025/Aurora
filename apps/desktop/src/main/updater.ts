/**
 * 自动更新（docs/04 §P6、docs/09）。
 *
 * 设计：把 electron-updater 收敛到一个**可注入的端口**后面，
 * `UpdateService` 只做状态机与错误降级，因此可以在 Node 里完整单测
 * （真实 autoUpdater 依赖已打包环境，无法在单测里驱动）。
 *
 * 更新源：公开的 releases-only 仓库（源码仓库保持私有），
 * 客户端不需要携带任何 GitHub 凭证。
 */
import type { Logger, UpdateState, UpdateStatus } from '@aurora/shared'
import { createNoopLogger } from '@aurora/shared'

/** 与 electron-updater 的行为面解耦后的最小端口 */
export interface UpdaterPort {
  /**
   * 检查更新。返回可用版本号；返回 null 表示已是最新。
   * 失败必须抛出（含网络错误 / 清单缺失）。
   */
  checkForUpdates(): Promise<{ version: string } | null>
  /** 下载已发现的更新（不安装） */
  downloadUpdate(): Promise<void>
  /** 退出并安装 */
  quitAndInstall(): void
  /** 当前是否可自动更新（未打包 / 平台不支持时为 false） */
  isSupported(): boolean
  /** 更新源描述，用于设置页展示 */
  describeFeed(): string | undefined
  onDownloadProgress(
    listener: (progress: { percent: number; transferred: number; total: number }) => void,
  ): () => void
}

export const AUTO_CHECK_DELAY_MS = 20_000

/** 更新源顺序：调试覆盖 > Center > GitHub。空串表示使用包内 GitHub source。 */
export function resolveUpdateFeeds(overrideFeed: string, centerFeed: string | undefined): string[] {
  if (overrideFeed.trim() !== '') return [overrideFeed.trim()]
  if (centerFeed === undefined || centerFeed.trim() === '') return ['']
  return [centerFeed.trim(), '']
}

export interface UpdateServiceOptions {
  port: UpdaterPort
  /** 当前运行版本（app.getVersion()） */
  currentVersion: string
  logger?: Logger
  /** 启动后延迟多久自动检查一次；<= 0 表示不自动检查 */
  autoCheckDelayMs?: number
  /** 定时器注入（测试用） */
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
}

export class UpdateService {
  private readonly port: UpdaterPort
  private readonly logger: Logger
  private readonly autoCheckDelayMs: number
  private readonly setTimeoutImpl: typeof setTimeout
  private readonly clearTimeoutImpl: typeof clearTimeout
  private readonly listeners = new Set<(state: UpdateState) => void>()
  private readonly detachProgress: () => void
  private state: UpdateState
  private timer: ReturnType<typeof setTimeout> | undefined
  private busy = false

  constructor(options: UpdateServiceOptions) {
    this.port = options.port
    this.logger = options.logger ?? createNoopLogger()
    this.autoCheckDelayMs = options.autoCheckDelayMs ?? AUTO_CHECK_DELAY_MS
    this.setTimeoutImpl = options.setTimeoutImpl ?? setTimeout
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout

    const enabled = this.port.isSupported()
    this.state = {
      status: enabled ? 'idle' : 'disabled',
      currentVersion: options.currentVersion,
      enabled,
      ...(this.port.describeFeed() === undefined ? {} : { feed: this.port.describeFeed() }),
    }

    this.detachProgress = this.port.onDownloadProgress((progress) => {
      if (this.state.status !== 'downloading') return
      this.patch({
        progressPercent: clampPercent(progress.percent),
        transferred: progress.transferred,
        total: progress.total,
      })
    })
  }

  getState(): UpdateState {
    const feed = this.port.describeFeed()
    return {
      ...this.state,
      ...(feed === undefined ? {} : { feed }),
    }
  }

  onStateChanged(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 启动后延迟自动检查（不阻塞启动；已是最新则静默） */
  scheduleAutoCheck(): void {
    if (!this.state.enabled || this.autoCheckDelayMs <= 0) return
    this.timer = this.setTimeoutImpl(() => {
      this.timer = undefined
      void this.check({ silent: true })
    }, this.autoCheckDelayMs)
    this.timer.unref?.()
  }

  dispose(): void {
    if (this.timer !== undefined) this.clearTimeoutImpl(this.timer)
    this.timer = undefined
    this.detachProgress()
    this.listeners.clear()
  }

  async check(options: { silent?: boolean } = {}): Promise<UpdateState> {
    if (!this.state.enabled) return this.getState()
    if (this.busy) return this.getState()

    this.busy = true
    this.patch({ status: 'checking', error: undefined })
    try {
      const result = await this.port.checkForUpdates()
      if (result === null) {
        this.patch({
          status: 'up-to-date',
          availableVersion: undefined,
          progressPercent: undefined,
          checkedAt: new Date().toISOString(),
        })
        this.logger.info('已是最新版本', { version: this.state.currentVersion })
      } else {
        this.patch({
          status: 'available',
          availableVersion: result.version,
          progressPercent: undefined,
          checkedAt: new Date().toISOString(),
        })
        this.logger.info('发现新版本', { current: this.state.currentVersion, next: result.version })
      }
    } catch (error) {
      this.fail(error, options.silent === true)
    } finally {
      this.busy = false
    }
    return this.getState()
  }

  async download(): Promise<UpdateState> {
    if (!this.state.enabled) return this.getState()
    if (this.state.status !== 'available' && this.state.status !== 'error') return this.getState()
    if (this.state.availableVersion === undefined) return this.getState()
    if (this.busy) return this.getState()

    this.busy = true
    this.patch({ status: 'downloading', progressPercent: 0, error: undefined })
    try {
      await this.port.downloadUpdate()
      this.patch({ status: 'downloaded', progressPercent: 100 })
      this.logger.info('更新已下载', { version: this.state.availableVersion })
    } catch (error) {
      this.fail(error)
    } finally {
      this.busy = false
    }
    return this.getState()
  }

  /** 退出并安装；调用后进程由 electron-updater 结束。 */
  install(): boolean {
    if (this.state.status !== 'downloaded') return false
    this.logger.info('安装更新并重启', { version: this.state.availableVersion })
    this.port.quitAndInstall()
    return true
  }

  private fail(error: unknown, silent = false): void {
    const message = describeUpdateError(error)
    this.patch({ status: 'error', error: message })
    const log = silent ? this.logger.warn : this.logger.error
    log.call(this.logger, '更新失败', { error: message })
  }

  private patch(next: Partial<UpdateState>): void {
    const sanitized: Partial<UpdateState> = { ...next }
    if ('error' in sanitized && sanitized.error === undefined) delete sanitized.error
    this.state = { ...this.state, ...sanitized }
    const snapshot = this.getState()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        this.logger.warn('更新状态监听器抛错', { error: String(error) })
      }
    }
  }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

/** 把 electron-updater 的错误转成用户能理解的一句话 */
export function describeUpdateError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ENETUNREACH/i.test(raw)) {
    return '检查更新失败：网络不可达，请检查网络或代理后重试'
  }
  if (/404|Cannot find|no such file|latest\.yml/i.test(raw)) {
    return '检查更新失败：更新源上还没有可用的发行版（latest.yml 缺失）'
  }
  if (/sha512|checksum/i.test(raw)) {
    return '更新包校验失败：下载内容与清单不一致，请重试或手动下载安装包'
  }
  return `检查更新失败：${raw}`
}

export type { UpdateStatus }
