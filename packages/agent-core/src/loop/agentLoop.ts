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
  LlmImageInput,
  LlmImageResolver,
  LlmToolDefinition,
  ReasoningEffortLevel,
} from '../llm/types.js'
import type { ToolDisplayImage, ToolImage, ToolProgress, ToolSource } from '../tools/registry.js'
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

    // 同轮多个工具调用：顺序执行，保证事件与结果顺序确定（docs/06 §5）
    for (const call of calls) {
      if (options.signal?.aborted) {
        /**
         * 用户在本轮中途点了「停止」：本轮**已落盘**的 tool_call 里，还没跑到的那几个仍是
         * `running`（`appendAssistant` 在 :330 已把整组落盘）。不收敛就会让工具卡在未来所有
         * 会话视图里永远显示「运行中」，重启也不修正 —— 与 P2-03 是同一个症状，只是入口不同
         * （那条修的是「流中断」，这条修的是「取消」）。
         */
        await settleUnexecutedCalls(options, assistant.id, calls, '已取消未执行')
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
