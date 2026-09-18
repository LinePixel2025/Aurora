/** 测试用假 LLM provider：按脚本轮次产出 ChatEvent。 */
import type { ChatEvent, ChatRequestMessage, LlmToolDefinition } from '../llm/types.js'
import type { LoopProvider } from '../loop/agentLoop.js'

export interface RecordedCall {
  model: string
  messages: ChatRequestMessage[]
  tools?: LlmToolDefinition[]
  temperature?: number
}

export interface ScriptRound {
  text?: string
  toolCalls?: Array<{ id: string; name: string; arguments?: string }>
  error?: { code: string; message: string }
}

/** 把脚本轮次展开为事件流（每轮以 done 收尾）。 */
export function createFakeProvider(
  rounds: ScriptRound[],
): LoopProvider & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  let index = 0
  return {
    id: 'fake',
    calls,
    chat(req, signal) {
      const round = rounds[index] ?? { text: '（脚本已用尽）' }
      index += 1
      calls.push({
        model: req.model,
        messages: req.messages,
        ...(req.tools === undefined ? {} : { tools: req.tools }),
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
      })
      return iterate(round, signal)
    },
  }
}

async function* iterate(round: ScriptRound, signal?: AbortSignal): AsyncIterable<ChatEvent> {
  if (signal?.aborted) {
    yield { type: 'done', finishReason: 'stop' }
    return
  }
  if (round.text !== undefined && round.text !== '') {
    yield { type: 'text', delta: round.text }
  }
  for (const call of round.toolCalls ?? []) {
    yield {
      type: 'tool_call',
      call: { id: call.id, name: call.name, arguments: call.arguments ?? '{}' },
    }
  }
  if (round.error !== undefined) {
    yield { type: 'error', code: round.error.code as never, message: round.error.message }
    return
  }
  yield {
    type: 'done',
    finishReason: (round.toolCalls?.length ?? 0) > 0 ? 'tool_calls' : 'stop',
  }
}
