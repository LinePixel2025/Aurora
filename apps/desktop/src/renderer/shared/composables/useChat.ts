/**
 * 对话状态（P3：真实内核 + 会话水合）。
 *
 * 与主进程的契约：`chat:send` → `chat:event` 流式事件 + `chat:history` 水合。
 * 事件按 `sessionId` 过滤，并按 `requestId` 丢弃**已结束请求的迟到事件**
 * （docs/06 §16.1：`done` / `error` 之后同一 requestId 的事件一律是陈旧事件）。
 *
 * 多会话并行（2026-11-07，docs/06 §4.3）：内核本就允许不同会话同时各跑一个请求；
 * 本模块为**每个会话**保存一份运行态（`ChatSessionRuntime`，纯逻辑见 `chatRuntime.ts`），
 * 事件按 `sessionId` 归属、请求级过滤（`finishedRequests` / `activeRequest`）也是每会话一套。
 * 当前会话只是把对应那份**投影**到界面：切会话不搬状态、不清空，后台会话的流式内容因此
 * 不会丢；切回正在跑的会话立刻是完整内容 + 「停止」可用。另有轻量的活动态
 * （`SessionActivity`）供左栏状态点 / 后台汇总使用，不随运行态淘汰而丢失。
 *
 * 多会话下的两条额外口径：
 * - 隐藏后台会话（`auto-` / `awareness-` / `-sub`）不在 chat 里累积运行态；
 * - 运行态最多保留 `RUNTIME_CACHE_LIMIT` 个（LRU，当前 / 流式中的永不淘汰），已结束会话
 *   被淘汰后切回时由 `chat:history` 水合恢复，活动态（未读 / 失败点）独立保留。
 */
import { computed, onScopeDispose, reactive, ref } from 'vue'
import { deepClone } from '@aurora/shared/browser'
import type {
  AgentJob,
  ChangedFileInfo,
  ChatMessageDto,
  ChatSessionSummary,
  ChatTurnChangesPayload,
  SendMessageRequest,
  WindowName,
} from '@aurora/shared'
import { createDeltaBuffer } from '@aurora/shared/browser'
import {
  activityTone,
  applyActivityEvent,
  applyChatEvent,
  applyStreamDelta,
  createSessionActivity,
  createSessionRuntime,
  evictRuntimeIds,
  isHiddenSessionId,
  markActivityViewed,
  mergeHydratedMessages,
  rebuildHistoricalSubagents,
  seedActivityRunning,
  toChatMessage,
  type ChatDelta,
  type ChatSessionRuntime,
  type ChatMessage,
  type QueuedDraft,
  type SessionActivity,
  type SessionStateTone,
  type SubagentRun,
} from './chatRuntime.js'

export type { ChatMessage, QueuedDraft, SubagentRun } from './chatRuntime.js'
export {
  matchUserMessageEcho,
  PENDING_REASON_TEXT,
  USER_MESSAGE_ECHO_WINDOW_MS,
} from './chatRuntime.js'

/** 当前窗口的会话上下文（原为窗口名映射；mini-chat 删除后改为显式声明，会话 id 保持不变） */
export type ChatContext = 'main' | 'quick' | 'settings'

/**
 * 上下文 → 会话 id。
 *
 * 映射刻意保持不变（`quick` / `main` / `settings`）：老会话文件继续可读。
 */
export function sessionIdFor(context: ChatContext): string {
  if (context === 'quick') return 'quick'
  if (context === 'main') return 'main'
  return 'settings'
}

/**
 * 轮终改动汇总的**模块级缓存**（2026-11-07，docs/06 §4.2）。
 *
 * 主进程在一条请求正常收敛后推 `chat:turnChanges`；这里按 `(sessionId, requestId)` 存下来，
 * **不按当前会话过滤**（事件对非当前会话也会到，切走再切回仍要能显示）。不落会话文件、
 * 重启即失 —— 与 DSH 的改动文件卡片同款口径。
 *
 * 有界：最多 200 条，超出按插入序丢最旧（长会话 / 多会话同开时不至于无界增长）。
 */
const turnChangesCache = new Map<
  string,
  { sessionId: string; requestId: string; files: readonly ChangedFileInfo[] }
>()
const TURN_CHANGES_CACHE_LIMIT = 200
const turnChangesVersion = ref(0)

function turnChangesKey(sessionId: string, requestId: string): string {
  return `${sessionId}\u0000${requestId}`
}

export function cacheTurnChanges(payload: ChatTurnChangesPayload): void {
  if (payload.files.length === 0) return
  const key = turnChangesKey(payload.sessionId, payload.requestId)
  turnChangesCache.delete(key)
  turnChangesCache.set(key, {
    sessionId: payload.sessionId,
    requestId: payload.requestId,
    files: payload.files,
  })
  while (turnChangesCache.size > TURN_CHANGES_CACHE_LIMIT) {
    const oldest = turnChangesCache.keys().next().value
    if (oldest === undefined) break
    turnChangesCache.delete(oldest)
  }
  turnChangesVersion.value += 1
}

/**
 * 读某个会话的轮终改动（requestId → files）。
 *
 * 读 `turnChangesVersion` 是**有意的**：模块级 Map 不是响应式的，写缓存后自增一次版本，
 * 让调用它的 computed 重算。单测也可以直接调它（不依赖 Vue 组件）。
 */
export function readTurnChanges(sessionId: string): Map<string, readonly ChangedFileInfo[]> {
  void turnChangesVersion.value
  const map = new Map<string, readonly ChangedFileInfo[]>()
  for (const entry of turnChangesCache.values()) {
    if (entry.sessionId !== sessionId) continue
    map.set(entry.requestId, entry.files)
  }
  return map
}

/** 没有运行态时的稳定空数组（computed 不返回新引用，避免每帧触发下游重算） */
const EMPTY_MESSAGES: ChatMessage[] = []

/** 后台会话列表刷新的防抖间隔（done / error 后对齐时间 / 排序 / running） */
const SESSIONS_REFRESH_DEBOUNCE_MS = 250

/**
 * `windowName` 仍然保留：它是 `chat:send` 的 `origin`（`SendMessageRequest.origin` 是 `WindowName`），
 * 主进程据此判断消息来自哪个窗口；会话 id 由显式的 `context` 决定。
 */
export function useChat(windowName: WindowName, context: ChatContext) {
  const defaultSessionId = sessionIdFor(context)
  /** 当前会话 id（可切换）。会话运行态独立保存，切换只改这个 ref。 */
  const sessionId = ref(defaultSessionId)
  /** 会话 id → 运行态（响应式 Map；值在创建时已 reactive，所有读写都经 Map.get） */
  const runtimes = reactive(new Map<string, ChatSessionRuntime>())
  /** 会话 id → 活动态（轻量、不随运行态淘汰；左栏状态点 / 后台汇总） */
  const activities = reactive(new Map<string, SessionActivity>())
  const sessions = ref<ChatSessionSummary[]>([])
  /** 已计入 `usage.totals` 的 `(requestId, round)`：全局一份（键本身全局唯一） */
  const countedUsage = new Set<string>()

  function ensureRuntime(id = sessionId.value): ChatSessionRuntime {
    const existing = runtimes.get(id)
    if (existing !== undefined) return existing
    const created = reactive(createSessionRuntime(id)) as ChatSessionRuntime
    runtimes.set(id, created)
    return created
  }

  function ensureActivity(id = sessionId.value): SessionActivity {
    const existing = activities.get(id)
    if (existing !== undefined) return existing
    const created = reactive(createSessionActivity()) as SessionActivity
    activities.set(id, created)
    return created
  }

  // 当前会话的投影（切会话只改 sessionId，下面这些 computed 自动指向新的运行态）
  const currentRuntime = computed<ChatSessionRuntime | undefined>(() =>
    runtimes.get(sessionId.value),
  )
  const messages = computed<ChatMessage[]>(() => currentRuntime.value?.messages ?? EMPTY_MESSAGES)
  const streaming = computed<boolean>(() => currentRuntime.value?.streaming ?? false)
  /** 当前会话的错误提示：可写（附件 / 语音等壳层错误也走这条通道） */
  const error = computed<string | null>({
    get: () => currentRuntime.value?.error ?? null,
    set: (value) => {
      ensureRuntime().error = value
    },
  })
  const unread = computed<boolean>({
    get: () => currentRuntime.value?.unread ?? false,
    set: (value) => {
      ensureRuntime().unread = value
    },
  })
  const pendingNotice = computed<string | null>(() => currentRuntime.value?.pendingNotice ?? null)
  const usage = computed(() => currentRuntime.value?.usage ?? EMPTY_USAGE)
  const jobs = computed<AgentJob[]>(() => currentRuntime.value?.jobs ?? EMPTY_JOBS)
  /** 正在接收思考过程的助手消息 id（供 MessageList 自动展开思考块）；空闲时为 null */
  const reasoningTargetId = computed<string | null>(
    () => currentRuntime.value?.reasoningTargetId ?? null,
  )
  /** 最近一次「本轮收尾」的 requestId（done / error 置位，含非本窗口发起的轮次） */
  const lastSettledRequestId = computed<string | null>(
    () => currentRuntime.value?.lastSettledRequestId ?? null,
  )
  const lastSettledAt = computed<number | null>(() => currentRuntime.value?.lastSettledAt ?? null)
  const latestTurnGroupable = computed<boolean>(
    () => currentRuntime.value?.latestTurnGroupable ?? true,
  )

  const statusTone = computed<'idle' | 'running' | 'unread' | 'error'>(() => {
    if (error.value) return 'error'
    if (streaming.value) return 'running'
    if (unread.value) return 'unread'
    return 'idle'
  })

  const lastAssistant = computed(() => {
    const list = messages.value
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const message = list[index]
      if (message && message.role === 'assistant') return message
    }
    return null
  })

  /** 「子代理」页面用：本会话的子代理运行（新的在前，实时 + 历史快照合并） */
  const subagentRuns = computed<SubagentRun[]>(() => {
    const rt = currentRuntime.value
    if (rt === undefined) return []
    // 显式读取版本号：索引是非响应式 Map，只有真正改变时才重新合并排序。
    void rt.historicalSubagentsVersion
    const merged = new Map<string, SubagentRun>()
    for (const run of rt.liveSubagents) {
      merged.set(run.callId === '' ? run.taskId : run.callId, run)
    }
    for (const [key, run] of rt.historicalSubagents) {
      if (merged.has(key)) continue
      merged.set(key, run)
    }
    return [...merged.values()].sort((left, right) => right.startedAt - left.startedAt)
  })

  /** 当前会话的轮终改动（requestId → files）。`turnChangesVersion` 只是触发器。 */
  const turnChangesForSession = computed<ReadonlyMap<string, readonly ChangedFileInfo[]>>(() =>
    readTurnChanges(sessionId.value),
  )

  // ───────────────────────── 后台活动（左栏状态点 / 头部汇总） ─────────────────────────

  /** 非当前会话的状态点数据（running > error > unread；无状态不出现） */
  const sessionStates = computed<Record<string, SessionStateTone>>(() => {
    const record: Record<string, SessionStateTone> = {}
    for (const [id, activity] of activities) {
      if (id === sessionId.value || isHiddenSessionId(id)) continue
      const tone = activityTone(activity)
      if (tone !== undefined) record[id] = tone
    }
    return record
  })

  const backgroundRunningCount = computed<number>(() => {
    let count = 0
    for (const [id, activity] of activities) {
      if (id !== sessionId.value && !isHiddenSessionId(id) && activity.running) count += 1
    }
    return count
  })

  const backgroundUnreadCount = computed<number>(() => {
    let count = 0
    for (const [id, activity] of activities) {
      if (id === sessionId.value || isHiddenSessionId(id) || activity.running) continue
      if (activity.unread || activity.attention !== null) count += 1
    }
    return count
  })

  /** 头部汇总药丸的 `title`：列出有状态会话的标题（最多 5 个，其余「等 N 个」） */
  const backgroundSessionTitles = computed<string[]>(() => {
    const titles: string[] = []
    for (const [id, activity] of activities) {
      if (id === sessionId.value || isHiddenSessionId(id)) continue
      if (!activity.running && !activity.unread && activity.attention === null) continue
      const title = sessions.value.find((item) => item.id === id)?.title?.trim() ?? ''
      titles.push(title === '' ? id : title)
    }
    return titles
  })

  /**
   * 流式增量的按帧合并缓冲。
   *
   * 一个 SSE token = 一次 IPC 推送；text / reasoning 只入队，真正的累加合并到**下一帧**
   * 一次做完（每帧一次组件渲染）。值里带 `sessionId`：帧回调按它找回**自己的**运行态，
   * 因此后台会话的增量不会写进当前会话。
   *
   * 隐藏窗口的兜底：页面不可见时 rAF 可能整帧暂停，缓冲区会一直涨；改用 16ms 定时器，
   * 恢复可见时再 flush（见下方的 visibilitychange 监听）。
   */
  const deltaFrameScheduler = {
    requestFrame: (callback: () => void): number =>
      document.visibilityState === 'hidden'
        ? window.setTimeout(callback, 16)
        : window.requestAnimationFrame(callback),
    cancelFrame: (handle: number): void => {
      window.cancelAnimationFrame(handle)
      window.clearTimeout(handle)
    },
  }
  const deltaBuffer = createDeltaBuffer<ChatDelta>((batches) => {
    for (const batch of batches) {
      for (const delta of batch.values) {
        const rt = runtimes.get(delta.sessionId)
        if (rt === undefined) continue
        applyStreamDelta(rt, delta)
      }
    }
  }, deltaFrameScheduler)

  /** 页面重新可见：把隐藏期间按定时器积压的增量立刻落地一次 */
  function onVisibilityChange(): void {
    if (document.visibilityState === 'visible') deltaBuffer.flush()
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  // ───────────────────────── 事件订阅 ─────────────────────────

  /** 喂给事件 reducer 的上下文（每次现取当前会话，避免闭包旧值） */
  function eventContext(): {
    currentSessionId: string
    countedUsage: Set<string>
    jobOrigin: AgentJob['origin']
    now: () => number
  } {
    return {
      currentSessionId: sessionId.value,
      countedUsage,
      jobOrigin: windowName === 'edge-bar' ? 'edge-bar' : 'chat',
      now: () => Date.now(),
    }
  }

  /** 会话收尾后的对齐：只有「本地可能缺前半段」的当前会话才自愈水合；任何会话都防抖重拉列表 */
  function onRequestSettled(rt: ChatSessionRuntime): void {
    if (sessionId.value === rt.id && rt.resyncOnSettle) {
      rt.resyncOnSettle = false
      void hydrateRuntime(rt.id, { force: true })
    }
    scheduleSessionsRefresh()
    evictIdleRuntimes()
  }

  const disposeEvent = window.aurora.chat.onEvent((event) => {
    const eventSessionId = event.type === 'job' ? event.job.sessionId : event.sessionId

    // 隐藏后台会话（自动化 / 文件自感知 / 子代理）不在 chat 里累积运行态；当前会话例外
    if (eventSessionId !== sessionId.value && isHiddenSessionId(eventSessionId)) return

    // 迟到事件（该会话的这个请求已收尾）：既不该重新点亮活动态，也不该进消息区。
    // job 事件例外：暂停恰恰发生在 done 之后（见 `applyChatEvent` 的同款注释）。
    const tracked = runtimes.get(eventSessionId)
    if (event.type !== 'job' && tracked?.finishedRequests.has(event.requestId) === true) return

    // 活动态先记：即使后面被「请求级过滤」丢掉（排队满的 error 等），左栏状态也要准
    applyActivityEvent(ensureActivity(eventSessionId), event, {
      currentSessionId: sessionId.value,
      now: () => Date.now(),
    })

    // 远程会话（center-*，docs/12 §5）由网页端发起：会话在主进程落盘后，本窗口的
    // 会话列表可能还没拉到它 —— 事件来自列表里没有的会话时补拉一次。代次守卫挡住
    // 流式期间的高频重入把旧列表写回。
    if (
      eventSessionId !== sessionId.value &&
      !sessions.value.some((item) => item.id === eventSessionId)
    ) {
      void refreshSessionsForUnknown()
    }

    // 当前会话与非当前会话走**同一条** reducer：事件落到它自己的运行态。后台会话的内容
    // 因此在本窗口内持续累积，切回时不会缺前半段（2026-11-07 起不再整条丢弃）。
    const rt = ensureRuntime(eventSessionId)
    // 非增量事件先把在途增量刷出去：它们的语义与顺序必须逐字不变 —— 尤其 `done` 读的是
    // 消息终态（正文是否为空、还有没有 pending），不先 flush 就会在「正文还在缓冲里」时
    // 判定成「暂无回复」。
    if (event.type !== 'text' && event.type !== 'reasoning') deltaBuffer.flush()

    const effect = applyChatEvent(rt, event, eventContext())
    if (!effect.accepted) return

    if (event.type === 'text' || event.type === 'reasoning') {
      deltaBuffer.push(event.messageId, {
        kind: event.type,
        sessionId: eventSessionId,
        messageId: event.messageId,
        requestId: event.requestId,
        seq: event.seq,
        delta: event.delta,
      })
    }
    // 面板只显示当前会话的任务：别的会话的 job 事件只更新它自己的运行态
    if (effect.refreshJobs && eventSessionId === sessionId.value) void refreshJobs()
    if (event.type === 'done' || event.type === 'error') onRequestSettled(rt)
  })

  // ───────────────────────── 远程 / 列表推送 ─────────────────────────

  /**
   * 远程会话激活（docs/12 §6.3 `chat:remoteActivate`）：Center 网页端要求客户端主界面
   * 切到指定会话时，主进程向本窗口推送 `{ sessionId }`。推送前主进程已对该会话
   * `sessions.get()` 兜底装载（未落盘的登记为空会话），因此这里直接走现成
   * `switchSession` 就能走通「网页端打开一个历史 center- 会话」。
   */
  const disposeRemoteActivate = window.aurora.chat.onRemoteActivate((event) => {
    void activateRemoteSession(event.sessionId)
  })

  /** 远程会话可见性变更：重拉列表（不切换当前会话） */
  const disposeCenterVisibility = window.aurora.chat.onCenterVisibilityChanged(() => {
    void loadSessions()
  })

  /** 会话删除推送：重拉列表；若删的是当前会话按「最近会话 / 新建」回落 */
  const disposeSessionDeleted = window.aurora.chat.onSessionDeleted((event) => {
    void handleSessionDeleted(event.sessionId)
  })

  /** 会话自动标题推送：原位更新左栏，不重新水合、不切换 */
  const disposeSessionTitle = window.aurora.chat.onSessionTitleChanged((event) => {
    const target = sessions.value.find((item) => item.id === event.sessionId)
    if (target !== undefined) {
      target.title = event.title
      return
    }
    void loadSessions()
  })

  /** 轮终改动汇总：**不按当前会话过滤**，切回该会话要能立刻显示卡片 */
  const disposeTurnChanges = window.aurora.chat.onTurnChanges((payload) => {
    cacheTurnChanges(payload)
  })

  let sessionsRefreshTimer: number | null = null

  /** done / error 后防抖重拉列表：左栏时间 / 排序 / running 与主进程对齐 */
  function scheduleSessionsRefresh(): void {
    if (sessionsRefreshTimer !== null) window.clearTimeout(sessionsRefreshTimer)
    sessionsRefreshTimer = window.setTimeout(() => {
      sessionsRefreshTimer = null
      void loadSessions()
    }, SESSIONS_REFRESH_DEBOUNCE_MS)
  }

  function dispose(): void {
    deltaBuffer.flush()
    deltaBuffer.dispose()
    disposeEvent()
    disposeRemoteActivate()
    disposeCenterVisibility()
    disposeSessionDeleted()
    disposeSessionTitle()
    disposeTurnChanges()
    if (sessionsRefreshTimer !== null) {
      window.clearTimeout(sessionsRefreshTimer)
      sessionsRefreshTimer = null
    }
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }

  onScopeDispose(dispose)

  // ───────────────────────── 会话列表 / 水合 ─────────────────────────

  // ───────────────────────── 任务（Job，docs/06 §4.1） ─────────────────────────

  /** 拉取当前会话的任务列表；失败保留旧列表（一次 IPC 抖动不该把面板清空） */
  async function refreshJobs(): Promise<void> {
    const target = sessionId.value
    const rt = ensureRuntime(target)
    const result = await window.aurora.chat.jobs({ sessionId: target })
    if (!result.ok) {
      window.console?.warn('任务列表读取失败', result.message)
      return
    }
    if (sessionId.value !== target) return
    rt.jobs = result.value
  }

  /**
   * 续跑一条暂停的任务（`chat:resumeJob`）：主进程从 `cursor.nextRound` 接着跑，
   * 成功后重拉列表 —— 状态一律以主进程为准，渲染层不做乐观改写。
   */
  async function resumeJob(jobId: string): Promise<void> {
    let result: Awaited<ReturnType<typeof window.aurora.chat.resumeJob>>
    try {
      result = await window.aurora.chat.resumeJob({ sessionId: sessionId.value, jobId })
    } catch (cause) {
      error.value = String(cause)
      return
    }
    if (!result.ok) {
      error.value = result.message
      return
    }
    await refreshJobs()
  }

  /** 取消一条在跑 / 排队 / 暂停的任务（`chat:cancelJob`）；回执口径同上。 */
  async function cancelJob(jobId: string): Promise<void> {
    let result: Awaited<ReturnType<typeof window.aurora.chat.cancelJob>>
    try {
      result = await window.aurora.chat.cancelJob({ sessionId: sessionId.value, jobId })
    } catch (cause) {
      error.value = String(cause)
      return
    }
    if (!result.ok) {
      error.value = result.message
      return
    }
    await refreshJobs()
  }

  /**
   * 归档 / 取消归档一个会话，随后重拉列表（分组由渲染层按 `archived` 判定）。
   *
   * 主进程侧幂等且 await 落盘完成，因此紧接的 `loadSessions()` 一定读到新状态。
   * 刻意**不碰**当前会话的运行态：归档只是标记，正在看的会话留在原地继续可读。
   */
  async function setArchived(targetId: string, archived: boolean): Promise<boolean> {
    let result: Awaited<ReturnType<typeof window.aurora.chat.archiveSession>>
    try {
      result = await window.aurora.chat.archiveSession({ sessionId: targetId, archived })
    } catch (cause) {
      error.value = String(cause)
      return false
    }
    if (!result.ok) {
      error.value = result.message
      return false
    }
    await loadSessions()
    return true
  }

  /** 绑定 / 解绑一个会话的项目（docs/06 §5.1），随后重拉列表；`projectId` 空串 = 清除。 */
  async function setSessionProject(targetId: string, projectId: string): Promise<boolean> {
    let result: Awaited<ReturnType<typeof window.aurora.chat.setSessionProject>>
    try {
      result = await window.aurora.chat.setSessionProject({ sessionId: targetId, projectId })
    } catch (cause) {
      error.value = String(cause)
      return false
    }
    if (!result.ok) {
      error.value = result.message
      return false
    }
    await loadSessions()
    return true
  }

  /**
   * 拉取会话列表（挂载 / 切会话 / 归档 / 删除后对齐）。
   *
   * - `running` 来自主进程 `agent.isBusy`：**只作初值 / 兜底**。为 true 时给活动态种下
   *   「在跑」，并让当前会话的 runtime 也进入流式态（窗口创建前就开跑 / 渲染层重载后
   *   「停止」仍可用）；**不拿 false 反向覆盖**本地事件已建立的状态（IPC 快照可能早于事件）。
   * - 当前会话的用量累计以落盘 `meta.usage` 为种子恢复（覆盖而非相加，meta 恒 ≥ 已计入部分）。
   * - 并发拉取用**代次**收口：后发的请求覆盖先发的（只在「最新一次」上写状态），
   *   避免切会话 / 防抖刷新 / 标题推送交叠时把旧列表覆盖回来。
   */
  let sessionsFetchGeneration = 0
  let sessionsAppliedGeneration = 0
  async function loadSessions(): Promise<void> {
    sessionsFetchGeneration += 1
    const generation = sessionsFetchGeneration
    const result = await window.aurora.chat.sessions()
    if (!result.ok) {
      window.console?.warn('会话列表读取失败', result.message)
      return
    }
    // 更晚发起的拉取已经先返回并写过状态：本次结果作废
    if (generation < sessionsAppliedGeneration) return
    sessionsAppliedGeneration = generation
    sessions.value = result.value.map((item) => ({
      ...item,
      active: item.id === sessionId.value,
    }))
    for (const item of result.value) {
      if (item.running !== true) continue
      seedActivityRunning(ensureActivity(item.id))
      if (item.id !== sessionId.value) continue
      const rt = ensureRuntime(item.id)
      // 本地不知道它在跑（窗口创建前就开跑 / 渲染层重载）：早几片增量可能没收到，
      // 收尾后用水合补齐（resyncOnSettle）
      if (!rt.streaming) {
        rt.streaming = true
        rt.resyncOnSettle = true
      }
    }
    seedUsageFromSummary(sessions.value.find((item) => item.id === sessionId.value))
  }

  /**
   * 未知会话事件触发的列表补拉（center-* 远程会话可见性机制）。
   * 流式期间同一会话的事件逐 token 到达，`loadSessions` 的代次守卫保证不会把旧列表写回。
   */
  async function refreshSessionsForUnknown(): Promise<void> {
    await loadSessions()
  }

  /** 以会话摘要里带出的 `meta.usage` 为种子恢复累计（切回 / 首次装载时调用） */
  function seedUsageFromSummary(summary: ChatSessionSummary | undefined): void {
    const stats = summary?.usage
    if (stats === undefined) return
    const rt = ensureRuntime()
    rt.usage = {
      ...rt.usage,
      totals: {
        promptTokens: stats.promptTokens,
        completionTokens: stats.completionTokens,
        totalTokens: stats.totalTokens,
        cachedTokens: stats.cachedTokens,
      },
    }
  }

  /** 切换 / 清空时复位「最近一轮」用量（累计不丢：切回由 meta 种子恢复） */
  function resetUsage(rt: ChatSessionRuntime): void {
    rt.usage = {
      latest: null,
      totals: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
    }
  }

  /** 每个会话同一时刻只跑一次 `chat:history`（切会话 + 收尾自愈可能撞车） */
  const hydrating = new Map<string, Promise<void>>()

  /**
   * 水合指定会话的历史（默认当前会话）。
   *
   * - `options.force`：绕过 `hydrated` 守卫强制重拉（切会话 / 收尾自愈）；
   * - `options.limit`：只拉最近 N 条（220px 提示条面板装不下长历史）。
   * - 合并走 `mergeHydratedMessages`：服务端快照与本地运行态**按消息 id 合并**，
   *   本地流式状态（pending / error / 附件 / 思考）优先保留。
   */
  async function hydrateRuntime(
    target: string,
    options?: { force?: boolean; limit?: number },
  ): Promise<void> {
    const rt = ensureRuntime(target)
    if (options?.force !== true && rt.hydrated) return
    rt.hydrated = true
    // 整表替换之前先把在途增量落地，否则它们会在新数组里凭空插一条旧消息
    deltaBuffer.flush()
    const inflight = hydrating.get(target)
    if (inflight !== undefined) {
      await inflight
      if (options?.force !== true) return
    }
    const run = (async () => {
      const result = await window.aurora.chat.history({
        sessionId: target,
        ...(options?.limit === undefined ? {} : { limit: options.limit }),
      })
      if (!result.ok) {
        window.console?.warn('会话历史读取失败', result.message)
        return
      }
      const server = result.value.map(toChatMessage)
      rt.messages = mergeHydratedMessages(server, rt.messages)
      rebuildHistoricalSubagents(rt)
    })()
    hydrating.set(target, run)
    try {
      await run
    } finally {
      hydrating.delete(target)
    }
  }

  async function hydrate(options?: { force?: boolean; limit?: number }): Promise<void> {
    await hydrateRuntime(sessionId.value, options)
  }

  /**
   * 只读拉取「快速会话」的最近几条（交互窗侧栏「快速」栏用）。
   * 刻意**不碰**当前会话的运行态：快速会话是独立于当前会话的预览。
   */
  async function loadQuickPreview(): Promise<ChatMessageDto[]> {
    const result = await window.aurora.chat.history({ sessionId: 'quick', limit: 5 })
    if (!result.ok) {
      window.console?.warn('快速会话预览读取失败', result.message)
      return []
    }
    return result.value
  }

  /** 标记某会话已查看：清当前 runtime 的 unread + 活动态的未读 / 失败点 */
  function markViewed(id: string): void {
    const rt = runtimes.get(id)
    if (rt !== undefined) rt.unread = false
    const activity = activities.get(id)
    if (activity !== undefined) markActivityViewed(activity)
  }

  /** LRU 淘汰已结束会话的运行态（当前 / 流式 / 有暂停提示的永不淘汰） */
  function evictIdleRuntimes(): void {
    const ids = evictRuntimeIds([...runtimes.entries()], sessionId.value)
    for (const id of ids) runtimes.delete(id)
  }

  /**
   * 处理 `chat:sessionDeleted`（docs/07 §2.3/P2-22）。
   *
   * 先重拉列表，再判断当前会话是否被删：**不是** → 只刷新左栏；**是** → 按「左栏最近
   * 一条会话回落」，列表里再没有别的会话时新建。`quick` 不作为回落目标。删除同时清掉
   * 该会话的运行态与活动态（否则 id 被复用时会继承旧状态）。
   */
  async function handleSessionDeleted(deletedId: string): Promise<void> {
    try {
      runtimes.delete(deletedId)
      activities.delete(deletedId)
      await loadSessions()
      if (sessionId.value !== deletedId) return
      const next = sessions.value.find((item) => item.id !== deletedId && item.id !== 'quick')
      if (next === undefined) {
        await newSession()
        return
      }
      await switchSession(next.id)
    } catch (cause) {
      window.console?.warn('会话删除后的回落失败', deletedId, cause)
    }
  }

  /** 执行一次远程激活：目标会话不在本地列表时先补拉一次；失败只 warn，界面留在原会话 */
  async function activateRemoteSession(id: string): Promise<void> {
    try {
      if (!sessions.value.some((item) => item.id === id)) await refreshSessionsForUnknown()
      await switchSession(id)
    } catch (cause) {
      window.console?.warn('远程会话激活失败', id, cause)
    }
  }

  /**
   * 切换到指定会话。**不再清空任何运行态**（2026-11-07）：消息、在途请求、已完成请求集合、
   * 排队草稿、子代理都留在目标会话自己的运行态里；只做「标记已读 + 强制水合 + 拉列表 / 任务」。
   */
  async function switchSession(id: string): Promise<void> {
    if (id === sessionId.value) {
      markViewed(id)
      return
    }
    deltaBuffer.flush()
    sessionId.value = id
    const rt = ensureRuntime(id)
    markViewed(id)
    // 切回来时如果活动态说它还在跑（事件可能早于本窗口的订阅），立刻恢复流式态：
    // 输入区的「停止 / 打断并发送」不等下一次事件就该可用。本地此前不知道它在跑 →
    // 早几片增量可能没收到，收尾后用水合补齐完整回复（resyncOnSettle）。
    if (activities.get(id)?.running === true) {
      if (!rt.streaming) {
        rt.streaming = true
        rt.resyncOnSettle = true
      }
    }
    // 切回时旧错误提示不再重复弹：失败现场由消息气泡 / 左栏状态承担
    rt.error = null
    // 暂停提示是「上一次收尾」的一次性交代：切会话即清（与旧口径一致；任务面板仍显示 paused）
    rt.pendingNotice = null
    await hydrateRuntime(id, { force: true })
    await loadSessions()
    // 任务列表与消息一起水合：暂停的长任务必须在切进这个会话时就看得见
    await refreshJobs()
    evictIdleRuntimes()
  }

  /**
   * 新建会话并切过去。新会话此时还没有标题，发完第一条消息后列表会刷新。
   * `options` 透传给 `chat:newSession`（`space` / `projectId`，docs/06 §4 会话三分）。
   */
  async function newSession(options?: {
    space?: 'agent' | 'work'
    projectId?: string
  }): Promise<void> {
    const result = await window.aurora.chat.newSession(options)
    if (!result.ok) {
      error.value = result.message
      return
    }
    await switchSession(result.value)
  }

  // ───────────────────────── 发送 / 中止 / 压缩 ─────────────────────────

  /**
   * 发送一条消息。
   *
   * 返回 `'sent'`（立即开始）/ `'queued'`（会话正忙，已排进内核队列）/ `'rejected'`
   * （**没有发出去**：调用方要把文本收回输入框）。
   */
  async function send(
    text: string,
    attachments: string[] = [],
  ): Promise<'sent' | 'queued' | 'rejected'> {
    const rt = ensureRuntime()
    const trimmed = text.trim()
    if (trimmed === '' && attachments.length === 0) return 'rejected'
    // 流式期间再发一条 = 插话排队（docs/06 §5.3）
    const queueing = rt.streaming
    const names = attachments.map(fileNameOf)
    const draftId = `u-${Date.now()}-${rt.messages.length}`
    rt.messages.push({
      id: draftId,
      role: 'user',
      content: trimmed,
      createdAt: Date.now(),
      ...(names.length === 0 ? {} : { attachments: names }),
    })

    /** 这次发送没有出路：摘掉气泡再落一条失败提示（留着气泡比报错更糟） */
    const reject = (message: string): 'rejected' => {
      const index = rt.messages.findIndex((item) => item.id === draftId)
      if (index >= 0) rt.messages.splice(index, 1)
      rt.queuedDrafts.delete(draftId)
      rt.messages.push({
        id: `e-${Date.now()}`,
        role: 'assistant',
        content: `发送失败：${message}`,
        error: true,
        createdAt: Date.now(),
      })
      // 排队的这条被拒时**不能动 streaming**（会抹掉正在跑的那次请求的界面状态）
      if (!queueing) {
        rt.streaming = false
        rt.error = message
      }
      return 'rejected'
    }

    if (!queueing) {
      rt.error = null
      rt.pendingNotice = null
      rt.streaming = true
      rt.unread = false
      rt.lastSettledAt = null
      rt.latestTurnGroupable = false
      rt.activeRequest = null
      rt.assistantId = null
      rt.reasoningTargetId = null
    }

    const request: SendMessageRequest = {
      sessionId: sessionId.value,
      text: trimmed,
      origin: windowName,
      // `attachments` 来自 `ref<string[]>`，是 Vue 的 reactive Proxy —— 结构化克隆不能传 Proxy
      ...(attachments.length === 0 ? {} : { attachments: deepClone(attachments) }),
    }
    let result: Awaited<ReturnType<typeof window.aurora.chat.send>>
    try {
      result = await window.aurora.chat.send(request)
    } catch (cause) {
      return reject(String(cause))
    }
    if (!result.ok) return reject(result.message)

    // 排队：这次没有开新请求，流式状态仍归正在跑的那一次，一律不碰
    if (result.value.queued === true) {
      const bubble = rt.messages.find((item) => item.id === draftId)
      if (bubble) bubble.queued = true
      rt.queuedDrafts.set(draftId, { text: trimmed, attachments: [...attachments] })
      return 'queued'
    }
    // 显式 `false` = 队列已满（内核同时广播 E_QUEUE_FULL，但那条事件按 activeRequest 过滤
    // 到不了这里）：气泡上的失败提示是用户唯一能看见的交代
    if (result.value.queued === false) return reject('排队已满，请等当前任务告一段落或先停止')

    rt.activeRequest = result.value.requestId
    return 'sent'
  }

  /**
   * 手动压缩当前会话上下文（`/compact`）：结果以一条系统提示落进消息区。
   * 刻意**不走 `send()`**：压缩不产生流式回复，走发送链会把输入区永远停在「流式中」。
   */
  async function compactContext(): Promise<void> {
    const rt = ensureRuntime()
    if (rt.streaming) return
    const target = sessionId.value
    let result: Awaited<ReturnType<typeof window.aurora.chat.compact>>
    try {
      result = await window.aurora.chat.compact(target)
    } catch (cause) {
      rt.error = String(cause)
      return
    }
    if (sessionId.value !== target) return
    if (result.ok) {
      rt.messages.push({
        id: `c-${Date.now()}`,
        role: 'system',
        content: `上下文已压缩：${result.value.coveredMessages} 条消息压成 ${result.value.summaryChars} 字摘要，之后的请求只携带压缩点之后的内容（历史消息仍可在本会话回看）。`,
        createdAt: Date.now(),
      })
      return
    }
    rt.error = result.message
  }

  /**
   * 停止当前回复。
   *
   * 优先用事件补上的 `activeRequest`（远端 / Center 请求也可停）；没有时退回最近见过的
   * `lastRequestId`，仍失败则如实写错误 —— 不再出现「点了停止毫无反应」。
   * 同时收回排队中的那几句（内核会清空该会话队列），把文本还给输入框。
   */
  async function abort(): Promise<QueuedDraft[]> {
    const rt = ensureRuntime()
    const requestId = rt.activeRequest ?? rt.lastRequestId
    if (requestId === null) return []
    let result: Awaited<ReturnType<typeof window.aurora.chat.abort>>
    try {
      result = await window.aurora.chat.abort(requestId)
    } catch (cause) {
      rt.error = String(cause)
      return []
    }
    if (!result.ok) {
      rt.error = result.message
      return []
    }
    if (result.value !== true && rt.activeRequest !== null) {
      // 主进程不认识这个 requestId（可能已收尾）：保留原状态，给用户一句交代
      rt.error = '这条回复可能已经结束，请稍后再试'
      return []
    }
    rt.streaming = false
    rt.lastSettledAt = null
    rt.latestTurnGroupable = false
    rt.reasoningTargetId = null
    for (const message of rt.messages) {
      if (message.pending === true) message.pending = false
    }
    const drafts: QueuedDraft[] = []
    // 倒着扫：splice 会让后面的下标前移，正着删会跳条目
    for (let index = rt.messages.length - 1; index >= 0; index -= 1) {
      const item = rt.messages[index]
      if (item?.queued !== true) continue
      const stored = rt.queuedDrafts.get(item.id)
      drafts.unshift({ text: item.content, attachments: stored?.attachments ?? [] })
      rt.queuedDrafts.delete(item.id)
      rt.messages.splice(index, 1)
    }
    // 本地主动中止：紧随其后的内核事件一律丢弃
    rt.activeRequest = null
    rt.lastRequestId = null
    rt.assistantId = null
    rt.finishedRequests.add(requestId)
    while (rt.finishedRequests.size > 64) {
      const oldest = rt.finishedRequests.values().next().value
      if (oldest === undefined) break
      rt.finishedRequests.delete(oldest)
    }
    // 内核的 abort 会清空该会话的整个插话队列：队列里那些 requestId 不会再有 done，
    // 活动态必须一起清，否则左栏会显示「一直在跑」
    const activity = activities.get(sessionId.value)
    if (activity !== undefined) {
      activity.activeRequests.clear()
      activity.running = false
    }
    return drafts
  }

  /** 清空当前消息区（不影响已保存的会话历史，也不碰其它会话的运行态） */
  function clear(): void {
    const rt = ensureRuntime()
    // 整表清空之前先把在途增量落地，否则清空后它会把消息又插回来
    deltaBuffer.flush()
    rt.messages = []
    rt.queuedDrafts.clear()
    rt.unread = false
    rt.error = null
    rt.pendingNotice = null
    rt.liveSubagents = []
    rt.lastSettledRequestId = null
    rt.lastSettledAt = null
    rt.latestTurnGroupable = true
    resetUsage(rt)
    rt.reasoningTargetId = null
  }

  function markRead(): void {
    markViewed(sessionId.value)
  }

  return {
    sessionId,
    messages,
    sessions,
    streaming,
    unread,
    error,
    statusTone,
    lastAssistant,
    /** 正在接收思考过程的助手消息 id（供 MessageList 自动展开思考块）；空闲时为 null */
    reasoningTargetId,
    /** 最近一次「本轮收尾」的 requestId（MessageList 的折叠收尾据此触发） */
    lastSettledRequestId,
    lastSettledAt,
    latestTurnGroupable,
    /** 当前会话的轮终改动（requestId → 文件清单；2026-11-07） */
    turnChangesForSession,
    /** 本会话 token 用量（输入框底部「上下文详解」的数据源） */
    usage,
    /** 本会话的子代理运行（「子代理」页面用，新的在前） */
    subagentRuns,
    /** 本会话的任务列表（「任务」面板用；docs/06 §4.1） */
    jobs,
    /** 长任务被暂停时的一句话提示（`done` 的 pendingReason；无原因时为 null） */
    pendingNotice,
    /**
     * 非当前会话的状态点（running / unread / error）：左栏会话行与头部后台汇总的数据源。
     * 只存在内存，重启后由 `chat:sessions.running` 与事件流重建。
     */
    sessionStates,
    backgroundRunningCount,
    backgroundUnreadCount,
    backgroundSessionTitles,
    hydrate,
    loadQuickPreview,
    loadSessions,
    /** 重拉任务列表（挂载 / 切会话后对齐；失败保留旧列表） */
    refreshJobs,
    /** 续跑一条暂停的任务（渲染层唯一的「继续」入口） */
    resumeJob,
    /** 取消一条在跑 / 排队 / 暂停的任务 */
    cancelJob,
    /** 归档 / 取消归档（左栏分组与主区提示条共用） */
    setArchived,
    /** 绑定 / 解绑会话项目（右栏「会话项目」下拉用，docs/06 §5.1） */
    setSessionProject,
    switchSession,
    newSession,
    send,
    abort,
    /** 手动压缩当前会话上下文（/compact） */
    compactContext,
    clear,
    markRead,
  }
}

/** token 用量空值（`usage` computed 的稳定兜底，避免每帧新对象） */
const EMPTY_USAGE = {
  latest: null,
  totals: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
}
const EMPTY_JOBS: AgentJob[] = []

/** 从绝对路径取文件名（Windows 反斜杠与 POSIX 斜杠都处理） */
function fileNameOf(path: string): string {
  const segments = path.split(/[\\/]/)
  return segments[segments.length - 1] ?? path
}
