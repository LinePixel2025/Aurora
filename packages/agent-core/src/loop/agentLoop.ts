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
import type { AgentToolCall, SubagentSnapshot } from '@aurora/shared'
import type {
  ChatEvent,
  ChatRequestMessage,
  LlmToolDefinition,
  ReasoningEffortLevel,
} from '../llm/types.js'
import type { ToolProgress, ToolRegistry } from '../tools/registry.js'
import type { NewMessage, StoredMessage, StoredToolCall } from '../session/types.js'

export const DEFAULT_MAX_ROUNDS = 8

/**
 * 循环事件（docs/06 §5、§16.1）。
 *
 * `round`：本事件属于第几个工具调用轮次（从 0 起）。思考链增量自身没有 `messageId`
 * （那轮助手消息要等流结束才落盘），带 `round` 后渲染层才能把思考绑到正确的消息上。
 */
export type AgentLoopEvent =
  | { type: 'reasoning'; round: number; delta: string }
  | { type: 'text'; round: number; messageId: string; delta: string }
  | { type: 'tool'; round: number; messageId: string; call: AgentToolCall }
  | {
      type: 'subagent'
      round: number
      messageId: string
      callId: string
      snapshot: SubagentSnapshot
    }
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
    let reasoning = ''
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
      if (event.type === 'reasoning') {
        // 思考链增量边到边转发（转发时还没有 messageId，渲染层按 requestId + round 聚合），
        // 同时累积进本轮助手消息的 reasoning 字段，随 append 一起持久化
        reasoning += event.delta
        yield { type: 'reasoning', round, delta: event.delta }
        continue
      }
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
      // 已产出的文本与思考链先落盘，避免用户看到的内容在历史里消失
      if (text !== '' || reasoning !== '' || calls.length > 0) {
        await appendAssistant(options, text, calls, reasoning)
      }
      yield { type: 'error', code: failed.code, message: failed.message }
      return
    }

    const assistant = await appendAssistant(options, text, calls, reasoning)
    if (text !== '') yield { type: 'text', round, messageId: assistant.id, delta: text }

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
      yield { type: 'tool', round, messageId: assistant.id, call: running }

      // 工具执行与进度事件并行推进：`task` 子代理在执行期间持续上报进度快照，
      // 由 runToolStreaming 边收边转成 `subagent` 事件（否则要等工具跑完才看得到）
      const streaming = runToolStreaming(options, call, assistant.id, round)
      let outcome: ToolOutcome
      for (;;) {
        const step = await streaming.next()
        if (step.done === true) {
          outcome = step.value
          break
        }
        yield step.value
      }

      call.state = outcome.state
      call.outputSummary = outcome.summary
      // 子代理快照随工具卡一起持久化（渲染层「子代理」页面据此回看历史运行）
      if (outcome.subagent !== undefined) call.subagent = outcome.subagent
      // 持久化工具卡片状态（同一 messageId 原地更新，渲染层据此刷新）
      await options.updateToolCall(assistant.id, { ...call })

      yield { type: 'tool', round, messageId: assistant.id, call: toAgentToolCall(call) }

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
  reasoning = '',
): Promise<StoredMessage> {
  return options.append({
    role: 'assistant',
    content: text,
    ...(calls.length === 0 ? {} : { toolCalls: calls.map((call) => ({ ...call })) }),
    // 空串视为「没有思考链」，不落字段（与 toolCalls 的缺省口径一致）
    ...(reasoning === '' ? {} : { reasoning }),
  })
}

function toMessages(history: readonly StoredMessage[]): ChatRequestMessage[] {
  // 只挑 API 需要的字段（role / content / 工具调用）：`reasoning` 等展示字段一律不回传
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
    ...(call.subagent === undefined ? {} : { subagent: call.subagent }),
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
  /** 工具自报的最终子代理快照（仅 `task`；随工具卡一起持久化） */
  subagent?: SubagentSnapshot
}

/**
 * 执行一次工具调用，并把工具在执行期间上报的进度（`emitProgress`）转成循环事件。
 *
 * 异步生成器的返回值是最终 `ToolOutcome`：消费方一路 `yield` 出去即可，
 * 既拿到实时进度、又拿到结果，不必等工具跑完才看得到中间过程。
 */
async function* runToolStreaming(
  options: AgentLoopOptions,
  call: StoredToolCall,
  messageId: string,
  round: number,
): AsyncGenerator<AgentLoopEvent, ToolOutcome> {
  const queue: ToolProgress[] = []
  let wake: (() => void) | undefined
  let finished = false
  let outcome: ToolOutcome | undefined
  let latest: SubagentSnapshot | undefined

  const notify = (): void => {
    const resume = wake
    wake = undefined
    resume?.()
  }
  const emitProgress = (payload: ToolProgress): void => {
    if (payload.kind === 'subagent') latest = payload.snapshot
    queue.push(payload)
    notify()
  }

  void runTool(options, call, emitProgress).then(
    (result) => {
      outcome = result
      finished = true
      notify()
    },
    (error: unknown) => {
      // runTool 自身不抛；这里只是兜底，保证消费方不会永久挂起
      const message = error instanceof Error ? error.message : String(error)
      outcome = { content: `工具执行失败：${message}`, summary: '工具执行失败', state: 'error' }
      finished = true
      notify()
    },
  )

  while (!finished || queue.length > 0) {
    if (queue.length === 0) {
      // 单线程：`wake` 在下一个 await 之前就已赋值，生产者的 notify 不会丢唤醒
      await new Promise<void>((resolve) => {
        wake = resolve
      })
      continue
    }
    const payload = queue.shift()
    if (payload === undefined) continue
    if (payload.kind === 'subagent') {
      yield {
        type: 'subagent',
        round,
        messageId,
        callId: call.id,
        snapshot: payload.snapshot,
      }
    }
  }

  const result = outcome ?? {
    content: '工具没有返回结果',
    summary: '工具没有返回结果',
    state: 'error' as const,
  }
  // 工具自报的最终快照优先（那是终态：status / endedAt / report 都齐），
  // 只在工具没自报时回落到「最后一条进度快照」，避免把运行中的中间态当成终态。
  if (result.subagent !== undefined) return result
  return latest === undefined ? result : { ...result, subagent: latest }
}

async function runTool(
  options: AgentLoopOptions,
  call: StoredToolCall,
  emitProgress?: (payload: ToolProgress) => void,
): Promise<ToolOutcome> {
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
      toolCallId: call.id,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(emitProgress === undefined ? {} : { emitProgress }),
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
      // 工具自报的最终子代理快照（仅 `task`）原样带上，随工具卡持久化
      ...(result.subagent === undefined ? {} : { subagent: result.subagent }),
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
