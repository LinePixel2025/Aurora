/**
 * 提醒编排层（docs/05 §3.3、docs/07 §4）。
 *
 * 一条「提醒」到这里之后按用户设置的**默认提醒方式**（`notifications.channel`，v37）投递：
 * - `system`：系统通知中心（点击可打开文件 / 文件夹）；
 * - `banner`：Aurora 自己的流光提醒（屏幕顶端流光 + 置顶卡片，可朗读 / 提示音）；
 * - `both`：两条都发；
 * - `off`：不打扰，只写日志。
 *
 * 行为：
 * - 分类完成 / 课前提醒 → 通知（系统通道下点击打开对应文件夹，docs/05 §3.3）；
 * - 通道不可用时降级为日志 + 计数（自测据此断言，避免依赖 Windows 通知中心状态）；
 * - 失败绝不抛错：提醒只是锦上添花，不能影响分类与提醒主流程。
 *
 * 两个通道都以**注入**形式接进来（`present` / `banner`），因此本模块可单测；
 * 它自己不认识窗口、不 import electron。
 */
import type { Logger, ReminderChannel } from '@aurora/shared'

export interface NotificationRequest {
  title: string
  body: string
  /** 点击通知时打开的路径（只有系统通知通道支持；流光提醒没有可操作入口） */
  openPath?: string
  /** 同类通知合并键：相同 key 的在短时间内只弹一次 */
  dedupeKey?: string
}

/** 注入的系统通知载体：返回是否成功展示 */
export type NotificationPresenter = (request: NotificationRequest) => boolean

/**
 * 注入的流光提醒载体（`BannerService.show` 的适配）：返回是否显示成功。
 *
 * 只传标题 / 正文 / dedupeKey —— 语义档位与是否朗读交给提醒通道自己决定，
 * 编排层不替流光挑视觉参数（两处各调一套就是「系统通知好看、流光难看」的来源）。
 */
export type NotificationBanner = (request: {
  title: string
  body: string
  dedupeKey?: string
}) => boolean

export interface NotificationServiceOptions {
  logger: Logger
  /** 默认用 Electron Notification（由主进程注入，保持本模块可测） */
  present?: NotificationPresenter
  /** 默认提醒方式读取器（live getter：设置页改完下一条立即按新方式投递） */
  channel?: () => ReminderChannel
  /** 流光提醒载体；未注入时 `banner` / `both` 通道降级为「只发系统通知」 */
  banner?: NotificationBanner
  /** 点击通知时打开路径（由主进程注入 shell.openPath） */
  openPath?: (target: string) => Promise<void>
  /** 去重窗口，默认 3s：防止同一次操作触发多条通知 */
  dedupeWindowMs?: number
}

export class NotificationService {
  private readonly logger: Logger
  private readonly present: NotificationPresenter
  private readonly channel: () => ReminderChannel
  private readonly banner: NotificationBanner | undefined
  private readonly openPath: ((target: string) => Promise<void>) | undefined
  private readonly dedupeWindowMs: number
  private readonly recent = new Map<string, number>()
  /** 自测与设置页用的**投递成功**计数（任一通道成功即 +1） */
  private shown = 0
  /** 只走流光通道的条数（自测用：证明默认提醒方式真的生效了） */
  private shownByBanner = 0

  constructor(options: NotificationServiceOptions) {
    this.logger = options.logger
    this.present = options.present ?? (() => false)
    this.channel = options.channel ?? (() => 'system')
    this.banner = options.banner
    this.openPath = options.openPath
    this.dedupeWindowMs = options.dedupeWindowMs ?? 3_000
  }

  /**
   * 按当前默认提醒方式投递一条提醒；被去重 / 全部载体不可用 / 设为不打扰时返回 false。
   *
   * 去重键在任何通道之前判定：同一条提醒在 `both` 下也只算一次，不会出现
   * 「系统通知被合并、流光却弹了两次」这种两套节奏。
   */
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

    let channel: ReminderChannel = 'system'
    try {
      channel = this.channel()
    } catch (error) {
      // 设置读取失败按系统通知处理：宁可多弹一条，也不要静默吞掉提醒
      this.logger.warn('读取默认提醒方式失败，按系统通知处理', { error: String(error) })
    }
    if (channel === 'off') {
      this.logger.info('提醒已按「不打扰」记录（未投递）', {
        title: request.title,
        body: request.body,
      })
      return false
    }

    const wantsBanner = (channel === 'banner' || channel === 'both') && this.banner !== undefined
    // 流光载体没注入（单测 / 别处装配）时 `banner` / `both` 回落到系统通知：不静默丢提醒
    const bannerFallback = (channel === 'banner' || channel === 'both') && this.banner === undefined
    if (bannerFallback) {
      this.logger.debug('流光提醒载体不可用，回落到系统通知', { title: request.title })
    }
    const wantsSystem = channel === 'system' || channel === 'both' || bannerFallback

    let systemShown = false
    if (wantsSystem) {
      try {
        systemShown = this.present(request)
      } catch (error) {
        this.logger.warn('通知展示失败（不影响主流程）', { error: String(error) })
      }
    }

    let bannerShown = false
    if (wantsBanner) {
      try {
        bannerShown =
          this.banner?.({
            title: request.title,
            body: request.body,
            ...(request.dedupeKey === undefined ? {} : { dedupeKey: request.dedupeKey }),
          }) ?? false
      } catch (error) {
        this.logger.warn('流光提醒展示失败（不影响主流程）', { error: String(error) })
      }
    }

    const shown = systemShown || bannerShown
    if (shown) this.shown += 1
    if (bannerShown && !systemShown) this.shownByBanner += 1
    this.logger.info('通知', {
      title: request.title,
      body: request.body,
      openPath: request.openPath ?? '',
      channel,
      systemShown,
      bannerShown,
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

  /** 供自测断言「默认提醒方式 = 流光提醒 / 两者」时确实走了流光通道 */
  get shownByBannerCount(): number {
    return this.shownByBanner
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
