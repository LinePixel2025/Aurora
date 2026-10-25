/**
 * 插件 RPC 的**纯协议实现**（docs/14 §2.3）：主进程宿主与 `plugin-host` 共用。
 *
 * 不 import electron / 不碰文件系统，传输层只要求一个 `send(message)`；
 * 关联 id、超时、取消、在途上限与帧大小都在这里判定，可以脱离真实子进程单测。
 */
import {
  PLUGIN_RPC_MAX_FRAME_BYTES,
  PLUGIN_RPC_MAX_INFLIGHT,
  PLUGIN_RPC_VERSION,
  type PluginRpcError,
  type PluginRpcErrorCode,
  type PluginRpcMessage,
} from '@aurora/shared'

export class PluginRpcFailure extends Error {
  readonly code: PluginRpcErrorCode | string
  readonly detail?: string

  constructor(code: PluginRpcErrorCode | string, message: string, detail?: string) {
    super(message)
    this.name = 'PluginRpcFailure'
    this.code = code
    if (detail !== undefined) this.detail = detail
  }
}

export interface PluginRpcTransport {
  send(message: PluginRpcMessage): void
}

export interface PluginRpcRequestOptions {
  timeoutMs: number
  signal?: AbortSignal
}

export interface PluginRpcPeerOptions {
  label?: string
  maxInflight?: number
  /** 收到宿主 / 插件发来的请求；未提供时回 `E_PLUGIN_INVALID_ARGS` */
  onRequest?: (
    method: string,
    params: unknown,
    context: { id: string },
  ) => unknown | Promise<unknown>
  onEvent?: (event: string, payload: unknown) => void
  /** 对端撤销某个在途请求（宿主侧用来 abort 本地处理器） */
  onCancel?: (id: string) => void
}

interface PendingCall {
  method: string
  resolve(value: unknown): void
  reject(error: unknown): void
  timer: NodeJS.Timeout
  detach?: () => void
}

function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  } catch {
    return PLUGIN_RPC_MAX_FRAME_BYTES + 1
  }
}

export class PluginRpcPeer {
  private readonly transport: PluginRpcTransport
  private readonly options: PluginRpcPeerOptions
  private readonly pending = new Map<string, PendingCall>()
  private counter = 0
  private disposed = false

  constructor(transport: PluginRpcTransport, options: PluginRpcPeerOptions = {}) {
    this.transport = transport
    this.options = options
  }

  get inflight(): number {
    return this.pending.size
  }

  /** 装配期绑定（进程工厂先建 peer，manager 随后注入宿主 API 处理器）。 */
  setRequestHandler(handler: PluginRpcPeerOptions['onRequest']): void {
    this.options.onRequest = handler
  }

  setEventHandler(handler: PluginRpcPeerOptions['onEvent']): void {
    this.options.onEvent = handler
  }

  request(method: string, params: unknown, options: PluginRpcRequestOptions): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new PluginRpcFailure('E_PLUGIN_CRASHED', '插件进程已退出'))
    }
    if (this.pending.size >= (this.options.maxInflight ?? PLUGIN_RPC_MAX_INFLIGHT)) {
      return Promise.reject(
        new PluginRpcFailure('E_PLUGIN_TOO_MANY_INFLIGHT', '插件同时在途请求过多'),
      )
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(new PluginRpcFailure('E_PLUGIN_CANCELLED', '调用已取消'))
    }

    const id = `r${++this.counter}`
    const message: PluginRpcMessage = {
      v: PLUGIN_RPC_VERSION,
      kind: 'req',
      id,
      method,
      params,
    }
    if (byteLength(message) > PLUGIN_RPC_MAX_FRAME_BYTES) {
      return Promise.reject(new PluginRpcFailure('E_PLUGIN_FRAME_TOO_LARGE', '请求超过 1 MiB 上限'))
    }

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id)
          reject(new PluginRpcFailure('E_PLUGIN_TIMEOUT', `插件调用超时（${method}）`))
        },
        Math.max(1, options.timeoutMs),
      )
      timer.unref?.()

      const abort = (): void => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        clearTimeout(timer)
        try {
          this.transport.send({ v: PLUGIN_RPC_VERSION, kind: 'cancel', id })
        } catch {
          /* 进程已经退出，cancel 发不出去不影响本地收尾 */
        }
        reject(new PluginRpcFailure('E_PLUGIN_CANCELLED', '调用已取消'))
      }
      options.signal?.addEventListener('abort', abort, { once: true })

      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', abort)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', abort)
          reject(error)
        },
        timer,
      })

      try {
        this.transport.send(message)
      } catch (error) {
        const pending = this.pending.get(id)
        this.pending.delete(id)
        pending?.reject(new PluginRpcFailure('E_PLUGIN_CRASHED', '插件进程不可用', String(error)))
      }
    })
  }

  /** 处理一条入站消息（传输层原样把结构化克隆对象交进来）。 */
  handleMessage(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return
    const message = raw as Partial<PluginRpcMessage> & { kind?: unknown }
    if (message.v !== PLUGIN_RPC_VERSION || typeof message.kind !== 'string') return

    if (message.kind === 'res') {
      const id = typeof message.id === 'string' ? message.id : ''
      const pending = this.pending.get(id)
      if (pending === undefined) return
      this.pending.delete(id)
      if (message.ok === true) {
        pending.resolve(message.result)
      } else {
        const error = (message as { error?: PluginRpcError }).error
        pending.reject(
          new PluginRpcFailure(
            typeof error?.code === 'string' ? error.code : 'E_PLUGIN_TOOL_FAILED',
            typeof error?.message === 'string' ? error.message : '插件调用失败',
            typeof error?.detail === 'string' ? error.detail : undefined,
          ),
        )
      }
      return
    }

    if (message.kind === 'cancel') {
      if (typeof message.id === 'string') this.options.onCancel?.(message.id)
      return
    }

    if (message.kind === 'evt') {
      const event = typeof message.event === 'string' ? message.event : ''
      if (event !== '') this.options.onEvent?.(event, message.payload)
      return
    }

    if (message.kind === 'req') {
      const id = typeof message.id === 'string' ? message.id : ''
      const method = typeof message.method === 'string' ? message.method : ''
      const handler = this.options.onRequest
      if (id === '' || method === '' || handler === undefined) {
        this.replyError(id, 'E_PLUGIN_INVALID_ARGS', `未实现的调用：${method}`)
        return
      }
      void Promise.resolve()
        .then(() => handler(method, message.params, { id }))
        .then(
          (result) => this.replyOk(id, result),
          (error: unknown) => {
            if (error instanceof PluginRpcFailure) {
              this.replyError(id, error.code, error.message, error.detail)
            } else {
              this.replyError(
                id,
                'E_PLUGIN_TOOL_FAILED',
                error instanceof Error ? error.message : String(error),
              )
            }
          },
        )
    }
  }

  /** 进程退出 / 主动销毁：拒绝全部在途请求。 */
  dispose(reason = '插件进程已退出'): void {
    this.disposed = true
    for (const [, pending] of this.pending) {
      pending.reject(new PluginRpcFailure('E_PLUGIN_CRASHED', reason))
    }
    this.pending.clear()
  }

  private replyOk(id: string, result: unknown): void {
    const message: PluginRpcMessage = { v: PLUGIN_RPC_VERSION, kind: 'res', id, ok: true, result }
    if (byteLength(message) > PLUGIN_RPC_MAX_FRAME_BYTES) {
      this.replyError(id, 'E_PLUGIN_FRAME_TOO_LARGE', '结果超过 1 MiB 上限')
      return
    }
    try {
      this.transport.send(message)
    } catch {
      /* 对端已退出 */
    }
  }

  private replyError(
    id: string,
    code: PluginRpcErrorCode | string,
    message: string,
    detail?: string,
  ): void {
    if (id === '') return
    try {
      this.transport.send({
        v: PLUGIN_RPC_VERSION,
        kind: 'res',
        id,
        ok: false,
        error: { code, message, ...(detail === undefined ? {} : { detail }) },
      })
    } catch {
      /* 对端已退出 */
    }
  }
}
