/**
 * SessionStore —— 会话持久化（docs/06 §4）。
 *
 * 约定：
 * - 一个会话一个文件：`<dir>/<sessionId>.json`；`sessionId` 白名单归一（防路径穿越）。
 * - 懒加载（首次访问读盘）+ 300ms 防抖原子写 + `flush()`（退出前调用）。
 * - 会话级元信息（`meta`：归档等）与消息同文件、同缓存、同脏标记；空 `meta` 不落键。
 * - 解析失败：备份为 `<sessionId>.corrupt-<ts>.json` 后重建为空会话（不静默丢数据）；
 *   但 `meta` 畸形**不算**解析失败（只归化为空 meta，避免为一个旁路字段丢消息）。
 * - 系统提示词**不落盘**，每次请求由 context 层重新组装。
 * - 纯 Node：文件系统经 `FileSystemPort` 注入，单测可替换。
 */
import { join } from 'node:path'
import {
  nodeFileSystem,
  type AgentToolCall,
  type ChatSessionSummary,
  type FileSystemPort,
} from '@aurora/shared'
import type { Logger } from '@aurora/shared'
import { createNoopLogger } from '@aurora/shared'
import { DEFAULT_MAX_MESSAGES, truncateHistory, type TruncateOptions } from './history.js'
import {
  SESSION_FILE_VERSION,
  type NewMessage,
  type SessionMeta,
  type StoredMessage,
  type StoredSession,
  type StoredToolCall,
} from './types.js'

export const SESSION_WRITE_DEBOUNCE_MS = 300
const MAX_BACKUPS = 3

/**
 * 会话摘要（`chat:sessions`，docs/06 §4）。
 *
 * 与 shared 的 `ChatSessionSummary`（`packages/shared/src/ipc/types.ts`）**结构兼容**
 * （多出的 `archived` 是可选字段，因此可以直接回给该通道），
 * 这里之所以在 store 内再声明一次：归档是会话存储层的概念，而本轮不允许改 shared。
 * 等 shared 的 `ChatSessionSummary` 补上 `archived?: boolean` 后，这个接口可以直接并过去。
 */
export interface SessionSummary extends ChatSessionSummary {
  /** 已归档（照常出现在列表里，只是带标记；渲染层据此分组） */
  archived?: boolean
}

export interface SessionStoreOptions {
  /** 会话目录（主进程传 `<userData>/sessions`） */
  dir: string
  fs?: FileSystemPort
  logger?: Logger
  /** 防抖写盘间隔，测试可传 0 立即写 */
  writeDebounceMs?: number
  /** 单会话消息上限（默认 2000） */
  maxMessages?: number
  onWriteError?: (error: Error) => void
}

/** 会话 id 白名单：只允许 `[A-Za-z0-9_-]`，其余一律归一为 `settings` */
export function normalizeSessionId(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return 'settings'
  const cleaned = trimmed.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
  return cleaned === '' ? 'settings' : cleaned
}

export function sessionFilePath(dir: string, sessionId: string): string {
  return join(dir, `${normalizeSessionId(sessionId)}.json`)
}

export class SessionStore {
  private readonly dir: string
  private readonly fs: FileSystemPort
  private readonly logger: Logger
  private readonly writeDebounceMs: number
  private readonly maxMessages: number
  private readonly onWriteError: ((error: Error) => void) | undefined

  private readonly cache = new Map<string, StoredMessage[]>()
  /** 会话级元信息（归档等）：与 `cache` / `loaded` / `dirty` 同一套懒加载 + 脏标记 */
  private readonly metaCache = new Map<string, SessionMeta>()
  private readonly loaded = new Set<string>()
  private readonly dirty = new Set<string>()
  private readonly writing = new Map<string, Promise<void>>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private counter = 0

  constructor(options: SessionStoreOptions) {
    this.dir = options.dir
    this.fs = options.fs ?? nodeFileSystem
    this.logger = options.logger ?? createNoopLogger()
    this.writeDebounceMs = options.writeDebounceMs ?? SESSION_WRITE_DEBOUNCE_MS
    this.maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES
    this.onWriteError = options.onWriteError
  }

  get directory(): string {
    return this.dir
  }

  /** 读取（必要时从磁盘加载）某会话的全部消息。 */
  async get(sessionId: string): Promise<StoredMessage[]> {
    const id = normalizeSessionId(sessionId)
    await this.ensureLoaded(id)
    return [...(this.cache.get(id) ?? [])]
  }

  /**
   * 预领一个消息 id（不落盘）。
   *
   * 流式正文用：助手消息在正文还没收完时就要有稳定 id 下发给渲染层，
   * 而落盘要等这条流结束（见 `NewMessage.id` 与 docs/06 §16.2）。
   * 与 `append` 共用同一个计数器，因此不会与自动生成的 id 相撞。
   */
  nextMessageId(): string {
    return this.generateId()
  }

  /** 追加一条消息并返回它（带生成好的 id；`message.id` 给了就用给的）。 */
  async append(sessionId: string, message: NewMessage): Promise<StoredMessage> {
    const id = normalizeSessionId(sessionId)
    await this.ensureLoaded(id)
    const stored: StoredMessage = {
      id: message.id ?? this.generateId(),
      role: message.role,
      content: message.content,
      createdAt: message.createdAt ?? new Date().toISOString(),
      ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls }),
      ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
      ...(message.reasoning === undefined ? {} : { reasoning: message.reasoning }),
    }
    const next = [...(this.cache.get(id) ?? []), stored]
    // 条数上限：与上下文截断同一套规则，保证不拆散工具调用组
    const trimmed =
      this.maxMessages > 0 && next.length > this.maxMessages
        ? truncateHistory(next, { maxChars: 0, maxMessages: this.maxMessages }).messages
        : next
    this.cache.set(id, trimmed)
    this.dirty.add(id)
    this.scheduleWrite(id)
    return stored
  }

  /**
   * 供渲染层水合的消息列表：过滤掉 `tool` 回填消息与 `system`，
   * 只保留用户与助手（助手带工具卡片状态）。
   *
   * 工具卡片在这里就从存储形状（`arguments` 是 JSON 字符串）转成渲染层形状
   * （`input` 是解析后的对象，见 `AgentToolCall`）：渲染层的参数折叠、「子代理」页面
   * 的指令与报告、todo 卡片的清单反推都直接读 `input`，不转的话水合出来的卡片是空的。
   */
  async rendererHistory(
    sessionId: string,
    limit?: number,
  ): Promise<
    Array<{
      id: string
      role: 'user' | 'assistant'
      content: string
      createdAt: string
      toolCalls?: AgentToolCall[]
      reasoning?: string
    }>
  > {
    const messages = await this.get(sessionId)
    const visible = messages.filter(
      (message): message is StoredMessage & { role: 'user' | 'assistant' } =>
        message.role === 'user' || message.role === 'assistant',
    )
    const sliced = limit !== undefined && limit > 0 ? visible.slice(-limit) : visible
    return sliced.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      ...(message.toolCalls === undefined
        ? {}
        : { toolCalls: message.toolCalls.map((call) => toAgentToolCall(call)) }),
      ...(message.reasoning === undefined ? {} : { reasoning: message.reasoning }),
    }))
  }

  /** 供 loop 使用的截断历史（不含本次用户输入）。 */
  async context(sessionId: string, options: TruncateOptions = {}): Promise<StoredMessage[]> {
    const messages = await this.get(sessionId)
    return truncateHistory(messages, options).messages
  }

  /** 原地更新某条消息里的工具卡片状态（不新增消息）。 */
  async updateToolCall(messageId: string, call: StoredToolCall): Promise<void> {
    for (const [id, messages] of this.cache) {
      const target = messages.find((message) => message.id === messageId)
      if (target === undefined) continue
      const calls = target.toolCalls ?? []
      const index = calls.findIndex((item) => item.id === call.id)
      if (index >= 0) calls[index] = { ...call }
      else calls.push({ ...call })
      target.toolCalls = calls
      this.dirty.add(id)
      this.scheduleWrite(id)
      return
    }
  }

  /**
   * 清空某会话的消息（会话本身与 meta 保留）。
   *
   * `ensureLoaded` 不是可省的：metaCache 可能还没装载过，
   * 直接写盘会因为拿不到 meta 而**把归档状态悄悄抹掉**（写出的 payload 里没有 `meta`）。
   */
  async clear(sessionId: string): Promise<void> {
    const id = normalizeSessionId(sessionId)
    await this.ensureLoaded(id)
    this.cache.set(id, [])
    this.loaded.add(id)
    this.dirty.add(id)
    this.scheduleWrite(id, 0)
  }

  /**
   * 归档 / 取消归档（`chat:archiveSession`，docs/06 §4）。
   *
   * - **幂等**：当前状态已等于目标值 → 直接返回，不写盘；
   * - 归档写 `archivedAt`，取消归档**删掉**它（不留一个空值）；
   * - 先 `ensureLoaded`：别把已在盘上的消息冲掉（写盘时 payload 用内存快照）；
   * - **await 写盘完成**：IPC 之后调用方要立刻能读到新状态（探针依赖这个确定性），
   *   所以走 `scheduleWrite(id, 0)` 而不是 300ms 防抖（该性质见 `writeNow` 注释）；
   * - 给一个**从未落盘的空会话**归档会因此首次写出一个只有 meta、`messages: []` 的文件 ——
   *   这是**预期行为**：归档这件事本身就需要一个落点，否则重启后归档状态无处可读。
   */
  async setArchived(id: string, archived: boolean): Promise<void> {
    const sessionId = normalizeSessionId(id)
    await this.ensureLoaded(sessionId)
    const current = this.metaCache.get(sessionId) ?? {}
    // 幂等判定按「是否已归档」而非字段原值：v1 老文件没有 archived 字段，同样算未归档
    if ((current.archived === true) === archived) return

    const next: SessionMeta = { ...current, archived }
    if (archived) next.archivedAt = new Date().toISOString()
    else delete next.archivedAt
    this.metaCache.set(sessionId, next)
    this.dirty.add(sessionId)
    this.scheduleWrite(sessionId, 0)
    await (this.writing.get(sessionId) ?? Promise.resolve())
  }

  /** 已落盘 / 已缓存的会话 id 列表。 */
  async listSessions(): Promise<string[]> {
    const ids = new Set<string>(this.cache.keys())
    try {
      for (const entry of await this.fs.readdir(this.dir)) {
        if (!entry.endsWith('.json')) continue
        if (entry.includes('.corrupt-')) continue
        ids.add(entry.slice(0, -'.json'.length))
      }
    } catch {
      /* 目录不存在：仅返回内存中的会话 */
    }
    return [...ids].sort()
  }

  /**
   * 会话摘要列表（`chat:sessions`，docs/06 §4）。
   *
   * 标题取**首条用户消息**的前若干字符：这比 let 模型生成标题便宜得多，
   * 也不需要额外请求；空会话回落为「新会话」。
   * 排序：有消息的按最后一条消息时间倒序，空会话排最后（新建会话在顶部更符合直觉，
   * 但用户此时期待看到的是「刚建的会话」，因此空会话用其 id 的生成时间参与排序）。
   * 归档**不参与排序**：归档会话照常出现在列表里，只是多一个 `archived` 标记，
   * 由渲染层决定分组（storage 层不做过滤，避免「归档后从磁盘消失了」这类误判）。
   */
  async summaries(activeId?: string): Promise<SessionSummary[]> {
    const items: SessionSummary[] = []
    for (const id of await this.listSessions()) {
      const messages = await this.get(id)
      const meta = this.metaCache.get(id) ?? {}
      const firstUser = messages.find((message) => message.role === 'user')
      const last = messages[messages.length - 1]
      items.push({
        id,
        title: titleFor(firstUser),
        updatedAt: last?.createdAt ?? createdAtFromId(id) ?? new Date(0).toISOString(),
        messageCount: messages.filter(
          (message) => message.role === 'user' || message.role === 'assistant',
        ).length,
        ...(activeId === undefined ? {} : { active: id === normalizeSessionId(activeId) }),
        ...(meta.archived === undefined ? {} : { archived: meta.archived }),
      })
    }
    return items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  /**
   * 新建一个空会话并返回其 id。
   *
   * 只生成 id 并标记为已加载（空数组）：文件在首条消息落盘时才真正创建，
   * 避免用户连点「新建」在磁盘上堆一批空文件。
   */
  async createSession(): Promise<string> {
    const id = normalizeSessionId(`chat-${Date.now().toString(36)}-${(this.counter += 1)}`)
    if (!this.loaded.has(id)) {
      this.loaded.add(id)
      this.cache.set(id, [])
    }
    return id
  }

  /**
   * 立即落盘（退出前 / 单测使用）。
   *
   * 先等在途写入排队完成（`writeNow` 自身不入队），再对仍然脏的会话重试，
   * 因此"写失败 → flush 重试"是可靠语义，而不是碰时序运气。
   */
  async flush(): Promise<void> {
    for (const [id, timer] of this.timers) {
      clearTimeout(timer)
      this.timers.delete(id)
    }
    await Promise.all([...this.writing.values()].map((task) => task.catch(() => undefined)))
    for (const id of [...this.dirty]) {
      await this.writeNow(id)
    }
    await Promise.all([...this.writing.values()].map((task) => task.catch(() => undefined)))
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  // ───────────────────────── 内部 ─────────────────────────

  /** 消息 id 生成：时间戳 + 进程内自增（同一毫秒内也不会重） */
  private generateId(): string {
    this.counter += 1
    return `msg-${Date.now()}-${this.counter}`
  }

  private async ensureLoaded(id: string): Promise<void> {
    if (this.loaded.has(id)) return
    this.loaded.add(id)
    const { messages, meta } = await this.readFromDisk(id)
    this.cache.set(id, messages)
    this.metaCache.set(id, meta)
  }

  /**
   * 读盘：消息与会话级 meta 一次读出（两者在同一个文件里，没有理由读两遍）。
   *
   * 宽容口径（docs/06 §4）：
   * - 文件不存在 → 空 messages + 空 meta（首次运行，不是错误）；
   * - `messages` 不是数组 → 走既有损坏备份路径（文件结构已不可信）；
   * - `meta` 畸形（不是对象 / 是数组 / 字段类型不对）→ 只当空 meta，**备份都不做** ——
   *   meta 是新加的旁路信息，绝不能因为它坏了就把整份会话备份重建（那等于丢消息）。
   */
  private async readFromDisk(
    id: string,
  ): Promise<{ messages: StoredMessage[]; meta: SessionMeta }> {
    const path = sessionFilePath(this.dir, id)
    let raw: string
    try {
      raw = await this.fs.readFile(path)
    } catch {
      return { messages: [], meta: {} } // 首次运行：会话文件尚不存在
    }

    try {
      const parsed: unknown = JSON.parse(raw)
      const messages = (parsed as StoredSession | null)?.messages
      if (!Array.isArray(messages)) throw new Error('messages 不是数组')
      return {
        messages: messages.filter(isStoredMessage),
        meta: normalizeMeta((parsed as StoredSession | null)?.meta),
      }
    } catch (error) {
      this.logger.error('会话文件解析失败，已备份并重建', { sessionId: id, error: String(error) })
      await this.backupCorrupt(id, path)
      return { messages: [], meta: {} }
    }
  }

  private async backupCorrupt(id: string, path: string): Promise<void> {
    try {
      const backup = join(this.dir, `${id}.corrupt-${Date.now()}.json`)
      await this.fs.rename(path, backup)
      await this.pruneBackups(id)
    } catch (error) {
      this.logger.warn('备份损坏会话文件失败', { sessionId: id, error: String(error) })
    }
  }

  private async pruneBackups(id: string): Promise<void> {
    try {
      const entries = (await this.fs.readdir(this.dir))
        .filter((name) => name.startsWith(`${id}.corrupt-`))
        .sort()
      while (entries.length > MAX_BACKUPS) {
        const oldest = entries.shift()
        if (oldest !== undefined) await this.fs.remove(join(this.dir, oldest))
      }
    } catch {
      /* 清理失败不影响主流程 */
    }
  }

  private scheduleWrite(id: string, delayMs = this.writeDebounceMs): void {
    if (delayMs <= 0) {
      const existing = this.timers.get(id)
      if (existing) {
        clearTimeout(existing)
        this.timers.delete(id)
      }
      void this.writeNow(id)
      return
    }
    const existing = this.timers.get(id)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.timers.delete(id)
      void this.writeNow(id)
    }, delayMs)
    timer.unref?.()
    this.timers.set(id, timer)
  }

  /**
   * 串行排队写盘：排到队时才读取最新内存快照，因此不会写旧内容。
   * 多个来源（防抖定时器 / flush / clear）天然合并为一次写。
   *
   * 注意：`run` 内部在**检查脏标记之前**不 await 任何东西，
   * 因此同步调用 `scheduleWrite(id, 0)` 后立刻 `await this.writing.get(id)`
   * 就能观察到本次写入的结果（单测依赖该性质）。
   */
  private writeNow(id: string): Promise<void> {
    if (!this.dirty.has(id)) return this.writing.get(id) ?? Promise.resolve()
    const run = (this.writing.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        if (!this.dirty.has(id)) return
        this.dirty.delete(id)
        const meta = this.metaCache.get(id) ?? {}
        const payload: StoredSession = {
          version: SESSION_FILE_VERSION,
          sessionId: id,
          updatedAt: new Date().toISOString(),
          messages: this.cache.get(id) ?? [],
          // 空 meta 不写这个键：老文件（v1）的形状保持不变，不让每个会话文件都多一行 `"meta": {}`
          ...(isEmptyMeta(meta) ? {} : { meta }),
        }
        try {
          await this.fs.writeFileAtomic(
            sessionFilePath(this.dir, id),
            `${JSON.stringify(payload, null, 2)}\n`,
          )
        } catch (error) {
          const wrapped = error instanceof Error ? error : new Error(String(error))
          this.dirty.add(id) // 保持脏标记，下次重试
          this.logger.error('会话写入失败', { sessionId: id, error: wrapped.message })
          this.onWriteError?.(wrapped)
        }
      })
    this.writing.set(id, run)
    return run
  }
}

function isStoredMessage(value: unknown): value is StoredMessage {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  const role = candidate['role']
  return (
    typeof candidate['id'] === 'string' &&
    typeof candidate['content'] === 'string' &&
    typeof candidate['createdAt'] === 'string' &&
    (role === 'user' || role === 'assistant' || role === 'tool' || role === 'system')
  )
}

/**
 * meta 归化：只保留**已知且类型正确**的字段，其余一概丢弃。
 *
 * 非对象（字符串 / 数字 / 数组 / null）一律当空 meta —— 这条宽容是刻意的：
 * meta 是旁路信息，畸形时把整个会话当损坏备份重建就等于丢消息（与 `messages` 的
 * 严格口径不同，那边结构不可信就真的没法读了）。
 */
function normalizeMeta(value: unknown): SessionMeta {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const candidate = value as Record<string, unknown>
  const meta: SessionMeta = {}
  if (typeof candidate['archived'] === 'boolean') meta.archived = candidate['archived']
  if (typeof candidate['archivedAt'] === 'string') meta.archivedAt = candidate['archivedAt']
  if (typeof candidate['pinned'] === 'boolean') meta.pinned = candidate['pinned']
  return meta
}

/** 空 meta（无字段或字段全 undefined）判定：决定要不要往 payload 里写 `meta` 键 */
function isEmptyMeta(meta: SessionMeta): boolean {
  return meta.archived === undefined && meta.archivedAt === undefined && meta.pinned === undefined
}

/** 会话标题最大长度（中文字符按 1 计） */
const TITLE_MAX_LENGTH = 24

/**
 * 存储形状 → 渲染层形状：`arguments`（JSON 字符串）解析成 `input` 对象。
 *
 * 宽容两种输入：正常落盘的消息只有 `arguments`；而**夹具 / 手工构造**的历史
 * （截图探针的 seed、早期版本写入的数据）可能已经带着渲染层的 `input` 字段。
 * 缺了这层宽容，`arguments.trim()` 会抛错 → 整个 `chat:history` 失败 →
 * 界面表现为「历史全空」（截图探针正是这样抓到的）。
 */
function toAgentToolCall(call: StoredToolCall & { input?: unknown }): AgentToolCall {
  const input = call.input !== undefined ? call.input : parseArguments(call.arguments)
  return {
    id: call.id,
    name: call.name,
    ...(input === undefined ? {} : { input }),
    state: call.state,
    ...(call.outputSummary === undefined ? {} : { outputSummary: call.outputSummary }),
    ...(call.subagent === undefined ? {} : { subagent: call.subagent }),
  }
}

/** 参数解析：空串与非字符串都视为无参数；非法 JSON 保留原文（与循环侧同款口径） */
function parseArguments(raw: unknown): unknown {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return { _raw: raw }
  }
}

function titleFor(firstUser: StoredMessage | undefined): string {
  if (firstUser === undefined) return '新会话'
  const text = firstUser.content.replace(/\s+/g, ' ').trim()
  if (text === '') return '新会话'
  return text.length <= TITLE_MAX_LENGTH ? text : `${text.slice(0, TITLE_MAX_LENGTH)}…`
}

/**
 * 空会话没有消息时间戳，用 id 里的 base36 时间戳兜底。
 * 仅识别 `chat-<base36>-<n>` 这一种自生成 id；其它（`main` / `quick` / 用户自定）
 * 返回 `undefined`，由调用方回落到 epoch（排最后）。
 */
function createdAtFromId(id: string): string | undefined {
  const match = /^chat-([0-9a-z]+)-\d+$/.exec(id)
  if (match === null) return undefined
  const parsed = Number.parseInt(match[1] ?? '', 36)
  if (!Number.isFinite(parsed)) return undefined
  return new Date(parsed).toISOString()
}
