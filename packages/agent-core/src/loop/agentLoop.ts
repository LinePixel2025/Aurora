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
import type { AgentToolCall, SubagentSnapshot, TokenUsage } from '@aurora/shared'
import type {
  ChatEvent,
  ChatRequestMessage,
  LlmToolDefinition,
  ReasoningEffortLevel,
} from '../llm/types.js'
import type { ToolProgress, ToolRegistry } from '../tools/registry.js'
import type { NewMessage, StoredMessage, StoredToolCall } from '../session/types.js'

export const DEFAULT_MAX_ROUNDS = 32

/**
 * 确认结果（四态，docs/06 §5、§11.2）：
 * - `false` = 拒绝；
 * - `true` = 用户**当次**在确认卡片上点放行；
 * - `'always'` = 用户**当次**点「总是允许」（本次放行 + 本会话内同名工具不再询问）；
 * - `'machine'` = 无人参与或历史授权的机器放行（auto 档根内判定、无项目、免确认模式、
 *   已记住 `'always'` 后的会话授权短路）——照常执行，但**不置 `ctx.approvedByUser`**，
 *   工具拿不到 `allowOutside`，端口层的项目根 realpath 兜底保留。
 *
 * 为什么要 `'always'`：敏感工具（写文件、跑命令）在一次任务里往往要连用十几次，
 * 逐次弹同一张卡片会逼用户"闭眼点确定"——那比不确认更危险。`'always'` 把"信任"的粒度
 * 定成**会话 × 工具名**：换会话、换工具都会重新问。
 *
 * 为什么要 `'machine'`：`approvedByUser` 会被文件 / 终端类工具透成 `allowOutside`，
 * 免掉端口层的项目根 realpath 兜底——这个特权必须只属于"用户当次真的看过卡片并点放行"。
 * 机器放行若也返回 `true`，根内指向根外的 junction / 符号链接就能零弹卡写到根外
 * （2026-09 独立安全审查指出的逃逸链），故以独立变体与用户批准区分出处。
 *
 * `'always'` 的**记忆不在本文件**：循环是一次请求一个实例、跑完即弃，记住它等于没记住。
 * 会话级记忆落在 `host/agentHost.ts`（`KernelAgentHost.sessionApprovals`，只存内存、不落盘），
 * 由它包装 `confirmTool` 后交进来——循环这一层只认"这次放行没放行"。
 */
export type ConfirmDecision = boolean | 'always' | 'machine'

/**
 * 循环事件（docs/06 §5、§16.1、§16.2）。
 *
 * `round`：本事件属于第几个工具调用轮次（从 0 起）。思考链增量自身没有 `messageId`
 * （那轮助手消息要等流结束才落盘），带 `round` 后渲染层才能把思考绑到正确的消息上。
 *
 * **正文 `text` 是增量**（2026-09 流式轮）：早先这里把一轮的正文攒完再整段发一次，
 * 界面表现为「等模型全部说完才出现回复」。现在每个 delta 都带 `messageId` 立刻转发，
 * 该 id 由 `nextMessageId` 在流开始前预领、落盘时原样沿用，因此边流边渲染的那条消息
 * 与磁盘上的最终消息是**同一条**（docs/06 §16.2）。
 */
export type AgentLoopEvent =
  | { type: 'reasoning'; round: number; messageId: string; delta: string }
  | { type: 'text'; round: number; messageId: string; delta: string }
  | { type: 'tool'; round: number; messageId: string; call: AgentToolCall }
  | {
      type: 'subagent'
      round: number
      messageId: string
      callId: string
      snapshot: SubagentSnapshot
    }
  | { type: 'usage'; round: number; usage: TokenUsage }
  /**
   * 收尾事件（docs/06 §4.1，v15）。
   *
   * - `pending: true` 表示"没有正常收敛就结束了"（轮次用尽 / 预算用尽 / 被中断）；
   * - `pendingReason` 说明**停在哪**（v15 新增）：`'max-rounds'` 轮次用尽、`'budget'` token 预算用尽、
   *   `'aborted'` 用户取消。客户端据此把"静默收尾"变成"可解释的暂停"，并给出「继续」入口。
   * - `round` 是**收尾时的轮次**（从 0 起，续跑时是绝对轮次不是相对轮次）；`usedTokens` 是本请求
   *   累计消耗（预算判定用的同一个数）。
   */
  | {
      type: 'done'
      pending?: boolean
      pendingReason?: 'max-rounds' | 'budget' | 'aborted'
      round: number
      usedTokens?: number
    }
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
   * 返回 `true` / `'always'` 都继续执行；两者的差别（本会话内同名工具不再询问）
   * 由 `KernelAgentHost` 的包装层承担，见 `ConfirmDecision`。
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
  }): Promise<ConfirmDecision>
  /** 落盘一条消息（用户 / 助手 / 工具结果） */
  append(message: NewMessage): Promise<StoredMessage>
  /**
   * 预领一个助手消息 id（正文流式的前提；缺省时循环内部生成一个）。
   *
   * 装配层注入 `SessionStore.nextMessageId`：与 `append` 共用同一计数器，
   * 保证「边流边发」用的 id 与落盘时的 id 是同一个、且不会与其它消息相撞。
   */
  nextMessageId?(): string
  /** 原地更新某条助手消息里的工具卡片状态 */
  updateToolCall(messageId: string, call: StoredToolCall): Promise<void>
  /** 工具执行留痕（供主进程日志与后续权限确认使用） */
  onToolCall?(info: { name: string; sensitivity: string; isError: boolean }): void
  /**
   * 续跑（docs/06 §4.1，v15）：从 `nextRound` 继续，而不是从第 0 轮重来。
   *
   * 循环本身**不做持久化**：谁调用它、谁负责在 `onRoundComplete` 里落游标。
   * `stepsDone` 只用于日志与一致性校验，不参与执行。
   */
  resume?: { nextRound: number; stepsDone: number }
  /**
   * 是否落盘本轮用户消息（**缺省 `true`**）。
   *
   * 续跑时必须传 `false`：那次请求的用户消息在**上一个 job** 里已经落过盘了，
   * 再 append 一次会话历史里就会出现两条一模一样的提问 —— 这是续跑最容易踩的坑。
   */
  appendUserMessage?: boolean
  /** 累计 token 预算（`maxTotalTokens = 0` 表示不限）。触顶即停止进入下一轮并置 `pendingReason: 'budget'` */
  budget?: { maxTotalTokens: number }
  /**
   * 每轮结束（工具都跑完、结果都已回填）时回调一次：调用方在这里把**游标**落盘。
   *
   * 语义是"先把这一轮记下来，再决定要不要继续"——所以它在轮次/预算判定**之前**被调用，
   * 崩溃或重启时最坏情况只是重跑最后那一轮，不会丢掉整段进度。
   */
  onRoundComplete?(info: {
    round: number
    usage?: TokenUsage
    usedTokens: number
    pendingCalls: StoredToolCall[]
  }): Promise<void> | void
}

export async function* runAgentLoop(options: AgentLoopOptions): AsyncIterable<AgentLoopEvent> {
  /**
   * 轮次区间：**续跑时从游标继续**，而不是从第 0 轮重来（docs/06 §4.1）。
   * 上界是"起点 + maxRounds"，至少给一轮 —— 否则 `resume.nextRound >= maxRounds` 时
   * 循环体一次都不进，直接静默结束（用户会看到"点了继续但什么都没发生"）。
   */
  const startRound = Math.max(0, options.resume?.nextRound ?? 0)
  const endRound = Math.max(
    startRound + 1,
    startRound + Math.max(1, options.maxRounds ?? DEFAULT_MAX_ROUNDS),
  )
  const messages: ChatRequestMessage[] = [
    { role: 'system', content: options.systemPrompt },
    ...toMessages(options.history),
  ]

  // 用户消息先落盘，保证即使后续失败也能在历史里看到提问。
  // **续跑时 `appendUserMessage` 为 false**：那条提问在上一个 job 里已经落过盘了，
  // 再 append 一次历史里就会有两份同样的用户消息（续跑最经典的重复落盘 bug）。
  if (options.appendUserMessage !== false) {
    await options.append({ role: 'user', content: options.userInput })
  }
  // 续跑时那条用户消息已经在 `history` 里（上一次请求写下的），不能重复 push 进 messages；
  // 非续跑时才补上本轮输入。
  if (options.appendUserMessage !== false) {
    messages.push({ role: 'user', content: options.userInput })
  }
  // 技能正文等一次性上下文：放在用户消息之后，只影响本次请求，不写入历史
  if (options.extraContext !== undefined && options.extraContext.trim() !== '') {
    messages.push({ role: 'system', content: options.extraContext })
  }

  // 工具数组走注册表的**唯一**实现：它按工具名排序返回（docs/06 §21.2），
  // 顺序只取决于名字集合，与注册先后无关 —— 请求体的 tools 因此是稳定前缀的一部分。
  const llmTools = options.tools.toLlmTools()
  let pending = false
  let pendingReason: 'max-rounds' | 'budget' | 'aborted' | undefined
  /** 本次请求累计消耗（预算判定的唯一依据；只累加 provider 回传的真实用量，不估算） */
  let usedTokens = 0
  const maxTotalTokens = Math.max(0, options.budget?.maxTotalTokens ?? 0)

  for (let round = startRound; round < endRound; round += 1) {
    if (options.signal?.aborted) {
      yield { type: 'done', pending: true, pendingReason: 'aborted', round, usedTokens }
      return
    }

    // 本轮助手消息的 id 在**流开始之前**就领好：正文要边收边发（docs/06 §16.2），
    // 而落盘要等这条流结束 —— 见 `appendAssistant` 里把同一个 id 交给 append。
    const messageId = options.nextMessageId?.() ?? localMessageId()

    let text = ''
    let reasoning = ''
    const calls: StoredToolCall[] = []
    let failed: { code: string; message: string } | null = null
    let usage: TokenUsage | undefined

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
        // 思考链增量边到边转发：与正文一样带上**预领的** messageId（2026-09 流式轮），
        // 渲染层因此能在正文之前就把「正在思考」显示出来；同时累积进本轮助手消息的
        // reasoning 字段，随 append 一起持久化
        reasoning += event.delta
        yield { type: 'reasoning', round, messageId, delta: event.delta }
        continue
      }
      if (event.type === 'text') {
        // 正文增量边到边转发（2026-09 流式轮）：携带**预领的** messageId，
        // 渲染层据此就地创建 / 追加那条助手消息
        text += event.delta
        yield { type: 'text', round, messageId, delta: event.delta }
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
      if (event.type === 'done') {
        if (event.usage !== undefined) usage = event.usage
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
        await appendAssistant(options, messageId, text, calls, reasoning)
      }
      yield { type: 'error', code: failed.code, message: failed.message }
      return
    }

    // 用量先于正文落盘转发：`promptTokens` 就是**本轮真实占用的上下文**，
    // 是输入框底部「上下文详解」的唯一分母/分子来源（docs/06 §16.2）
    if (usage !== undefined) {
      yield { type: 'usage', round, usage }
      // 预算累计（v15）：只认 provider 回传的 `totalTokens`，缺字段时按输入+输出近似
      usedTokens +=
        usage.totalTokens > 0 ? usage.totalTokens : usage.promptTokens + usage.completionTokens
    }

    const assistant = await appendAssistant(options, messageId, text, calls, reasoning)

    if (calls.length === 0) {
      // 模型不再要用工具 = 正常收敛：这不是"暂停"，不带 pendingReason
      yield { type: 'done', round, usedTokens }
      return
    }

    messages.push(toAssistantMessage(assistant))

    // 同轮多个工具调用：顺序执行，保证事件与结果顺序确定（docs/06 §5）
    for (const call of calls) {
      if (options.signal?.aborted) {
        yield { type: 'done', pending: true, pendingReason: 'aborted', round, usedTokens }
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

    // 本轮结束（工具都跑完、结果都回填了）：**先把这一轮记下来再决定要不要继续**。
    // 顺序不能反 —— 反过来的话，最后一轮的进度会随着"暂停"一起丢掉，续跑会重跑它。
    await options.onRoundComplete?.({
      round,
      ...(usage === undefined ? {} : { usage }),
      usedTokens,
      pendingCalls: calls,
    })

    // 预算触顶：停止进入下一轮，并明确告诉调用方"停在哪"（不是静默收尾）
    if (maxTotalTokens > 0 && usedTokens >= maxTotalTokens) {
      yield { type: 'done', pending: true, pendingReason: 'budget', round, usedTokens }
      return
    }

    // 轮次用尽：同上，标成 max-rounds（v15 之前这里只置 pending、没有原因）
    if (round === endRound - 1) pending = true
  }

  // 轮次用尽仍未收敛：保留已产出的输出，标记 pending + 原因（不报错、不丢内容）
  if (pending) pendingReason = 'max-rounds'
  yield {
    type: 'done',
    ...(pending ? { pending: true } : {}),
    ...(pendingReason === undefined ? {} : { pendingReason }),
    round: endRound - 1,
    usedTokens,
  }
}

// ───────────────────────── 内部 ─────────────────────────

/**
 * 循环自带的 id 生成器：只在装配层没注入 `nextMessageId` 时使用（单测的常见情形）。
 *
 * 前缀刻意与 `SessionStore` 的 `msg-<ts>-<n>` 区分开：两条计数器互相看不见，
 * 同一毫秒内数值恰好相同就会撞 id，而 id 撞了意味着界面把两条消息当成同一条。
 */
let localCounter = 0
function localMessageId(): string {
  localCounter += 1
  return `msg-local-${Date.now()}-${localCounter}`
}

async function appendAssistant(
  options: AgentLoopOptions,
  id: string,
  text: string,
  calls: StoredToolCall[],
  reasoning = '',
): Promise<StoredMessage> {
  return options.append({
    id,
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
  //
  // `approvedByUser` 只在"用户当次批准（含首次 'always'）"时置位：它会被传给工具上下文，
  // 文件 / 终端类工具据此把 `allowOutside` 透给端口（越界的第二道边界在端口里）。
  // `'machine'`（auto 根内 / 无项目 / 免确认模式 / 已记住 'always' 的会话授权短路）
  // 照常执行但不置位 —— 机器放行不得免掉项目根的 realpath 兜底（docs/06 §11.2）。
  // 没接确认钩子时字段保持 `undefined` —— 那时并没有"用户批准"这回事，
  // 端口也就照旧按越界拦截（缺省一律按没批准处理）。
  let approvedByUser = false
  if (tool.sensitivity === 'confirm' && options.confirmTool !== undefined) {
    let decision: ConfirmDecision = false
    try {
      decision = await options.confirmTool({
        name: call.name,
        input,
        sessionId: options.sessionId,
        sensitivity: 'confirm',
      })
    } catch (error) {
      // 确认链路本身出错按"拒绝"处理：宁可不动敏感操作，也不越权执行
      decision = false
      options.onToolCall?.({ name: call.name, sensitivity: 'confirm', isError: true })
      const message = `用户确认流程异常，已取消执行：${error instanceof Error ? error.message : String(error)}`
      return { content: message, summary: message, state: 'error' }
    }

    // 只有明确的 `false` 才是拒绝：`true` / `'always'` / `'machine'` 都继续执行
    //（`'always'` 的"本会话不再问"已由上层包装层消化，这里看到的仍是一次放行）
    if (decision === false) {
      options.onToolCall?.({ name: call.name, sensitivity: 'confirm', isError: true })
      const message = `用户拒绝执行工具 "${call.name}"，请勿重复调用；如确有必要，请先向用户说明原因并征得同意。`
      return { content: message, summary: '用户拒绝执行', state: 'error' }
    }
    // 出处只在这一处收敛：仅用户当次卡片批准（含首次 'always'）才置位；
    // `'machine'` 是机器放行，照常执行但免不了端口层的项目根边界（docs/06 §11.2）。
    if (decision === true || decision === 'always') approvedByUser = true
  }

  try {
    const result = await tool.execute(input, {
      sessionId: options.sessionId,
      toolCallId: call.id,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(emitProgress === undefined ? {} : { emitProgress }),
      ...(approvedByUser ? { approvedByUser: true } : {}),
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
