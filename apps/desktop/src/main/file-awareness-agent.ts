/**
 * 文件自感知的后台 Agent 适配器（docs/06 §26）。
 *
 * 复用 KernelAgentHost，但按 `origin: 'file-awareness'` 走无工具运行档；这里只把一次请求
 * 的流式正文聚合为最终字符串，交给文件自感知服务解析。
 */
import type { AgentEvent, AgentHost, Logger, SessionUsageStats } from '@aurora/shared'

export interface FileAwarenessAnalyzeResult {
  text: string
  usage?: SessionUsageStats
}

export interface FileAwarenessAgentOptions {
  agent: AgentHost
  logger: Logger
  timeoutMs?: number
}

interface Pending {
  requestId?: string
  sessionId: string
  text: string
  usage?: SessionUsageStats
  resolve: (result: FileAwarenessAnalyzeResult) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class FileAwarenessAnalyzer {
  private readonly options: FileAwarenessAgentOptions
  private readonly pending = new Map<string, Pending>()
  private readonly preparing = new Map<string, Pending>()
  private readonly detach: () => void

  constructor(options: FileAwarenessAgentOptions) {
    this.options = options
    this.detach = options.agent.onEvent((event) => this.handleEvent(event))
  }

  async analyze(input: {
    sessionId: string
    text: string
    extraContext?: string
    images?: readonly string[]
  }): Promise<FileAwarenessAnalyzeResult> {
    return await new Promise<FileAwarenessAnalyzeResult>((resolve, reject) => {
      const pending: Pending = {
        sessionId: input.sessionId,
        text: '',
        resolve,
        reject,
        timer: setTimeout(() => {
          this.settleBySession(input.sessionId, new Error('文件自感知后台 Agent 超时'))
          if (pending.requestId !== undefined) this.options.agent.abort(pending.requestId)
        }, this.options.timeoutMs ?? 120_000),
      }
      pending.timer.unref?.()
      this.preparing.set(input.sessionId, pending)
      void this.options.agent
        .send({
          sessionId: input.sessionId,
          text: input.text,
          origin: 'file-awareness',
          ...(input.extraContext === undefined ? {} : { extraContext: input.extraContext }),
          ...(input.images === undefined || input.images.length === 0
            ? {}
            : { images: input.images }),
        })
        .then(({ requestId }) => {
          if (this.preparing.get(input.sessionId) !== pending) return
          pending.requestId = requestId
          this.preparing.delete(input.sessionId)
          this.pending.set(requestId, pending)
        })
        .catch((error: unknown) => {
          this.settleBySession(
            input.sessionId,
            error instanceof Error ? error : new Error(String(error)),
          )
        })
    })
  }

  dispose(): void {
    for (const pending of [...this.pending.values(), ...this.preparing.values()]) {
      clearTimeout(pending.timer)
      pending.reject(new Error('文件自感知后台 Agent 已关闭'))
    }
    this.pending.clear()
    this.preparing.clear()
    this.detach()
  }

  private handleEvent(event: AgentEvent): void {
    const pending =
      this.pending.get(event.requestId) ??
      (this.preparing.get(event.sessionId)?.sessionId === event.sessionId
        ? this.preparing.get(event.sessionId)
        : undefined)
    if (pending === undefined || pending.sessionId !== event.sessionId) return
    if (event.type === 'text') {
      pending.text += event.delta
      return
    }
    if (event.type === 'usage') {
      pending.usage = addUsage(pending.usage, {
        promptTokens: event.usage.promptTokens,
        completionTokens: event.usage.completionTokens,
        totalTokens: event.usage.totalTokens,
        cachedTokens: event.usage.cachedTokens ?? 0,
        rounds: 1,
      })
      return
    }
    if (event.type === 'done') {
      this.settleBySession(event.sessionId, undefined, pending.text, pending.usage)
      return
    }
    if (event.type === 'error') {
      this.settleBySession(event.sessionId, new Error(event.message))
    }
  }

  private settleBySession(
    sessionId: string,
    error?: Error,
    text = '',
    usage?: SessionUsageStats,
  ): void {
    const pending =
      this.preparing.get(sessionId) ??
      ((): Pending | undefined => {
        for (const item of this.pending.values()) {
          if (item.sessionId === sessionId) return item
        }
        return undefined
      })()
    if (pending === undefined) return
    this.preparing.delete(sessionId)
    if (pending.requestId !== undefined) this.pending.delete(pending.requestId)
    clearTimeout(pending.timer)
    this.options.logger.debug('文件自感知后台 Agent 收尾', {
      sessionId: pending.sessionId,
      failed: error !== undefined,
      chars: text.length,
    })
    if (error !== undefined) pending.reject(error)
    else pending.resolve({ text, ...(usage === undefined ? {} : { usage }) })
  }
}

function addUsage(
  current: SessionUsageStats | undefined,
  next: SessionUsageStats,
): SessionUsageStats {
  return {
    promptTokens: (current?.promptTokens ?? 0) + Math.max(0, next.promptTokens),
    completionTokens: (current?.completionTokens ?? 0) + Math.max(0, next.completionTokens),
    totalTokens: (current?.totalTokens ?? 0) + Math.max(0, next.totalTokens),
    cachedTokens: (current?.cachedTokens ?? 0) + Math.max(0, next.cachedTokens),
    rounds: (current?.rounds ?? 0) + Math.max(0, next.rounds),
  }
}
