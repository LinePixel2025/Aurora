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
  type PermissionMode,
  type SessionUsageStats,
  type TokenUsage,
} from '@aurora/shared'
import type { Logger } from '@aurora/shared'
import { createNoopLogger } from '@aurora/shared'
import { DEFAULT_MAX_MESSAGES, truncateHistory, type TruncateOptions } from './history.js'
import {
  SESSION_FILE_VERSION,
  type NewMessage,
  type SessionCompact,
  type SessionMeta,
  type SessionModelOverride,
  type SessionSpace,
  type StoredAskRecord,
  type StoredDisplayImage,
  type StoredMessage,
  type StoredSession,
  type StoredToolCall,
} from './types.js'

export const SESSION_WRITE_DEBOUNCE_MS = 300
const MAX_BACKUPS = 3
/** 单会话保留的提问留痕条数（有界环）：长会话也不让 `asks` 无限增长 */
export const MAX_ASK_RECORDS = 50

/**
 * Center 回放的条目（`rendererHistoryWithAsks` 的返回）：普通消息 + 提问留痕。
 *
 * 与协议里的 `CenterSessionHistoryMessage` 同形（`kind` / `ask` 都是可选，
 * 老网页端忽略它们即可）。
 */
export type RendererHistoryEntry = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  toolCalls?: AgentToolCall[]
  reasoning?: string
  kind?: 'ask'
  ask?: StoredAskRecord
}

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
  /**
   * 会话绑定的项目 id（docs/06 §5.1 会话级项目）。未绑定的会话**不含这个键**
   * （与 `archived` 同款：渲染层按「有没有键」区分「未绑定」与「绑定到某项目」）。
   */
  projectId?: string
  /**
   * 会话级权限档覆盖（docs/06 §11.2 / docs/12 §6.3）。缺省**不含这个键** = 跟随全局档。
   */
  permissionMode?: PermissionMode
  /**
   * 会话空间（docs/06 §4 会话三分）。未标记的会话**不含这个键** = Agent 空间
   * （undefined 与 `'agent'` 等价，渲染层按「有没有键」与 `projectId` 分三区）。
   */
  space?: SessionSpace
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
  /**
   * 内存里同时保留的**已装载会话**上限（默认 8）。
   *
   * 脏的 / 正在写盘的 / 正在读盘的会话永不淘汰；被淘汰的会话只丢消息数组
   * （`metaCache` 保留），下次 `ensureLoaded` 自动重读（2026-10-04 性能轮）。
   */
  maxLoadedSessions?: number
  /**
   * 会话被淘汰前要求的最短空闲时间（默认 5 分钟）。
   *
   * 只防「加载完立刻被另一条异步链淘汰」的竞态；`summaries()` 的临时装载另有
   * `releaseTransient` 显式释放，不依赖这个阈值。
   */
  loadedIdleMs?: number
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
  private readonly maxLoadedSessions: number
  private readonly loadedIdleMs: number
  private readonly onWriteError: ((error: Error) => void) | undefined

  private readonly cache = new Map<string, StoredMessage[]>()
  /** 消息 id → 会话 id。工具状态更新是热路径，避免每次扫描所有会话。 */
  private readonly messageOwners = new Map<string, string>()
  /** 会话级元信息（归档等）：与 `cache` / `loaded` / `dirty` 同一套懒加载 + 脏标记 */
  private readonly metaCache = new Map<string, SessionMeta>()
  /**
   * 提问留痕（本轮，docs/12 §5）：与元信息同一套懒加载 + 脏标记。
   *
   * 单独的 Map 而不是塞进 `meta`：它是**数组**且可能增长，而 `meta` 是"小而稳定"的
   * 开关集合（`isEmptyMeta` 逐字段判空、每次都整份写）。分开之后留痕的有界环与
   * 归档 / 可见性这些开关互不影响。
   */
  private readonly askCache = new Map<string, StoredAskRecord[]>()
  private readonly loaded = new Set<string>()
  /**
   * 首读去重：`id → 读盘中的 promise`（in-flight）。
   *
   * `loaded` 只在**读盘成功之后**才登记，读盘期间用这里复用同一个 promise，
   * 因此不存在「已标记 loaded、内容却还没装填」的中间态（原因见 `ensureLoaded`）。
   */
  private readonly loading = new Map<string, Promise<void>>()
  /** 会话 LRU 访问序：Map 的迭代序即"最久未访问在前" */
  private readonly lastAccess = new Map<string, number>()
  /**
   * 会话摘要缓存（`chat:sessions`）。
   *
   * 键是会话 id，值是**不含 active** 的摘要；任何写盘排队（`scheduleWrite`）都会失效它。
   * 意义：`summaries()` 不必为了算标题 / 条数把每个会话的消息常驻内存，也不会重复读盘。
   */
  private readonly summaryCache = new Map<string, SessionSummary>()
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
    this.maxLoadedSessions = Math.max(1, options.maxLoadedSessions ?? 8)
    this.loadedIdleMs = Math.max(0, options.loadedIdleMs ?? 5 * 60_000)
    this.onWriteError = options.onWriteError
  }

  get directory(): string {
    return this.dir
  }

  /** 当前内存里保留的已装载会话数（诊断 / 单测用；不含只读 meta）。 */
  get loadedSessionCount(): number {
    return this.cache.size
  }

  /**
   * 读取（必要时从磁盘加载）某会话的全部消息。
   *
   * 读盘抛**非「文件不存在」**错误（EPERM / EBUSY / EIO）时原样上抛，不返回空快照 ——
   * 空快照会被后续写盘当成真实内容覆盖掉磁盘历史（见 `readFromDisk`）；调用方重试即可。
   */
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
      // 图片附件路径（多模态输入，docs/06 §3.1）：空数组与缺省同义，不落空键
      ...(message.images === undefined || message.images.length === 0
        ? {}
        : { images: message.images }),
    }
    const current = this.cache.get(id) ?? []
    // 常态原地追加，避免长任务每条消息都复制整个历史数组（O(n²)）。
    // 只有触发条数上限时才走截断并重建数组。
    current.push(stored)
    let messages = current
    if (this.maxMessages > 0 && current.length > this.maxMessages) {
      messages = truncateHistory(current, { maxChars: 0, maxMessages: this.maxMessages }).messages
      this.cache.set(id, messages)
      this.indexMessages(id, messages)
    } else {
      this.cache.set(id, current)
      this.messageOwners.set(stored.id, id)
    }
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

  /**
   * 供 **Center 回放**用的历史（本轮，docs/12 §5）：在 `rendererHistory` 的基础上
   * 把**提问留痕**按 `createdAt` 交错进去，条目带 `kind: 'ask'` 与 `ask` 详情。
   *
   * 为什么不直接改 `rendererHistory`：桌面渲染层的 `chat:history` 也吃那个方法，
   * 而它认识的 `kind` 只有 user / assistant —— 多出来的 ask 条目会在主界面里渲染成
   * 一条空气泡。回放是**另一个消费方**，就单独给一个方法，两边互不影响。
   */
  async rendererHistoryWithAsks(
    sessionId: string,
    limit?: number,
  ): Promise<RendererHistoryEntry[]> {
    const [messages, asks] = await Promise.all([
      this.rendererHistory(sessionId, limit),
      this.asksOf(sessionId),
    ])
    if (asks.length === 0) return messages
    const entries: RendererHistoryEntry[] = [
      ...messages,
      ...asks.map((ask) => ({
        id: `ask-${ask.requestId}`,
        role: 'assistant' as const,
        content: ask.question,
        createdAt: ask.createdAt,
        kind: 'ask' as const,
        ask,
      })),
    ]
    entries.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    return limit !== undefined && limit > 0 ? entries.slice(-limit) : entries
  }

  /**
   * 追问留痕（`meta` 之外的旁路数据）：`undefined` 归一为 `[]`。
   *
   * 与 `modelOverrideOf` 不同，这里走 `ensureLoaded`：调用方都是允许 await 的
   * 回放 / 落痕路径，没有"必须在同步 slot 里取值"的约束。
   */
  async asksOf(sessionId: string): Promise<StoredAskRecord[]> {
    const id = normalizeSessionId(sessionId)
    await this.ensureLoaded(id)
    return [...(this.askCache.get(id) ?? [])]
  }

  /**
   * 追加一条提问留痕（本轮，docs/12 §5）：本地问答结算后由装配层调用。
   *
   * - **有界环**：单会话只保留最近 `MAX_ASK_RECORDS` 条，防止长会话把文件越写越大；
   * - 同一 `requestId` 重复追加按覆盖处理（幂等：结算通知可能重放）；
   * - 先 `ensureLoaded` + **await 写盘完成**（与 `setProject` 同一条铁律）：
   *   装配层是「发一条事件、不管结果」的监听器，若这里只排个微任务就返回，
   *   `flush()`（退出前收尾）有可能在标记脏之前跑过 —— 那条留痕就丢了。
   */
  async appendAskRecord(sessionId: string, record: StoredAskRecord): Promise<void> {
    const id = normalizeSessionId(sessionId)
    await this.ensureLoaded(id)
    const current = this.askCache.get(id) ?? []
    const next = current.filter((item) => item.requestId !== record.requestId)
    next.push(record)
    this.askCache.set(id, next.slice(-MAX_ASK_RECORDS))
    this.dirty.add(id)
    this.scheduleWrite(id, 0)
    await (this.writing.get(id) ?? Promise.resolve())
  }

  /** 供 loop 使用的截断历史（不含本次用户输入）。 */
  async context(sessionId: string, options: TruncateOptions = {}): Promise<StoredMessage[]> {
    const messages = await this.get(sessionId)
    return truncateHistory(messages, options).messages
  }

  /**
   * 按 `(sessionId, imageId)` 查一张对话展示图片。
   *
   * 只从已落盘的 assistant 工具卡里查，不接受调用方给路径；读取侧因此永远拿到
   * 应用记录的图片，而不是一个可被 Center 任意构造的本地路径。
   */
  async displayImageOf(
    sessionId: string,
    imageId: string,
  ): Promise<StoredDisplayImage | undefined> {
    const id = normalizeSessionId(sessionId)
    await this.ensureLoaded(id)
    const targetId = imageId.trim()
    if (targetId === '') return undefined
    for (const message of this.cache.get(id) ?? []) {
      for (const call of message.toolCalls ?? []) {
        const found = storedDisplayImagesOf(call).find((item) => item.id === targetId)
        if (found !== undefined) return { ...found }
      }
    }
    return undefined
  }

  /** 原地更新某条消息里的工具卡片状态（不新增消息）。 */
  async updateToolCall(messageId: string, call: StoredToolCall): Promise<void> {
    const indexedId = this.messageOwners.get(messageId)
    const candidates: Array<[string, StoredMessage[] | undefined]> =
      indexedId === undefined ? [...this.cache.entries()] : [[indexedId, this.cache.get(indexedId)]]
    for (const [id, messages] of candidates) {
      if (messages === undefined) continue
      const target = messages.find((message) => message.id === messageId)
      if (target === undefined) continue
      const calls = target.toolCalls ?? []
      const index = calls.findIndex((item) => item.id === call.id)
      if (index >= 0) calls[index] = { ...call }
      else calls.push({ ...call })
      target.toolCalls = calls
      this.messageOwners.set(messageId, id)
      this.dirty.add(id)
      this.scheduleWrite(id)
      return
    }
  }

  /**
   * 累加一次会话级用量（docs/06 §16.2，本轮）：内核在每轮 usage 事件处调用。
   *
   * - **只加不减**：渲染层的「清空消息区」只清视图不清这里 —— 它统计的是会话一生的消耗；
   * - 写入走 300ms 防抖（与消息落盘同一套脏标记）：每轮一次的频次不需要即时落盘，
   *   异常断电最坏丢最后一轮的累计；
   * - **不 await 写盘**：调用方（内核事件转发路径）是热路径，落盘由防抖与 flush 兜底；
   * - 负数按 0 计（手改文件的防御）：累计值没有「回拨」的合法来源。
   */
  async addUsage(sessionId: string, usage: TokenUsage): Promise<void> {
    const id = normalizeSessionId(sessionId)
    await this.ensureLoaded(id)
    const current = this.metaCache.get(id) ?? {}
    const prev = current.usage
    const next: SessionUsageStats = {
      promptTokens: (prev?.promptTokens ?? 0) + Math.max(0, usage.promptTokens),
      completionTokens: (prev?.completionTokens ?? 0) + Math.max(0, usage.completionTokens),
      totalTokens: (prev?.totalTokens ?? 0) + Math.max(0, usage.totalTokens),
      cachedTokens: (prev?.cachedTokens ?? 0) + Math.max(0, usage.cachedTokens ?? 0),
      rounds: (prev?.rounds ?? 0) + 1,
    }
    this.metaCache.set(id, { ...current, usage: next })
    this.dirty.add(id)
    this.scheduleWrite(id)
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
    for (const message of this.cache.get(id) ?? []) this.messageOwners.delete(message.id)
    this.cache.set(id, [])
    this.loaded.add(id)
    this.dirty.add(id)
    this.scheduleWrite(id, 0)
  }

  /**
   * **真删除**会话（`chat:deleteSession`，docs/08 会话管理页）：删盘上文件 + 清全部内存态。
   *
   * 与 `clear`（只清消息、meta 保留）不同，这是不可逆操作：
   * - **先撤掉防抖定时器与脏标记**：挂着待写状态删文件，紧接着的那次 `writeNow` 会把
   *   内存快照原样写回磁盘，表现为「删了又回来了」；
   * - **再 await 该 id 的在途写盘**（并吞掉它的失败，对照同文件 `setArchived` 的做法）：
   *   定时器与脏标记只挡得住**尚未开始**的写，已经在 `writeFileAtomic` 里的那一次
   *   会在 remove 返回之后把文件重建出来 —— 这是同一条「删了又回来」的另一半；
   * - 文件不存在（从未落盘的空会话）不算错误 —— `fs.remove` 对缺失路径幂等；
   * - 删除失败原样抛出（调用方转 `E_UNKNOWN`），不做静默降级；
   * - 调用方（IPC 层）负责先确认该会话没有在跑的请求 —— 这里只管存储。
   */
  async remove(sessionId: string): Promise<void> {
    const id = normalizeSessionId(sessionId)
    const timer = this.timers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(id)
    }
    this.dirty.delete(id)
    await (this.writing.get(id) ?? Promise.resolve()).catch(() => undefined)
    for (const message of this.cache.get(id) ?? []) this.messageOwners.delete(message.id)
    this.cache.delete(id)
    this.metaCache.delete(id)
    this.askCache.delete(id)
    this.summaryCache.delete(id)
    this.lastAccess.delete(id)
    this.loaded.delete(id)
    this.loading.delete(id)
    await this.fs.remove(sessionFilePath(this.dir, id))
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

  /**
   * 会话绑定的项目 id（docs/06 §5.1 会话级项目，`chat:setSessionProject`）。
   *
   * - **幂等**：目标值与当前值相同（含「都未绑定」）→ 直接返回，不写盘；
   * - 空串 / 全空白 = **清除绑定**（删掉键，不留一个空值）；
   * - 先 `ensureLoaded`：别把已在盘上的消息冲掉（与 `setArchived` 同一条铁律）；
   * - **await 写盘完成**：渲染层拿到 ok 后立刻拉 `chat:sessions` 一定能读到新绑定
   *   （与 `setArchived` 的确定性约定一致）。
   *
   * 给一个从未落盘的空会话绑定项目会首次写出一个只有 meta、`messages: []` 的文件 ——
   * 这是**预期行为**（与归档同款）：绑定本身需要一个落点。
   */
  async setProject(sessionId: string, projectId: string): Promise<void> {
    const id = normalizeSessionId(sessionId)
    await this.ensureLoaded(id)
    const current = this.metaCache.get(id) ?? {}
    const nextId = projectId.trim()
    // 幂等判定按归一后的值：'' 与 undefined 都算「未绑定」，相互设置不算变更
    if ((current.projectId ?? '') === nextId) return

    const next: SessionMeta = { ...current }
    if (nextId === '') delete next.projectId
    else next.projectId = nextId
    this.metaCache.set(id, next)
    this.dirty.add(id)
    this.scheduleWrite(id, 0)
    await (this.writing.get(id) ?? Promise.resolve())
  }

  /**
   * 会话在客户端左栏的可见性（docs/12 §6.3 `session.visibility`，v0.2.3）。
   *
   * - **缺省可见**：undefined 与 true 等价，相互设置不算变更（幂等）；
   * - 置回可见时**删掉键**（不留 `"centerVisible": true` 这种冗余空值，与 `setProject` 同款）；
   * - 先 `ensureLoaded` + **await 写盘完成**：与 `setArchived` / `setProject` 同一条铁律 ——
   *   调用方拿到返回后立刻拉 `summaries()` 一定能读到新状态。
   */
  async setCenterVisible(sessionId: string, visible: boolean): Promise<void> {
    const id = normalizeSessionId(sessionId)
    await this.ensureLoaded(id)
    const current = this.metaCache.get(id) ?? {}
    // 幂等判定按「缺省可见」归一：undefined 与 true 同为可见
    if ((current.centerVisible ?? true) === visible) return

    const next: SessionMeta = { ...current }
    if (visible) delete next.centerVisible
    else next.centerVisible = false
    this.metaCache.set(id, next)
    this.dirty.add(id)
    this.scheduleWrite(id, 0)
    await (this.writing.get(id) ?? Promise.resolve())
  }

  /**
   * 会话级权限档覆盖（docs/06 §11.2 / docs/12 §6.3 `session.setPermission`，v0.2.3）。
   *
   * - **幂等**：与当前覆盖值相同（含「都未覆盖」）→ 直接返回，不写盘；
   * - 只接受三档合法值（readonly / confirm / auto），非法值抛错而不是静默落盘 ——
   *   档位写错会让确认判定落到 undefined 覆盖（等价全局档），看似成功实则没生效；
   * - 先 `ensureLoaded` + **await 写盘完成**（与 `setProject` 同一条铁律）。
   */
  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
    if (mode !== 'readonly' && mode !== 'confirm' && mode !== 'auto') {
      throw new Error(`非法的权限档位：${String(mode)}`)
    }
    const id = normalizeSessionId(sessionId)
    await this.ensureLoaded(id)
    const current = this.metaCache.get(id) ?? {}
    if (current.permissionMode === mode) return

    const next: SessionMeta = { ...current, permissionMode: mode }
    this.metaCache.set(id, next)
    this.dirty.add(id)
    this.scheduleWrite(id, 0)
    await (this.writing.get(id) ?? Promise.resolve())
  }

  /**
   * 会话级权限档覆盖（**异步**，必要时先读盘；undefined = 未覆盖，跟随全局档）。
   *
   * 消费方是装配层 `createConfirmTool` 的 `mode` getter（允许 await 读盘），
   * 与 `projectIdOf` 同款套路 —— 不提供同步版：确认判定允许 await，不需要同步口径。
   */
  async permissionModeOf(sessionId: string): Promise<PermissionMode | undefined> {
    const id = normalizeSessionId(sessionId)
    await this.ensureLoaded(id)
    return this.metaCache.get(id)?.permissionMode
  }

  /**
   * 会话级模型覆盖（docs/06 §3，本轮；`chat:setSessionModel` 与 Center `session.setModel`）。
   *
   * - **幂等**：目标值与当前值相同（含「都未覆盖」）→ 直接返回，不写盘；
   * - `null` / providerId 或 model 为空串 = **清除覆盖**（删键，回落全局 `llm.active`）；
   * - 先 `ensureLoaded`（别把已在盘上的消息冲掉）+ **await 写盘完成**：调用方拿到返回后
   *   立刻拉 `chat:sessions` / `session.list` 一定能读到新覆盖（与 `setProject` 同一条铁律）。
   */
  async setModelOverride(sessionId: string, value: SessionModelOverride | null): Promise<void> {
    const id = normalizeSessionId(sessionId)
    await this.ensureLoaded(id)
    const current = this.metaCache.get(id) ?? {}
    const nextValue = normalizeModelOverride(value)
    if (sameModelOverride(normalizeModelOverride(current.llm), nextValue)) return

    const next: SessionMeta = { ...current }
    if (nextValue === undefined) delete next.llm
    else next.llm = nextValue
    this.metaCache.set(id, next)
    this.dirty.add(id)
    this.scheduleWrite(id, 0)
    await (this.writing.get(id) ?? Promise.resolve())
  }

  /**
   * 会话级模型覆盖（**同步**，只读内存缓存；undefined = 未覆盖，跟随全局）。
   *
   * 为什么必须是同步的：消费方是内核 `send()` 里的 provider 解析点，而那里**不能新增 await**
   * ——`E_BUSY` 检查与 `active.set` 之间一旦有 await，同会话两条请求会双双越过防双跑的
   * 守卫（`send()` 里那段注释说的就是这个）。依赖的装配层不变量与 `projectOf` 同款：
   * **一次会话的发送之前，会话列表必然已装载**（渲染层启动即拉 `chat:sessions` → `summaries()`
   * 逐个 `get()`；Center 的 `session.list` 同款）—— 新建的空会话读不到覆盖，而新会话本来就
   * 不可能有覆盖，因此这条回落是安全的。
   */
  modelOverrideOf(sessionId: string): SessionModelOverride | undefined {
    return normalizeModelOverride(this.metaCache.get(normalizeSessionId(sessionId))?.llm)
  }

  /**
   * 手动压缩留痕（`/compact`，2026-10-03，docs/06 §4）：内核 `agent.compact` 生成摘要后调用。
   *
   * - `compact === null` = 清除留痕（当前无调用方，留给未来的「撤销压缩」）；
   * - 先 `ensureLoaded` + **await 写盘完成**（与 `setProject` 同一条铁律）：
   *   渲染层拿到 ok 后立刻能从 `chat:sessions` / 后续组装读到新状态；
   * - 消息本体**不动**：压缩只是「组装口径」的变化，历史仍完整留在会话文件里。
   */
  async setCompact(sessionId: string, compact: SessionCompact | null): Promise<void> {
    const id = normalizeSessionId(sessionId)
    await this.ensureLoaded(id)
    const current = this.metaCache.get(id) ?? {}
    const next: SessionMeta = { ...current }
    if (compact === null) delete next.compact
    else next.compact = compact
    this.metaCache.set(id, next)
    this.dirty.add(id)
    this.scheduleWrite(id, 0)
    await (this.writing.get(id) ?? Promise.resolve())
  }

  /** 手动压缩留痕（**异步**，必要时先读盘；undefined = 从未手动压缩过）。 */
  async compactOf(sessionId: string): Promise<SessionCompact | undefined> {
    const id = normalizeSessionId(sessionId)
    await this.ensureLoaded(id)
    return this.metaCache.get(id)?.compact
  }

  /**
   * 会话空间（docs/06 §4 会话三分）。
   *
   * - **幂等**：与当前空间相同（含「都是未标记」）→ 直接返回，不写盘；
   * - 只认 `'agent' | 'work'`（`'code'` 预留未启用），非法值抛错而不是静默落盘 ——
   *   与 `setPermissionMode` 同一条口径：空间写错会让工作目录 / 权限边界落到错误分区；
   * - 先 `ensureLoaded` + **await 写盘完成**（与 `setProject` 同一条铁律）。
   *
   * 给从未落盘的空会话调它**会**首次写出只有 meta 的文件（与归档 / 绑定项目同款）——
   * 「新会话带空间」请走 `createSession({ space })`：那条路只写内存缓存、不置脏标记，
   * 空会话永远不会落盘。
   */
  async setSpace(sessionId: string, space: SessionSpace): Promise<void> {
    if (space !== 'agent' && space !== 'work') {
      throw new Error(`非法的会话空间：${String(space)}`)
    }
    const id = normalizeSessionId(sessionId)
    await this.ensureLoaded(id)
    const current = this.metaCache.get(id) ?? {}
    // 幂等判定按「缺省 agent」归一：undefined 与 'agent' 等价，相互设置不算变更
    if ((current.space ?? 'agent') === space) return

    const next: SessionMeta = { ...current }
    if (space === 'agent') delete next.space
    else next.space = space
    this.metaCache.set(id, next)
    this.dirty.add(id)
    this.scheduleWrite(id, 0)
    await (this.writing.get(id) ?? Promise.resolve())
  }

  /**
   * 会话绑定的项目 id（**同步**，只读内存缓存；'' / undefined 一律归一为 undefined）。
   *
   * 为什么是同步的：工具执行链上的端口边界（`file-port` / `command-runner` 的
   * `workspaceRoot`）与缺省 cwd 都是**同步 getter**，等不了一次读盘。
   * 这依赖一条装配层不变量：**会话的工具执行之前，`agentLoop` 已经 `sessions.get(sessionId)`**
   * （`KernelAgentHost.run()` 组装历史时必然发生），因此执行期缓存必然已装载 ——
   * 不确定装载与否的异步路径（确认钩子 / 指令注入）请用 `projectIdOf`。
   */
  projectOf(sessionId: string): string | undefined {
    const projectId = this.metaCache.get(normalizeSessionId(sessionId))?.projectId
    return projectId === undefined || projectId === '' ? undefined : projectId
  }

  /** 异步版 `projectOf`：必要时先读盘再取（确认钩子 / 指令注入等允许 await 的路径用）。 */
  async projectIdOf(sessionId: string): Promise<string | undefined> {
    const id = normalizeSessionId(sessionId)
    await this.ensureLoaded(id)
    return this.projectOf(id)
  }

  /**
   * 会话空间（**同步**，只读内存缓存；undefined 归一为 `'agent'`，docs/06 §4）。
   *
   * 与 `projectOf` 同一条装配层不变量（工具执行前会话必然已装载），消费方是
   * `main/tools/session-project.ts` 的空间回落级 —— 同步 getter，等不了一次读盘。
   */
  spaceOf(sessionId: string): SessionSpace {
    return this.metaCache.get(normalizeSessionId(sessionId))?.space ?? 'agent'
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
    const normalizedActive = activeId === undefined ? undefined : normalizeSessionId(activeId)
    const items: SessionSummary[] = []
    for (const id of await this.listSessions()) {
      // 摘要缓存命中：不读盘、不装载消息（写盘排队时会被 `scheduleWrite` 失效）
      const cached = this.summaryCache.get(id)
      if (cached !== undefined) {
        items.push(this.withActive(cached, normalizedActive))
        continue
      }
      // 未装载过的会话只**临时**装载：算完摘要立刻释放消息数组（`metaCache` 保留），
      // 避免 `chat:sessions` 把磁盘上每个会话的全部消息都常驻内存。
      const wasLoaded = this.cache.has(id)
      // 逐条隔离（P2-01 的配套）：读盘错误在 `get()` 上**如实上抛**是对的方向，但聚合层
      // 不能被单点拖垮 —— 否则一个文件被瞬时占用（Windows 杀软 / 同步盘）就会让整个
      // `chat:sessions` 返回 E_UNKNOWN、左栏一条都不显示。失败者跳过（下次访问自愈）。
      let messages: StoredMessage[]
      try {
        messages = await this.get(id)
      } catch (error) {
        this.logger.warn('会话摘要读取失败，已跳过该条', {
          sessionId: id,
          error: error instanceof Error ? error.message : String(error),
        })
        continue
      }
      const summary = this.buildSummary(id, messages, this.metaCache.get(id) ?? {})
      this.summaryCache.set(id, summary)
      if (!wasLoaded) this.releaseTransient(id)
      items.push(this.withActive(summary, normalizedActive))
    }
    return items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  /** 摘要的 `active` 只属于**当前这次调用**，不写进 `summaryCache`（否则会串台）。 */
  private withActive(summary: SessionSummary, activeId: string | undefined): SessionSummary {
    return activeId === undefined ? { ...summary } : { ...summary, active: summary.id === activeId }
  }

  private buildSummary(id: string, messages: StoredMessage[], meta: SessionMeta): SessionSummary {
    const firstUser = messages.find((message) => message.role === 'user')
    const last = messages[messages.length - 1]
    const projectId = this.projectOf(id)
    return {
      id,
      title: titleFor(firstUser),
      updatedAt: last?.createdAt ?? createdAtFromId(id) ?? new Date(0).toISOString(),
      messageCount: messages.filter(
        (message) => message.role === 'user' || message.role === 'assistant',
      ).length,
      ...(meta.archived === undefined ? {} : { archived: meta.archived }),
      ...(projectId === undefined ? {} : { projectId }),
      // 远程会话管理（docs/12 §6.3）：visibility 缺省可见（undefined = 不带键），
      // permissionMode 缺省跟随全局（同样不带键）
      ...(meta.centerVisible === undefined ? {} : { centerVisible: meta.centerVisible }),
      ...(meta.permissionMode === undefined ? {} : { permissionMode: meta.permissionMode }),
      // 会话级模型覆盖（docs/06 §3，本轮）：未覆盖不带键（= 跟随全局，与 projectId 同款「有键才有值」）
      ...(meta.llm === undefined ? {} : { llm: meta.llm }),
      // 会话空间（docs/06 §4）：未标记 = Agent 空间，不带键（与 projectId 同款「有键才有值」）
      ...(meta.space === undefined ? {} : { space: meta.space }),
      // 会话级用量累计（docs/06 §16.2，本轮）：从未回传过 usage 的会话不带键
      ...(meta.usage === undefined ? {} : { usage: meta.usage }),
    }
  }

  /**
   * 新建一个空会话并返回其 id。
   *
   * 只生成 id 并标记为已加载（空数组）：文件在首条消息落盘时才真正创建，
   * 避免用户连点「新建」在磁盘上堆一批空文件。
   *
   * `options.space`（docs/06 §4 会话三分）：**只写内存 metaCache、不置脏标记** ——
   * 左栏 Agent / Work 分区的新建入口因此能在列表里立即按空间分组，而空会话
   * 永远不会落盘（连「只有 meta 的文件」都不会出现）；首条消息 append 落盘时
   * meta 随消息一起写入。重启后未发过消息的空间会话随之消失（与空会话同命，符合预期）。
   */
  async createSession(options?: { space?: SessionSpace }): Promise<string> {
    const id = normalizeSessionId(`chat-${Date.now().toString(36)}-${(this.counter += 1)}`)
    if (!this.loaded.has(id)) {
      this.loaded.add(id)
      this.cache.set(id, [])
    }
    this.touch(id)
    const space = options?.space
    // 只为 'work' 落缓存键：'agent' 是缺省空间（`spaceOf` 已归一），写 `{ space: 'agent' }`
    // 会让 summaries / isEmptyMeta 出现「有键但无信息量」的空值键
    if (space === 'work') {
      this.metaCache.set(id, { space })
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

  /**
   * 懒加载：并发首读共享同一次读盘（in-flight promise map），**读盘成功后才置 `loaded`**。
   *
   * 为什么不能"先置 loaded 再 await 读盘"（本方法原先的写法）：
   * `loaded.add(id)` 与读盘之间隔着一次 await，在这个窗口里第二个调用者会看到 `loaded` 命中、
   * 于是立刻返回——但它拿到的 `cache.get(id)` 还是**空快照**。
   * 最典型的时序是 `Promise.all([get(id), append(id, msg)])`：`get` 发起读盘，
   * `append` 在窗口内基于空快照算出 next（只有新消息、没有磁盘历史）并排好写盘，
   * 紧接着读盘结果 `cache.set(id, messages)` 把新消息冲掉（或反过来：写盘把磁盘历史整体改写）——
   * 两个方向都是**永久数据丢失**，而且只在首次访问某个会话时偶发。
   *
   * 现在：读盘中的 promise 放进 `loading`，并发调用复用它（同一 id 只读一次盘）；
   * 读盘成功才登记 `loaded`；`finally` 里清掉 map 条目，失败时下次访问能重新读盘
   * （降级口径见 `readFromDisk`：只有**文件确实不存在**才返回空会话，「读错误」原样上抛，
   * 调用方（`get` / `append` / `summaries`…）拿到的是异常而不是一份空快照）。
   */
  private async ensureLoaded(id: string): Promise<void> {
    if (this.loaded.has(id)) {
      this.touch(id)
      return
    }
    const inFlight = this.loading.get(id)
    // 已有在途读盘：直接复用它，既不重复读盘也不提前置 loaded
    if (inFlight !== undefined) return inFlight
    // 这里必须「先声明、后赋值」：`isCurrent` 闭包要按**身份**比对「我这条还在不在 loading
    // 里」，而它引用的正是这个 promise 自身 —— 写成 `const task = …` 会在初始值里引用自己。
    let task: Promise<void>
    // 传 `isCurrent`：`remove()` 会把本 id 的 `loading` 条目删掉，读盘完成后据此丢弃结果，
    // 避免「先删会话、后读到盘」把已删会话复活（与 P2-02 是同一家族的另一半）。
    // eslint-disable-next-line prefer-const -- 自引用闭包，见上（`prefer-const` 报在赋值行）
    task = this.loadFromDisk(id, () => this.loading.get(id) === task).finally(() => {
      if (this.loading.get(id) === task) this.loading.delete(id)
    })
    this.loading.set(id, task)
    return task.then(() => {
      this.touch(id)
      this.evictIfOverCapacity()
    })
  }

  /**
   * 真正读盘并装填 `cache` / `metaCache`（由 `ensureLoaded` 去重后调用）。
   *
   * 装填是**合并**而不是覆盖：读盘期间可能有并发写已经落进 `cache`（`append` 等），
   * 直接 `cache.set(id, messages)` 会把它们冲掉，紧接着那一次写盘就会把这份内存快照
   * 写回磁盘——既丢新消息、又把磁盘上的历史改写成"读盘那一刻"的旧快照。
   * 合并口径：磁盘历史为底（顺序原样保留），cache 里磁盘没有的按原顺序补在后面；
   * 同 id 视为同一条，取 cache 里那份（它可能已被 `updateToolCall` 就地更新过，状态更新）。
   */
  private async loadFromDisk(id: string, isCurrent?: () => boolean): Promise<void> {
    const { messages, meta, asks } = await this.readFromDisk(id)
    // 读盘期间被 `remove()` 删掉了：`remove` 已清 cache/metaCache/loaded 并删了文件，
    // 这里再 `set` 会把已删会话以**完整内容**复活在内存（幽灵条目，直到重启）。
    // 判据是「`loading` 里那一条还是不是本次这个 task」—— `remove()` 会把它删掉。
    if (isCurrent !== undefined && !isCurrent()) return
    const cached = this.cache.get(id)
    this.cache.set(
      id,
      cached === undefined || cached.length === 0 ? messages : mergeMessages(messages, cached),
    )
    this.indexMessages(id, this.cache.get(id) ?? [])
    // meta 同理：读盘期间写下的 meta（归档等）比盘上那份新，不能反过来覆盖它
    if (!this.metaCache.has(id)) this.metaCache.set(id, meta)
    // 留痕按 requestId 合并：读盘期间新结算的那条不能被盘上那份盖掉（与 meta 同一顾虑）
    const cachedAsks = this.askCache.get(id)
    this.askCache.set(id, cachedAsks === undefined ? asks : mergeAsks(asks, cachedAsks))
    this.loaded.add(id)
  }

  // ───────────────────────── 内存有界（2026-10-04 性能轮） ─────────────────────────

  /** 标记一次访问（LRU：Map 迭代序即最久未访问在前） */
  private touch(id: string): void {
    this.lastAccess.delete(id)
    this.lastAccess.set(id, Date.now())
  }

  /**
   * 超过上限时淘汰最久未访问的会话。
   *
   * 三条不可淘汰：脏的 / 有待写定时器的 / 正在读盘的 —— 淘汰它们会让「内存快照」丢失或
   * 让写盘拿到不完整数据（`append` / `updateToolCall` 依赖 cache 里有完整历史）。
   * 刻意**不看 `writing`**：那张 map 保留的是已结算的 promise（串行写盘队列的队尾），
   * 拿它当"在写盘"判据会让淘汰永远不生效；真正的在途写在 `dirty` 清除前都受保护。
   * 另外只在空闲超过 `loadedIdleMs` 后动手，避开「加载完立刻被另一条异步链淘汰」的竞态。
   */
  private evictIfOverCapacity(): void {
    if (this.cache.size <= this.maxLoadedSessions) return
    const now = Date.now()
    for (const id of [...this.cache.keys()]) {
      if (this.cache.size <= this.maxLoadedSessions) break
      if (this.dirty.has(id) || this.timers.has(id)) continue
      if (this.loading.has(id)) continue
      if (now - (this.lastAccess.get(id) ?? 0) < this.loadedIdleMs) continue
      this.evictSession(id)
    }
  }

  /** 只丢消息数组与留痕（`metaCache` 保留：归档 / 项目 / 用量都是小对象，重读成本不值当） */
  private evictSession(id: string): void {
    for (const message of this.cache.get(id) ?? []) this.messageOwners.delete(message.id)
    this.cache.delete(id)
    this.askCache.delete(id)
    this.loaded.delete(id)
    this.lastAccess.delete(id)
  }

  /**
   * 释放「只为算一次摘要而临时装载」的会话。
   *
   * `summaries()` 专用：调用前记录 `wasLoaded`，未装载过的会话读盘算完摘要后立刻释放，
   * 这样 `chat:sessions` 的内存占用与磁盘会话总量脱钩（2026-10-04 性能轮）。
   * 脏 / 有待写定时器 / 在读的一律不释放，语义与 `evictIfOverCapacity` 一致。
   */
  private releaseTransient(id: string): void {
    if (this.dirty.has(id) || this.timers.has(id)) return
    if (this.loading.has(id)) return
    this.evictSession(id)
  }

  /**
   * 读盘：消息与会话级 meta 一次读出（两者在同一个文件里，没有理由读两遍）。
   *
   * 宽容口径（docs/06 §4）：
   * - 文件**确实不存在** → 空 messages + 空 meta（首次运行，不是错误）；
   * - 读取异常（EPERM / EBUSY / EIO —— Windows 上杀软与同步盘短暂锁文件现实存在）→
   *   **原样上抛**，由 `ensureLoaded` 保证「不置 loaded、下次访问重试」（P2-01）：
   *   在这里返回空快照会被当成装载成功，紧接着那一次写盘就用「只有新消息」的 payload
   *   把会话文件整体覆盖掉 —— 这正是「空快照冲盘」家族（对照 `jobs/store.ts` 的 `isAbsent`）；
   * - `messages` 不是数组 → 走既有损坏备份路径（文件结构已不可信）；
   * - `meta` 畸形（不是对象 / 是数组 / 字段类型不对）→ 只当空 meta，**备份都不做** ——
   *   meta 是新加的旁路信息，绝不能因为它坏了就把整份会话备份重建（那等于丢消息）。
   */
  /**
   * 读盘：消息 / 会话级 meta / 提问留痕一次读出（三者都在同一个文件里，没有理由读三遍）。
   *
   * 宽容口径（docs/06 §4）：
   * - 文件**确实不存在** → 空 messages + 空 meta + 空 asks（首次运行，不是错误）；
   * - 读取异常（EPERM / EBUSY / EIO —— Windows 上杀软与同步盘短暂锁文件现实存在）→
   *   **原样上抛**，由 `ensureLoaded` 保证「不置 loaded、下次访问重试」（P2-01）：
   *   在这里返回空快照会被当成装载成功，紧接着那一次写盘就用「只有新消息」的 payload
   *   把会话文件整体覆盖掉 —— 这正是「空快照冲盘」家族（对照 `jobs/store.ts` 的 `isAbsent`）；
   * - `messages` 不是数组 → 走既有损坏备份路径（文件结构已不可信）；
   * - `meta` / `asks` 畸形（不是对象 / 是数组 / 字段类型不对）→ 只当空值，**备份都不做** ——
   *   两者都是新加的旁路信息，绝不能因为它们坏了就把整份会话备份重建（那等于丢消息）。
   */
  private async readFromDisk(
    id: string,
  ): Promise<{ messages: StoredMessage[]; meta: SessionMeta; asks: StoredAskRecord[] }> {
    const path = sessionFilePath(this.dir, id)
    let raw: string
    try {
      raw = await this.fs.readFile(path)
    } catch (error) {
      if (await this.isAbsent(path, error)) return { messages: [], meta: {}, asks: [] }
      throw error
    }

    try {
      const parsed: unknown = JSON.parse(raw)
      const messages = (parsed as StoredSession | null)?.messages
      if (!Array.isArray(messages)) throw new Error('messages 不是数组')
      const session = parsed as StoredSession | null
      return {
        messages: messages.filter(isStoredMessage),
        meta: normalizeMeta(session?.meta),
        asks: normalizeAsks(session?.asks),
      }
    } catch (error) {
      this.logger.error('会话文件解析失败，已备份并重建', { sessionId: id, error: String(error) })
      await this.backupCorrupt(id, path)
      return { messages: [], meta: {}, asks: [] }
    }
  }

  /**
   * 读盘异常是否表示「文件**确实不存在**」（对照 `jobs/store.ts` 的同名方法）。
   *
   * 三层判定，从严到宽：
   * 1. `error.code === 'ENOENT'` —— 真实文件系统的标准口径；
   * 2. 端口没带 `code`（内存文件系统 / 某些包装层）时报文里点名 ENOENT / no such file；
   * 3. 退一步向端口问一次 `exists`：**答"不存在"才算缺失**；
   *    探测本身抛错按「不是缺失」处理（宁可上抛走下次重试，也不冒险用空快照冲盘）。
   */
  private async isAbsent(path: string, error: unknown): Promise<boolean> {
    if (errorCodeOf(error) === 'ENOENT') return true
    if (/ENOENT|no such file|not exist/i.test(messageOf(error))) return true
    try {
      return !(await this.fs.exists(path))
    } catch {
      return false
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
    // 任何写盘排队都意味着会话内容 / meta 可能已变：摘要缓存必须失效，
    // 否则 `chat:sessions` 会回旧标题 / 旧条数 / 旧归档标记。
    this.summaryCache.delete(id)
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

  private indexMessages(id: string, messages: readonly StoredMessage[]): void {
    for (const [messageId, owner] of this.messageOwners) {
      if (owner === id) this.messageOwners.delete(messageId)
    }
    for (const message of messages) this.messageOwners.set(message.id, id)
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
        const asks = this.askCache.get(id) ?? []
        const payload: StoredSession = {
          version: SESSION_FILE_VERSION,
          sessionId: id,
          updatedAt: new Date().toISOString(),
          messages: this.cache.get(id) ?? [],
          // 空 meta 不写这个键：老文件（v1）的形状保持不变，不让每个会话文件都多一行 `"meta": {}`
          ...(isEmptyMeta(meta) ? {} : { meta }),
          // 提问留痕（本轮）：没有留痕就不写键，老文件形状照旧
          ...(asks.length === 0 ? {} : { asks }),
        }
        try {
          await this.fs.writeFileAtomic(
            sessionFilePath(this.dir, id),
            `${JSON.stringify(payload, null, 2)}\n`,
          )
        } catch (error) {
          const wrapped = error instanceof Error ? error : new Error(String(error))
          // 只在**会话还在缓存里**时重新点亮脏标记：写盘失败与 `remove()` 并发时，
          // `remove()` 已经清过 dirty 并删了文件 —— 无脑 `add` 会让退出前的 `flush()`
          // 用空 messages 把刚删掉的会话**重建**成空文件（「删了又回来」的另一半）。
          if (this.cache.has(id)) this.dirty.add(id) // 保持脏标记，下次重试
          this.logger.error('会话写入失败', { sessionId: id, error: wrapped.message })
          this.onWriteError?.(wrapped)
        }
      })
    this.writing.set(id, run)
    return run
  }
}

/**
 * 读盘结果与「读盘期间写进 cache 的消息」合并（`loadFromDisk` 用）。
 *
 * 以磁盘为底而不是以 cache 为底：磁盘那段是已经发生过的历史，必须原序保留；
 * cache 里多出来的这些正是读盘窗口内新追加的消息，按追加顺序补在后面
 * （反过来把新消息排到历史前面，会让 `summaries()` 的"首条用户消息作标题"
 * 与上下文顺序一起错位）。同 id 取 cache 那份：它可能已被 `updateToolCall` 更新过状态。
 */
function mergeMessages(disk: StoredMessage[], cached: StoredMessage[]): StoredMessage[] {
  const fromCache = new Map(cached.map((message) => [message.id, message]))
  const merged = disk.map((message) => fromCache.get(message.id) ?? message)
  const seen = new Set(disk.map((message) => message.id))
  for (const message of cached) {
    if (seen.has(message.id)) continue
    seen.add(message.id)
    merged.push(message)
  }
  return merged
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
  if (typeof candidate['projectId'] === 'string') meta.projectId = candidate['projectId']
  if (typeof candidate['centerVisible'] === 'boolean') {
    meta.centerVisible = candidate['centerVisible']
  }
  // 权限档只认三档合法值：老文件 / 手改文件里的畸形值按「未覆盖」处理（宽容归化）
  const permissionMode = candidate['permissionMode']
  if (permissionMode === 'readonly' || permissionMode === 'confirm' || permissionMode === 'auto') {
    meta.permissionMode = permissionMode
  }
  // 会话空间只认已启用的两个取值（'code' 预留未启用）；畸形值按未标记（Agent 空间）处理
  const space = candidate['space']
  if (space === 'agent' || space === 'work') meta.space = space
  // 会话级模型覆盖：必须是 `{ providerId, model }` 两个非空字符串（缺一个按「未覆盖」归化，
  // 与写入侧 normalizeModelOverride 同口径）—— 半截条目会让解析链取错 provider 的参数表
  const llm = candidate['llm']
  if (typeof llm === 'object' && llm !== null && !Array.isArray(llm)) {
    const override = normalizeModelOverride(llm as SessionModelOverride)
    if (override !== undefined) meta.llm = override
  }
  // 会话级用量累计（docs/06 §16.2，本轮）：四个数值字段齐全且非负才算有效，
  // 半截 / 畸形条目整段丢弃（= 没有累计），不猜测、不半截通过
  const usage = normalizeUsageStats(candidate['usage'])
  if (usage !== undefined) meta.usage = usage
  // 手动压缩留痕（/compact，本轮）：三个字段齐全且 summary 非空才算有效
  const compact = normalizeCompact(candidate['compact'])
  if (compact !== undefined) meta.compact = compact
  return meta
}

/** 用量累计归化（读取侧 `normalizeMeta` 与写入侧 `addUsage` 共用一条口径） */
function normalizeUsageStats(value: unknown): SessionUsageStats | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  const promptTokens = candidate['promptTokens']
  const completionTokens = candidate['completionTokens']
  const totalTokens = candidate['totalTokens']
  const cachedTokens = candidate['cachedTokens']
  const rounds = candidate['rounds']
  if (
    typeof promptTokens !== 'number' ||
    !Number.isFinite(promptTokens) ||
    promptTokens < 0 ||
    typeof completionTokens !== 'number' ||
    !Number.isFinite(completionTokens) ||
    completionTokens < 0 ||
    typeof totalTokens !== 'number' ||
    !Number.isFinite(totalTokens) ||
    totalTokens < 0 ||
    typeof cachedTokens !== 'number' ||
    !Number.isFinite(cachedTokens) ||
    cachedTokens < 0 ||
    typeof rounds !== 'number' ||
    !Number.isFinite(rounds) ||
    rounds < 0
  ) {
    return undefined
  }
  return { promptTokens, completionTokens, totalTokens, cachedTokens, rounds }
}

/** 压缩留痕归化（`normalizeMeta` 用）：summary 非空 + at / upToMessageId 齐全才算有效 */
function normalizeCompact(value: unknown): SessionCompact | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  const summary = candidate['summary']
  const at = candidate['at']
  const upToMessageId = candidate['upToMessageId']
  if (
    typeof summary !== 'string' ||
    summary.trim() === '' ||
    typeof at !== 'string' ||
    typeof upToMessageId !== 'string' ||
    upToMessageId === ''
  ) {
    return undefined
  }
  return { summary, at, upToMessageId }
}

/**
 * 归一模型覆盖：`(providerId, model)` **两个都非空**才算有效，任一缺失 / 空白按「未覆盖」。
 *
 * 归一收在一处（读取侧 `normalizeMeta` 与写入侧 `setModelOverride` 共用），
 * 否则「写进一个空串 providerId」会让文件里多一条半截记录、幂等判定也判不准。
 */
function normalizeModelOverride(
  value: SessionModelOverride | null | undefined,
): SessionModelOverride | undefined {
  if (value === null || value === undefined) return undefined
  const providerId = typeof value.providerId === 'string' ? value.providerId.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (providerId === '' || model === '') return undefined
  return { providerId, model }
}

/** 模型覆盖相等判定（undefined 与 undefined 相等；用于 `setModelOverride` 的幂等短路） */
function sameModelOverride(
  left: SessionModelOverride | undefined,
  right: SessionModelOverride | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.providerId === right.providerId && left.model === right.model
}

/**
 * 提问留痕归化：逐条走**白名单**，畸形条目整条丢弃（不猜测、不半截通过）。
 *
 * 与 `normalizeMeta` 同一条宽容哲学：留痕是旁路信息，坏掉只当没有，
 * 绝不能因此把整份会话当损坏备份重建（那等于丢消息）。
 */
function normalizeAsks(value: unknown): StoredAskRecord[] {
  if (!Array.isArray(value)) return []
  const records: StoredAskRecord[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const candidate = item as unknown as Record<string, unknown>
    const requestId = candidate['requestId']
    const question = candidate['question']
    const createdAt = candidate['createdAt']
    const settledAt = candidate['settledAt']
    if (
      typeof requestId !== 'string' ||
      requestId === '' ||
      typeof question !== 'string' ||
      typeof createdAt !== 'string' ||
      typeof settledAt !== 'string'
    ) {
      continue
    }
    const outcome = candidate['outcome']
    const answers = stringListOf(candidate['answers'])
    records.push({
      requestId,
      question,
      ...(typeof candidate['header'] === 'string' ? { header: candidate['header'] } : {}),
      ...(normalizeOptions(candidate['options']) === undefined
        ? {}
        : { options: normalizeOptions(candidate['options'])! }),
      multiSelect: candidate['multiSelect'] === true,
      answers: answers ?? [],
      ...(stringMatrixOf(candidate['answersByQuestion']) === undefined
        ? {}
        : { answersByQuestion: stringMatrixOf(candidate['answersByQuestion'])! }),
      outcome:
        outcome === 'skipped' || outcome === 'timedOut' || outcome === 'aborted'
          ? outcome
          : 'answered',
      createdAt,
      settledAt,
    })
  }
  return records
}

/** 字符串数组（缺省 / 畸形一律 undefined，由调用方决定怎么兜） */
function stringListOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.every((item) => typeof item === 'string') ? [...(value as string[])] : undefined
}

/** 二维字符串数组（多问的分组作答） */
function stringMatrixOf(value: unknown): string[][] | undefined {
  if (!Array.isArray(value)) return undefined
  const groups: string[][] = []
  for (const group of value) {
    const parsed = stringListOf(group)
    if (parsed === undefined) return undefined
    groups.push(parsed)
  }
  return groups
}

/** 选项归化（label 必须是非空字符串；description 可选） */
function normalizeOptions(value: unknown): { label: string; description?: string }[] | undefined {
  if (!Array.isArray(value)) return undefined
  const options: { label: string; description?: string }[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const candidate = item as unknown as Record<string, unknown>
    const label = candidate['label']
    if (typeof label !== 'string' || label === '') continue
    options.push({
      label,
      ...(typeof candidate['description'] === 'string'
        ? { description: candidate['description'] }
        : {}),
    })
  }
  return options
}

/**
 * 留痕合并（读盘 vs 内存）：盘上那份为底，内存里盘上没有的按原顺序补在后面。
 *
 * 与 `mergeMessages` 同一意图：读盘期间新结算的那条（内存里）不能被盘上的旧快照盖掉。
 */
function mergeAsks(onDisk: StoredAskRecord[], cached: StoredAskRecord[]): StoredAskRecord[] {
  if (cached.length === 0) return onDisk
  const seen = new Set(onDisk.map((item) => item.requestId))
  const merged = [...onDisk]
  for (const record of cached) {
    if (seen.has(record.requestId)) continue
    seen.add(record.requestId)
    merged.push(record)
  }
  return merged.slice(-MAX_ASK_RECORDS)
}

/**
 * 空 meta（无字段或字段全 undefined / 空串）判定：决定要不要往 payload 里写 `meta` 键。
 *
 * `projectId` 按归一口径参与判定：空串与 undefined 一样算「未绑定」，
 * 不让 `"projectId": ""` 这种空值把每个会话文件都多写一行。
 */
function isEmptyMeta(meta: SessionMeta): boolean {
  return (
    meta.archived === undefined &&
    meta.archivedAt === undefined &&
    meta.pinned === undefined &&
    (meta.projectId === undefined || meta.projectId === '') &&
    // centerVisible 只有 false 才有信息量（true = 缺省可见），setCenterVisible 写入侧已归一；
    // 这里再兜一道：不让 `"centerVisible": true` 把每个会话文件多写一行
    meta.centerVisible === undefined &&
    meta.permissionMode === undefined &&
    // llm 只有写入了有效覆盖才有信息量；setModelOverride 写入侧已归一，这里再兜一道
    meta.llm === undefined &&
    // usage 四个字段全 0（rounds 也为 0）与「从未累计」等价，不落键
    (meta.usage === undefined ||
      (meta.usage.promptTokens === 0 &&
        meta.usage.completionTokens === 0 &&
        meta.usage.totalTokens === 0 &&
        meta.usage.cachedTokens === 0 &&
        meta.usage.rounds === 0)) &&
    meta.compact === undefined &&
    // space 只有 'work' 才有信息量（'agent' = 缺省空间），setSpace / createSession 写入侧已归一
    (meta.space === undefined || meta.space === 'agent')
  )
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
  const visibleInput = rendererToolInput(call, input)
  return {
    id: call.id,
    name: call.name,
    ...(visibleInput === undefined ? {} : { input: visibleInput }),
    state: call.state,
    ...(call.outputSummary === undefined ? {} : { outputSummary: call.outputSummary }),
    ...(call.startedAt === undefined ? {} : { startedAt: call.startedAt }),
    ...(call.endedAt === undefined ? {} : { endedAt: call.endedAt }),
    ...(call.subagent === undefined ? {} : { subagent: call.subagent }),
    ...(storedDisplayImagesOf(call).length === 0
      ? {}
      : {
          displayImages: storedDisplayImagesOf(call).map((item) => ({
            id: item.id,
            name: item.name,
            mime: item.mime,
            ...(item.caption === undefined ? {} : { caption: item.caption }),
          })),
        }),
  }
}

/** `show_image` 的 path 只留在会话存储内部，跨 IPC / Center 的投影不含本地路径。 */
function rendererToolInput(call: StoredToolCall, input: unknown): unknown {
  if (call.name !== 'show_image') return input
  const record =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined
  const caption = typeof record?.['caption'] === 'string' ? record['caption'].trim() : ''
  const name = call.displayImages?.[0]?.name
  if (caption === '' && name === undefined) return undefined
  return {
    ...(caption === '' ? {} : { caption }),
    ...(name === undefined ? {} : { name }),
  }
}

/** 工具卡里的展示图片白名单归化：畸形条目整条丢弃，不把半截数据送进渲染层。 */
function storedDisplayImagesOf(call: StoredToolCall): StoredDisplayImage[] {
  if (!Array.isArray(call.displayImages)) return []
  const images: StoredDisplayImage[] = []
  for (const item of call.displayImages) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const candidate = item as unknown as Record<string, unknown>
    if (
      typeof candidate['id'] !== 'string' ||
      candidate['id'] === '' ||
      typeof candidate['path'] !== 'string' ||
      candidate['path'] === '' ||
      typeof candidate['name'] !== 'string' ||
      candidate['name'] === '' ||
      typeof candidate['mime'] !== 'string' ||
      candidate['mime'] === ''
    ) {
      continue
    }
    images.push({
      id: candidate['id'],
      path: candidate['path'],
      name: candidate['name'],
      mime: candidate['mime'],
      ...(typeof candidate['caption'] === 'string' && candidate['caption'].trim() !== ''
        ? { caption: candidate['caption'] }
        : {}),
    })
  }
  return images
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

/** 异常上的 `code`（`node:fs` 的 ENOENT / EPERM / EBUSY / EIO 都在这条链上） */
function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
