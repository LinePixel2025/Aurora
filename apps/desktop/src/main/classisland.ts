/**
 * ClassIsland 联动（docs/05 §3.4 v2/v3）。
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
 *   "status": { "version": 3, "onClass": true, "currentSubject": "数学",
 *               "currentStartTime": "08:00", "currentEndTime": "08:45",
 *               "nextSubject": "物理", "nextStartTime": "09:55", "nextEndTime": "10:40" } }
 * ```
 * `weekday` 沿用 `Lesson` 语义（0=周日 … 6=周六），**一次给全周**，
 * 由 `getToday` 按当天过滤 —— 与 `IScheduleProvider` 的既有契约天然对齐，
 * 因此感知摘要、课前提醒、`timetable` Skill 三条消费链无需任何改动。
 * 可选的 `status` 快照（v2 起）宽容解析：缺省 undefined，经 `getStatus()` 随
 * `classisland:status` IPC 透出。
 *
 * **反向通道（v3 新增）**：`ClassIslandNotifier` 把提醒送进 ClassIsland
 * （文件模式写 `command.json` 并轮询 `command-result.json`，HTTP 模式 `POST /notify`），
 * 供 `classisland:notify` IPC 与 `classisland_remind` 工具使用。
 *
 * 工程约定（ADR-007）：桥接数据缺失 / 格式非法 / 超时一律**降级为空课表并记日志**，
 * 绝不抛出到调用方 —— 课前提醒是增强能力，不能影响主流程；
 * 提醒通道同理，失败一律转成 `{ ok: false, error }` 结果。
 * 本文件不依赖 Electron，系统能力（fetch / 读写文件 / 定时）全部可注入，故可在 Node 里单测。
 */
import type {
  ClassIslandBridgeSnapshot,
  ClassIslandNotifyRequest,
  ClassIslandNotifyResult,
  ClassIslandNotifyState,
  Logger,
} from '@aurora/shared'
import type { IScheduleProvider, Lesson } from './schedule.js'

/** 桥接 JSON 的一条课程（与 `Lesson` 形状一致，独立声明以便逐行做宽松校验） */
export interface ClassIslandPayloadLesson {
  weekday: number
  startTime: string
  endTime: string
  subject: string
}

/**
 * 桥接的当前课状态快照（v2 引入，v3 扩充；docs/05 §3.4 v2/v3）。
 *
 * **这就是 shared 的契约类型**（`ClassIslandBridgeSnapshot`，IPC 契约 SSOT），
 * 不再维护本地副本 —— `ClassIslandStatus.status` / `ClassIslandTestResult.status` /
 * `PerceptionSummary.classStatus` 三处透出的是同一个类型，字段增删由 shared 一处收口。
 */
export type ClassIslandBridgeStatus = ClassIslandBridgeSnapshot

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
 * 逐字段校验类型（`onClass` 布尔、科目字符串、`version` 数字），
 * 三个时间字段（v3 新增的 `currentStartTime` / `currentEndTime` / `nextEndTime`
 * 与既有的 `nextStartTime`）统一走 `normalizeClock` ——
 * `8:05` 这类未补零写法归一成 `08:05`，非法值（`25:00` / 非字符串）**整字段丢弃**。
 * 坏字段按缺失处理，**不产生 warnings**（缺状态是常态，不是数据错误）；
 * 版本号不参与分派，未知版本照常解析（向前兼容）。
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
  const currentSubject = readNonEmptyString(record['currentSubject'])
  const nextSubject = readNonEmptyString(record['nextSubject'])
  const currentStartTime = normalizeClock(record['currentStartTime'])
  const currentEndTime = normalizeClock(record['currentEndTime'])
  const nextStartTime = normalizeClock(record['nextStartTime'])
  const nextEndTime = normalizeClock(record['nextEndTime'])

  // 契约快照的两个**核心字段**：`version`（格式版本）与 `onClass`（是否上课）。
  // 缺任何一个都说明这份 status 不是桥接的契约快照（桥接插件从 v2 起必写这两个字段），
  // 此时整份丢弃 → undefined（宁可没有状态，也不要一个"看起来存在但语义不明"的对象）。
  // 其余字段一律可缺：坏字段丢弃、好字段保留。
  if (version === undefined || onClass === undefined) return undefined

  return {
    version,
    onClass,
    ...(generatedAt === undefined ? {} : { generatedAt }),
    ...(currentSubject === undefined ? {} : { currentSubject }),
    ...(currentStartTime === undefined ? {} : { currentStartTime }),
    ...(currentEndTime === undefined ? {} : { currentEndTime }),
    ...(nextSubject === undefined ? {} : { nextSubject }),
    ...(nextStartTime === undefined ? {} : { nextStartTime }),
    ...(nextEndTime === undefined ? {} : { nextEndTime }),
  }
}

/** 非空字符串读取（纯空白视为缺失，与 `subject` 的口径一致） */
function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.trim() === '' ? undefined : value
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

/**
 * `classisland:status` 的缓存上限：超过就重读一次。
 * 取值小于渲染层的 30 秒轮询间隔，保证轮询每次都拿到新数据（也让设置页改端点后立刻可见）。
 */
export const STATUS_MAX_AGE_MS = 15_000

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
  /** 上次读取的时刻（`refreshIfStale` 据此判断缓存是否过期） */
  private lastReadAt = 0
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

  /**
   * 缓存过期时主动读一次（供 `classisland:status` 使用，docs/05 §3.4 v3）。
   *
   * 为什么需要：状态快照只在「走到 `getToday` / `test`」时才刷新，而右栏的课堂状态卡是
   * 每 30 秒轮询 `classisland:status` 的 —— 用户刚把课表来源切到 ClassIsland 时，
   * 新 provider 还没读过任何数据，卡片会一直停在「暂无课堂状态」，直到下一次感知摘要组装
   * 顺手读一遍才补上（实测就是这么空着的）。让状态接口在缓存过期时自己拉一次，
   * 界面就与配置同步了。读取失败不抛错（失败原因已由 `readLessons` 记进 status）。
   */
  async refreshIfStale(maxAgeMs = STATUS_MAX_AGE_MS): Promise<void> {
    if (Date.now() - this.lastReadAt < maxAgeMs) return
    try {
      await this.getToday(new Date())
    } catch {
      /* 读取失败已记入 status，这里不再抛 */
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
    /** 桥接附带的当前课状态快照（v2/v3；桥接未提供时为 undefined） */
    status?: ClassIslandBridgeStatus
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
    const { lessons, warnings, status } = this.parseSafely(read.raw)
    const weekday = now.getDay()
    return {
      ok: true,
      lessons: lessons
        .filter((lesson) => lesson.weekday === weekday)
        .map((lesson) => ({ ...lesson })),
      warnings,
      ...(status === undefined ? {} : { status }),
      elapsedMs: Date.now() - started,
    }
  }

  private async readLessons(): Promise<Lesson[]> {
    this.lastReadAt = Date.now()
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

// ───────────────────────── 反向提醒通道（v3） ─────────────────────────

/** 提醒命令文件 / 回执文件名（与桥接插件 v3 的契约一致，docs/05 §3.4 v3） */
export const COMMAND_FILE_NAME = 'command.json'
export const COMMAND_RESULT_FILE_NAME = 'command-result.json'

/** 命令契约版本（`command.json` / `command-result.json` 的 `version`） */
const COMMAND_VERSION = 1

/** 文件模式的回执轮询间隔 */
const RESULT_POLL_INTERVAL_MS = 150

/** 提醒通道的运行配置（每次调用即时读取，设置页改完立即生效） */
export interface ClassIslandNotifyConfig {
  source: 'http' | 'file'
  /** `http` 为端点 URL；`file` 为**课表 JSON 文件**路径（命令文件写在同一目录） */
  endpoint: string
  timeoutMs: number
}

export interface ClassIslandNotifierOptions {
  /** 每次调用即时读取配置（端点 / 来源改完无需重建实例） */
  getConfig: () => ClassIslandNotifyConfig
  /** 出网实现（主进程注入 `netFetch`，使 `advanced.proxy` 生效） */
  fetchImpl?: () => typeof fetch
  /** 原子写（默认「写 .tmp 再 rename」，与桥接插件同一套约定） */
  writeFile?: (path: string, content: string) => Promise<void>
  readFile?: (path: string) => Promise<string>
  /** 幂等等待（单测注入假实现以避免真实等待） */
  sleep?: (ms: number) => Promise<void>
  /** 命令 id 生成（单测注入固定值） */
  newId?: () => string
  now?: () => Date
  logger?: Logger
}

/**
 * ClassIsland 提醒通道（Aurora → ClassIsland，docs/05 §3.4 v3、docs/08 §1）。
 *
 * 两条路径（按当前配置的 `source` 选择），契约完全一致：
 * - **文件**：原子写 `<课表文件同目录>/command.json`，然后轮询同目录 `command-result.json`
 *   直到 `id` 匹配（超时用 `timeoutMs`）；命令文件**不删除**（插件靠 id 去重，
 *   删掉反而会让"重启后补处理"失去保护）。
 * - **HTTP**：`POST <端点 origin>/notify`（用户填的端点可能带路径，
 *   例如 `http://127.0.0.1:17945/schedule` → 请求 `http://127.0.0.1:17945/notify`），
 *   请求 / 响应体就是上面两个文件的内容；
 *   **走注入的 `fetchImpl`**（主进程给 `netFetch`），否则 `advanced.proxy` 对它无效。
 *
 * 失败语义（ADR-007 同款）：任何异常都转成 `{ ok: false, error }`，**绝不抛出**；
 * 成功 / 失败都会更新 `notify` 状态（`available` / `ok` / `lastAt` / `error`），
 * 供 `classisland:status` 与设置页回显。
 */
export class ClassIslandNotifier {
  private readonly options: ClassIslandNotifierOptions
  private state: ClassIslandNotifyState = {
    available: false,
    ok: false,
    lastAt: null,
  }

  constructor(options: ClassIslandNotifierOptions) {
    this.options = options
    this.refreshAvailability()
  }

  /** 最近一次提醒通道状态（`classisland:status` 的 `notify` 字段） */
  getState(): ClassIslandNotifyState {
    return { ...this.state }
  }

  /**
   * 配置变化后重置「通道是否可用」：端点已配置 = 可能可用（真正可用与否由下次调用证实）。
   * `notify()` 每次调用都会按结果细化它（通道类失败 → false）。
   */
  refreshAvailability(): void {
    const configured = this.options.getConfig().endpoint.trim() !== ''
    this.state = { ...this.state, available: configured }
  }

  async notify(request: ClassIslandNotifyRequest): Promise<ClassIslandNotifyResult> {
    const started = Date.now()
    const elapsed = (): number => Date.now() - started

    const title = (request.title ?? '').trim()
    const body = (request.body ?? '').trim()
    if (title === '' && body === '') {
      // 参数错误不算「通道不可用」：桥接端本身没问题
      const error = '提醒标题与正文不能都为空'
      this.recordFailure(error, false)
      return { ok: false, error, elapsedMs: elapsed() }
    }

    const config = this.options.getConfig()
    if (config.endpoint.trim() === '') {
      const error = '尚未配置 ClassIsland 桥接端点'
      this.recordFailure(error, true)
      return { ok: false, error, elapsedMs: elapsed() }
    }

    const timeoutMs = clampTimeout(config.timeoutMs)
    const command: NotifyCommandPayload = {
      version: COMMAND_VERSION,
      id: this.newId(),
      kind: 'notify',
      channel: request.channel ?? 'custom',
      title,
      body,
      createdAt: (this.options.now?.() ?? new Date()).toISOString(),
    }

    try {
      const outcome =
        config.source === 'http'
          ? await this.sendHttp(config.endpoint, command, timeoutMs)
          : await this.sendFile(config.endpoint, command, timeoutMs)

      if (!outcome.ok) {
        this.recordFailure(outcome.error ?? '提醒发送失败', outcome.channelUnavailable === true)
      } else {
        this.state = { available: true, ok: true, lastAt: new Date().toISOString() }
      }
      return {
        ok: outcome.ok,
        ...(outcome.ok || outcome.error === undefined ? {} : { error: outcome.error }),
        elapsedMs: elapsed(),
      }
    } catch (error) {
      // 兜底：sendFile / sendHttp 内部已各自兜错，这里只防注入实现抛出
      const message = describeError(error)
      this.recordFailure(message, true)
      return { ok: false, error: message, elapsedMs: elapsed() }
    }
  }

  // ───────────────────────── 内部 ─────────────────────────

  private newId(): string {
    if (this.options.newId !== undefined) return this.options.newId()
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }

  private recordFailure(error: string, channelUnavailable: boolean): void {
    this.state = {
      available: channelUnavailable ? false : this.state.available,
      ok: false,
      lastAt: new Date().toISOString(),
      error,
    }
    this.options.logger?.debug('ClassIsland 提醒发送失败', { error, channelUnavailable })
  }

  private directoryOf(endpoint: string): string {
    const index = Math.max(endpoint.lastIndexOf('/'), endpoint.lastIndexOf('\\'))
    return index <= 0 ? '' : endpoint.slice(0, index)
  }

  private join(directory: string, name: string): string {
    const separator = directory.includes('\\') ? '\\' : '/'
    return `${directory.replace(/[\\/]+$/, '')}${separator}${name}`
  }

  /** 文件模式：写命令 → 轮询回执（按 id 匹配） */
  private async sendFile(
    endpoint: string,
    command: NotifyCommandPayload,
    timeoutMs: number,
  ): Promise<SendOutcome> {
    const directory = this.directoryOf(endpoint)
    if (directory === '') {
      return {
        ok: false,
        error: '端点不是有效的文件路径（无法确定 command.json 的目录）',
        channelUnavailable: true,
      }
    }

    const commandPath = this.join(directory, COMMAND_FILE_NAME)
    const resultPath = this.join(directory, COMMAND_RESULT_FILE_NAME)
    const write = this.options.writeFile ?? defaultAtomicWrite
    const read = this.options.readFile ?? defaultReadFile
    const sleep = this.options.sleep ?? defaultSleep

    try {
      await write(commandPath, JSON.stringify(command, null, 2))
    } catch (error) {
      return {
        ok: false,
        error: `写入 command.json 失败：${describeError(error)}`,
        channelUnavailable: true,
      }
    }

    const deadline = Date.now() + timeoutMs
    // 先立刻读一次（插件通常在 1 秒内处理完，命中时不必等一个轮询间隔）
    for (;;) {
      const result = await this.readResult(read, resultPath, command.id)
      if (result !== undefined) {
        return result.ok
          ? { ok: true }
          : { ok: false, error: result.error ?? '桥接返回了失败回执', channelUnavailable: false }
      }
      if (Date.now() >= deadline) {
        return {
          ok: false,
          error: `等待 ClassIsland 回执超时（${timeoutMs}ms）—— 桥接插件是否为 v3？命令通道是否开启？`,
          channelUnavailable: true,
        }
      }
      await sleep(RESULT_POLL_INTERVAL_MS)
    }
  }

  /** 读一次回执：未出现 / 不是合法 JSON / id 不匹配（上一次命令的残留）都返回 undefined */
  private async readResult(
    read: (path: string) => Promise<string>,
    resultPath: string,
    id: string,
  ): Promise<{ ok: boolean; error?: string } | undefined> {
    let raw: string
    try {
      raw = await read(resultPath)
    } catch {
      return undefined // 还没写出来
    }

    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) return undefined
      const record = parsed as Record<string, unknown>
      if (record['id'] !== id) return undefined
      const ok = record['ok'] === true
      const error = typeof record['error'] === 'string' ? record['error'] : undefined
      return { ok, ...(error === undefined ? {} : { error }) }
    } catch {
      return undefined
    }
  }

  /** HTTP 模式：POST <origin>/notify（端点带路径时按 origin 拼接） */
  private async sendHttp(
    endpoint: string,
    command: NotifyCommandPayload,
    timeoutMs: number,
  ): Promise<SendOutcome> {
    const fetchImpl = this.options.fetchImpl?.() ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
      return { ok: false, error: '当前运行环境不提供 fetch', channelUnavailable: true }
    }

    const url = buildNotifyUrl(endpoint)
    if (url === undefined) {
      return { ok: false, error: `端点不是合法的 HTTP 地址：${endpoint}`, channelUnavailable: true }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(command),
        signal: controller.signal,
      })
      if (!response.ok) {
        return {
          ok: false,
          error: `端点返回 HTTP ${response.status}（命令通道是否已开启？）`,
          channelUnavailable: true,
        }
      }
      const parsed: unknown = await response.json()
      if (typeof parsed !== 'object' || parsed === null) {
        return { ok: false, error: '端点回执不是 JSON 对象', channelUnavailable: true }
      }
      const record = parsed as Record<string, unknown>
      if (record['ok'] === true) return { ok: true }
      const error = typeof record['error'] === 'string' ? record['error'] : '桥接返回了失败回执'
      return { ok: false, error, channelUnavailable: false }
    } catch (error) {
      const message = describeError(error)
      return { ok: false, error: message, channelUnavailable: true }
    } finally {
      clearTimeout(timer)
    }
  }
}

interface SendOutcome {
  ok: boolean
  error?: string
  /** 失败是否属于「通道不可用」（设备/端点/超时）—— 影响 `notify.available` 回显 */
  channelUnavailable?: boolean
}

interface NotifyCommandPayload {
  version: number
  id: string
  kind: 'notify'
  channel: string
  title: string
  body: string
  createdAt: string
}

/**
 * 端点 → `/notify` URL。
 *
 * 用户在设置页填的是**课表端点**（`http://127.0.0.1:17945/schedule`，也可能只填了
 * `http://127.0.0.1:17945` 甚至带别的路径），因此一律**按 origin 拼接** `/notify`：
 * 不猜路径、不做字符串替换（`/schedule` 换成 `/notify` 会在用户填了别的路径时悄悄打错地址）。
 * 非法 URL 返回 undefined，由调用方转为 `{ ok: false }`。
 */
export function buildNotifyUrl(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return `${url.origin}/notify`
  } catch {
    return undefined
  }
}

/** 原子写：先写 `.tmp` 再 rename（桥接插件的 watcher 只在文件出现/变化时动作） */
async function defaultAtomicWrite(path: string, content: string): Promise<void> {
  const { writeFile, rename } = await import('node:fs/promises')
  const temporary = `${path}.tmp`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, path)
}

async function defaultReadFile(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return readFile(path, 'utf8')
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
