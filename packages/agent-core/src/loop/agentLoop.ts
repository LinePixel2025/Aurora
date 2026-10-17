/**
 * Agent Loop —— 工具调用循环（docs/06 §5）。
 *
 * 纯逻辑：不依赖 Electron / 文件系统 / 网络实现，全部经参数注入，
 * 因此可以用假 provider + 内存会话完整单测（含多轮工具调用）。
 *
 * 循环形态：用户消息 → LLM → [工具调用 → 按并发批次执行 → 结果回填] × N（`maxRounds`，默认 32）→ 最终回复。
 * 同轮的多个调用按「相邻且声明了 `parallel` 的并成一批」起跑（docs/06 §5「同轮工具并发」），
 * 但结果始终按模型写下的原始顺序落盘 —— 批次只改起跑时机，不改配对顺序。
 * 每个 LLM 轮次产生的助手消息（文本 + 工具调用）**立即持久化**：
 * 工具结果必须能对应到发起它的 assistant 消息，否则续接上下文时服务端会拒绝请求。
 */
import type { AgentToolCall, SubagentSnapshot, TokenUsage } from '@aurora/shared'
import type {
  ChatEvent,
  ChatRequestMessage,
  LlmImageInput,
  LlmImageResolver,
  LlmToolDefinition,
  ReasoningEffortLevel,
} from '../llm/types.js'
import type {
  ToolDefinition,
  ToolDisplayImage,
  ToolImage,
  ToolProgress,
  ToolResult,
  ToolSource,
} from '../tools/registry.js'
import type { NewMessage, StoredMessage, StoredToolCall } from '../session/types.js'

/**
 * 一次请求的轮次兜底上限（docs/06 §5，v34 起是**内核常量、不是设置项**）。
 *
 * 对齐主流编码代理的口径：一次任务应当跑到模型自己收敛，而不是在第 32 轮被墙打断、
 * 再靠"自动续轮额度"续命 —— 那种设计把"我们怕它失控"的焦虑摊派成了用户的点击。
 * 但"完全不设上限"也不行：模型偶发会陷入「调用 → 看结果 → 再调用同一个」的循环，
 * 那会一直烧到上下文耗尽。所以留一道**只在真失控时才碰得到**的墙：512 轮。
 *
 * 碰上了仍然落 `paused` + `pendingReason: 'max-rounds'`（续跑链路保留，见 §4.1）——
 * 只是正常情况下没人会再看到它。
 */
export const RUNAWAY_MAX_ROUNDS = 512

/**
 * 子代理（`task`，§19）的轮次上限：它没有用户盯着、也没有「继续」可点，
 * 所以**不跟主循环共用**那道 512 的墙 —— 保持 v33 之前的 32，跑不完就以部分结果回报父代理。
 */
export const SUBAGENT_MAX_ROUNDS = 32

/** 同轮工具调用的默认并发度（`agent.loop.maxParallelCalls` 缺省值，docs/06 §5） */
export const DEFAULT_MAX_PARALLEL_CALLS = 8

/**
 * 单次工具调用的默认执行上限（毫秒，docs/06 §5）。
 *
 * 这一条**只兜「真挂起」**：一次卡死的调用不该把整条循环永久堵在那里。
 * 自带超时预算的长任务工具（`run_command` ≤300s、`office_render` 120s、`ask_user` 180s、
 * `generate_image` 120s、`web_fetch` 20s）都已经在默认值之内，不重复计时；
 * 天生没有墙钟上限的（`task` 子代理，靠轮次与取消自限）显式声明 `timeoutMs: 0`。
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 600_000

/**
 * 确认结果（四态，docs/06 §5、§11.2）：
 * - `false` = 拒绝；
 * - `true` = 用户**当次**在确认卡片上点放行，或用户已显式选择 `auto` 完全权限档；
 * - `'always'` = 用户**当次**点「总是允许」（本次放行 + 本会话内同名工具不再询问）；
 * - `'machine'` = 历史授权或免确认模式的机器放行（`allowPatterns` 命中、
 *   已记住 `'always'` 后的会话授权短路）——照常执行，但**不置 `ctx.approvedByUser`**，
 *   工具拿不到 `allowOutside`，端口层的项目根 realpath 兜底保留。
 *
 * 为什么要 `'always'`：敏感工具（写文件、跑命令）在一次任务里往往要连用十几次，
 * 逐次弹同一张卡片会逼用户"闭眼点确定"——那比不确认更危险。`'always'` 把"信任"的粒度
 * 定成**会话 × 工具名**：换会话、换工具都会重新问。
 *
 * 为什么要 `'machine'`：`approvedByUser` 会被文件 / 终端类工具透成 `allowOutside`，
 * 免掉端口层的项目根 realpath 兜底——这个特权属于"用户当次真的看过卡片并点放行"，
 * 或"用户已显式选择完全权限档"。历史授权 / 免确认模式的机器放行仍以独立变体区分出处，
 * 避免把一次自动化命中静默扩成永久越界许可。
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
   * - `pendingReason` 说明**停在哪**：`'max-rounds'` 轮次用尽（v34 起只有防失控上限这一种）、
   *   `'aborted'` 用户取消。
   *   （v15 曾有 `'budget'`，随 token 预算一起退役。）客户端据此把"静默收尾"变成"可解释的暂停"，并给出「继续」入口。
   * - `round` 是**收尾时的轮次**（从 0 起，续跑时是绝对轮次不是相对轮次）；`usedTokens` 是本请求
   *   累计消耗（预算判定用的同一个数）。
   */
  | {
      type: 'done'
      pending?: boolean
      pendingReason?: 'max-rounds' | 'aborted'
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

/**
 * 一条「运行中插话」的最小形状（docs/06 §5.3）。
 *
 * 刻意只有正文 + 图片路径：附件提取出来的 `extraContext` 由装配层在入队时就拼好
 * （与一次普通发送同一口径），循环不再关心"这条是从哪来的"。
 */
export interface PendingUserInput {
  text: string
  /** 与一次普通发送同款的一次性上下文（附件提取正文等）：作为一条 system 片段紧跟其后下发，不落会话历史 */
  extraContext?: string
  images?: readonly string[]
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
  /**
   * 本次用户输入随附的图片（多模态输入，docs/06 §3.1）：已解析好的内容，
   * 由装配层经 `loadImages` 读盘得到。缺省 = 本轮没有图片。
   *
   * 落盘那份存的是**路径**（`userImagePaths`），两者是同一批图片的两种形状：
   * 一个给本轮请求用，一个给跨轮次重放用。
   */
  userImages?: readonly LlmImageInput[]
  /**
   * 与 `userImages` 配套的图片**路径**，随用户消息一起落进会话历史（`StoredMessage.images`）。
   * 缺省 / 空数组 = 不写该字段。
   */
  userImagePaths?: readonly string[]
  /**
   * 历史消息里的图片路径 → 图片内容（多模态输入，docs/06 §3.1）。
   * 由装配层一次性读好放进查表闭包；缺省 = 历史里的图片不重放（按纯文本下发）。
   */
  resolveImages?: LlmImageResolver
  /**
   * 本次可用的工具（注册表，或装配层按运行来源过滤后的**只读视图**，docs/06 §5.2）。
   * 循环只依赖 `get()` / `toLlmTools()`，因此视图与注册表可互换。
   */
  tools: ToolSource
  sessionId: string
  signal?: AbortSignal
  maxRounds?: number
  /**
   * 单次工具调用的默认执行上限（毫秒，docs/06 §5）：缺省 `DEFAULT_TOOL_TIMEOUT_MS`，
   * `0` = 不限。工具自己声明的 `ToolDefinition.timeoutMs` **优先于**这一项。
   *
   * 做成请求级参数主要是给单测用（真等 10 分钟不叫测试）；装配层目前没有对应的
   * 设置项——这条是故障兜底，不是用户会按任务调的工作量旋钮，因此不进 `agent.loop.*`
   * （口径见 docs/06 §5 的「工具执行上限」）。
   */
  toolTimeoutMs?: number
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
  /**
   * 同轮工具调用的**并发度**（docs/06 §5，来自设置 `agent.loop.maxParallelCalls`）：
   * 一个并发批次里最多同时执行几个调用，超出的排队等位（**不丢弃、不改序**）。
   * 缺省 `DEFAULT_MAX_PARALLEL_CALLS`。只有 `parallel` 的只读调用会成批，
   * 所以这一项限的是"同时压给磁盘 / 网络 / 本机检索的量"，不影响任务能否跑完。
   */
  maxParallelCalls?: number
  /**
   * 取走「运行中插话」（docs/06 §5.3）：队列归**装配层**持有（它是会话级状态，
   * 循环是一次请求一个实例、跑完即弃），循环只在这个边界问一次"有要插进来的话吗"。
   *
   * 返回一条用户输入时，循环把它**落盘**并 push 进本次请求的 messages，于是下一个轮次
   * 模型就看见这句话 —— 这就是"插话"的全部语义：改的是**正在跑的这一个**任务的方向，
   * 不是等它跑完再发一轮。
   *
   * 只在**确实还会进下一轮**时才调用（预算已触顶、或这就是最后一轮时不调）：
   * 消费掉却发不出去，比不消费更难解释。剩下的排队条目由调用方在请求收尾后发起新一轮。
   */
  takePendingInput?: () => PendingUserInput | undefined
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
    startRound + Math.max(1, options.maxRounds ?? RUNAWAY_MAX_ROUNDS),
  )
  const messages: ChatRequestMessage[] = [
    { role: 'system', content: options.systemPrompt },
    ...toMessages(options.history, options.resolveImages),
  ]

  // 用户消息先落盘，保证即使后续失败也能在历史里看到提问。
  // **续跑时 `appendUserMessage` 为 false**：那条提问在上一个 job 里已经落过盘了，
  // 再 append 一次历史里就会有两份同样的用户消息（续跑最经典的重复落盘 bug）。
  if (options.appendUserMessage !== false) {
    await options.append({
      role: 'user',
      content: options.userInput,
      // 图片**存路径不存内容**（docs/06 §3.1）：会话文件不因图片膨胀，重放时按路径重读
      ...(options.userImagePaths === undefined || options.userImagePaths.length === 0
        ? {}
        : { images: [...options.userImagePaths] }),
    })
  }
  // 续跑时那条用户消息已经在 `history` 里（上一次请求写下的），不能重复 push 进 messages；
  // 非续跑时才补上本轮输入。图片同理：只有非续跑那次才需要把本轮图片放进请求。
  if (options.appendUserMessage !== false) {
    messages.push({
      role: 'user',
      content: options.userInput,
      ...(options.userImages === undefined || options.userImages.length === 0
        ? {}
        : { images: [...options.userImages] }),
    })
  }
  // 技能正文等一次性上下文：放在用户消息之后，只影响本次请求，不写入历史
  if (options.extraContext !== undefined && options.extraContext.trim() !== '') {
    messages.push({ role: 'system', content: options.extraContext })
  }

  // 工具数组走注册表的**唯一**实现：它按工具名排序返回（docs/06 §21.2），
  // 顺序只取决于名字集合，与注册先后无关 —— 请求体的 tools 因此是稳定前缀的一部分。
  const llmTools = options.tools.toLlmTools()
  let pending = false
  let pendingReason: 'max-rounds' | 'aborted' | undefined
  /** 本次请求累计消耗（只累加 provider 回传的真实用量，不估算）—— v34 起**只统计、不做闸门** */
  let usedTokens = 0

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
          // 发起时刻随工具卡落盘：渲染层耗时徽章的真实计时起点（切走再切回、重启后
          // 都从它算，不再由渲染层「首次观察到 running」重新起表）
          startedAt: new Date().toISOString(),
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
      /**
       * 流在 `[DONE]` 之前断开（网络中断、网关中途掐流）：本轮已产出但**从未执行**的
       * tool_call 绝不能以 `running` 落盘 —— 那会让工具卡在未来所有会话视图里
       * 永远显示「运行中」，重启也不修正（P2-03）。这里在落盘前统一收敛为 `error`。
       */
      for (const call of calls) {
        call.state = 'error'
        call.outputSummary ??= '流中断未执行'
        // 从未执行的调用没有 startedAt 之外的可靠时刻：结算时刻就是收敛这一刻
        call.endedAt ??= new Date().toISOString()
      } // 已产出的文本与思考链先落盘，避免用户看到的内容在历史里消失
      if (text !== '' || reasoning !== '' || calls.length > 0) {
        await appendAssistant(options, messageId, text, calls, reasoning)
      }
      /**
       * 用户取消（signal 已 abort）时**按「暂停」收尾**，而不是报 `error`：
       * 装配层 `agent.abort()` 已经把 job 乐观落成 `aborted`，这里若报 error，
       * `finishJob` 会反手把它改写成 `error` —— 点「停止」的 job 终态必须保持 `aborted`
       * （与循环里其它两处 abort 检查点同款；P1-08 让取消真的能中断流，这条收敛因此才被看见）。
       */
      if (options.signal?.aborted === true) {
        yield { type: 'done', pending: true, pendingReason: 'aborted', round, usedTokens }
        return
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

    /**
     * 本轮工具产出的图片（图像工具，docs/06 §25）。
     *
     * 攒到本轮**全部**工具结果之后才下发：同轮多个工具调用时，中间插一条 user 消息会把
     * 「assistant(tool_calls) → 每个 id 各自的 tool 消息」这条配对链断开，服务端直接 400。
     * 因此这里只收集，注入放在下面那个 for 循环之后。
     */
    const roundImages: ToolImage[] = []

    // 同轮多个工具调用：按**并发批次**执行（docs/06 §5「同轮工具并发」）。
    //
    // 批次只决定「什么时候一起起跑」，**不决定落盘顺序**：结算始终按 `calls` 的原始下标走，
    // 「assistant(tool_calls) → 每个 id 各自的 tool 消息」这条配对链因此与串行时代逐字一致
    // （链一断服务端直接 400，见上面 `roundImages` 那段同款约束）。
    for (const group of planParallelGroups(options.tools, calls)) {
      if (options.signal?.aborted) {
        /**
         * 用户在本轮中途点了「停止」：本轮**已落盘**的 tool_call 里，还没跑到的那几个仍是
         * `running`（`appendAssistant` 上面已把整组落盘）。不收敛就会让工具卡在未来所有
         * 会话视图里永远显示「运行中」，重启也不修正 —— 与 P2-03 是同一个症状，只是入口不同
         * （那条修的是「流中断」，这条修的是「取消」）。
         *
         * 并发化的影响只到「未起跑的批次」为止：起跑中的那一批已经各自有了终态
         * （中止的调用会走超时或 signal 拒绝），不会留下 `running` 的悬空卡片。
         */
        await settleUnexecutedCalls(options, assistant.id, calls, '已取消未执行')
        yield { type: 'done', pending: true, pendingReason: 'aborted', round, usedTokens }
        return
      }

      // ① 起跑：把整批的 `running` 卡片先发出去，再边跑边转进度事件（子代理靠这一条）
      const running = runToolGroup(options, group, assistant.id, round)
      let outcomes: ToolOutcome[] = []
      for (;;) {
        const step = await running.next()
        if (step.done === true) {
          outcomes = step.value
          break
        }
        yield step.value
      }

      // ② 结算：按原始顺序逐条落卡片状态、tool 消息与本轮图片
      for (const [index, call] of group.entries()) {
        const outcome = outcomes[index] ?? MISSING_OUTCOME

        call.state = outcome.state
        call.outputSummary = outcome.summary
        // 结算时刻随工具卡落盘（与 startedAt 配对，渲染层据此显示真实耗时）
        call.endedAt = new Date().toISOString()
        // 子代理快照随工具卡一起持久化（渲染层「子代理」页面据此回看历史运行）
        if (outcome.subagent !== undefined) call.subagent = outcome.subagent
        // 对话展示图片随工具卡持久化；路径只留在客户端内部，事件里由 toAgentToolCall 脱敏
        if (outcome.displayImages !== undefined && outcome.displayImages.length > 0) {
          call.displayImages = outcome.displayImages.map((item) => ({
            id: item.id,
            path: item.path,
            name: item.name,
            mime: item.mime,
            ...(item.caption === undefined ? {} : { caption: item.caption }),
          }))
        }
        // 持久化工具卡片状态（同一 messageId 原地更新，渲染层据此刷新）
        await options.updateToolCall(assistant.id, { ...call })

        yield { type: 'tool', round, messageId: assistant.id, call: toAgentToolCall(call) }

        const toolMessage = await options.append({
          role: 'tool',
          content: outcome.content,
          toolCallId: call.id,
          // 图片**存路径不存内容**（与用户附件同一条回放口径，docs/06 §25）：
          // 会话文件不因截图膨胀，跨轮重放时按路径重读，关闭 vision 后自动不再下发。
          ...(outcome.images === undefined || outcome.images.length === 0
            ? {}
            : { images: outcome.images.map((item) => item.path) }),
        })
        messages.push({
          role: 'tool',
          content: toolMessage.content,
          toolCallId: call.id,
        })
        // 本轮请求的图片分片用**端口刚读好的内容**（不必回查缓存）：同一批图在这一轮里
        // 手上就有，跨轮重放才走 `resolveImages`。
        if (outcome.images !== undefined && outcome.images.length > 0) {
          roundImages.push(...outcome.images)
        }
      }
    }

    // 本轮有工具产出的图片：作为一条**合成 user 消息**附在全部 tool 结果之后下发
    //（tool 角色只能带字符串，两套协议都一样，docs/06 §25）。
    if (roundImages.length > 0) {
      messages.push({
        role: 'user',
        content: `【工具返回的图片】${roundImages.map((item) => item.path).join('；')}`,
        images: roundImages.map((item) => item.image),
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

    // 运行中插话（docs/06 §5.3）：装配层的会话队列在**轮次边界**被取走，落盘成一条用户消息
    // 并 push 进本次请求 —— 模型在下一个轮次就看见它，而不是等这次任务跑完再重新起一轮。
    //
    // 顺序口径：必须排在 `onRoundComplete` **之后**（游标已经落盘，这条插话属于下一轮的内容，
    // 崩溃重启续跑时它会从会话历史里自然读回来，不会丢也不会重），且排在预算判定之后、
    // 「还有下一轮吗」的判定之内 —— 只有确实要进下一轮才消费，消费掉却发不出去最难解释。
    if (round < endRound - 1) {
      // 一次边界**排空**当前队列：排队时用户连着说了三句，就应该三句一起到模型面前，
      // 一句一轮会让后面的句子越排越晚
      for (;;) {
        const injected = options.takePendingInput?.()
        if (injected === undefined) break
        const injectedMessage = await options.append({
          role: 'user',
          content: injected.text,
          ...(injected.images === undefined || injected.images.length === 0
            ? {}
            : { images: [...injected.images] }),
        })
        // 图片走与历史回放同一条解析口径（本轮读好的内容已在装配层的缓存里）
        messages.push({
          role: 'user',
          content: injectedMessage.content,
          ...imagesOfMessage(injectedMessage, options.resolveImages),
        })
        // 附件正文这类一次性上下文：与本轮首次发送同一形状（system 片段，不进会话历史）
        const context = injected.extraContext?.trim() ?? ''
        if (context !== '') messages.push({ role: 'system', content: context })
      }
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

/**
 * 把「本轮已产出但从未执行」的 tool_call 收敛为 `error` 并写回（P2-03）。
 *
 * 两个入口都要用：① 流在 `[DONE]` 之前断开（`failed` 分支）；② 用户在轮中途点「停止」
 * （工具循环的 abort 检查点）。共同症状是 `appendAssistant` 已经把整组以 `running`
 * 落盘，不收敛就会让工具卡永远显示「运行中」。
 *
 * 只动 `state === 'running'` 的那些 —— 已执行完的调用保留真实终态。
 */
async function settleUnexecutedCalls(
  options: AgentLoopOptions,
  messageId: string,
  calls: readonly StoredToolCall[],
  summary: string,
): Promise<void> {
  for (const call of calls) {
    if (call.state !== 'running') continue
    call.state = 'error'
    call.outputSummary ??= summary
    call.endedAt ??= new Date().toISOString()
    await options.updateToolCall(messageId, { ...call })
  }
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

function toMessages(
  history: readonly StoredMessage[],
  resolveImages?: LlmImageResolver,
): ChatRequestMessage[] {
  // 只挑 API 需要的字段（role / content / 工具调用 / 图片）：`reasoning` 等展示字段一律不回传
  const out: ChatRequestMessage[] = []
  /**
   * 待下发的工具图片路径（图像工具，docs/06 §25）。
   *
   * 攒着而不是"每条 tool 消息后立刻插一条 user 消息"：同轮多个工具调用时，
   * 历史里是连续的若干条 tool 消息，逐条插 user 会把它们**从中间劈开** ——
   * 「assistant(tool_calls) → 每个 id 各自的 tool 消息」的配对链一断，服务端直接 400。
   * 因此只在「一段 tool 消息结束」（碰到非 tool 消息）时统一注入一条，
   * 与写入路径「轮末统一插入」产生的顺序逐字一致。
   */
  let pendingImages: string[] = []

  const flushImages = (): void => {
    if (pendingImages.length === 0) return
    const paths = pendingImages
    pendingImages = []
    // 未注入解析器（历史按纯文本下发）/ 解析不出（关闭 vision、文件已删）时整条省略
    if (resolveImages === undefined) return
    const images = resolveImages(paths)
    if (images.length === 0) return
    out.push({
      role: 'user',
      content: `【工具返回的图片】${paths.join('；')}`,
      images: [...images],
    })
  }

  for (const message of history) {
    if (message.role === 'system') continue
    if (message.role === 'tool') {
      out.push({
        role: 'tool',
        content: message.content,
        ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
      })
      pendingImages.push(...imagePathsOf(message))
      continue
    }
    // 非 tool 消息：先把上一段工具图片发出去，再发这一条
    flushImages()
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
    out.push({ role: 'user', content: message.content, ...imagesOfMessage(message, resolveImages) })
  }
  // 历史以 tool 消息结尾时也要把最后一段发出去
  flushImages()
  return out
}

/**
 * 消息上挂着的图片**路径**（多模态输入 / 图像工具，docs/06 §3.1、§25）。
 *
 * 只收字符串：会话文件是磁盘数据，可能被手改过 —— 畸形值在这里滤掉，
 * 不让它进到解析器（解析失败会白报一次错，而"图没了"本身只该是一条提示）。
 */
function imagePathsOf(message: StoredMessage): string[] {
  if (!Array.isArray(message.images)) return []
  return message.images.filter((path): path is string => typeof path === 'string' && path !== '')
}

/**
 * 用户消息的图片分片（多模态输入，docs/06 §3.1）：`images` 是路径，解析要靠装配层注入的
 * 解析器（同步查表）。解析不出来就当纯文本下发 —— 不写 `images` 键，与「本来就没图片」一致。
 */
function imagesOfMessage(
  message: StoredMessage,
  resolveImages?: LlmImageResolver,
): { images?: LlmImageInput[] } {
  if (resolveImages === undefined) return {}
  const paths = imagePathsOf(message)
  if (paths.length === 0) return {}
  const resolved = resolveImages(paths)
  return resolved.length === 0 ? {} : { images: [...resolved] }
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
  const rawInput = parseArguments(call.arguments)
  const input = rendererToolInput(call, rawInput)
  return {
    id: call.id,
    name: call.name,
    ...(input === undefined ? {} : { input }),
    state: call.state,
    ...(call.outputSummary === undefined ? {} : { outputSummary: call.outputSummary }),
    ...(call.startedAt === undefined ? {} : { startedAt: call.startedAt }),
    ...(call.endedAt === undefined ? {} : { endedAt: call.endedAt }),
    ...(call.subagent === undefined ? {} : { subagent: call.subagent }),
    ...(call.displayImages === undefined || call.displayImages.length === 0
      ? {}
      : {
          displayImages: call.displayImages.map((item) => ({
            id: item.id,
            name: item.name,
            mime: item.mime,
            ...(item.caption === undefined ? {} : { caption: item.caption }),
          })),
        }),
  }
}

/**
 * 展示给渲染层的工具入参。`show_image` 的 path 是本地路径，只允许留在会话存储内部；
 * 事件 / 历史投影一律移除它，只保留说明与文件名（文件名来自 displayImages）。
 */
function rendererToolInput(call: StoredToolCall, input: unknown): unknown {
  if (call.name !== 'show_image') return input
  const record =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined
  const caption = typeof record?.['caption'] === 'string' ? record['caption'].trim() : ''
  const name = call.displayImages?.[0]?.name
  if (caption === '' && name === undefined) return undefined
  return {
    ...(caption === '' ? {} : { caption }),
    ...(name === undefined ? {} : { name }),
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
  /** 工具产出 / 读到的图片（图像工具，docs/06 §25）：随 tool 消息落盘路径、随合成 user 消息下发内容 */
  images?: readonly ToolImage[]
  /** 对话图片区的展示图片（`show_image` / `generate_image`）：随工具卡持久化并脱敏下发 */
  displayImages?: ToolDisplayImage[]
}

/**
 * 本次调用能否与同轮的邻居**并发起跑**（docs/06 §5「同轮工具并发」）。
 *
 * 两道闸门都在循环这一层，不靠工具自己的声明自觉（口径见 `ToolDefinition.parallel`）：
 * ① 必须**显式** `parallel: true` —— 只读不等于无副作用，`todo_write` 就是反例；
 * ② `confirm` 级永不并发 —— 一次弹两三张确认卡片，用户没法判断"我在批准什么"，
 *    那比慢一点严重得多。
 * 工具查不到（未注册 / 被运行档摘除）也按串行走：让它去拿「工具不存在」的确定性错误，
 * 比让一次无法归因的并发执行混进批次好。
 */
function isParallelEligible(tool: ToolDefinition | undefined): boolean {
  return tool !== undefined && tool.parallel === true && tool.sensitivity !== 'confirm'
}

/**
 * 把本轮的工具调用切成执行批次：**连续的**可并发调用并成一批，其余各自成批。
 *
 * 「连续」这一条是刻意的保守口径：非并发的调用是一道**串行屏障**，它后面的调用不会越过它
 * 提前起跑。于是「读 → 写 → 再读同一处」这种同轮序列仍然严格按模型写下的顺序成立，
 * 而模型最常见的批量查询（一轮里全是 `read_file` / `grep`）照样并发拿满收益。
 * 想越过屏障去重排，就需要一套「哪些调用互相依赖」的信息 —— 那既不是模型今天会提供的东西，
 * 也不是能靠工具名猜出来的东西，因此不做。
 */
export function planParallelGroups(
  tools: ToolSource,
  calls: readonly StoredToolCall[],
): StoredToolCall[][] {
  const groups: StoredToolCall[][] = []
  /** 上一批是否是「还能继续并入」的并发批（串行调用成批后立即置 false） */
  let joinable = false
  for (const call of calls) {
    const eligible = isParallelEligible(tools.get(call.name))
    const current = groups[groups.length - 1]
    if (eligible && joinable && current !== undefined) {
      current.push(call)
      continue
    }
    groups.push([call])
    joinable = eligible
  }
  return groups
}

/** 批次里某次调用没有交出结果时的兜底（与 `runToolStreaming` 的缺省口径同一句） */
const MISSING_OUTCOME: ToolOutcome = {
  content: '工具没有返回结果',
  summary: '工具没有返回结果',
  state: 'error',
}

/**
 * 执行一个批次：先把整批的 `running` 卡片发出去，再并发推进、边跑边转发进度事件；
 * 返回值是**与批次同序**的结果，交给调用方按原始顺序结算。
 *
 * 单条批次走的是与串行时代逐字相同的路径（一次 `runToolStreaming` 消费到底），
 * 因此「只有 `echo` 这类默认工具」的历史行为没有任何变化 —— 并发只发生在
 * 工具自己声明了 `parallel` 且相邻成批的时候。
 *
 * 事件顺序的取舍：批次内进度事件按**到达顺序**转发（不排队等齐），
 * 但工具卡的状态事件与 tool 消息一律在②阶段按原始下标落地，
 * 所以渲染层看到的卡片状态序列、以及回给模型的结果序列都是确定的。
 */
async function* runToolGroup(
  options: AgentLoopOptions,
  group: readonly StoredToolCall[],
  messageId: string,
  round: number,
): AsyncGenerator<AgentLoopEvent, ToolOutcome[]> {
  for (const call of group) {
    yield { type: 'tool', round, messageId, call: toAgentToolCall(call) }
  }

  if (group.length === 1) {
    const only = group[0]
    if (only === undefined) return [MISSING_OUTCOME]
    // 工具执行与进度事件并行推进：`task` 子代理在执行期间持续上报进度快照，
    // 由 runToolStreaming 边收边转成 `subagent` 事件（否则要等工具跑完才看得到）
    const streaming = runToolStreaming(options, only, messageId, round)
    for (;;) {
      const step = await streaming.next()
      if (step.done === true) return [step.value]
      yield step.value
    }
  }

  // 批次内并发：每条各自消费自己的进度流，事件汇到一条共享队列上由本生成器转发。
  // 汇流这一层必要但顺序不承诺 —— `task` 子代理现在也会进并发批（docs/06 §19.5），
  // 多路进度按到达顺序交错；渲染层按事件里的 `callId` 各自归位，结算仍按原始下标。
  const queue: AgentLoopEvent[] = []
  let wake: (() => void) | undefined
  const notify = (): void => {
    const resume = wake
    wake = undefined
    resume?.()
  }
  const outcomes = new Array<ToolOutcome | undefined>(group.length).fill(undefined)
  let remaining = group.length
  /**
   * 并发度闸门（docs/06 §5）：同时在跑的不超过 `maxParallelCalls` 条，其余**排队等位**。
   *
   * 排队不是丢弃：起跑顺序仍按 `group` 的原始下标（`started` 单调递增），
   * 结算也按原始下标，所以这一项只影响"同一时刻有几个工具在占磁盘 / 网络"，
   * 不影响任何一条调用会不会被执行。
   */
  const limit = Math.max(1, options.maxParallelCalls ?? DEFAULT_MAX_PARALLEL_CALLS)
  let started = 0
  let inFlight = 0

  const launchReady = (): void => {
    while (started < group.length && inFlight < limit) {
      const index = started
      const call = group[index]
      started += 1
      if (call === undefined) {
        outcomes[index] = MISSING_OUTCOME
        remaining -= 1
        continue
      }
      inFlight += 1
      const streaming = runToolStreaming(options, call, messageId, round)
      void (async () => {
        for (;;) {
          const step = await streaming.next()
          if (step.done === true) {
            outcomes[index] = step.value
            break
          }
          queue.push(step.value)
          notify()
        }
      })()
        .catch((error: unknown) => {
          // 单条批内意外不能拖垮整批（`runToolStreaming` 自身已兜底，这里只留一道保险）
          const message = error instanceof Error ? error.message : String(error)
          outcomes[index] = {
            content: `工具执行失败：${message}`,
            summary: '工具执行失败',
            state: 'error',
          }
        })
        .finally(() => {
          inFlight -= 1
          remaining -= 1
          // 让出的是一个槽位：把下一个排队的补进来（否则整批会卡在 limit 条上不再前进）
          launchReady()
          notify()
        })
    }
  }
  launchReady()

  while (remaining > 0 || queue.length > 0) {
    if (queue.length === 0) {
      // 单线程：`wake` 在下一个 await 之前就已赋值，生产者的 notify 不会丢唤醒
      await new Promise<void>((resolve) => {
        wake = resolve
      })
      continue
    }
    const event = queue.shift()
    if (event !== undefined) yield event
  }

  return group.map((_call, index) => outcomes[index] ?? MISSING_OUTCOME)
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
    // 子代理进度描述的是同一份“当前快照”，不是必须逐条回放的日志。
    // 生产者可能在消费方下一次调度前连续上报多步，合并队尾可避免无界队列和
    // 大型任务期间的内存 / 事件循环抖动；最终快照仍由 latest 保留。
    const tail = queue[queue.length - 1]
    if (payload.kind === 'subagent' && tail?.kind === 'subagent') {
      queue[queue.length - 1] = payload
    } else {
      queue.push(payload)
    }
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
  // `approvedByUser` 在"用户当次批准（含首次 'always'）"或"用户已选完全权限档"时置位：
  // 它会被传给工具上下文，
  // 文件 / 终端类工具据此把 `allowOutside` 透给端口（越界的第二道边界在端口里）。
  // `'machine'`（免确认模式 / 已记住 'always' 的会话授权短路）
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

  // 执行上限（docs/06 §5）：工具自己声明的 `timeoutMs` 优先，其次请求级注入，最后循环默认。
  // 这里用**本次调用自己的** AbortController，而不是把 `options.signal` 直接交给工具：
  // 超时只该中止这一次调用，同时外层取消（用户点停止）仍要照常传导进来 —— 两者互不覆盖。
  const timeoutMs = tool.timeoutMs ?? options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
  const callController = new AbortController()
  const outerSignal = options.signal
  const onOuterAbort = (): void => callController.abort(outerSignal?.reason)
  if (outerSignal !== undefined) {
    if (outerSignal.aborted) callController.abort(outerSignal.reason)
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true })
  }
  const running = tool.execute(input, {
    sessionId: options.sessionId,
    toolCallId: call.id,
    signal: callController.signal,
    ...(emitProgress === undefined ? {} : { emitProgress }),
    ...(approvedByUser ? { approvedByUser: true } : {}),
  })
  // 超时之后这次调用可能仍在后台跑完：它的拒绝没有人接会变成 unhandledRejection，
  // 而循环此刻已经把「超时」回填给模型了 —— 挂一个 catch 只做兜底，不改变已给出的结果。
  running.catch(() => undefined)

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result =
      timeoutMs > 0
        ? await new Promise<ToolResult>((resolve, reject) => {
            timer = setTimeout(() => {
              // 先中止再拒绝：工具据此收尾（`run_command` 会杀进程树），别让它背后空跑
              const failure = new ToolTimeoutError(timeoutMs)
              callController.abort(failure)
              reject(failure)
            }, timeoutMs)
            timer.unref?.()
            running.then(resolve, reject)
          })
        : await running
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
      // 工具产出 / 读到的图片（图像工具，docs/06 §25）：失败的调用不回传图片分片 ——
      // `isError` 的结果里带上图片会让模型看到"读失败但图在这儿"的自相矛盾输入
      ...(!isError && result.images !== undefined && result.images.length > 0
        ? { images: result.images }
        : {}),
      ...(!isError && result.displayImages !== undefined && result.displayImages.length > 0
        ? { displayImages: [...result.displayImages] }
        : {}),
    }
  } catch (error) {
    options.onToolCall?.({
      name: call.name,
      sensitivity: tool.sensitivity ?? 'safe',
      isError: true,
    })
    // 超时单独给一句可执行的解释：与「工具坏了」区分开，模型才会拆小任务或换路径，
    // 而不是原样重试同一次调用（重试只会再烧掉一个上限）。
    if (error instanceof ToolTimeoutError) {
      const limit = formatDuration(timeoutMs)
      return {
        content:
          `工具 "${call.name}" 本次调用超过 ${limit} 已中止。` +
          '请把任务拆小、缩小读取范围或改用别的路径，不要原样重试同一次调用。',
        summary: `工具执行超时（${limit}）`,
        state: 'error',
      }
    }
    const message = error instanceof Error ? error.message : String(error)
    // 工具抛错不中断循环：以错误文本回填，让模型自行决定下一步
    return {
      content: `工具执行失败：${message}`,
      summary: `工具执行失败：${message}`,
      state: 'error',
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    outerSignal?.removeEventListener('abort', onOuterAbort)
  }
}

/** 超时中止的标记错误：与「工具自己抛错」区分开，回填文案因此能说清是哪回事 */
class ToolTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`工具执行超过 ${formatDuration(timeoutMs)} 已中止`)
  }
}

/** 上限的中文读法（回填给模型的文案与卡片摘要共用，避免同一数字两处各拼一遍） */
function formatDuration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000} 分钟`
  if (ms % 1_000 === 0) return `${ms / 1_000} 秒`
  return `${ms} 毫秒`
}

function truncate(text: string, max: number): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length <= max ? compact : `${compact.slice(0, max)}…`
}
