/**
 * 流式增量的**按帧合并缓冲**。
 *
 * 为什么需要：一个 SSE token = 一次 `webContents.send` = 一次渲染层回调。真实推理模型
 * 100+ token/s 时，渲染层每秒要被叫醒上百次，每次都要重跑一遍组件渲染与布局 ——
 * 结果是主线程排满、思考内容远远跟不上模型输出（BUG 现场见 capture 的 chat-stream-burst）。
 * 这里把同一帧内到达的增量合并成一次 `apply`，把「每秒上百次」压到「每帧一次」。
 *
 * 语义（四条，改实现时必须逐条保住）：
 * 1. **同 key 合并**：同一帧内同 key 的多次入队合并成一条（`values` 按入队顺序）；
 * 2. **一帧一次 apply**：无论入队多少次，一帧只回调一次；不同 key 按首次出现顺序排列；
 * 3. **顺序保持**：`values` 的先后就是入队先后，调用方据此可以安全地累加文本；
 * 4. **flush 立即**：`flush()` 同步 apply 已入队内容（终态事件如 `done` 之前必须走它，
 *    否则终态会读到还没写完的消息内容）。
 *
 * 刻意**零 import**（不 import vue、不 import @aurora/*）：纯逻辑 + 注入帧调度，
 * 这样 vitest 的 node 环境能直接收它的单测（浏览器侧的 rAF 由调用方注入）。
 */

/** 帧调度（注入 `window.requestAnimationFrame` / `cancelAnimationFrame`） */
export interface DeltaFrameScheduler {
  requestFrame: (callback: () => void) => number
  cancelFrame: (handle: number) => void
}

/** 一次 `apply` 里同一个 key 的全部增量（按入队顺序） */
export interface DeltaBatch<T> {
  key: string
  values: T[]
}

export interface DeltaBuffer<T> {
  /** 入队；同一帧内同 key 的多次入队合并为一次 apply */
  push(key: string, value: T): void
  /** 立即同步 apply 全部已入队内容（顺序 = 入队顺序），并取消已排的帧 */
  flush(): void
  /** 取消已排的帧并清空缓冲（组件已卸载，不再 apply） */
  dispose(): void
}

export function createDeltaBuffer<T>(
  apply: (batch: DeltaBatch<T>[]) => void,
  scheduler: DeltaFrameScheduler,
): DeltaBuffer<T> {
  /** 在途帧句柄。用 `null` 表示「没有」，**不能用 0** —— 0 也可能是合法的帧句柄 */
  let handle: number | null = null
  /** 待 apply 的增量。Map 的迭代顺序 = key 首次入队的顺序（跨 key 顺序靠它保住） */
  let pending = new Map<string, T[]>()

  const runFrame = (): void => {
    // 先清句柄再 apply：apply 过程中再次 push 必须能正常排下一帧，
    // 否则那批增量会被吞掉（句柄还在，schedule 直接返回）
    handle = null
    if (pending.size === 0) return
    const batch: DeltaBatch<T>[] = []
    for (const [key, values] of pending) batch.push({ key, values })
    // 先摘走再 apply：apply 里 push 的内容属于下一帧，不能混进这一批
    pending = new Map()
    apply(batch)
  }

  return {
    push(key, value) {
      const values = pending.get(key)
      if (values === undefined) pending.set(key, [value])
      else values.push(value)
      if (handle === null) handle = scheduler.requestFrame(runFrame)
    },
    flush() {
      if (handle !== null) {
        scheduler.cancelFrame(handle)
        handle = null
      }
      runFrame()
    },
    dispose() {
      if (handle !== null) {
        scheduler.cancelFrame(handle)
        handle = null
      }
      pending = new Map()
    },
  }
}
