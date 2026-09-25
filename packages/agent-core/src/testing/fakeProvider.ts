/** 测试用假 LLM provider：按脚本轮次产出 ChatEvent。 */
import type {
  ChatEvent,
  ChatRequestMessage,
  LlmToolDefinition,
  ReasoningEffortLevel,
} from '../llm/types.js'
import type { LoopProvider } from '../loop/agentLoop.js'

export interface RecordedCall {
  model: string
  messages: ChatRequestMessage[]
  tools?: LlmToolDefinition[]
  temperature?: number
  /** 思考等级；`undefined` 表示本次请求没有下发思考等级字段 */
  reasoningEffort?: ReasoningEffortLevel
}

export interface ScriptRound {
  /** 思考链增量序列（每个元素一条 `reasoning` 事件，先于文本产出） */
  reasoning?: string[]
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
        // 快照发送时的消息列表：loop 会在轮次之间原地 push 同一个数组，
        // 不拷贝的话后面轮次的追加会"回填"进前面轮次的记录里
        messages: req.messages.map((message) => ({ ...message })),
        ...(req.tools === undefined ? {} : { tools: req.tools }),
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
        ...(req.reasoningEffort === undefined ? {} : { reasoningEffort: req.reasoningEffort }),
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
  for (const delta of round.reasoning ?? []) {
    yield { type: 'reasoning', delta }
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
