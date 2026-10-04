import { describe, expect, it } from 'vitest'
import { createNoopLogger, type AgentEvent, type AgentHost } from '@aurora/shared'
import { FileAwarenessAnalyzer } from './file-awareness-agent.js'

class FakeAgent implements AgentHost {
  private listeners = new Set<(event: AgentEvent) => void>()
  aborted: string[] = []

  async send(request: {
    sessionId: string
    text: string
    origin: string
    extraContext?: string
  }): Promise<{ requestId: string }> {
    const requestId = 'req-1'
    queueMicrotask(() => {
      this.emit({
        type: 'text',
        sessionId: request.sessionId,
        requestId,
        seq: 1,
        round: 0,
        messageId: 'm1',
        delta: '{"ok":',
      })
      this.emit({
        type: 'text',
        sessionId: request.sessionId,
        requestId,
        seq: 2,
        round: 0,
        messageId: 'm1',
        delta: 'true}',
      })
      this.emit({ type: 'done', sessionId: request.sessionId, requestId, seq: 3 })
    })
    return { requestId }
  }

  abort(requestId: string): boolean {
    this.aborted.push(requestId)
    return true
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  isReady(): boolean {
    return true
  }

  isBusy(): boolean {
    return false
  }

  async compact(): Promise<never> {
    throw new Error('not used')
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

describe('FileAwarenessAnalyzer', () => {
  it('聚合 text 增量并在 done 收尾；dispose 后解绑', async () => {
    const agent = new FakeAgent()
    const analyzer = new FileAwarenessAnalyzer({ agent, logger: createNoopLogger() })
    await expect(analyzer.analyze({ sessionId: 'awareness-1', text: '分析' })).resolves.toBe(
      '{"ok":true}',
    )
    analyzer.dispose()
  })
})
