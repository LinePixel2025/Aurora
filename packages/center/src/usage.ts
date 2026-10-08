/**
 * Center 官方语言模型 token 用量（docs/12 §12.3）。
 *
 * 明细按日 NDJSON 保存，180 天后清理；终身累计另行保存在原子写摘要里。这里只记录
 * 真实 usage 元数据，绝不写提示词、回复或模型产物。
 */
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type {
  CenterTokenUsageDay,
  CenterTokenUsageRecord,
  CenterTokenUsageTotals,
  CenterUsageQuery,
  CenterUsageResponse,
  Logger,
} from '@aurora/shared'
import { JsonStore } from './store.js'

const RETENTION_DAYS = 180
const PRUNE_INTERVAL_MS = 24 * 3600 * 1000

interface UsageSummary {
  version: 1
  lifetime: CenterTokenUsageTotals
  byUser: Record<string, CenterTokenUsageTotals>
  byClient: Record<string, CenterTokenUsageTotals>
  byModel: Record<string, CenterTokenUsageTotals>
}

export interface UsageRecordInput {
  userId: string
  username: string
  clientId: string
  model: string
  promptTokens: number
  completionTokens: number
  cachedTokens?: number
  totalTokens?: number
}

export interface UsageStoreOptions {
  dataDir: string
  logger?: Logger
  now?: () => Date
  retentionDays?: number
}

export class UsageStore {
  private readonly usageDir: string
  private readonly summaryStore: JsonStore<UsageSummary>
  private readonly logger?: Logger
  private readonly now: () => Date
  private readonly retentionDays: number
  private summary: UsageSummary = fallback()
  private writeChain: Promise<void> = Promise.resolve()
  private pruneTimer: NodeJS.Timeout | undefined

  constructor(options: UsageStoreOptions) {
    this.usageDir = join(options.dataDir, 'usage')
    this.summaryStore = new JsonStore<UsageSummary>(
      join(options.dataDir, 'usage-summary.json'),
      fallback,
      options.logger,
    )
    this.logger = options.logger
    this.now = options.now ?? (() => new Date())
    this.retentionDays = options.retentionDays ?? RETENTION_DAYS
  }

  async init(): Promise<void> {
    await fs.mkdir(this.usageDir, { recursive: true })
    this.summary = await this.summaryStore.load()
    await this.prune()
    this.pruneTimer = setInterval(() => void this.prune(), PRUNE_INTERVAL_MS)
    this.pruneTimer.unref?.()
  }

  close(): void {
    if (this.pruneTimer !== undefined) clearInterval(this.pruneTimer)
    this.pruneTimer = undefined
  }

  record(input: UsageRecordInput): Promise<CenterTokenUsageRecord> {
    const at = this.now().toISOString()
    const record: CenterTokenUsageRecord = {
      id: `use-${randomBytes(6).toString('hex')}`,
      at,
      userId: input.userId,
      username: input.username,
      clientId: input.clientId,
      model: input.model,
      promptTokens: nonNegative(input.promptTokens),
      completionTokens: nonNegative(input.completionTokens),
      ...(input.cachedTokens === undefined
        ? {}
        : { cachedTokens: nonNegative(input.cachedTokens) }),
      totalTokens: nonNegative(input.totalTokens ?? input.promptTokens + input.completionTokens),
    }
    const run = this.writeChain.then(async () => {
      await fs.appendFile(
        join(this.usageDir, `${record.at.slice(0, 10)}.ndjson`),
        `${JSON.stringify(record)}\n`,
        'utf8',
      )
      addTotals(this.summary.lifetime, record)
      addTotals(mapOf(this.summary.byUser, record.userId), record)
      addTotals(mapOf(this.summary.byClient, record.clientId), record)
      addTotals(mapOf(this.summary.byModel, record.model), record)
      await this.summaryStore.save(this.summary)
    })
    this.writeChain = run.then(
      () => undefined,
      (error) => {
        this.logger?.warn('写入 token 用量失败', { error: String(error) })
      },
    )
    return run.then(() => record)
  }

  async query(query: CenterUsageQuery = {}): Promise<CenterUsageResponse> {
    const today = this.now().toISOString().slice(0, 10)
    const defaultFrom = new Date(this.now().getTime() - 29 * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10)
    const from = dateOnly(query.from) ?? defaultFrom
    const to = dateOnly(query.to) ?? today
    const boundedFrom = from > to ? to : from
    const records = await this.readRange(boundedFrom, to)
    const filtered = records.filter((record) => {
      if (query.userId !== undefined && record.userId !== query.userId) return false
      if (query.clientId !== undefined && record.clientId !== query.clientId) return false
      if (query.model !== undefined && record.model !== query.model) return false
      return true
    })
    filtered.sort((a, b) => b.at.localeCompare(a.at))
    const dailyMap = new Map<string, CenterTokenUsageDay>()
    for (const record of filtered) {
      const date = record.at.slice(0, 10)
      const day = dailyMap.get(date) ?? {
        date,
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
      }
      day.requests += 1
      day.promptTokens += record.promptTokens
      day.completionTokens += record.completionTokens
      day.cachedTokens += record.cachedTokens ?? 0
      day.totalTokens += record.totalTokens
      dailyMap.set(date, day)
    }
    const totals = totalsOf(filtered)
    const limit = Math.max(1, Math.min(500, query.limit ?? 100))
    const offset = Math.max(0, Math.floor(query.offset ?? 0))
    const lifetime =
      query.userId === undefined
        ? { ...this.summary.lifetime }
        : { ...(this.summary.byUser[query.userId] ?? emptyTotals()) }
    return {
      scope: { allUsers: query.userId === undefined, userId: query.userId ?? '' },
      range: { from: boundedFrom, to },
      totals,
      lifetime,
      daily: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
      recent: filtered.slice(offset, offset + limit),
      recentTotal: filtered.length,
    }
  }

  async prune(): Promise<void> {
    const threshold = new Date(this.now().getTime() - this.retentionDays * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10)
    const entries = await fs.readdir(this.usageDir).catch(() => [])
    await Promise.all(
      entries
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(name) && name.slice(0, 10) < threshold)
        .map((name) => fs.rm(join(this.usageDir, name), { force: true }).catch(() => undefined)),
    )
  }

  private async readRange(from: string, to: string): Promise<CenterTokenUsageRecord[]> {
    const wanted = enumerateDates(from, to)
    const records: CenterTokenUsageRecord[] = []
    for (const date of wanted) {
      const raw = await fs.readFile(join(this.usageDir, `${date}.ndjson`), 'utf8').catch(() => '')
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue
        try {
          records.push(JSON.parse(line) as CenterTokenUsageRecord)
        } catch {
          /* 损坏单行跳过；不因一行坏数据打不开用量页 */
        }
      }
    }
    return records
  }
}

function fallback(): UsageSummary {
  return {
    version: 1,
    lifetime: emptyTotals(),
    byUser: {},
    byClient: {},
    byModel: {},
  }
}

function emptyTotals(): CenterTokenUsageTotals {
  return {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
  }
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

function mapOf(map: Record<string, CenterTokenUsageTotals>, key: string): CenterTokenUsageTotals {
  const existing = map[key]
  if (existing !== undefined) return existing
  const created = emptyTotals()
  map[key] = created
  return created
}

function addTotals(total: CenterTokenUsageTotals, record: CenterTokenUsageRecord): void {
  total.requests += 1
  total.promptTokens += record.promptTokens
  total.completionTokens += record.completionTokens
  total.cachedTokens += record.cachedTokens ?? 0
  total.totalTokens += record.totalTokens
}

function totalsOf(records: CenterTokenUsageRecord[]): CenterTokenUsageTotals {
  const totals = emptyTotals()
  for (const record of records) addTotals(totals, record)
  return totals
}

function dateOnly(value: string | undefined): string | undefined {
  return value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined
}

function enumerateDates(from: string, to: string): string[] {
  const out: string[] = []
  const cursor = new Date(`${from}T00:00:00.000Z`)
  const end = new Date(`${to}T00:00:00.000Z`)
  while (cursor <= end && out.length < 400) {
    out.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return out
}
