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
} from '@aurora/shared'
import type { Logger } from '@aurora/shared'
import { createNoopLogger } from '@aurora/shared'
import { DEFAULT_MAX_MESSAGES, truncateHistory, type TruncateOptions } from './history.js'
import {
  SESSION_FILE_VERSION,
  type NewMessage,
  type SessionMeta,
  type SessionSpace,
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
  /**
   * 首读去重：`id → 读盘中的 promise`（in-flight）。
   *
   * `loaded` 只在**读盘成功之后**才登记，读盘期间用这里复用同一个 promise，
   * 因此不存在「已标记 loaded、内容却还没装填」的中间态（原因见 `ensureLoaded`）。
   */
  private readonly loading = new Map<string, Promise<void>>()
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
        ...(this.projectOf(id) === undefined ? {} : { projectId: this.projectOf(id) }),
        // 远程会话管理（docs/12 §6.3）：visibility 缺省可见（undefined = 不带键），
        // permissionMode 缺省跟随全局（同样不带键）
        ...(meta.centerVisible === undefined ? {} : { centerVisible: meta.centerVisible }),
        ...(meta.permissionMode === undefined ? {} : { permissionMode: meta.permissionMode }),
        // 会话空间（docs/06 §4）：未标记 = Agent 空间，不带键（与 projectId 同款「有键才有值」）
        ...(meta.space === undefined ? {} : { space: meta.space }),
      })
    }
    return items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
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
   * （失败降级口径仍由 `readFromDisk` 负责，这里不新造错误）。
   */
  private async ensureLoaded(id: string): Promise<void> {
    if (this.loaded.has(id)) return
    const inFlight = this.loading.get(id)
    // 已有在途读盘：直接复用它，既不重复读盘也不提前置 loaded
    if (inFlight !== undefined) return inFlight
    const task = this.loadFromDisk(id).finally(() => {
      this.loading.delete(id)
    })
    this.loading.set(id, task)
    return task
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
  private async loadFromDisk(id: string): Promise<void> {
    const { messages, meta } = await this.readFromDisk(id)
    const cached = this.cache.get(id)
    this.cache.set(
      id,
      cached === undefined || cached.length === 0 ? messages : mergeMessages(messages, cached),
    )
    // meta 同理：读盘期间写下的 meta（归档等）比盘上那份新，不能反过来覆盖它
    if (!this.metaCache.has(id)) this.metaCache.set(id, meta)
    this.loaded.add(id)
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
  return meta
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
