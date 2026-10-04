/**
 * 提取池：主进程侧管理 `utilityProcess` 生命周期（docs/02 §2.1）。
 *
 * 职责：
 * - **懒启动**：第一次需要提取时才 fork，避免常驻一个空子进程；
 * - **超时**：默认 15s 未回包 → 杀进程并按「文件名证据」降级（畸形 PDF 可能卡死）；
 * - **崩溃重启**：子进程非正常退出后，下一次请求重新 fork（只重试一次，避免崩溃循环）；
 * - **串行**：一次只发一个请求，避免子进程侧并发解析放大内存峰值；
 *   并发度由上层队列（`classify/queue.ts`，并发 2）控制，两路交替使用本池。
 *
 * 纯逻辑注入：`fork` 由调用方传入，因此本模块可在单测里用假子进程完整覆盖。
 */
import type { EvidenceKind } from './extract.js'

export interface ExtractPoolRequest {
  path: string
  ext: string
  sizeBytes: number
  /** 文件自感知需要内容哈希；分类管线保持缺省，避免额外全量读盘。 */
  hashContent?: boolean
}

export interface ExtractPoolResult {
  kind: EvidenceKind
  evidence: string
  evidenceChars: number
  warnings: string[]
  sourceHash?: string
  /** 是否走了降级路径（超时 / 崩溃 / 解析器失败） */
  degraded: boolean
}

/**
 * 子进程的最小结构面（Electron 的 UtilityProcess 天然满足）。
 *
 * **注意 message 的形状不对称**（已用真实 Electron 33 探针实测）：
 * - 子进程 → 父进程：payload **裸传**，`UtilityProcess.on('message')` 拿到的就是 payload
 *   本身（`{ id, ok, evidence }`），**没有** `.data` 包装；
 * - 父进程 → 子进程：payload 被包在 `{ data, ports }` 里，子进程必须读 `message.data`。
 *
 * 因此父进程侧不能照抄子进程的 `message.data`（这曾导致每次提取都白等 15s 超时），
 * 这里用 `unwrapChildMessage` 同时兼容两种形状。
 */
export interface ExtractChildLike {
  postMessage(message: unknown): void
  kill(): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
}

/** `utilityProcess.fork(...)` 的返回值可直接断言为本类型 */
export type ExtractWorkerChild = ExtractChildLike

/**
 * 归一子进程回包：裸 payload 直接用；被 `{ data }` 包住时取 `data`。
 * 两种形状都接受，避免依赖 Electron 版本的具体包装行为。
 */
export function unwrapChildMessage(message: unknown): unknown {
  if (typeof message !== 'object' || message === null) return undefined
  const record = message as Record<string, unknown>
  // 有 data 且 data 是对象 → 视为包装（MessageEvent 形状）
  if (typeof record['data'] === 'object' && record['data'] !== null) return record['data']
  // 裸 payload：必须自带 id 字段才是我们的回包
  if (typeof record['id'] === 'string') return record
  return undefined
}

export interface ExtractPoolOptions {
  /** fork 一个 worker；由主进程传 `utilityProcess.fork` 包装 */
  fork: () => ExtractChildLike
  logger?: {
    debug(message: string, detail?: Record<string, unknown>): void
    warn(message: string, detail?: Record<string, unknown>): void
  }
  /** 单次提取超时，默认 15s */
  timeoutMs?: number
}

interface Pending {
  resolve(result: ExtractPoolResult): void
  id: string
  path: string
  timer: NodeJS.Timeout
}

export const DEFAULT_EXTRACT_TIMEOUT_MS = 15_000

export class ExtractPool {
  private readonly options: ExtractPoolOptions
  private readonly timeoutMs: number
  private child: ExtractChildLike | undefined
  private pending: Pending | undefined
  private counter = 0
  private closed = false
  /** 子进程异常退出后置位：下一次请求先重建，且只允许重建一次 */
  private needsRespawn = false

  constructor(options: ExtractPoolOptions) {
    this.options = options
    this.timeoutMs = options.timeoutMs ?? DEFAULT_EXTRACT_TIMEOUT_MS
  }

  /** 提取一个文件；任何失败都返回 `degraded: true` 的降级结果，**不抛错**。 */
  async extract(request: ExtractPoolRequest): Promise<ExtractPoolResult> {
    if (this.closed) return degraded(request, '提取池已关闭')
    // 串行：上一个还在跑时排队等待，避免子进程内并发解析
    while (this.pending !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      if (this.closed) return degraded(request, '提取池已关闭')
    }

    const child = this.ensureChild()
    if (child === undefined) return degraded(request, '提取子进程不可用')

    const id = `ex-${++this.counter}`
    return new Promise<ExtractPoolResult>((resolve) => {
      const timer = setTimeout(() => {
        this.options.logger?.warn('内容提取超时，已降级为文件名证据', {
          path: request.path,
          timeoutMs: this.timeoutMs,
        })
        this.pending = undefined
        // 卡死的子进程不可复用（可能仍在解析），杀掉后下次重建
        this.restartChild()
        resolve(degraded(request, `提取超时（${this.timeoutMs}ms）`))
      }, this.timeoutMs)
      timer.unref?.()

      this.pending = { resolve, id, path: request.path, timer }
      try {
        child.postMessage({
          id,
          path: request.path,
          ext: request.ext,
          sizeBytes: request.sizeBytes,
          ...(request.hashContent === true ? { hashContent: true } : {}),
        })
      } catch (error) {
        clearTimeout(timer)
        this.pending = undefined
        resolve(degraded(request, `发送提取请求失败：${String(error)}`))
      }
    })
  }

  /** 停止子进程（退出 / 模式停用时调用）。 */
  close(): void {
    this.closed = true
    const pending = this.pending
    if (pending) {
      clearTimeout(pending.timer)
      this.pending = undefined
      pending.resolve(degraded({ path: pending.path, ext: '', sizeBytes: 0 }, '提取池已关闭'))
    }
    this.child?.kill()
    this.child = undefined
  }

  /** 供测试与状态展示 */
  get running(): boolean {
    return this.pending !== undefined
  }

  // ───────────────────────── 内部 ─────────────────────────

  private ensureChild(): ExtractChildLike | undefined {
    if (this.child === undefined || this.needsRespawn) {
      this.child?.kill()
      try {
        this.child = this.options.fork()
        this.needsRespawn = false
        this.attach(this.child)
      } catch (error) {
        this.options.logger?.warn('提取子进程启动失败', { error: String(error) })
        this.child = undefined
        return undefined
      }
    }
    return this.child
  }

  private attach(child: ExtractChildLike): void {
    child.on('message', (message) => {
      const payload = unwrapChildMessage(message) as
        | {
            id?: string
            ok?: boolean
            kind?: EvidenceKind
            evidence?: string
            evidenceChars?: number
            warnings?: string[]
            sourceHash?: string
            error?: string
          }
        | undefined
      const pending = this.pending
      if (pending === undefined || payload === undefined || payload.id !== pending.id) return

      clearTimeout(pending.timer)
      this.pending = undefined

      if (payload.ok === true) {
        pending.resolve({
          kind: payload.kind ?? 'unknown',
          evidence: payload.evidence ?? '',
          evidenceChars: payload.evidenceChars ?? (payload.evidence ?? '').length,
          warnings: payload.warnings ?? [],
          ...(payload.sourceHash === undefined ? {} : { sourceHash: payload.sourceHash }),
          degraded: (payload.warnings ?? []).length > 0,
        })
        return
      }
      this.options.logger?.warn('内容提取失败，已降级为文件名证据', {
        path: pending.path,
        error: payload.error ?? 'unknown',
      })
      pending.resolve(
        degraded({ path: pending.path, ext: '', sizeBytes: 0 }, payload.error ?? '提取失败'),
      )
    })

    child.on('exit', (code) => {
      this.needsRespawn = true
      this.child = undefined
      const pending = this.pending
      if (pending === undefined) return
      clearTimeout(pending.timer)
      this.pending = undefined
      this.options.logger?.warn('提取子进程退出，在途请求降级', { code })
      pending.resolve(
        degraded({ path: pending.path, ext: '', sizeBytes: 0 }, `子进程退出（code=${code}）`),
      )
    })
  }

  /** 杀掉当前子进程，让下一次请求重建（用于超时后的卡死进程）。 */
  private restartChild(): void {
    this.child?.kill()
    this.child = undefined
    this.needsRespawn = true
  }
}

/** 降级结果：只有文件名与大小可用，足够让「文件名关键词」规则命中。 */
function degraded(request: ExtractPoolRequest, reason: string): ExtractPoolResult {
  const name = request.path.split(/[\\/]/).pop() ?? request.path
  return {
    kind: 'unknown',
    evidence: `文件名：${name}\n大小：${request.sizeBytes} B\n（内容提取降级：${reason}）`,
    evidenceChars: 0,
    warnings: [reason],
    degraded: true,
  }
}
