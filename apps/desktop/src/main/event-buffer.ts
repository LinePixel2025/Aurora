/**
 * 主进程侧的**事件合并缓冲**（流式增量按时间窗批量下发）。
 *
 * 为什么需要：一个 SSE token = 一次 `webContents.send`，且是**广播给所有窗口**的。
 * 真实推理模型 100+ token/s 时，主进程每秒要发上百次 IPC、每个渲染进程被叫醒上百次，
 * 每次都要重跑组件渲染 —— 渲染跟不上输出（BUG 现场见 capture 的 chat-stream-burst）。
 * 这里按约 16ms（一帧）的窗口合并增量后再发，把「每秒上百次」压到「每帧一次」。
 *
 * 语义（顺序即真相，必须精确保持）：
 * 1. **只有相邻**且 `(sessionId, requestId, messageId, type)` 全同的 `text` / `reasoning`
 *    才合并：`delta` 拼接、保留**第一条**的 `seq` 与其余字段；
 * 2. 其余事件原样入队，且不与其前后的增量合并（中间夹一个 `tool` 就断开合并）；
 * 3. `done` / `error` / `user-message` 是**终态或同步语义**，先把队列 flush 出去、
 *    再同步下发自己 —— 否则终态会先于它前面的增量到达（界面「回复为空」）；
 * 4. 其余事件按入队顺序在窗口到点后一次性下发。
 *
 * 刻意**不 import electron**：类型只从 `@aurora/shared` 取，这样 vitest 的 node 环境能收它。
 */
import type { AgentEvent } from '@aurora/shared'

export interface EventBuffer {
  push(event: AgentEvent): void
  flush(): void
  dispose(): void
}

/** 可以合并的两类事件（流式增量） */
type StreamEvent = Extract<AgentEvent, { type: 'text' | 'reasoning' }>

/** 默认合并窗口（约一帧，60Hz）：再大就会让人眼看出「一段一段地蹦」 */
const DEFAULT_WINDOW_MS = 16

export function createEventBuffer(
  send: (event: AgentEvent) => void,
  options?: { windowMs?: number },
): EventBuffer {
  const windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS
  const queue: AgentEvent[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  /** 立即按入队顺序下发全部在途事件；不重复下发（队列会被摘空） */
  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (queue.length === 0) return
    const pending = queue.splice(0, queue.length)
    for (const event of pending) send(event)
  }

  const schedule = (): void => {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      flush()
    }, windowMs)
    // 不让这个定时器拖住进程退出（与 SessionStore 的写盘定时器同款处理）
    timer.unref?.()
  }

  return {
    push(event) {
      // 终态 / 同步语义：先把它之前的增量发完，再同步发自己
      if (event.type === 'done' || event.type === 'error' || event.type === 'user-message') {
        flush()
        send(event)
        return
      }
      // 只与**队尾**比较：中间夹了别的事件就不合并（顺序即真相）
      const tail = queue[queue.length - 1]
      if (
        isStreamEvent(event) &&
        tail !== undefined &&
        isStreamEvent(tail) &&
        streamKey(tail) === streamKey(event)
      ) {
        queue[queue.length - 1] = { ...tail, delta: tail.delta + event.delta }
        // 队尾本来就在等这个窗口；这里再 schedule 一次是为了兜住「定时器刚被 flush 清掉」
        schedule()
        return
      }
      queue.push(event)
      schedule()
    },
    flush,
    dispose() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      // 进程 / 窗口要关了，在途事件不再需要（也不再发给正在销毁的 webContents）
      queue.length = 0
    },
  }
}

function isStreamEvent(event: AgentEvent): event is StreamEvent {
  return event.type === 'text' || event.type === 'reasoning'
}

/** 合并的分组键：四元全同才算同一条流。用 \u0000 分隔避免 id 里出现分隔符导致误判 */
function streamKey(event: StreamEvent): string {
  return [event.type, event.sessionId, event.requestId, event.messageId].join('\u0000')
}
