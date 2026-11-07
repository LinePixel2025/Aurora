/**
 * 智慧提醒（v40，docs/07 §4）：免打扰期收集被抑制的提醒，期结束后总结输出。
 *
 * 分层与 `notifications.ts` 同款：**纯逻辑、不依赖 Electron**。设置、时钟、课程表、
 * 模型总结与最终投递全部由调用方注入，因此整条「抑制 → 入队 → 落盘 → 结算 → 投递」
 * 都能在 Node 里完整单测。
 *
 * 语义边界（docs/07 §4）：
 * - 抑制闸只作用在 `NotificationService.notify()` 的默认路由上（去重之后、通道判定之前）；
 *   显式流光（`notify_banner` / `ctx.banner`）与 `ask_user` 旁路播报不被抑制。
 * - 手动时段（`smartWindow`）与「上课期间不提醒」（`smartDuringClass`，仅 ClassRoom 模式）
 *   是两个独立来源，任一命中即抑制；「上课中」与课前提醒同源，从
 *   `IScheduleProvider.getToday()` 推导，不读 ClassIsland status 快照。
 * - 结算（免打扰期结束且队列非空）：优先让模型总结，失败 / 关闭时回落为逐条纯文本——
 *   **不丢提醒**；投递走默认提醒方式且跳过抑制闸（`notifyDigest`）。
 */
import type { Logger } from '@aurora/shared'
import { isQuietHour } from './proactive.js'
import { currentLesson, type Lesson } from './schedule.js'

/** 一条被抑制的提醒（落盘 `<userData>/smart-reminder-queue.json`，docs/08 §1.2）。 */
export interface SmartReminderEntry {
  /** 抑制时刻（ISO 字符串，本地时钟） */
  at: string
  title: string
  body: string
}

/** 队列文件形状（损坏时按空队列重建，docs/08 §1.2）。 */
export interface SmartReminderQueueFile {
  version: number
  queue: SmartReminderEntry[]
  /** 最近一次结算投递的摘要文本（诊断 / 排障用；用户看的是投递出去的那条） */
  lastDigest?: string
}

/** gate 需要的 `notifications` 子树（与 `NotificationsSettings` 的 smart* 字段同形）。 */
export interface SmartReminderPrefs {
  smartEnabled: boolean
  smartWindow: { start: string; end: string; daily: boolean; armedDate: string } | null
  smartDuringClass: boolean
  smartSummarize: boolean
}

/** gate 判定结果：`deliver` = 照常走通道；`suppress` = 已入队，调用方直接返回未投递。 */
export type SmartGateVerdict = 'deliver' | 'suppress'

export interface SmartReminderDeps {
  logger: Logger
  clock: () => Date
  /** 每次判定现读（live getter：改设置无需重启） */
  settings: () => SmartReminderPrefs
  /** 当前模式 id（上课期间免打扰仅 classroom 生效） */
  mode: () => string
  /** 今日课程；provider 失败按「没在上课」处理，绝不把错误抛出闸门 */
  lessonsToday: (now: Date) => Promise<readonly Lesson[]>
  /** 队列持久化（启动加载 + 每次入队 / 结算后保存；测试注入内存实现） */
  loadQueue: () => Promise<SmartReminderEntry[]>
  saveQueue: (file: SmartReminderQueueFile) => Promise<void>
  /** 清空一次性手动窗口（结算后 / 过期时调用；写设置由装配层实现） */
  clearWindow: () => Promise<void>
  /** 免打扰期总结：返回摘要文本；抛错或返回 null = 回落逐条纯文本 */
  summarize: (entries: readonly SmartReminderEntry[]) => Promise<string | null>
  /** 结算投递（已绕过抑制闸，见 `NotificationService.notifyDigest`） */
  deliverDigest: (text: string, count: number) => void
  /** 结算节拍，默认 30s（与提示条 scheduler 同量级；「上课中」缓存也靠它刷新） */
  intervalMs?: number
  /** 队列上限，默认 50：超出丢最旧（防长时间免打扰把内存与文件撑爆） */
  maxQueue?: number
}

/** 队列文件版本（形状变化时递增；读取对旧版本宽容——只认认识的字段） */
export const SMART_REMINDER_QUEUE_VERSION = 1

/**
 * 汇总请求的分流标记（提示词首行，与 `session-title.ts` 的 `TITLE_PROMPT_MARKER` 同款口径）：
 * 离线桩模型（smoke-llm）据此把汇总请求走专属分流，**不消耗**「第 1 次对话请求发工具调用」
 * 的计数寻址坑位——2026-11-07 实测：不带标记时汇总请求会顶掉冒烟对话链路的第一次请求，
 * 桩按计数把纯文本回给对话，五条断言随机变红。真实模型按正文要求只输出摘要。
 */
export const SMART_DIGEST_PROMPT_MARKER = 'AURORA_SMART_DIGEST'

/** 汇总提示词（纯函数：单测钉住「标记在首行 + 每条提醒都在」）。 */
export function buildDigestPrompt(entries: readonly SmartReminderEntry[]): string {
  const lines = entries
    .map((entry) => `${entry.at.slice(11, 16)} ${entry.title}：${entry.body}`)
    .join('\n')
  return [
    SMART_DIGEST_PROMPT_MARKER,
    '下面是免打扰期间被静默的提醒。请把它们归并总结成一段中文摘要：',
    '同类合并、去掉重复；保留每件事的关键信息（文件名 / 科目 / 时间 / 待办）；',
    '不超过 200 字；只输出摘要正文，不要开场白。',
    '',
    '【被静默的提醒】',
    lines,
  ].join('\n')
}

/** 模型输出清洗：剥掉分流标记（真实模型不该回显它，防御性兜底）。 */
export function stripDigestMarker(raw: string): string {
  return raw.replaceAll(SMART_DIGEST_PROMPT_MARKER, '')
}

/** 本地日期键（YYYY-MM-DD）：一次性窗口的 `armedDate` 与它比较。 */
export function localDateKey(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** 手动窗口此刻是否生效（跨天口径复用 `isQuietHour`；起止相同视为未配置）。 */
export function isSmartWindowActive(now: Date, window: SmartReminderPrefs['smartWindow']): boolean {
  if (window === null) return false
  if (!window.daily && window.armedDate !== localDateKey(now)) return false
  return isQuietHour(now, { start: window.start, end: window.end })
}

export class SmartReminderService {
  private readonly deps: SmartReminderDeps
  private readonly intervalMs: number
  private readonly maxQueue: number
  private queue: SmartReminderEntry[] = []
  private timer: NodeJS.Timeout | undefined
  private started = false
  /** 最近一次评估的抑制状态（边沿检测：true → false 且队列非空 = 结算） */
  private active = false
  /** 「上课中」缓存（gate 是同步的，课程表异步结果由 evaluate 每拍刷新） */
  private inClass = false
  private digestFired = false
  private lastDigest: string | undefined
  private lastDigestAt: string | undefined
  /** 持久化串行链：入队高频，防并发写互相覆盖 */
  private saveChain: Promise<void> = Promise.resolve()

  constructor(deps: SmartReminderDeps) {
    this.deps = deps
    this.intervalMs = deps.intervalMs ?? 30_000
    this.maxQueue = deps.maxQueue ?? 50
  }

  /** 启动定时器；启动即评估一次（刷新「上课中」缓存 + 处理跨重启的遗留队列）。 */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    try {
      this.queue = await this.deps.loadQueue()
    } catch (error) {
      this.queue = []
      this.deps.logger.warn('智慧提醒队列读取失败，按空队列处理', { error: String(error) })
    }
    await this.evaluate()
    // 跨重启的遗留队列：此刻不在免打扰期 = 上一个窗口在停机期间结束（或用户中途关了
    // 总开关）—— 边沿检测赶不上，直接补一次结算，不让攒下的提醒无声消失。
    if (!this.active && this.queue.length > 0) {
      await this.settle()
    }
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = setInterval(() => {
      void this.evaluate().catch((error: unknown) => {
        this.deps.logger.warn('智慧提醒评估失败（下一拍重试）', { error: String(error) })
      })
    }, this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    this.started = false
  }

  /**
   * 同步抑制闸（挂在 `notify()` 去重之后、通道判定之前）。
   * 「上课中」用 evaluate 维护的缓存（最多滞后一个节拍），课程表 provider 的异步
   * 不能把 `notify()` 拖成 async。抑制时入队并异步落盘，绝不抛错。
   */
  gate(request: { title: string; body: string }): SmartGateVerdict {
    let prefs: SmartReminderPrefs
    try {
      prefs = this.deps.settings()
    } catch (error) {
      this.deps.logger.warn('智慧提醒设置读取失败，按不抑制处理', { error: String(error) })
      return 'deliver'
    }
    if (!prefs.smartEnabled) return 'deliver'
    if (!this.isActive(prefs)) return 'deliver'

    this.queue = [
      ...this.queue,
      { at: this.deps.clock().toISOString(), title: request.title, body: request.body },
    ].slice(-this.maxQueue)
    this.persist()
    this.deps.logger.info('提醒处于免打扰期，已入队待汇总', {
      title: request.title,
      queueLength: this.queue.length,
    })
    return 'suppress'
  }

  /**
   * 单次评估：刷新「上课中」缓存 → 更新抑制状态 → 边沿结算。
   * 定时器调用；测试也可以直接调（注入 clock 控制时间）。
   */
  async evaluate(): Promise<void> {
    const prefs = this.deps.settings()
    const now = this.deps.clock()

    // 「上课中」只有开启上课免打扰且在 ClassRoom 模式才需要课程表；
    // provider 失败按没在上课处理（不抑制）
    if (prefs.smartEnabled && prefs.smartDuringClass && this.deps.mode() === 'classroom') {
      try {
        this.inClass = currentLesson(await this.deps.lessonsToday(now), now) !== undefined
      } catch (error) {
        this.inClass = false
        this.deps.logger.debug('课程表读取失败，本拍按「没在上课」处理', { error: String(error) })
      }
    } else {
      this.inClass = false
    }

    const activeNow = prefs.smartEnabled && this.isActive(prefs)
    const wasActive = this.active
    this.active = activeNow

    // 边沿：免打扰期刚结束且队列非空 → 结算。窗口到点 / 被编辑 / 总开关被关都表现为
    // active → false，语义统一为「等待结束，把攒下的提醒交出来」。
    if (wasActive && !activeNow && this.queue.length > 0) {
      await this.settle()
      return
    }

    // 过期的一次性窗口（跨天重启 / 结算前崩溃遗留）：队列空就直接清掉，不留死配置
    if (
      !activeNow &&
      prefs.smartWindow !== null &&
      !prefs.smartWindow.daily &&
      prefs.smartWindow.armedDate !== localDateKey(now) &&
      this.queue.length === 0
    ) {
      try {
        await this.deps.clearWindow()
      } catch (error) {
        this.deps.logger.warn('清理过期一次性免打扰窗口失败', { error: String(error) })
      }
    }
  }

  /** 结算：取走全部队列 → 总结（失败回落纯文本）→ 投递 → 清一次性窗口。 */
  async settle(): Promise<void> {
    const entries = this.queue
    if (entries.length === 0) return
    // 先清队列再投递：投递路径万一重入 gate 也不会把同一条提醒结两次
    this.queue = []
    this.persist()

    const prefs = this.deps.settings()
    let text: string | null = null
    if (prefs.smartSummarize) {
      try {
        text = await this.deps.summarize(entries)
      } catch (error) {
        this.deps.logger.warn('免打扰期总结失败，回落逐条纯文本', { error: String(error) })
      }
    }
    if (text === null || text.trim() === '') {
      text = this.fallbackText(entries)
    }

    this.digestFired = true
    this.lastDigest = text
    this.lastDigestAt = this.deps.clock().toISOString()
    this.persist()
    this.deps.deliverDigest(text, entries.length)
    this.deps.logger.info('免打扰期提醒已汇总投递', { count: entries.length })

    // 一次性窗口用完即清（下一次要重新设置；每天重复的窗口保留）
    const window = prefs.smartWindow
    if (window !== null && !window.daily) {
      try {
        await this.deps.clearWindow()
      } catch (error) {
        this.deps.logger.warn('清空一次性免打扰窗口失败', { error: String(error) })
      }
    }
  }

  /** 供自测与冒烟诊断 */
  diagnostics(): {
    active: boolean
    inClass: boolean
    queueLength: number
    digestFired: boolean
    lastDigestAt: string | undefined
  } {
    return {
      active: this.active,
      inClass: this.inClass,
      queueLength: this.queue.length,
      digestFired: this.digestFired,
      lastDigestAt: this.lastDigestAt,
    }
  }

  private isActive(prefs: SmartReminderPrefs): boolean {
    const now = this.deps.clock()
    if (isSmartWindowActive(now, prefs.smartWindow)) return true
    return prefs.smartDuringClass && this.deps.mode() === 'classroom' && this.inClass
  }

  /** 串行落盘：任一次失败只记日志（启动路径的兜底是按空队列重建 + 结算回落） */
  private persist(): void {
    const file: SmartReminderQueueFile = {
      version: SMART_REMINDER_QUEUE_VERSION,
      queue: [...this.queue],
      ...(this.lastDigest === undefined ? {} : { lastDigest: this.lastDigest }),
    }
    this.saveChain = this.saveChain
      .then(() => this.deps.saveQueue(file))
      .catch((error: unknown) => {
        this.deps.logger.warn('智慧提醒队列写盘失败（内存队列不受影响）', { error: String(error) })
      })
  }

  /** 回落文本：免打扰期内被静默的提醒按「时刻 标题：正文」逐条列出（截断防超长）。 */
  private fallbackText(entries: readonly SmartReminderEntry[]): string {
    const lines = entries.map((entry) => {
      const time = entry.at.slice(11, 16)
      const body = entry.body.trim()
      return body === '' ? `${time} ${entry.title}` : `${time} ${entry.title}：${body}`
    })
    const joined = lines.join('\n')
    if (joined.length <= 600) return `免打扰期间的 ${entries.length} 条提醒：\n${joined}`
    // 超长时退化为只列标题（条数保留——每条都还在，只是不展开正文）
    const titles = entries.map((entry) => entry.title).join('、')
    const clipped = titles.length > 560 ? `${titles.slice(0, 560)}…` : titles
    return `免打扰期间的 ${entries.length} 条提醒：${clipped}`
  }
}
