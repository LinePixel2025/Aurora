/**
 * Agent Loop —— 工具调用循环（docs/06 §5）。
 *
 * 纯逻辑：不依赖 Electron / 文件系统 / 网络实现，全部经参数注入，
 * 因此可以用假 provider + 内存会话完整单测（含多轮工具调用）。
 *
 * 循环形态：用户消息 → LLM → [工具调用 → 顺序执行 → 结果回填] × N（上限 8 轮）→ 最终回复。
 * 每个 LLM 轮次产生的助手消息（文本 + 工具调用）**立即持久化**：
 * 工具结果必须能对应到发起它的 assistant 消息，否则续接上下文时服务端会拒绝请求。
 */
import type { AgentToolCall } from '@aurora/shared'
import type {
  ChatEvent,
  ChatRequestMessage,
  LlmToolDefinition,
  ReasoningEffortLevel,
} from '../llm/types.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { NewMessage, StoredMessage, StoredToolCall } from '../session/types.js'

export const DEFAULT_MAX_ROUNDS = 8

export type AgentLoopEvent =
  | { type: 'text'; messageId: string; delta: string }
  | { type: 'tool'; messageId: string; call: AgentToolCall }
  | { type: 'done'; pending?: boolean }
  | { type: 'error'; code: string; message: string }

/** 只依赖 `chat()` 的 provider 形状（便于测试注入假实现） */
export interface LoopProvider {
  readonly id: string
  chat(
    req: {
      model: string
      messages: ChatRequestMessage[]
      tools?: LlmToolDefinition[]
      temperature?: number
      /** 思考等级；`undefined` = 不下发思考等级字段（见 `ReasoningEffortLevel`） */
      reasoningEffort?: ReasoningEffortLevel
      jsonObject?: boolean
    },
    signal?: AbortSignal,
  ): AsyncIterable<ChatEvent>
}

export interface AgentLoopOptions {
  provider: LoopProvider
  model: string
  temperature?: number
  /** 思考等级（v5）；`undefined` = 不下发思考等级字段 */
  reasoningEffort?: ReasoningEffortLevel
  systemPrompt: string
  /** 本次用户输入 */
  userInput: string
  /**
   * 与本次请求相关的补充上下文（如技能正文、强制注入的提示）。
   * 随用户消息一起送入模型，**只影响本次请求，不写入会话历史**。
   */
  extraContext?: string
  /** 本次用户输入之前的会话历史（不含本次输入） */
  history: readonly StoredMessage[]
  tools: ToolRegistry
  sessionId: string
  signal?: AbortSignal
  maxRounds?: number
  /**
   * 敏感工具（`sensitivity === 'confirm'`）执行前的用户确认（docs/06 §5）。
   *
   * 返回 `false` 表示用户拒绝：不执行工具，以「用户拒绝执行」文本回填模型，
   * 工具卡片置 `error`，循环继续（模型可以改走别的路径或向用户说明）。
   *
   * **未提供时保持 v0.3.0 行为**：不拦截、只记日志留痕。
   * 这样既不会让 P3 的 MCP 路径意外变成"必然被拒"，
   * 也保证确认交互只在主进程真正接好后才生效。
   */
  confirmTool?(info: {
    name: string
    input: unknown
    sessionId: string
    sensitivity: 'confirm'
  }): Promise<boolean>
  /** 落盘一条消息（用户 / 助手 / 工具结果） */
  append(message: NewMessage): Promise<StoredMessage>
  /** 原地更新某条助手消息里的工具卡片状态 */
  updateToolCall(messageId: string, call: StoredToolCall): Promise<void>
  /** 工具执行留痕（供主进程日志与后续权限确认使用） */
  onToolCall?(info: { name: string; sensitivity: string; isError: boolean }): void
}

export async function* runAgentLoop(options: AgentLoopOptions): AsyncIterable<AgentLoopEvent> {
  const maxRounds = Math.max(1, options.maxRounds ?? DEFAULT_MAX_ROUNDS)
  const messages: ChatRequestMessage[] = [
    { role: 'system', content: options.systemPrompt },
    ...toMessages(options.history),
  ]

  // 用户消息先落盘，保证即使后续失败也能在历史里看到提问
  await options.append({ role: 'user', content: options.userInput })
  messages.push({ role: 'user', content: options.userInput })
  // 技能正文等一次性上下文：放在用户消息之后，只影响本次请求，不写入历史
  if (options.extraContext !== undefined && options.extraContext.trim() !== '') {
    messages.push({ role: 'system', content: options.extraContext })
  }

  const llmTools = toLlmTools(options.tools)
  let pending = false

  for (let round = 0; round < maxRounds; round += 1) {
    if (options.signal?.aborted) {
      yield { type: 'done' }
      return
    }

    let text = ''
    const calls: StoredToolCall[] = []
    let failed: { code: string; message: string } | null = null

    for await (const event of options.provider.chat(
      {
        model: options.model,
        messages,
        ...(llmTools.length === 0 ? {} : { tools: llmTools }),
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: options.reasoningEffort }),
      },
      options.signal,
    )) {
      if (event.type === 'text') {
        text += event.delta
        continue
      }
      if (event.type === 'tool_call') {
        calls.push({
          id: event.call.id,
          name: event.call.name,
          arguments: event.call.arguments,
          state: 'running',
        })
        continue
      }
      if (event.type === 'error') {
        failed = { code: event.code, message: event.message }
        break
      }
    }

    if (failed) {
      // 已产出的文本先落盘，避免用户看到的内容在历史里消失
      if (text !== '' || calls.length > 0) {
        await appendAssistant(options, text, calls)
      }
      yield { type: 'error', code: failed.code, message: failed.message }
      return
    }

    const assistant = await appendAssistant(options, text, calls)
    if (text !== '') yield { type: 'text', messageId: assistant.id, delta: text }

    if (calls.length === 0) {
      yield { type: 'done' }
      return
    }

    messages.push(toAssistantMessage(assistant))

    // 同轮多个工具调用：顺序执行，保证事件与结果顺序确定（docs/06 §5）
    for (const call of calls) {
      if (options.signal?.aborted) {
        yield { type: 'done' }
        return
      }

      const running = toAgentToolCall(call)
      yield { type: 'tool', messageId: assistant.id, call: running }

      const outcome = await runTool(options, call)
      call.state = outcome.state
      call.outputSummary = outcome.summary
      // 持久化工具卡片状态（同一 messageId 原地更新，渲染层据此刷新）
      await options.updateToolCall(assistant.id, { ...call })

      yield { type: 'tool', messageId: assistant.id, call: toAgentToolCall(call) }

      const toolMessage = await options.append({
        role: 'tool',
        content: outcome.content,
        toolCallId: call.id,
      })
      messages.push({
        role: 'tool',
        content: toolMessage.content,
        toolCallId: call.id,
      })
    }

    if (round === maxRounds - 1) pending = true
  }

  // 轮次用尽仍未收敛：保留已产出的输出，标记 pending（不报错、不丢内容）
  yield { type: 'done', ...(pending ? { pending: true } : {}) }
}

// ───────────────────────── 内部 ─────────────────────────

async function appendAssistant(
  options: AgentLoopOptions,
  text: string,
  calls: StoredToolCall[],
): Promise<StoredMessage> {
  return options.append({
    role: 'assistant',
    content: text,
    ...(calls.length === 0 ? {} : { toolCalls: calls.map((call) => ({ ...call })) }),
  })
}

function toMessages(history: readonly StoredMessage[]): ChatRequestMessage[] {
  const out: ChatRequestMessage[] = []
  for (const message of history) {
    if (message.role === 'system') continue
    if (message.role === 'tool') {
      out.push({
        role: 'tool',
        content: message.content,
        ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
      })
      continue
    }
    if (message.role === 'assistant') {
      const stored = message.toolCalls ?? []
      out.push({
        role: 'assistant',
        content: message.content,
        ...(stored.length === 0
          ? {}
          : {
              toolCalls: stored.map((call) => ({
                id: call.id,
                name: call.name,
                arguments: call.arguments,
              })),
            }),
      })
      continue
    }
    out.push({ role: 'user', content: message.content })
  }
  return out
}

function toAssistantMessage(message: StoredMessage): ChatRequestMessage {
  const calls = message.toolCalls ?? []
  return {
    role: 'assistant',
    content: message.content,
    ...(calls.length === 0
      ? {}
      : {
          toolCalls: calls.map((call) => ({
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          })),
        }),
  }
}

function toLlmTools(tools: ToolRegistry): LlmToolDefinition[] {
  return tools.list().map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
}

function toAgentToolCall(call: StoredToolCall): AgentToolCall {
  return {
    id: call.id,
    name: call.name,
    ...(parseArguments(call.arguments) === undefined
      ? {}
      : { input: parseArguments(call.arguments) }),
    state: call.state,
    ...(call.outputSummary === undefined ? {} : { outputSummary: call.outputSummary }),
  }
}

function parseArguments(raw: string): unknown {
  if (raw.trim() === '') return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return { _raw: raw }
  }
}

interface ToolOutcome {
  content: string
  summary: string
  state: 'success' | 'error'
}

async function runTool(options: AgentLoopOptions, call: StoredToolCall): Promise<ToolOutcome> {
  const tool = options.tools.get(call.name)
  if (tool === undefined) {
    const message = `工具 "${call.name}" 不存在；请从可用工具清单中选择。`
    options.onToolCall?.({ name: call.name, sensitivity: 'unknown', isError: true })
    return { content: message, summary: message, state: 'error' }
  }

  let input: unknown
  try {
    input = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments)
  } catch {
    const message = `工具参数不是合法 JSON：${truncate(call.arguments, 200)}`
    options.onToolCall?.({
      name: call.name,
      sensitivity: tool.sensitivity ?? 'safe',
      isError: true,
    })
    return { content: message, summary: message, state: 'error' }
  }

  // 敏感工具执行前的用户确认（docs/06 §5）。
  // 未接确认钩子时保持既有行为（仅标记 sensitivity + 日志留痕）。
  if (tool.sensitivity === 'confirm' && options.confirmTool !== undefined) {
    let approved = false
    try {
      approved = await options.confirmTool({
        name: call.name,
        input,
        sessionId: options.sessionId,
        sensitivity: 'confirm',
      })
    } catch (error) {
      // 确认链路本身出错按"拒绝"处理：宁可不动敏感操作，也不越权执行
      approved = false
      options.onToolCall?.({ name: call.name, sensitivity: 'confirm', isError: true })
      const message = `用户确认流程异常，已取消执行：${error instanceof Error ? error.message : String(error)}`
      return { content: message, summary: message, state: 'error' }
    }

    if (!approved) {
      options.onToolCall?.({ name: call.name, sensitivity: 'confirm', isError: true })
      const message = `用户拒绝执行工具 "${call.name}"，请勿重复调用；如确有必要，请先向用户说明原因并征得同意。`
      return { content: message, summary: '用户拒绝执行', state: 'error' }
    }
  }

  try {
    const result = await tool.execute(input, {
      sessionId: options.sessionId,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    const isError = result.isError === true
    options.onToolCall?.({ name: call.name, sensitivity: tool.sensitivity ?? 'safe', isError })
    const summary = result.summary ?? truncate(result.content, 200)
    return {
      content:
        result.content === ''
          ? isError
            ? '（工具返回空错误）'
            : '（工具无输出）'
          : result.content,
      summary,
      state: isError ? 'error' : 'success',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    options.onToolCall?.({
      name: call.name,
      sensitivity: tool.sensitivity ?? 'safe',
      isError: true,
    })
    // 工具抛错不中断循环：以错误文本回填，让模型自行决定下一步
    return {
      content: `工具执行失败：${message}`,
      summary: `工具执行失败：${message}`,
      state: 'error',
    }
  }
}

function truncate(text: string, max: number): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length <= max ? compact : `${compact.slice(0, max)}…`
}
