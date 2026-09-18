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
import electronUpdater from 'electron-updater'
import type { Logger } from '@aurora/shared'
import type { UpdaterPort } from './updater.js'

/** 自测用：把更新源指到本地 HTTP 服务（必须是受信任的调试开关，默认不生效） */
export const UPDATE_FEED_ENV = 'AURORA_UPDATE_FEED'

export function createUpdaterPort(logger: Logger): UpdaterPort {
  const { autoUpdater } = electronUpdater

  autoUpdater.autoDownload = false
  // 关掉"退出时静默安装"：用户点了"安装并重启"才换版本，避免意外升级
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.logger = {
    info: (message?: unknown) => logger.info('updater', { message: String(message) }),
    warn: (message?: unknown) => logger.warn('updater', { message: String(message) }),
    error: (message?: unknown) => logger.error('updater', { message: String(message) }),
    debug: (message?: unknown) => logger.debug('updater', { message: String(message) }),
  }

  const overrideFeed = (process.env[UPDATE_FEED_ENV] ?? '').trim()
  if (overrideFeed !== '') {
    logger.warn('更新源被环境变量覆盖（仅用于自测）', { feed: overrideFeed })
    autoUpdater.setFeedURL({ provider: 'generic', url: overrideFeed })
  }

  return {
    isSupported: () => app.isPackaged,
    describeFeed: () =>
      overrideFeed !== ''
        ? overrideFeed
        : app.isPackaged
          ? 'github: LinePixel2025/Aurora-releases'
          : undefined,
    async checkForUpdates() {
      const result = await autoUpdater.checkForUpdates()
      if (result === null || result === undefined) return null
      const version = result.updateInfo?.version ?? ''
      if (version === '') return null
      // electron-updater 在没有可用更新时也会返回当前版本
      return version === app.getVersion() ? null : { version }
    },
    async downloadUpdate() {
      await autoUpdater.downloadUpdate()
    },
    quitAndInstall() {
      // isSilent=false 让安装器显示进度；isForceRunAfter=true 安装后自动启动
      autoUpdater.quitAndInstall(false, true)
    },
    onDownloadProgress(listener) {
      const handler = (progress: {
        percent?: number
        transferred?: number
        total?: number
      }): void => {
        listener({
          percent: progress.percent ?? 0,
          transferred: progress.transferred ?? 0,
          total: progress.total ?? 0,
        })
      }
      autoUpdater.on('download-progress', handler)
      return () => {
        autoUpdater.off('download-progress', handler)
      }
    },
  }
}
