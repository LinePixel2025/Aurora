/**
 * Agent 内置浏览器的**并发槽位注册表**（v35，docs/06 §27）。
 *
 * 为什么单独一个 electron-free 文件：浏览器会话真正的资源是 webview guest 进程
 * （一个标签 = 一个 Chromium 渲染进程），开太多会直接顶爆内存。所有「最多几个 /
 * 空闲多久释放」的判定都收在这里，`browser-agent.ts` 只负责驱动，测试不需要 Electron。
 *
 * 口径（docs/06 §27）：
 * - 上限是**全局**的（不是按会话）：同时最多 `maxCount()` 个 Agent 浏览器会话；
 * - `maxCount` / `idleMs` 都是 **live getter**：设置页改完立即生效，不需要重启；
 * - 到上限**拒绝不排队**：会话是长生命周期资源，排队等另一个会话关闭会自我死锁
 *   （同一 Agent 往往既持有旧会话又想开新会话）；
 * - 同会话重复 acquire 由调用方先 `has()` 复用；这里遇到重复按失败返回，避免
 *   「以为是新会话、实际顶掉旧会话」的静默错账；
 * - 空闲释放只**通知**（`onIdle`），真正的 detach / 状态推送由 manager 做 ——
 *   注册表不认识 Electron，也不认识渲染层。
 */

/** 硬上限（不进配置的兜底常量，与 SUBAGENT_MAX_PARALLEL 同属防失控）。 */
export const MAX_AGENT_BROWSER_SESSIONS_HARD = 4

/** 单个会话的最小登记信息（供诊断 / 测试）。 */
export interface BrowserSessionSlot {
  sessionId: string
  createdAt: number
  lastUsedAt: number
}

export type BrowserAcquireResult =
  { ok: true } | { ok: false; reason: 'limit'; limit: number } | { ok: false; reason: 'duplicate' }

export interface BrowserSessionSlotsOptions {
  /** 同时允许的会话数（live getter；运行时夹到 1..MAX_AGENT_BROWSER_SESSIONS_HARD） */
  maxCount: () => number
  /** 空闲释放阈值毫秒（live getter；<=0 表示不自动释放） */
  idleMs: () => number
  /** 空闲到期回调：manager 在这里结束会话（detach + 推 released 状态） */
  onIdle: (sessionId: string) => void
  /** 注入时钟（单测用） */
  now?: () => number
  /** 注入定时器（单测用）；返回句柄透传给 clearTimer */
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface BrowserSessionSlots {
  /** 申请一个会话名额；已存在同会话时返回 duplicate（调用方应先 has() 复用） */
  acquire(sessionId: string): BrowserAcquireResult
  /** 释放名额（不存在返回 false；幂等） */
  release(sessionId: string): boolean
  /** 记录一次成功操作：刷新 lastUsedAt 并重置空闲计时 */
  touch(sessionId: string): void
  has(sessionId: string): boolean
  get(sessionId: string): BrowserSessionSlot | undefined
  ids(): string[]
  count(): number
  /** 结束全部会话并返回被释放的 sessionId（关闭能力 / 退出时用） */
  clear(): string[]
  /** 停掉全部计时器（dispose 后不可再 acquire） */
  dispose(): void
  snapshot(): { count: number; limit: number; idleMs: number }
}

interface Entry {
  slot: BrowserSessionSlot
  timer: unknown
}

export function createBrowserSessionSlots(
  options: BrowserSessionSlotsOptions,
): BrowserSessionSlots {
  const now = options.now ?? (() => Date.now())
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))

  const entries = new Map<string, Entry>()
  let disposed = false

  const clampLimit = (): number => {
    const raw = options.maxCount()
    const value = Number.isFinite(raw) ? Math.floor(raw) : 1
    return Math.min(MAX_AGENT_BROWSER_SESSIONS_HARD, Math.max(1, value))
  }

  const idleMs = (): number => {
    const raw = options.idleMs()
    if (!Number.isFinite(raw)) return 0
    return Math.max(0, Math.floor(raw))
  }

  /** 每个会话一条计时器：touch 时重置；到期再判一次实际空闲，避免时钟漂移误杀。 */
  const schedule = (sessionId: string, entry: Entry): void => {
    if (entry.timer !== undefined) clearTimer(entry.timer)
    entry.timer = undefined
    if (disposed) return
    const threshold = idleMs()
    if (threshold <= 0) return
    entry.timer = setTimer(() => {
      const current = entries.get(sessionId)
      if (current !== entry) return
      const idleFor = now() - entry.slot.lastUsedAt
      if (idleFor < idleMs()) {
        schedule(sessionId, entry)
        return
      }
      // 通知 manager 收掉会话；真正的 delete 由 manager 调 release 完成，
      // 这样「释放」只有一条路径（不会出现注册表已删、manager 仍在推状态的错账）。
      options.onIdle(sessionId)
    }, threshold)
  }

  const stopTimer = (entry: Entry): void => {
    if (entry.timer === undefined) return
    clearTimer(entry.timer)
    entry.timer = undefined
  }

  /** 释放全部并返回被释放的 sessionId（`clear` 与 `dispose` 共用；不依赖 `this`） */
  const clearAll = (): string[] => {
    const ids = [...entries.keys()]
    for (const id of ids) {
      const entry = entries.get(id)
      if (entry !== undefined) stopTimer(entry)
      entries.delete(id)
    }
    return ids
  }

  return {
    acquire(sessionId) {
      if (disposed) return { ok: false, reason: 'limit', limit: clampLimit() }
      if (entries.has(sessionId)) return { ok: false, reason: 'duplicate' }
      const limit = clampLimit()
      if (entries.size >= limit) return { ok: false, reason: 'limit', limit }
      const timestamp = now()
      const entry: Entry = {
        slot: { sessionId, createdAt: timestamp, lastUsedAt: timestamp },
        timer: undefined,
      }
      entries.set(sessionId, entry)
      schedule(sessionId, entry)
      return { ok: true }
    },

    release(sessionId) {
      const entry = entries.get(sessionId)
      if (entry === undefined) return false
      stopTimer(entry)
      entries.delete(sessionId)
      return true
    },

    touch(sessionId) {
      const entry = entries.get(sessionId)
      if (entry === undefined) return
      entry.slot.lastUsedAt = now()
      schedule(sessionId, entry)
    },

    has(sessionId) {
      return entries.has(sessionId)
    },

    get(sessionId) {
      return entries.get(sessionId)?.slot
    },

    ids() {
      return [...entries.keys()]
    },

    count() {
      return entries.size
    },

    clear() {
      return clearAll()
    },

    dispose() {
      clearAll()
      disposed = true
    },

    snapshot() {
      return { count: entries.size, limit: clampLimit(), idleMs: idleMs() }
    },
  }
}
