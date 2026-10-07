/**
 * electron-updater 适配层（docs/09 §3）。
 *
 * 把 `autoUpdater` 收敛成 `UpdaterPort`：
 * - 只有**已打包**的应用才可用（electron-updater 依赖打包产物里的 `app-update.yml`）；
 * - 支持 `AURORA_UPDATE_FEED` 覆盖更新源，仅用于本地/发布自测
 *   （见 `scripts/verify-update.mjs` 与 docs/09 §6）；
 * - 下载进度转成百分比后推给 `UpdateService`。
 */
import { app } from 'electron'
import type { AppUpdater } from 'electron-updater'
import type { Logger } from '@aurora/shared'
import { resolveUpdateFeeds, type UpdaterPort } from './updater.js'

/** 自测用：把更新源指到本地 HTTP 服务（必须是受信任的调试开关，默认不生效） */
export const UPDATE_FEED_ENV = 'AURORA_UPDATE_FEED'

export interface UpdaterPortOptions {
  /** 当前 Center 的公开更新源；返回 undefined 时只用包内 GitHub source。 */
  centerFeed?: () => string | undefined
}

export function createUpdaterPort(logger: Logger, options: UpdaterPortOptions = {}): UpdaterPort {
  const overrideFeed = (process.env[UPDATE_FEED_ENV] ?? '').trim()
  /**
   * electron-updater **按需加载**（2026-10-04 性能轮）。
   *
   * 实测静态 `require('electron-updater')` 约 16MB RSS / 190ms；而它只在「已打包 +
   * 20s 后自动检查更新」或用户手动点检查时才用得到。未打包的 dev 进程因此完全不为它付费。
   * 进度监听也先记在本地 Set 里，等模块真正加载时再挂一条原生监听统一转发。
   */
  let autoUpdater: AppUpdater | null = null
  let loading: Promise<AppUpdater> | null = null
  const progressListeners = new Set<
    (progress: { percent: number; transferred: number; total: number }) => void
  >()

  const load = (): Promise<AppUpdater> => {
    if (autoUpdater !== null) return Promise.resolve(autoUpdater)
    loading ??= import('electron-updater').then((mod) => {
      const instance =
        (mod as unknown as { autoUpdater?: AppUpdater }).autoUpdater ??
        (mod as unknown as { default?: { autoUpdater?: AppUpdater } }).default?.autoUpdater
      if (instance === undefined) throw new Error('electron-updater 未导出 autoUpdater')
      instance.autoDownload = false
      // 关掉"退出时静默安装"：用户点了"安装并重启"才换版本，避免意外升级
      instance.autoInstallOnAppQuit = false
      instance.logger = {
        info: (message?: unknown) => logger.info('updater', { message: String(message) }),
        warn: (message?: unknown) => logger.warn('updater', { message: String(message) }),
        error: (message?: unknown) => logger.error('updater', { message: String(message) }),
        debug: (message?: unknown) => logger.debug('updater', { message: String(message) }),
      }
      if (overrideFeed !== '') {
        logger.warn('更新源被环境变量覆盖（仅用于自测）', { feed: overrideFeed })
        instance.setFeedURL({ provider: 'generic', url: overrideFeed })
      }
      instance.on('download-progress', (progress) => {
        for (const listener of progressListeners) {
          listener({
            percent: progress.percent ?? 0,
            transferred: progress.transferred ?? 0,
            total: progress.total ?? 0,
          })
        }
      })
      autoUpdater = instance
      return instance
    })
    return loading
  }

  return {
    isSupported: () => app.isPackaged,
    describeFeed: () =>
      overrideFeed !== ''
        ? overrideFeed
        : options.centerFeed?.() !== undefined
          ? `Center: ${options.centerFeed?.()}（失败时回退 GitHub）`
          : app.isPackaged
            ? 'github: LinePixel2025/Aurora-releases'
            : undefined,
    async checkForUpdates() {
      const updater = await load()
      const center = options.centerFeed?.()
      const feeds = resolveUpdateFeeds(overrideFeed, center)
      let lastError: unknown
      for (const feed of feeds) {
        configureFeed(updater, feed, logger)
        try {
          const result = await updater.checkForUpdates()
          if (result === null || result === undefined) {
            return null
          }
          const version = result.updateInfo?.version ?? ''
          if (version === '') {
            return null
          }
          return version === app.getVersion() ? null : { version }
        } catch (error) {
          lastError = error
          if (feed !== '' && feeds.length > 1) {
            logger.warn('Center 更新源检查失败，回退 GitHub', { feed, error: String(error) })
            continue
          }
          throw error
        }
      }
      throw lastError ?? new Error('没有可用更新源')
    },
    async downloadUpdate() {
      await (await load()).downloadUpdate()
    },
    quitAndInstall() {
      const install = (instance: AppUpdater): void => {
        // isSilent=false 让安装器显示进度；isForceRunAfter=true 安装后自动启动
        instance.quitAndInstall(false, true)
      }
      if (autoUpdater !== null) install(autoUpdater)
      else void load().then(install, () => undefined)
    },
    onDownloadProgress(listener) {
      progressListeners.add(listener)
      return () => progressListeners.delete(listener)
    },
  }
}

function configureFeed(updater: AppUpdater, feed: string, logger: Logger): void {
  if (feed === '') {
    updater.setFeedURL({
      provider: 'github',
      owner: 'LinePixel2025',
      repo: 'Aurora-releases',
    })
    return
  }
  logger.info('使用更新源', { feed })
  updater.setFeedURL({
    provider: 'generic',
    url: feed,
    channel: 'latest',
  })
}
