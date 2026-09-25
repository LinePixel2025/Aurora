/**
 * ClassIsland 联动（docs/05 §3.4 v2）。
 *
 * 背景：ClassIsland 的扩展体系是 .NET（`PluginBase` + `manifest.yml`），跨进程能力走
 * `dotnetCampus.Ipc` **命名管道**，`classisland://` URI 只做应用内导航、不传数据，
 * 官方并未提供 HTTP API。Aurora 是 Node/Electron，无法直连它的 IPC，因此这里
 * **只认一份稳定的本地 JSON 契约**，暴露方式交给随仓库附带的桥接插件
 * （`integrations/classisland-bridge`）二选一：
 *
 * - `file`：桥接插件把课表原子写成一个 JSON 文件，Aurora 定时读取；
 * - `http`：桥接插件在本机回环端口监听，Aurora 请求该端点。
 *
 * 契约（`ClassIslandPayload`）：
 * ```json
 * { "version": 1, "generatedAt": "2026-09-19T07:30:00Z",
 *   "lessons": [{ "weekday": 1, "startTime": "08:00", "endTime": "08:45", "subject": "数学" }],
 *   "status": { "version": 2, "onClass": true, "currentSubject": "数学",
 *               "nextSubject": "物理", "nextStartTime": "09:55" } }
 * ```
 * `weekday` 沿用 `Lesson` 语义（0=周日 … 6=周六），**一次给全周**，
 * 由 `getToday` 按当天过滤 —— 与 `IScheduleProvider` 的既有契约天然对齐，
 * 因此感知摘要、课前提醒、`timetable` Skill 三条消费链无需任何改动。
 * 可选的 `status` 快照（v2）宽容解析：缺省 undefined，经 `getStatus()` 随
 * `classisland:status` IPC 透出。
 *
 * 工程约定（ADR-007）：桥接数据缺失 / 格式非法 / 超时一律**降级为空课表并记日志**，
 * 绝不抛出到调用方 —— 课前提醒是增强能力，不能影响主流程。
 * 本文件不依赖 Electron，系统能力（fetch / 读文件）全部可注入，故可在 Node 里单测。
 */
import type { Logger } from '@aurora/shared'
import type { IScheduleProvider, Lesson } from './schedule.js'

/** 桥接 JSON 的一条课程（与 `Lesson` 形状一致，独立声明以便逐行做宽松校验） */
export interface ClassIslandPayloadLesson {
  weekday: number
  startTime: string
  endTime: string
  subject: string
}

/**
 * 桥接的当前课状态快照（v2，Design/betav2-spec.md §8.8 / §10）。
 *
 * 由 ClassIsland 桥接插件产出：`onClass` / `currentSubject` 来自它的实时课程状态，
 * `nextSubject` / `nextStartTime` 与课表同源。所有字段**宽容解析**——
 * 缺失 / 类型不对一律按 undefined 处理，绝不让一个坏字段废掉整份课表（ADR-007）。
 */
export interface ClassIslandBridgeStatus {
  version?: number
  generatedAt?: string
  onClass?: boolean
  currentSubject?: string
  nextSubject?: string
  nextStartTime?: string
}

export interface ClassIslandPayload {
  version?: number
  generatedAt?: string
  lessons: ClassIslandPayloadLesson[]
  /** 当前课状态（v2 桥接可选携带；缺省 undefined = 桥接端未提供） */
  status?: ClassIslandBridgeStatus
}

export interface ClassIslandParseResult {
  lessons: Lesson[]
  /** 逐行校验失败的原因（带行号），供设置页「测试连接」展示 */
  warnings: string[]
  /** 桥接附带的当前课状态（payload 未携带 / 字段坏掉时为 undefined，宽容处理） */
  status?: ClassIslandBridgeStatus
}

/** 单个源读取超时下限 / 上限（Schema 已约束，这里再兜一层防注入非法值） */
const MIN_TIMEOUT_MS = 200
const MAX_TIMEOUT_MS = 30_000

/**
 * 宽松解析桥接 payload。
 *
 * 宽容点（避免桥接插件一个字段变动就让整份课表作废）：
 * - 顶层允许是 `{ lessons: [...] }`，也允许直接是数组；
 * - `weekday` 允许数字字符串，`7`（周日）折成 `0`；
 * - 时间允许 `8:05` 这类未补零写法（输出统一补零）；
 * - 行内多余字段忽略。
 *
 * 严格点：`weekday` 必须在 0–7、`subject` 非空字符串、`startTime`/`endTime` 必须是
 * 合法时刻，否则该行进 `warnings` 并跳过 —— 宁可少一节课，
 * 也不要让课前提醒在错误的时间指向错误的科目。
 */
export function parseClassislandPayload(raw: unknown): ClassIslandParseResult {
  const warnings: string[] = []

  const list = extractLessonArray(raw)
  if (list === undefined) {
    return { lessons: [], warnings: ['桥接数据格式非法：缺少 lessons 数组'] }
  }

  const lessons: Lesson[] = []
  list.forEach((item, index) => {
    const parsed = parseLesson(item)
    if (typeof parsed === 'string') {
      warnings.push(`第 ${index + 1} 条课程已跳过：${parsed}`)
      return
    }
    lessons.push(parsed)
  })

  return { lessons: sortLessons(lessons), warnings, status: parseBridgeStatus(raw) }
}

function extractLessonArray(raw: unknown): unknown[] | undefined {
  if (Array.isArray(raw)) return raw
  if (typeof raw !== 'object' || raw === null) return undefined
  const lessons = (raw as { lessons?: unknown }).lessons
  return Array.isArray(lessons) ? lessons : undefined
}

/**
 * 宽容解析 payload 里的可选 `status` 快照：对象缺失 → undefined；
 * 逐字段校验类型（`onClass` 布尔、时间 / 科目字符串、`version` 数字），
 * 坏字段按缺失处理并丢弃，**不产生 warnings**（缺状态是常态，不是数据错误）。
 */
function parseBridgeStatus(raw: unknown): ClassIslandBridgeStatus | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const source = (raw as { status?: unknown }).status
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return undefined
  const record = source as Record<string, unknown>

  const version =
    typeof record['version'] === 'number' && Number.isFinite(record['version'])
      ? record['version']
      : undefined
  const generatedAt = typeof record['generatedAt'] === 'string' ? record['generatedAt'] : undefined
  const onClass = typeof record['onClass'] === 'boolean' ? record['onClass'] : undefined
  const currentSubject =
    typeof record['currentSubject'] === 'string' && record['currentSubject'].trim() !== ''
      ? record['currentSubject']
      : undefined
  const nextSubject =
    typeof record['nextSubject'] === 'string' && record['nextSubject'].trim() !== ''
      ? record['nextSubject']
      : undefined
  const nextStartTime =
    typeof record['nextStartTime'] === 'string' && record['nextStartTime'].trim() !== ''
      ? record['nextStartTime']
      : undefined

  const status: ClassIslandBridgeStatus = {
    ...(version === undefined ? {} : { version }),
    ...(generatedAt === undefined ? {} : { generatedAt }),
    ...(onClass === undefined ? {} : { onClass }),
    ...(currentSubject === undefined ? {} : { currentSubject }),
    ...(nextSubject === undefined ? {} : { nextSubject }),
    ...(nextStartTime === undefined ? {} : { nextStartTime }),
  }
  return Object.keys(status).length === 0 ? undefined : status
}

function parseLesson(item: unknown): Lesson | string {
  if (typeof item !== 'object' || item === null) return '不是对象'
  const source = item as Record<string, unknown>

  const weekday = normalizeWeekday(source['weekday'])
  if (weekday === undefined) return 'weekday 缺失或非法（需 0–6）'

  const subject = typeof source['subject'] === 'string' ? source['subject'].trim() : ''
  if (subject === '') return 'subject 为空'

  const startTime = normalizeClock(source['startTime'])
  if (startTime === undefined) return 'startTime 非法（需 HH:mm）'

  const endTime = normalizeClock(source['endTime'])
  if (endTime === undefined) return 'endTime 非法（需 HH:mm）'

  return { weekday, startTime, endTime, subject }
}

/**
 * 归一星期。
 *
 * 只接受 `0–7`：ClassIsland 侧常见的两种表示是「0=周日」与「7=周日」，
 * 因此把 `7` 折成 `0`；其余越界值（`9`、`-1`）一律拒绝 ——
 * 取模看似"容错"，实则会把写错的数据静默映射成**另一天的课**，
 * 那会让课前提醒在错误的时刻打开错误的科目文件夹。
 */
function normalizeWeekday(value: unknown): number | undefined {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) return undefined
  if (numeric < 0 || numeric > 7) return undefined
  return numeric === 7 ? 0 : numeric
}

function normalizeClock(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(value.trim())
  if (match === null) return undefined
  const [, hours = '', minutes = ''] = match
  const hour = Number(hours)
  const minute = Number(minutes)
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return undefined
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined
  return `${`${hour}`.padStart(2, '0')}:${`${minute}`.padStart(2, '0')}`
}

function sortLessons(lessons: Lesson[]): Lesson[] {
  return [...lessons].sort((left, right) => {
    if (left.weekday !== right.weekday) return left.weekday - right.weekday
    if (left.startTime !== right.startTime) return left.startTime.localeCompare(right.startTime)
    return left.subject.localeCompare(right.subject, 'zh-Hans-CN')
  })
}

// ───────────────────────── 数据源读取 ─────────────────────────

export interface ClassIslandSourceOptions {
  source: 'http' | 'file'
  /** `http` 为端点 URL；`file` 为 JSON 文件路径。空串表示未配置。 */
  endpoint: string
  timeoutMs: number
  /** 注入便于单测；默认 `globalThis.fetch` */
  fetchImpl?: typeof fetch
  /** 注入便于单测；默认 `node:fs/promises` 的 readFile */
  readFile?: (path: string) => Promise<string>
  logger?: Logger
}

/** 一次源读取的结果：`raw` 为原始 JSON（未解析），`error` 非空表示读取失败。 */
export interface ClassIslandFetchResult {
  raw?: string
  error?: string
  elapsedMs: number
}

/** 读取桥接数据（不做解析、不抛错）。 */
export async function readClassIslandSource(
  options: ClassIslandSourceOptions,
  deps: { fetchImpl?: typeof fetch; readFile?: (path: string) => Promise<string> } = {},
): Promise<ClassIslandFetchResult> {
  const started = Date.now()
  const elapsed = (): number => Date.now() - started

  if (options.endpoint.trim() === '') {
    return { error: '尚未配置 ClassIsland 桥接端点', elapsedMs: elapsed() }
  }

  const timeoutMs = clampTimeout(options.timeoutMs)

  try {
    const raw =
      options.source === 'http'
        ? await fetchText(options.endpoint, timeoutMs, deps.fetchImpl ?? options.fetchImpl)
        : await readFileText(options.endpoint, timeoutMs, deps.readFile ?? options.readFile)
    return { raw, elapsedMs: elapsed() }
  } catch (error) {
    return { error: describeError(error), elapsedMs: elapsed() }
  }
}

async function fetchText(
  endpoint: string,
  timeoutMs: number,
  fetchImpl: typeof fetch | undefined,
): Promise<string> {
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不提供 fetch')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(endpoint, { signal: controller.signal })
    if (!response.ok) throw new Error(`端点返回 HTTP ${response.status}`)
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

async function readFileText(
  path: string,
  timeoutMs: number,
  readFile: ((path: string) => Promise<string>) | undefined,
): Promise<string> {
  const reader =
    readFile ??
    (async (target: string) => {
      const { readFile: nodeReadFile } = await import('node:fs/promises')
      return nodeReadFile(target, 'utf8')
    })
  return withTimeout(reader(path), timeoutMs)
}

/** 读文件本身没有取消机制，用 Promise.race 兜超时（挂起的读取不影响后续调用）。 */
function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`读取超时（${timeoutMs}ms）`)), timeoutMs)
    task.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function clampTimeout(value: number): number {
  if (!Number.isFinite(value)) return 3000
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(value)))
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'AbortError' ? '请求超时' : error.message
  }
  return String(error)
}

// ───────────────────────── provider ─────────────────────────

/** provider 的对外状态（IPC `classisland:status` 直接消费） */
export interface ClassIslandProviderStatus {
  ok: boolean
  lastSyncAt: string | null
  lessonCount: number
  warnings: string[]
  error?: string
  /** 桥接附带的当前课状态快照（v2；桥接未提供时为 undefined） */
  status?: ClassIslandBridgeStatus
}

/**
 * ClassIsland 课程表 provider。
 *
 * - `getToday()` 返回当天课程；任何失败返回 `[]` 并更新状态（供设置页与自测查看原因）。
 * - 解析结果按**原始文本**缓存：桥接文件没变就不重复解析，也避免同一批告警反复刷屏。
 */
export class ClassIslandProvider implements IScheduleProvider {
  readonly id = 'classisland' as const
  private readonly options: ClassIslandSourceOptions
  private status: ClassIslandProviderStatus = {
    ok: false,
    lastSyncAt: null,
    lessonCount: 0,
    warnings: [],
  }
  /** 上次读取到的原始文本（用于跳过重复解析） */
  private lastRaw: string | undefined
  private lastLessons: Lesson[] = []
  /** 上次解析出的当前课状态（随 payload 缓存，`getStatus()` 透出） */
  private lastStatus: ClassIslandBridgeStatus | undefined

  constructor(options: ClassIslandSourceOptions) {
    this.options = options
  }

  getStatus(): ClassIslandProviderStatus {
    return {
      ...this.status,
      warnings: [...this.status.warnings],
      ...(this.lastStatus === undefined ? {} : { status: this.lastStatus }),
    }
  }

  async getToday(now: Date): Promise<Lesson[]> {
    const lessons = await this.readLessons()
    const weekday = now.getDay()
    return lessons.filter((lesson) => lesson.weekday === weekday).map((lesson) => ({ ...lesson }))
  }

  /** 「测试连接」：立即读一次并回传预览与诊断，不改变 provider 的既有状态语义 */
  async test(now: Date): Promise<{
    ok: boolean
    lessons: Lesson[]
    warnings: string[]
    error?: string
    elapsedMs: number
  }> {
    const started = Date.now()
    const read = await readClassIslandSource(this.options)
    if (read.raw === undefined) {
      return {
        ok: false,
        lessons: [],
        warnings: [],
        ...(read.error === undefined ? {} : { error: read.error }),
        elapsedMs: Date.now() - started,
      }
    }
    const { lessons, warnings } = this.parseSafely(read.raw)
    const weekday = now.getDay()
    return {
      ok: true,
      lessons: lessons
        .filter((lesson) => lesson.weekday === weekday)
        .map((lesson) => ({ ...lesson })),
      warnings,
      elapsedMs: Date.now() - started,
    }
  }

  private async readLessons(): Promise<Lesson[]> {
    const read = await readClassIslandSource(this.options)

    if (read.raw === undefined) {
      const error = read.error ?? '未知错误'
      this.status = { ...this.status, ok: false, error }
      this.options.logger?.debug('ClassIsland 桥接读取失败', { error, ...this.describe() })
      return []
    }

    const { lessons, warnings } = this.parseSafely(read.raw)
    this.status = {
      ok: true,
      lastSyncAt: new Date().toISOString(),
      lessonCount: lessons.length,
      warnings,
    }
    if (warnings.length > 0) {
      this.options.logger?.warn('ClassIsland 桥接数据存在被跳过的课程', {
        count: warnings.length,
        ...this.describe(),
      })
    }
    return lessons
  }

  /** 文本未变则复用上次解析结果（跳过重复解析与重复告警） */
  private parseSafely(raw: string): ClassIslandParseResult {
    if (this.lastRaw === raw) {
      return { lessons: this.lastLessons, warnings: this.status.warnings, status: this.lastStatus }
    }
    this.lastRaw = raw

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      this.lastLessons = []
      this.lastStatus = undefined
      this.options.logger?.warn('ClassIsland 桥接数据不是合法 JSON', { error: String(error) })
      return { lessons: [], warnings: ['桥接数据不是合法 JSON'] }
    }

    const result = parseClassislandPayload(parsed)
    this.lastLessons = result.lessons
    this.lastStatus = result.status
    return result
  }

  private describe(): { source: string; endpoint: string } {
    return { source: this.options.source, endpoint: this.options.endpoint }
  }
}

/** 按设置构造 provider；未配置端点时返回 `undefined`（调用方回落到空课表实现）。 */
export function createClassIslandProviderIfConfigured(
  config: { source: 'http' | 'file'; endpoint: string; timeoutMs: number },
  logger?: Logger,
): ClassIslandProvider | undefined {
  if (config.endpoint.trim() === '') return undefined
  return new ClassIslandProvider({ ...config, ...(logger === undefined ? {} : { logger }) })
}
