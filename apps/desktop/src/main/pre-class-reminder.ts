/**
 * 课前提醒（docs/05 §3.4、docs/06 §9）。
 *
 * 每 `intervalMs`（默认 30s）跑一次：按课程表 provider 取当天课程 →
 * `preClassTrigger` 判定是否进入「课前 5 分钟」窗口 → 系统通知 + 自动打开该科目文件夹。
 *
 * **不依赖 Electron**：通知、打开文件夹、科目目录解析全部经 options 注入
 * （`notify` / `openPath` / `resolveSubjectDir`），因此可以在 Node 里单测。
 * 任何一步失败都只记日志、不抛出：课前提醒是增强能力，不能影响主流程（ADR-007）。
 */
import type { Logger } from '@aurora/shared'
import {
  DEFAULT_LOOKAHEAD_MINUTES,
  needsNextDayLessons,
  preClassTrigger,
  type IScheduleProvider,
  type Lesson,
} from './schedule.js'
import { isQuietHour } from './proactive.js'

export interface PreClassReminderOptions {
  /**
   * 课程表 provider（docs/05 §3.4）。
   *
   * **注意**：`resolveScheduleProvider()` 是按值快照的，若在启动时构造一次就固定下来，
   * 用户在设置页改完课程表必须重启才生效。因此优先使用下面的 `getProvider`，
   * 每次检查都重新解析，保证「改完即生效」，也支持 provider 从 manual 切到 classisland。
   */
  provider?: IScheduleProvider
  /** 每次检查时重新解析 provider（优先于 `provider`） */
  getProvider?: () => IScheduleProvider
  /** 开关（设置项 `modes.classroom.preClassReminder`），每次 tick 即时读取 */
  enabled: () => boolean
  /** 勿扰时段（设置项 `advanced.quietHours`）；勿扰内静默跳过，不补发 */
  quietHours: () => { start: string; end: string } | null
  /** 系统通知（第三个参数为点击通知要打开的目录） */
  notify: (title: string, body: string, openPath?: string) => void
  /** 打开科目文件夹（主进程注入 `shell.openPath`） */
  openPath: (target: string) => Promise<void>
  /**
   * 是否自动打开科目文件夹（设置项 `modes.classroom.preClassOpenFolder`），
   * 每次 tick 即时读取；**只门控自动打开**，系统通知照发（点击通知仍可打开目录）。
   * 未注入时保持原行为（始终自动打开）。
   */
  openFolderEnabled?: () => boolean
  /** 科目 → 绝对目录（复用 `paths.resolveSubjectFolder` + 设置里的科目映射） */
  resolveSubjectDir: (subjectName: string) => string
  logger: Logger
  /** 检查间隔，默认 30s */
  intervalMs?: number
  /** 课前进度窗口，默认 5 分钟 */
  lookaheadMinutes?: number
  /**
   * 每次成功触发后的回调（通知 + 打开目录都已完成）。
   *
   * 存在的理由：自测需要在**不真的弹出资源管理器**的前提下断言
   * 「课前提醒真的触发过」，因此留一个可观测的收尾钩子；生产装配可以不传。
   */
  onFired?: (info: { subject: string; minutesUntil: number; targetDir: string }) => void
}

export interface PreClassTriggerResult {
  lesson: Lesson
  minutesUntil: number
}

const DEFAULT_INTERVAL_MS = 30_000

export class PreClassReminder {
  private readonly options: PreClassReminderOptions
  private readonly intervalMs: number
  private readonly lookaheadMinutes: number
  /** 已触发集合：`<weekday>-<startTime>-<subject>`，保证同一节课只提醒一次 */
  private readonly firedKeys = new Set<string>()
  private timer: NodeJS.Timeout | undefined
  private running = false

  constructor(options: PreClassReminderOptions) {
    this.options = options
    this.intervalMs = Math.max(1_000, options.intervalMs ?? DEFAULT_INTERVAL_MS)
    this.lookaheadMinutes = options.lookaheadMinutes ?? DEFAULT_LOOKAHEAD_MINUTES
  }

  /** 启动：立即检查一次（启动补偿）+ 周期检查。重复调用幂等。 */
  start(): void {
    if (this.timer !== undefined) return
    void this.tick().catch((error: unknown) => {
      this.options.logger.warn('课前提醒检查失败', { error: String(error) })
    })
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.options.logger.warn('课前提醒检查失败', { error: String(error) })
      })
    }, this.intervalMs)
    this.timer.unref?.()
    this.options.logger.debug('课前提醒已启动', {
      provider: this.safeProviderId(),
      intervalMs: this.intervalMs,
      lookaheadMinutes: this.lookaheadMinutes,
    })
  }

  /** 日志用：provider id（解析失败时不抛错） */
  private safeProviderId(): string {
    try {
      return this.resolveProvider().id
    } catch {
      return 'unknown'
    }
  }

  stop(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
    this.options.logger.debug('课前提醒已停止')
  }

  /** 跑一次检查并返回本次触发的课程（单测入口）。 */
  async tick(now: Date = new Date()): Promise<PreClassTriggerResult[]> {
    if (this.running) return []
    if (!this.options.enabled()) return []
    if (isQuietHour(now, this.options.quietHours())) {
      this.options.logger.debug('处于勿扰时段，跳过课前提醒')
      return []
    }

    this.pruneFired(now)

    let lessons: readonly Lesson[]
    try {
      lessons = await this.collectLessons(now)
    } catch (error) {
      this.options.logger.warn('读取课程表失败，本轮课前提醒跳过', { error: String(error) })
      return []
    }

    const triggers = preClassTrigger({
      lessons,
      now,
      lookaheadMinutes: this.lookaheadMinutes,
      firedKeys: this.firedKeys,
    })
    if (triggers.length === 0) return []

    this.running = true
    try {
      const results: PreClassTriggerResult[] = []
      for (const trigger of triggers) {
        // 先记录再执行副作用：即使通知/打开失败也不重复提醒（避免每 30s 刷屏）
        this.firedKeys.add(trigger.key)
        const minutesUntil = Math.max(0, Math.round(trigger.minutesUntil))
        const dir = this.resolveDir(trigger.lesson.subject)
        this.notify(trigger.lesson, minutesUntil, dir)
        if (dir !== '' && this.shouldOpenDir()) await this.openDir(dir, trigger.lesson.subject)
        this.reportFired(trigger.lesson.subject, minutesUntil, dir)
        results.push({ lesson: trigger.lesson, minutesUntil: trigger.minutesUntil })
      }
      this.options.logger.info('课前提醒已触发', {
        count: results.length,
        lessons: results.map((item) => `${item.lesson.subject}@${item.lesson.startTime}`),
      })
      return results
    } finally {
      this.running = false
    }
  }

  // ───────────────────────── 内部 ─────────────────────────

  /** 当天课程；临近午夜时补上次日课程，让 23:5x → 次日 00:0x 的课也能提醒（跨天）。 */
  private async collectLessons(now: Date): Promise<Lesson[]> {
    const provider = this.resolveProvider()
    const today = await provider.getToday(now)
    if (!needsNextDayLessons(now, this.lookaheadMinutes)) return today
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000)
    const nextDay = await provider.getToday(tomorrow)
    return [...today, ...nextDay]
  }

  /** 每次检查重新解析 provider，使设置页改动即时生效（docs/05 §3.4）。 */
  private resolveProvider(): IScheduleProvider {
    if (this.options.getProvider) return this.options.getProvider()
    if (this.options.provider) return this.options.provider
    throw new Error('PreClassReminder 需要 provider 或 getProvider')
  }

  private pruneFired(now: Date): void {
    const today = now.getDay()
    const tomorrow = (today + 1) % 7
    for (const key of [...this.firedKeys]) {
      const weekday = Number(key.split('-')[0] ?? '')
      if (weekday !== today && weekday !== tomorrow) this.firedKeys.delete(key)
    }
  }

  private resolveDir(subject: string): string {
    try {
      return this.options.resolveSubjectDir(subject).trim()
    } catch (error) {
      this.options.logger.warn('解析科目目录失败', { subject, error: String(error) })
      return ''
    }
  }

  /** 自动打开科目的开关：`preClassOpenFolder`（缺省注入时视为开）。 */
  private shouldOpenDir(): boolean {
    if (this.options.openFolderEnabled === undefined) return true
    try {
      return this.options.openFolderEnabled()
    } catch (error) {
      this.options.logger.warn('读取打开文件夹开关失败，按打开处理', { error: String(error) })
      return true
    }
  }

  private notify(lesson: Lesson, minutesUntil: number, dir: string): void {
    const body = `${lesson.startTime} 上课，还有 ${minutesUntil} 分钟`
    try {
      this.options.notify(`课前提醒：${lesson.subject}`, body, dir === '' ? undefined : dir)
    } catch (error) {
      this.options.logger.warn('课前提醒通知失败', { error: String(error) })
    }
  }

  private async openDir(dir: string, subject: string): Promise<void> {
    try {
      await this.options.openPath(dir)
      this.options.logger.info('已打开科目文件夹', { subject, dir })
    } catch (error) {
      this.options.logger.warn('打开科目文件夹失败', { subject, dir, error: String(error) })
    }
  }

  /** 触发收尾回调；回调抛错不影响主流程 */
  private reportFired(subject: string, minutesUntil: number, targetDir: string): void {
    try {
      this.options.onFired?.({ subject, minutesUntil, targetDir })
    } catch (error) {
      this.options.logger.warn('课前提醒回调抛错', { error: String(error) })
    }
  }
}
