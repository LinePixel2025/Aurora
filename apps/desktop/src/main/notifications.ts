/**
 * 系统通知（docs/05 §3.3、docs/07 §4）。
 *
 * 行为：
 * - 分类完成 / 课前提醒 → 系统通知；分类通知**点击打开对应文件夹**（docs/05 §3.3）；
 * - 通知能力不可用时降级为日志 + 计数（自测据此断言，避免依赖 Windows 通知中心状态）；
 * - 失败绝不抛错：通知只是锦上添花，不能影响分类与提醒主流程。
 *
 * 通知实现通过 `present` 注入（默认用 Electron `Notification`），因此本模块可单测。
 */
import type { Logger } from '@aurora/shared'

export interface NotificationRequest {
  title: string
  body: string
  /** 点击通知时打开的路径 */
  openPath?: string
  /** 同类通知合并键：相同 key 的在短时间内只弹一次 */
  dedupeKey?: string
}

/** 注入的通知载体：返回是否成功展示 */
export type NotificationPresenter = (request: NotificationRequest) => boolean

export interface NotificationServiceOptions {
  logger: Logger
  /** 默认用 Electron Notification（由主进程注入，保持本模块可测） */
  present?: NotificationPresenter
  /** 点击通知时打开路径（由主进程注入 shell.openPath） */
  openPath?: (target: string) => Promise<void>
  /** 去重窗口，默认 3s：防止同一次操作触发多条通知 */
  dedupeWindowMs?: number
}

export class NotificationService {
  private readonly logger: Logger
  private readonly present: NotificationPresenter
  private readonly openPath: ((target: string) => Promise<void>) | undefined
  private readonly dedupeWindowMs: number
  private readonly recent = new Map<string, number>()
  /** 自测与设置页用的展示计数 */
  private shown = 0

  constructor(options: NotificationServiceOptions) {
    this.logger = options.logger
    this.present = options.present ?? (() => false)
    this.openPath = options.openPath
    this.dedupeWindowMs = options.dedupeWindowMs ?? 3_000
  }

  /** 展示一条通知；被去重或载体不可用时返回 false。 */
  notify(request: NotificationRequest): boolean {
    const key = request.dedupeKey ?? `${request.title}\u0000${request.body}`
    const now = Date.now()
    const last = this.recent.get(key)
    if (last !== undefined && now - last < this.dedupeWindowMs) {
      this.logger.debug('通知已去重', { title: request.title })
      return false
    }
    this.recent.set(key, now)
    this.pruneRecent(now)

    let shown = false
    try {
      shown = this.present(request)
    } catch (error) {
      this.logger.warn('通知展示失败（不影响主流程）', { error: String(error) })
    }

    if (shown) this.shown += 1
    this.logger.info('通知', {
      title: request.title,
      body: request.body,
      openPath: request.openPath ?? '',
      shown,
    })
    return shown
  }

  /** 分类完成通知：点击打开文件所在目录（docs/05 §3.3）。 */
  notifyClassified(input: { fileName: string; subject: string; targetDir: string }): boolean {
    return this.notify({
      title: '分类完成',
      body: `《${input.fileName}》已分类到 ${input.subject}`,
      openPath: input.targetDir,
      dedupeKey: `classify:${input.fileName}`,
    })
  }

  /** 分类失败 / 兜底通知。 */
  notifyFallback(input: { fileName: string; reason: string; targetDir: string }): boolean {
    return this.notify({
      title: '需要你确认分类',
      body: `《${input.fileName}》未能确定科目：${input.reason}`,
      openPath: input.targetDir,
      dedupeKey: `fallback:${input.fileName}`,
    })
  }

  /** 课前提醒通知（docs/05 §3.4）。 */
  notifyPreClass(input: { subject: string; minutesUntil: number; targetDir: string }): boolean {
    return this.notify({
      title: '快要上课了',
      body: `${input.minutesUntil} 分钟后是《${input.subject}》，已为你打开资料文件夹`,
      openPath: input.targetDir,
      dedupeKey: `preclass:${input.subject}:${input.minutesUntil}`,
    })
  }

  /** 供自测断言「确实发出过通知」 */
  get shownCount(): number {
    return this.shown
  }

  /** 点击通知的实际动作：打开路径（失败只记日志）。 */
  async handleClick(openPath: string | undefined): Promise<void> {
    if (openPath === undefined || openPath.trim() === '' || this.openPath === undefined) return
    try {
      await this.openPath(openPath)
    } catch (error) {
      this.logger.warn('打开通知目标失败', { openPath, error: String(error) })
    }
  }

  private pruneRecent(now: number): void {
    if (this.recent.size < 100) return
    for (const [key, at] of this.recent) {
      if (now - at > this.dedupeWindowMs) this.recent.delete(key)
    }
  }
}
