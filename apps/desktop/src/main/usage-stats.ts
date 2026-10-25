/**
 * 本机用量账本（插件 `ctx.usage.summary` 的数据源，docs/14 §4.1）。
 *
 * 口径：
 * - **只记计数**：Token / 缓存命中 / 生图次数 / 语音次数，绝不落提示词、回复、图片、音频或凭据；
 * - 按**本地日期**分桶（`YYYY-MM-DD`），保留 90 天（与插件可查询窗口上限一致）；
 * - 内存态是唯一读写面：记录后 1s 防抖落盘，退出前由装配层调用 `flush()`；
 * - 账本从引入本模块的版本开始累积：历史会话只有累计值、没有逐日时间戳，因此不回溯。
 *
 * 本文件不 import electron：可以被 vitest 直接加载。
 */
import {
  PLUGIN_USAGE_DAYS,
  type Logger,
  type PluginUsageDay,
  type PluginUsageQuery,
  type PluginUsageSummary,
  type PluginUsageTokenStats,
  type PluginUsageTokenTotals,
  type TokenUsage,
} from '@aurora/shared'
import { readJsonFile, writeJsonAtomic } from './plugins/fs-json.js'

/** 账本文件版本（与 `CONFIG_VERSION` 无关：这是独立的计数文件）。 */
const USAGE_STATS_VERSION = 1
/** 落盘防抖：每轮 LLM 收尾一条，没必要每条都写盘。 */
const FLUSH_DEBOUNCE_MS = 1_000
/** 账本保留天数：与可查询上限一致，超出窗口的旧日桶自动清理。 */
const RETENTION_DAYS = PLUGIN_USAGE_DAYS.max

interface DayRecord {
  tokens: PluginUsageTokenTotals
  /** 其中后台自感知分析消耗的部分（不另计总量，只做拆分） */
  backgroundTokens: PluginUsageTokenTotals
  images: number
  tts: number
  ttsChars: number
  stt: number
  sttChars: number
}

interface UsageStatsFile {
  version: number
  days: Record<string, DayRecord>
}

export interface UsageStatsStoreOptions {
  /** 账本路径（主进程传 `<userData>/usage-stats.json`） */
  file: string
  logger: Logger
  /** 注入时钟便于单测；默认 `() => new Date()` */
  now?: () => Date
  /** 注入便于单测；默认 1s */
  flushDebounceMs?: number
}

export class UsageStatsStore {
  private readonly file: string
  private readonly logger: Logger
  private readonly now: () => Date
  private readonly flushDebounceMs: number
  private readonly days = new Map<string, DayRecord>()
  private flushTimer: NodeJS.Timeout | undefined
  private writeChain: Promise<void> = Promise.resolve()

  constructor(options: UsageStatsStoreOptions) {
    this.file = options.file
    this.logger = options.logger
    this.now = options.now ?? (() => new Date())
    this.flushDebounceMs = options.flushDebounceMs ?? FLUSH_DEBOUNCE_MS
  }

  /** 读盘并归化；损坏 / 缺失一律按空账本（不阻断启动）。 */
  async init(): Promise<void> {
    const raw = await readJsonFile<unknown>(this.file, null)
    const root = asRecord(raw)
    const days = asRecord(root?.['days'])
    if (days !== undefined) {
      for (const [key, value] of Object.entries(days)) {
        if (!isDateKey(key)) continue
        const record = normalizeDay(value)
        if (record !== undefined) this.days.set(key, record)
      }
    }
    this.prune()
  }

  /** 记一轮 LLM 的 Token 用量（主进程在 provider `onUsage` 处调用）。 */
  recordTokens(usage: TokenUsage, options: { background?: boolean } = {}): void {
    const day = this.dayOf(this.now())
    addUsage(day.tokens, usage)
    if (options.background === true) addUsage(day.backgroundTokens, usage)
    this.persistEventually()
  }

  /** 记一次成功的生图。 */
  recordImage(): void {
    this.dayOf(this.now()).images += 1
    this.persistEventually()
  }

  /** 记一次成功的 TTS 合成（`chars` = 实际送出的字符数）。 */
  recordTts(chars: number): void {
    const day = this.dayOf(this.now())
    day.tts += 1
    day.ttsChars += count(chars)
    this.persistEventually()
  }

  /** 记一次成功的 STT 识别（`chars` = 识别结果字符数）。 */
  recordStt(chars: number): void {
    const day = this.dayOf(this.now())
    day.stt += 1
    day.sttChars += count(chars)
    this.persistEventually()
  }

  /** 汇总最近 `query.days` 天（缺省 30，夹取 1–90）。窗口内每一天都返回（含空白日）。 */
  summary(query?: PluginUsageQuery): PluginUsageSummary {
    const days = clampDays(query?.days)
    const now = this.now()
    const end = startOfLocalDay(now)
    const start = addDays(end, -(days - 1))
    const total = emptyTotals()
    const background = emptyTotals()
    const daily: PluginUsageDay[] = []
    let images = 0
    let tts = 0
    let ttsChars = 0
    let stt = 0
    let sttChars = 0

    for (let offset = 0; offset < days; offset += 1) {
      const date = addDays(start, offset)
      const key = dateKey(date)
      const record = this.days.get(key)
      const tokens = record?.tokens ?? emptyTotals()
      const backgroundTokens = record?.backgroundTokens ?? emptyTotals()
      addTotals(total, tokens)
      addTotals(background, backgroundTokens)
      images += record?.images ?? 0
      tts += record?.tts ?? 0
      ttsChars += record?.ttsChars ?? 0
      stt += record?.stt ?? 0
      sttChars += record?.sttChars ?? 0
      daily.push({
        date: key,
        tokens: withRate(tokens),
        images: record?.images ?? 0,
        voice: { tts: record?.tts ?? 0, stt: record?.stt ?? 0 },
      })
    }

    return {
      days,
      from: dateKey(start),
      to: dateKey(end),
      tokens: { ...withRate(total), background },
      images: { generated: images },
      voice: { tts, ttsChars, stt, sttChars },
      daily,
    }
  }

  /** 立即落盘（退出前调用；防抖定时器一并清掉）。 */
  async flush(): Promise<void> {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    await this.write()
  }

  private dayOf(date: Date): DayRecord {
    this.prune(date)
    const key = dateKey(date)
    const existing = this.days.get(key)
    if (existing !== undefined) return existing
    const created = emptyDay()
    this.days.set(key, created)
    return created
  }

  private persistEventually(): void {
    if (this.flushTimer !== undefined) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.write()
    }, this.flushDebounceMs)
    this.flushTimer.unref?.()
  }

  private write(): Promise<void> {
    const payload: UsageStatsFile = {
      version: USAGE_STATS_VERSION,
      days: Object.fromEntries([...this.days.entries()].sort(([a], [b]) => a.localeCompare(b))),
    }
    this.writeChain = this.writeChain
      .then(() => writeJsonAtomic(this.file, payload))
      .catch((error: unknown) => {
        this.logger.warn('用量账本写入失败', { error: String(error) })
      })
    return this.writeChain
  }

  /** 只保留最近 `RETENTION_DAYS` 天的合法日桶。 */
  private prune(date = this.now()): void {
    const cutoff = dateKey(addDays(startOfLocalDay(date), -(RETENTION_DAYS - 1)))
    for (const key of [...this.days.keys()]) {
      if (!isDateKey(key) || key < cutoff) this.days.delete(key)
    }
  }
}

function emptyTotals(): PluginUsageTokenTotals {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    rounds: 0,
  }
}

function emptyDay(): DayRecord {
  return {
    tokens: emptyTotals(),
    backgroundTokens: emptyTotals(),
    images: 0,
    tts: 0,
    ttsChars: 0,
    stt: 0,
    sttChars: 0,
  }
}

function addUsage(target: PluginUsageTokenTotals, usage: TokenUsage): void {
  target.promptTokens += count(usage.promptTokens)
  target.completionTokens += count(usage.completionTokens)
  target.totalTokens += count(usage.totalTokens)
  target.cachedTokens += count(usage.cachedTokens)
  target.rounds += 1
}

function addTotals(target: PluginUsageTokenTotals, source: PluginUsageTokenTotals): void {
  target.promptTokens += count(source.promptTokens)
  target.completionTokens += count(source.completionTokens)
  target.totalTokens += count(source.totalTokens)
  target.cachedTokens += count(source.cachedTokens)
  target.rounds += count(source.rounds)
}

function withRate(totals: PluginUsageTokenTotals): PluginUsageTokenStats {
  return {
    ...totals,
    cacheHitRate:
      totals.promptTokens <= 0
        ? 0
        : Math.round((totals.cachedTokens / totals.promptTokens) * 10_000) / 10_000,
  }
}

function clampDays(value: number | undefined): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : NaN
  if (!Number.isFinite(parsed)) return PLUGIN_USAGE_DAYS.default
  return Math.min(Math.max(parsed, PLUGIN_USAGE_DAYS.min), PLUGIN_USAGE_DAYS.max)
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function normalizeDay(value: unknown): DayRecord | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  return {
    tokens: normalizeTotals(record['tokens']),
    backgroundTokens: normalizeTotals(record['backgroundTokens']),
    images: count(record['images']),
    tts: count(record['tts']),
    ttsChars: count(record['ttsChars']),
    stt: count(record['stt']),
    sttChars: count(record['sttChars']),
  }
}

function normalizeTotals(value: unknown): PluginUsageTokenTotals {
  const record = asRecord(value)
  if (record === undefined) return emptyTotals()
  return {
    promptTokens: count(record['promptTokens']),
    completionTokens: count(record['completionTokens']),
    totalTokens: count(record['totalTokens']),
    cachedTokens: count(record['cachedTokens']),
    rounds: count(record['rounds']),
  }
}

function isDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function addDays(date: Date, delta: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + delta)
  return next
}

function dateKey(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
