/**
 * Office worker 池：单请求串行、超时杀进程、崩溃后下次重建。
 *
 * Office 引擎可能在畸形文件或极端内容上卡住；worker 隔离保证主进程事件循环不被拖死。
 * 超时 / 崩溃都**不自动重试**：重试同一份畸形输入只会再卡一次，调用方应明确报错。
 */
import type { OfficeWorkerResponse, OfficeWorkerRunRequest } from './office-protocol.js'

export interface OfficeChildLike {
  postMessage(message: unknown): void
  kill(): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
}

export interface OfficePoolOptions {
  fork: () => OfficeChildLike
  logger?: {
    debug(message: string, detail?: Record<string, unknown>): void
    warn(message: string, detail?: Record<string, unknown>): void
  }
  timeoutMs?: number
}

export const DEFAULT_OFFICE_TIMEOUT_MS = 45_000

interface Pending {
  id: string
  resolve(response: OfficeWorkerResponse): void
  timer: NodeJS.Timeout
}

export class OfficePool {
  private readonly options: OfficePoolOptions
  private readonly timeoutMs: number
  private child: OfficeChildLike | undefined
  private pending: Pending | undefined
  private counter = 0
  private closed = false
  private needsRespawn = false

  constructor(options: OfficePoolOptions) {
    this.options = options
    this.timeoutMs = options.timeoutMs ?? DEFAULT_OFFICE_TIMEOUT_MS
  }

  async run(request: OfficeWorkerRunRequest): Promise<OfficeWorkerResponse> {
    if (this.closed) return failure('Office worker 已关闭')
    while (this.pending !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      if (this.closed) return failure('Office worker 已关闭')
    }
    const child = this.ensureChild()
    if (child === undefined) return failure('Office worker 不可用')
    const id = `office-${++this.counter}`
    return new Promise<OfficeWorkerResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.options.logger?.warn('Office worker 超时，已终止且不自动重试', {
          timeoutMs: this.timeoutMs,
          action: request.action,
        })
        this.pending = undefined
        this.restartChild()
        resolve(failure(`Office 操作超时（${this.timeoutMs}ms），worker 已终止`))
      }, this.timeoutMs)
      timer.unref?.()
      this.pending = { id, resolve, timer }
      try {
        child.postMessage({ ...request, id })
      } catch (error) {
        clearTimeout(timer)
        this.pending = undefined
        resolve(failure(`发送 Office worker 请求失败：${String(error)}`))
      }
    })
  }

  close(): void {
    this.closed = true
    const pending = this.pending
    if (pending !== undefined) {
      clearTimeout(pending.timer)
      this.pending = undefined
      pending.resolve(failure('Office worker 已关闭'))
    }
    this.child?.kill()
    this.child = undefined
  }

  get running(): boolean {
    return this.pending !== undefined
  }

  private ensureChild(): OfficeChildLike | undefined {
    if (this.child === undefined || this.needsRespawn) {
      this.child?.kill()
      try {
        this.child = this.options.fork()
        this.needsRespawn = false
        this.attach(this.child)
      } catch (error) {
        this.options.logger?.warn('Office worker 启动失败', { error: String(error) })
        this.child = undefined
        return undefined
      }
    }
    return this.child
  }

  private attach(child: OfficeChildLike): void {
    child.on('message', (message) => {
      const payload = unwrapOfficeMessage(message)
      const pending = this.pending
      if (pending === undefined || payload?.id !== pending.id) return
      clearTimeout(pending.timer)
      this.pending = undefined
      pending.resolve(payload)
    })
    child.on('exit', (code) => {
      this.needsRespawn = true
      this.child = undefined
      const pending = this.pending
      if (pending === undefined) return
      clearTimeout(pending.timer)
      this.pending = undefined
      this.options.logger?.warn('Office worker 退出，在途请求失败', { code })
      pending.resolve(failure(`Office worker 退出（code=${code}）`))
    })
  }

  private restartChild(): void {
    this.child?.kill()
    this.child = undefined
    this.needsRespawn = true
  }
}

export function unwrapOfficeMessage(message: unknown): OfficeWorkerResponse | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const record = message as Record<string, unknown>
  const candidate =
    typeof record['data'] === 'object' && record['data'] !== null
      ? (record['data'] as Record<string, unknown>)
      : record
  return typeof candidate['id'] === 'string' && typeof candidate['ok'] === 'boolean'
    ? (candidate as unknown as OfficeWorkerResponse)
    : undefined
}

function failure(error: string): OfficeWorkerResponse {
  return { id: '', ok: false, error }
}
