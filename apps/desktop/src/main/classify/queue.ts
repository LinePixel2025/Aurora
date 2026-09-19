/**
 * 分类队列（docs/02 §5.2「分类队列（并发 2）」）—— 纯逻辑，可独立单测。
 *
 * 职责：
 * - **去重**：同一个路径在途时重复入队直接忽略（chokidar 可能重复报同一文件）；
 * - **并发上限**：默认 2，避免同时解析多个大文件把内存与 CPU 打满；
 * - **状态推送**：每个阶段变化都发事件，渲染层的分类流水靠它实时刷新；
 * - **失败隔离**：单个文件处理抛错不影响队列与其它文件（docs/02 §7 降级原则）。
 *
 * 处理器（`handler`）由 `ClassificationService` 注入，负责真正的提取 / 判定 / 落盘。
 */
import type { ClassificationEvent, ClassificationRecord, ClassificationState } from '@aurora/shared'
export interface QueueJob {
  path: string
  fileName: string
  ext: string
  sizeBytes: number
  /** 源文件修改时间（毫秒），用于 `(路径, 大小, mtime)` 去重签名（docs/05 §3.2） */
  mtimeMs?: number
  /**
   * 入队时就已确定的流水记录（进度事件与最终事件**必须共用同一个 id**，
   * 否则渲染层按 id 归并时会留下一条永远停在「排队中」的幽灵行）。
   */
  record?: ClassificationRecord
}

/** 处理器返回的进度更新；`state` 为终态时队列释放一个并发位 */
export interface QueueProgress {
  /** 目前的持久化记录快照 */
  record: ClassificationRecord
  state: ClassificationState
}

export interface ClassificationQueueOptions {
  /** 处理单个文件；通过 `report` 上报中间状态 */
  handler(job: QueueJob, report: (progress: QueueProgress) => void): Promise<QueueProgress>
  /** 默认 2（docs/02 §5.2） */
  concurrency?: number
  logger?: {
    debug(message: string, detail?: Record<string, unknown>): void
    warn(message: string, detail?: Record<string, unknown>): void
  }
}

export const DEFAULT_CONCURRENCY = 2

export class ClassificationQueue {
  private readonly options: ClassificationQueueOptions
  private readonly concurrency: number
  private readonly waiting: QueueJob[] = []
  private readonly active = new Map<string, QueueJob>()
  private readonly listeners = new Set<(event: ClassificationEvent) => void>()
  private disposed = false

  constructor(options: ClassificationQueueOptions) {
    this.options = options
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY)
  }

  /** 入队。返回 false 表示被去重跳过或队列已关闭。 */
  enqueue(job: QueueJob): boolean {
    if (this.disposed) return false
    if (this.active.has(job.path) || this.waiting.some((item) => item.path === job.path)) {
      this.options.logger?.debug('文件已在分类队列中，跳过重复入队', { path: job.path })
      return false
    }
    this.waiting.push(job)
    this.pump()
    return true
  }

  /** 订阅分类事件（渲染层推送 + 测试断言）。 */
  onEvent(listener: (event: ClassificationEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get depth(): number {
    return this.waiting.length
  }

  get running(): number {
    return this.active.size
  }

  /** 等待队列清空（退出前收尾；单元测试也用它做同步点）。 */
  async drain(): Promise<void> {
    while (this.waiting.length > 0 || this.active.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  dispose(): void {
    this.disposed = true
    this.waiting.length = 0
  }

  // ───────────────────────── 内部 ─────────────────────────

  private pump(): void {
    while (!this.disposed && this.active.size < this.concurrency && this.waiting.length > 0) {
      const job = this.waiting.shift()!
      this.active.set(job.path, job)
      void this.run(job)
    }
  }

  private async run(job: QueueJob): Promise<void> {
    const report = (progress: QueueProgress): void => {
      this.emit({
        record: progress.record,
        state: progress.state,
        queueDepth: this.waiting.length,
        running: this.active.size,
      })
    }

    try {
      const final = await this.options.handler(job, report)
      report(final)
    } catch (error) {
      // 处理器已尽力处理错误；仍抛出说明是意外故障：记录并放行，绝不卡住队列
      this.options.logger?.warn('分类任务异常', { path: job.path, error: String(error) })
    } finally {
      this.active.delete(job.path)
      this.pump()
    }
  }

  private emit(event: ClassificationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        this.options.logger?.warn('分类事件监听器抛错', { error: String(error) })
      }
    }
  }
}
