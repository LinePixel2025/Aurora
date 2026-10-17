/**
 * 子代理并发限流（docs/06 §19.5，2026-10-18）。
 *
 * `task` 声明 `parallel` 之后，同轮多个子代理可以一起起跑；但一个子代理就是一条完整的
 * 模型调用循环，不能无限制地同时跑。本模块提供**按父会话**的限额与写入互斥：
 *
 * - 每个父会话最多 `SUBAGENT_MAX_PARALLEL` 个子代理同时运行，超出的 FIFO 排队等位；
 * - `write: true` 的请求还要额外拿一把**写锁**：同一父会话同一时刻最多 1 个写子代理
 *   （原因见 docs/06 §19.2：文件「读 → 改 → 写」交错 + 渲染层敏感确认是单槽位）；
 * - 排队中的请求可以在 `signal` 中止时立刻退出（返回 `undefined`），不会在父请求取消后
 *   还悄悄起跑一个子代理；
 * - 状态按会话隔离、空闲后清理，不常驻内存。
 *
 * 刻意**不做成配置项**：与 `RUNAWAY_MAX_ROUNDS` 同属防失控兜底，不是用户按任务调的工作量旋钮。
 *
 * 为什么先判写锁再判槽位（两者在同一个 FIFO 队列里原子判定）：排队者不会「占着写锁等槽位」
 * 把同会话的读子代理一起堵死；代价是写请求排在队首时会按 FIFO 挡住后面的读请求 ——
 * 这是有意的保序，避免写请求在持续读流量下饥饿。
 */

/** 同一父会话最多同时运行的子代理数（内核常量，docs/06 §19.5） */
export const SUBAGENT_MAX_PARALLEL = 3

export interface SubagentSlotOptions {
  /** 该子代理是否被实际授予写工具（不是请求参数，见 docs/06 §19.2） */
  write: boolean
  /** 父请求的取消信号：排队中被中止时 acquire 返回 undefined */
  signal?: AbortSignal
}

/** 释放槽位（幂等；拿到后必须在 finally 里调用） */
export type SubagentSlotRelease = () => void

interface Waiter {
  write: boolean
  resolve: (release: SubagentSlotRelease | undefined) => void
  signal?: AbortSignal
  onAbort?: () => void
  /** 已获授 / 已中止；防止同一 waiter 被重复结算 */
  settled: boolean
}

interface SessionState {
  active: number
  writeLocked: boolean
  queue: Waiter[]
}

export interface SubagentLimiter {
  /**
   * 申请一个子代理槽位；返回释放函数，排队中被中止时返回 `undefined`（调用方据此不启动）。
   * 每个成功返回的 release 都必须且只能调用一次（幂等，重复调用无副作用）。
   */
  acquire(sessionId: string, options: SubagentSlotOptions): Promise<SubagentSlotRelease | undefined>
  /** 诊断 / 单测：当前会话的活跃数、排队数与写锁状态 */
  snapshot(sessionId: string): { active: number; queued: number; writeLocked: boolean }
}

export function createSubagentLimiter(limit: number = SUBAGENT_MAX_PARALLEL): SubagentLimiter {
  const max = Math.max(1, Math.floor(limit))
  const sessions = new Map<string, SessionState>()

  const stateOf = (sessionId: string): SessionState => {
    const existing = sessions.get(sessionId)
    if (existing !== undefined) return existing
    const created: SessionState = { active: 0, writeLocked: false, queue: [] }
    sessions.set(sessionId, created)
    return created
  }

  /** 会话空闲（无活跃、无排队、无写锁）就清掉，避免长期运行进程里按会话累积 */
  const cleanup = (sessionId: string, state: SessionState): void => {
    if (state.active === 0 && state.queue.length === 0 && !state.writeLocked) {
      sessions.delete(sessionId)
    }
  }

  const detachAbort = (waiter: Waiter): void => {
    if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
  }

  /** 把槽位与（可选的）写锁同时授给一个 waiter */
  const grant = (sessionId: string, state: SessionState, waiter: Waiter): void => {
    waiter.settled = true
    detachAbort(waiter)
    if (waiter.write) state.writeLocked = true
    state.active += 1
    let released = false
    const release: SubagentSlotRelease = () => {
      if (released) return
      released = true
      state.active -= 1
      if (waiter.write) state.writeLocked = false
      drain(sessionId)
    }
    waiter.resolve(release)
  }

  /**
   * 从队首按 FIFO 发放：队首拿不到（槽位满 / 写锁被占）就停 —— 后面的请求不越队。
   * 每次 release / 中止 / 新请求入队后都调一次。
   */
  const drain = (sessionId: string): void => {
    const state = sessions.get(sessionId)
    if (state === undefined) return
    while (state.queue.length > 0) {
      const head = state.queue[0]
      if (head === undefined) break
      if (head.settled) {
        state.queue.shift()
        continue
      }
      if (state.active >= max) break
      if (head.write && state.writeLocked) break
      state.queue.shift()
      grant(sessionId, state, head)
    }
    cleanup(sessionId, state)
  }

  return {
    acquire(sessionId, options) {
      // 已经取消的父请求：不建状态、不入队、不启动
      if (options.signal?.aborted === true) return Promise.resolve(undefined)

      const state = stateOf(sessionId)
      return new Promise<SubagentSlotRelease | undefined>((resolve) => {
        const waiter: Waiter = {
          write: options.write,
          resolve,
          settled: false,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }
        if (options.signal !== undefined) {
          waiter.onAbort = () => {
            // 已获授的 waiter 的 abort 监听已经在 grant 时摘掉；这里只处理排队中
            if (waiter.settled) return
            waiter.settled = true
            const index = state.queue.indexOf(waiter)
            if (index >= 0) state.queue.splice(index, 1)
            resolve(undefined)
            drain(sessionId)
          }
          options.signal.addEventListener('abort', waiter.onAbort, { once: true })
        }
        state.queue.push(waiter)
        drain(sessionId)
      })
    },

    snapshot(sessionId) {
      const state = sessions.get(sessionId)
      if (state === undefined) return { active: 0, queued: 0, writeLocked: false }
      return { active: state.active, queued: state.queue.length, writeLocked: state.writeLocked }
    },
  }
}
