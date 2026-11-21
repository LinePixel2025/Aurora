/**
 * 计划 Markdown 文件存储（docs/06 §29）。
 *
 * 每个会话一个目录：`<userData>/plans/<sessionId>/`。
 * - 正文：`<yyyyMMdd-HHmmss>-<safePlanId>.md`（内容就是 submit_plan 提交的 Markdown）；
 * - 索引：`index.json`（标题 / 创建时间 / 状态 / 文件名，新的在前）。
 *
 * 索引损坏 / 缺失时扫描目录重建（状态标 unknown）。写盘一律 tmp + rename 原子写：
 * Windows 上 `fs.rename` 覆盖已存在文件，因此不需要先删目标（先删会让「写一半崩溃」
 * 变成「文件消失」而不是「保留上一版」，与 `plugins/fs-json.ts` 同一口径）。
 *
 * 这是**应用数据**，不进项目工作区；渲染层只能经 `plans:list` / `plans:read`
 * 拿列表与正文，拿不到任意路径。
 */
import { promises as fs } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { Logger } from '@aurora/shared'
import type {
  PlanFileContent,
  PlanFileInfo,
  PlanFileStatus,
  SessionPlanStatus,
} from '@aurora/shared'
import { normalizeSessionId } from '@aurora/agent-core'

/** 索引 / 列表最多保留的条数（旧文件仍留在磁盘，只是不进侧边栏列表） */
export const PLAN_INDEX_LIMIT = 200
/** 单份计划正文读取上限（提交侧已限 32k，这里防手改文件撑爆渲染层） */
export const PLAN_READ_MAX_BYTES = 64 * 1024

interface PlanFileEntry {
  id: string
  file: string
  title: string
  createdAt: string
  status: PlanFileStatus
}

interface PlansIndexFile {
  version: 1
  plans: PlanFileEntry[]
}

export interface PlanFileStoreOptions {
  /** `<userData>/plans` */
  dir: string
  logger?: Logger
  /** 单测注入确定性时间 */
  clock?: () => Date
}

export interface WritePlanFileInput {
  sessionId: string
  planId: string
  markdown: string
  status: SessionPlanStatus
}

export interface PlanFileStore {
  write(input: WritePlanFileInput): Promise<PlanFileInfo>
  setStatus(sessionId: string, planId: string, status: PlanFileStatus): Promise<void>
  list(sessionId: string): Promise<PlanFileInfo[]>
  read(sessionId: string, planId: string): Promise<PlanFileContent>
  remove(sessionId: string, planId: string): Promise<void>
  deleteSession(sessionId: string): Promise<void>
}

export function createPlanFileStore(options: PlanFileStoreOptions): PlanFileStore {
  return new PlanFileStoreImpl(options)
}

class PlanFileStoreImpl implements PlanFileStore {
  private readonly dir: string
  private readonly logger: Logger | undefined
  private readonly clock: () => Date

  constructor(options: PlanFileStoreOptions) {
    this.dir = options.dir
    this.logger = options.logger
    this.clock = options.clock ?? (() => new Date())
  }

  async write(input: WritePlanFileInput): Promise<PlanFileInfo> {
    const sessionDir = this.sessionDir(input.sessionId)
    await fs.mkdir(sessionDir, { recursive: true })
    const safeId = safeSegment(input.planId)
    const stamp = compactTimestamp(this.clock())
    const fileName = `${stamp}-${safeId}.md`
    const filePath = this.ensureWithin(sessionDir, fileName)
    const markdown = input.markdown

    await writeAtomic(filePath, markdown)
    const entry: PlanFileEntry = {
      id: input.planId,
      file: fileName,
      title: titleOf(markdown),
      createdAt: this.clock().toISOString(),
      status: input.status,
    }
    try {
      const entries = await this.readIndex(sessionDir)
      const next = [entry, ...entries.filter((item) => item.id !== entry.id)].slice(
        0,
        PLAN_INDEX_LIMIT,
      )
      await this.writeIndex(sessionDir, next)
    } catch (error) {
      // 索引没写成 = 侧边栏看不到这份计划；把正文也撤掉，避免「磁盘有文件但不可见」
      await fs.rm(filePath, { force: true }).catch(() => undefined)
      throw error
    }
    return toInfo(entry)
  }

  async setStatus(sessionId: string, planId: string, status: PlanFileStatus): Promise<void> {
    const sessionDir = this.sessionDir(sessionId)
    const entries = await this.readIndexForUpdate(sessionDir)
    const index = entries.findIndex((item) => item.id === planId)
    if (index === -1) return
    const current = entries[index]
    if (current === undefined || current.status === status) return
    entries[index] = { ...current, status }
    await this.writeIndex(sessionDir, entries)
  }

  async list(sessionId: string): Promise<PlanFileInfo[]> {
    const sessionDir = this.sessionDir(sessionId)
    const entries = await this.readIndex(sessionDir)
    const checks = await Promise.all(
      entries.map(async (entry) => {
        try {
          await fs.stat(this.ensureWithin(sessionDir, entry.file))
          return toInfo(entry)
        } catch {
          return undefined
        }
      }),
    )
    return checks.filter((item): item is PlanFileInfo => item !== undefined)
  }

  async read(sessionId: string, planId: string): Promise<PlanFileContent> {
    const sessionDir = this.sessionDir(sessionId)
    let entries = await this.readIndex(sessionDir)
    let entry = entries.find((item) => item.id === planId)
    if (entry === undefined) {
      // 索引可能落后于磁盘（手改 / 旧版本）：重建一次再找
      entries = await this.rebuildIndex(sessionDir)
      entry = entries.find((item) => item.id === planId)
    }
    if (entry === undefined) throw new Error('计划不存在或已被删除')
    const filePath = this.ensureWithin(sessionDir, entry.file)
    const stat = await fs.stat(filePath)
    if (stat.size > PLAN_READ_MAX_BYTES) throw new Error('计划文件过大，无法在侧边栏预览')
    const markdown = await fs.readFile(filePath, 'utf8')
    return { ...toInfo(entry), markdown }
  }

  async remove(sessionId: string, planId: string): Promise<void> {
    const sessionDir = this.sessionDir(sessionId)
    const entries = await this.readIndex(sessionDir)
    const entry = entries.find((item) => item.id === planId)
    if (entry !== undefined) {
      await fs.rm(this.ensureWithin(sessionDir, entry.file), { force: true })
    }
    const next = entries.filter((item) => item.id !== planId)
    await this.writeIndex(sessionDir, next)
  }

  async deleteSession(sessionId: string): Promise<void> {
    await fs.rm(this.sessionDir(sessionId), { recursive: true, force: true })
  }

  private sessionDir(sessionId: string): string {
    return resolve(this.dir, normalizeSessionId(sessionId))
  }

  /** 防路径穿越：文件名只允许落在会话目录内 */
  private ensureWithin(sessionDir: string, fileName: string): string {
    const target = resolve(sessionDir, fileName)
    const prefix = sessionDir.endsWith(sep) ? sessionDir : `${sessionDir}${sep}`
    if (!target.startsWith(prefix)) throw new Error('计划文件路径非法')
    return target
  }

  private indexPath(sessionDir: string): string {
    return join(sessionDir, 'index.json')
  }

  private async readIndex(sessionDir: string): Promise<PlanFileEntry[]> {
    try {
      const raw = await fs.readFile(this.indexPath(sessionDir), 'utf8')
      const parsed = JSON.parse(raw) as PlansIndexFile
      if (!Array.isArray(parsed.plans)) throw new Error('索引形状非法')
      return normalizeEntries(parsed.plans)
    } catch (error) {
      // 首次写计划时索引本来就不存在：按空索引处理，不刷 warn
      if (isNotFound(error)) return []
      this.logger?.warn('计划索引不可读，按目录重建', { dir: sessionDir, error: String(error) })
      return this.rebuildIndex(sessionDir)
    }
  }

  /** 更新路径专用：索引缺失 / 损坏时重建，但不把重建结果写回（写回由调用方决定） */
  private async readIndexForUpdate(sessionDir: string): Promise<PlanFileEntry[]> {
    try {
      const raw = await fs.readFile(this.indexPath(sessionDir), 'utf8')
      const parsed = JSON.parse(raw) as PlansIndexFile
      if (!Array.isArray(parsed.plans)) throw new Error('索引形状非法')
      return normalizeEntries(parsed.plans)
    } catch (error) {
      if (isNotFound(error)) return []
      this.logger?.warn('计划索引不可读，按目录重建', { dir: sessionDir, error: String(error) })
      return this.rebuildIndex(sessionDir)
    }
  }

  private async rebuildIndex(sessionDir: string): Promise<PlanFileEntry[]> {
    let names: string[] = []
    try {
      names = (await fs.readdir(sessionDir)).filter((name) => name.endsWith('.md'))
    } catch {
      return []
    }
    const entries: PlanFileEntry[] = []
    for (const file of names.sort((left, right) => (left < right ? 1 : left > right ? -1 : 0))) {
      try {
        const filePath = this.ensureWithin(sessionDir, file)
        const stat = await fs.stat(filePath)
        const head = await readHead(filePath)
        const id = planIdFromFileName(file)
        entries.push({
          id,
          file,
          title: titleOf(head),
          createdAt: stat.mtime.toISOString(),
          status: 'unknown',
        })
      } catch (error) {
        this.logger?.warn('计划文件不可读，已跳过', { dir: sessionDir, file, error: String(error) })
      }
      if (entries.length >= PLAN_INDEX_LIMIT) break
    }
    return entries
  }

  private async writeIndex(sessionDir: string, entries: PlanFileEntry[]): Promise<void> {
    await fs.mkdir(sessionDir, { recursive: true })
    const payload: PlansIndexFile = { version: 1, plans: entries }
    await writeAtomic(this.indexPath(sessionDir), JSON.stringify(payload, null, 2))
  }
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT'
}

function toInfo(entry: PlanFileEntry): PlanFileInfo {
  return { id: entry.id, title: entry.title, createdAt: entry.createdAt, status: entry.status }
}

function normalizeEntries(value: unknown[]): PlanFileEntry[] {
  const entries: PlanFileEntry[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const candidate = item as Record<string, unknown>
    const id = candidate['id']
    const file = candidate['file']
    const title = candidate['title']
    const createdAt = candidate['createdAt']
    const status = candidate['status']
    if (
      typeof id !== 'string' ||
      id === '' ||
      typeof file !== 'string' ||
      file === '' ||
      typeof title !== 'string' ||
      typeof createdAt !== 'string' ||
      !isPlanFileStatus(status)
    ) {
      continue
    }
    entries.push({ id, file, title, createdAt, status })
  }
  return entries.slice(0, PLAN_INDEX_LIMIT)
}

function isPlanFileStatus(value: unknown): value is PlanFileStatus {
  return (
    value === 'pending' ||
    value === 'approved' ||
    value === 'exited' ||
    value === 'superseded' ||
    value === 'unknown'
  )
}

/** 会话目录 / 文件名里只允许白名单字符（planId 来自 toolCallId，仍再洗一遍） */
function safeSegment(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 64)
  return cleaned === '' ? 'plan' : cleaned
}

function compactTimestamp(date: Date): string {
  const iso = date.toISOString()
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`
}

function planIdFromFileName(file: string): string {
  // 文件名 = <yyyyMMdd>-<HHmmss>-<safePlanId>.md；重建索引时把时间前缀整段剥掉。
  const matched = /^\d{8}-\d{6}-(.+)\.md$/.exec(file)
  if (matched !== null) return matched[1] ?? file.replace(/\.md$/, '')
  return file.replace(/\.md$/, '')
}

/** 标题 = 第一个 Markdown 标题；没有标题时取第一行非空文本，仍没有就「实施计划」 */
function titleOf(markdown: string): string {
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const heading = /^#{1,6}\s+(.+)$/.exec(trimmed)
    const text = heading === null ? trimmed : (heading[1] ?? '')
    return text.replace(/\s+/g, ' ').slice(0, 60) || '实施计划'
  }
  return '实施计划'
}

async function readHead(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

/** tmp + rename 原子写（Windows 上 rename 覆盖已存在文件） */
async function writeAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true })
  const temp = `${filePath}.tmp`
  await fs.writeFile(temp, content, 'utf8')
  await fs.rename(temp, filePath)
}
