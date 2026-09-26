/**
 * KernelAgentHost —— 把内核各模块装配成 `AgentHost`（docs/02 §3.1、docs/06 §5）。
 *
 * 纯逻辑：所有系统能力（模型凭据解密、模式提示词、感知摘要、会话存储）
 * 由主进程以依赖形式注入，因此可在 Node 里完整单测。
 */
import type { AgentEvent, AgentHost as AgentHostContract, AgentToolCall } from '@aurora/shared'
import type { Logger } from '@aurora/shared'
import { createNoopLogger } from '@aurora/shared'
import { buildSystemPrompt, buildToolGuidance, describeTools } from '../context/systemPrompt.js'
import { runAgentLoop, type ConfirmDecision, type LoopProvider } from '../loop/agentLoop.js'
import type { ReasoningEffortLevel } from '../llm/types.js'
import type { SkillsBridge } from '../skills/bridge.js'
import {
  compressHistory,
  DEFAULT_MAX_CHARS,
  filterMessagesWithinWindow,
  type SummarizeFn,
} from '../session/history.js'
import type { SessionStore } from '../session/store.js'
import type { NewMessage, StoredToolCall } from '../session/types.js'
import type { ToolRegistry } from '../tools/registry.js'

export interface ProviderConfig {
  provider: LoopProvider
  model: string
  temperature?: number
  /** 思考等级（v5）；`undefined` = 不下发思考等级字段 */
  reasoningEffort?: ReasoningEffortLevel
}

export interface AgentProviderFactory {
  /**
   * 每次请求即时构造（保证设置页改 Key 后立即生效）。
   *
   * `allowFallback` 只由**装配层的自愈路径**使用（step-02 §6）：配置被写坏、导致
   * `llm.active` 指向不存在的 provider 时，回退到「有 baseUrl + model + 可用 Key」的
   * 最近可用条目，避免 AI 彻底失能。缺省 `false`——正常路径行为与从前完全一致。
   */
  create(options?: { allowFallback?: boolean }): ProviderConfig | undefined
}

export interface AgentHostDeps {
  sessions: SessionStore
  provider: AgentProviderFactory
  tools: ToolRegistry
  skills: SkillsBridge
  logger?: Logger
  /** 当前模式提示词片段 */
  modePrompt?(): string
  /** 系统感知摘要 */
  perceptionSummary?(): Promise<string>
  /** 单次请求的会话历史字符预算 */
  maxChars?: number
  /**
   * 长上下文摘要（docs/06 §4）：截断丢弃的旧消息交给它压成一段摘要，
   * 跨轮次累计后注入系统提示词。未注入 / 失败时行为与纯截断一致。
   */
  summarize?: SummarizeFn
  /**
   * quick 会话滑动窗口（docs/06 §4）：> 0 时，`sessionId === 'quick'` 的请求只把
   * 最近 `quickContextWindowMs` 内的消息交给上下文组装，更早的仅留在存储 / 界面历史；
   * 窗口模式下同步跳过滚动摘要（不读、不写 summaries）。缺省 0 = 不启用，
   * 行为与从前完全一致（全量历史进组装）。
   */
  quickContextWindowMs?: number
  /** 工具调用轮次上限 */
  maxRounds?: number
  /**
   * 敏感工具执行前的用户确认（docs/06 §5）。
   * 未注入时保持 v0.3.0 行为（不拦截，仅由 `onToolCall` 留痕）。
   *
   * 返回 `'always'` 表示「本次放行，且本会话内同名工具不再询问」——那份会话级记忆
   * 由本类持有（`sessionApprovals`），**不会再问第二遍**：确认卡片的语义是"减少打扰"，
   * 逐次弹同一张卡只会训练用户闭眼点确定。
   */
  confirmTool?(info: {
    name: string
    input: unknown
    sessionId: string
    sensitivity: 'confirm'
  }): Promise<ConfirmDecision>
  /**
   * 「Agent 可修改的设置」清单（docs/06 §17 提到的正式通道）：
   * 原样注入 systemPrompt 的独立小节；抛错时省略该节，不中断请求。
   */
  settingsHint?(): string
  /**
   * 当前会话任务清单摘要（docs/06 §18，`renderTodoList` 的结果）；
   * 返回空串时整段省略；读取失败降级为省略，不中断请求。
   */
  todoSummary?(sessionId: string): Promise<string>
  /**
   * 项目级约定（docs/06 §5.1，v13）：从项目根到当前工作目录逐层收集的 `AGENTS.md` 文本。
   * 返回空串 / undefined / 抛错时整段省略（降级为"无项目约定"，不中断请求）。
   */
  projectInstructions?(): Promise<string | undefined>
}

export const ERROR_NO_MODEL = 'E_NO_MODEL'
export const ERROR_BUSY = 'E_BUSY'

/**
 * 发出事件时的入参形状：`seq` 由 `emit` 统一分配（docs/06 §16.1），
 * 调用点不必、也不该自己编号 —— 序号是「发出顺序」的单一事实来源。
 */
type AgentEventInput = AgentEvent extends infer T
  ? T extends { seq: number }
    ? Omit<T, 'seq'>
    : never
  : never

export class KernelAgentHost implements AgentHostContract {
  private readonly deps: AgentHostDeps
  private readonly logger: Logger
  private readonly listeners = new Set<(event: AgentEvent) => void>()
  private readonly active = new Map<string, { requestId: string; controller: AbortController }>()
  /** 每个会话的累计历史摘要（内存态；进程重启后由后续轮次重新压缩得出） */
  private readonly summaries = new Map<string, string>()
  /**
   * 会话级「已授权不再询问」的工具名表（`confirmTool` 返回 `'always'` 时写入）。
   *
   * 为什么放在这里而不是主进程：许可的粒度是**会话 × 工具名**，而"会话"这个概念
   * 在内核里就有（`sessionId`）、在主进程里反而要靠 IPC 上下文去猜；放在内核既少一层
   * 跨进程状态，也让"换会话就重新问"成为天然行为（键就是会话）。
   *
   * **只存内存、不落盘**：它是"用户此刻愿意信任这个工具"的表达，
   * 不该跨进程重启继承——重启后重新问一次是刻意的保守选择。
   */
  private readonly sessionApprovals = new Map<string, Set<string>>()
  private counter = 0
  /**
   * 事件序号（docs/06 §16.1）：单调递增，随每个 `AgentEvent` 下发。
   * 渲染层据此排序消息、识别陈旧请求的迟到事件 —— 事件本身没有时间戳，
   * 只靠 IPC 到达顺序无法区分「新一轮」与「上一轮的迟到事件」。
   */
  private seqCounter = 0

  constructor(deps: AgentHostDeps) {
    this.deps = deps
    this.logger = deps.logger ?? createNoopLogger()
  }

  isReady(): boolean {
    return this.deps.provider.create() !== undefined
  }

  async send(request: {
    sessionId: string
    text: string
    origin: string
    /**
     * 额外上下文（附件提取文本等，docs/07 §2.3）。
     * 由装配层在发送前准备好并拼进本轮用户消息，内核只负责透传。
     */
    extraContext?: string
  }): Promise<{ requestId: string }> {
    const sessionId = request.sessionId
    this.counter += 1
    const requestId = `req-${Date.now()}-${this.counter}`

    this.emit({ type: 'queued', sessionId, requestId })

    const text = request.text.trim()
    if (text === '') {
      this.emit({
        type: 'error',
        sessionId,
        requestId,
        code: 'E_INVALID_ARGUMENT',
        message: '消息内容为空',
      })
      return { requestId }
    }

    if (this.active.has(sessionId)) {
      this.emit({
        type: 'error',
        sessionId,
        requestId,
        code: ERROR_BUSY,
        message: '该会话正在回复中，请等待或先停止当前回复',
      })
      return { requestId }
    }

    const config = this.deps.provider.create()
    if (config === undefined) {
      this.emit({
        type: 'error',
        sessionId,
        requestId,
        code: ERROR_NO_MODEL,
        message: '还没有可用的 AI 模型配置：请在「设置 → AI 模型」中填写并保存 API Key',
      })
      return { requestId }
    }

    const controller = new AbortController()
    this.active.set(sessionId, { requestId, controller })

    // 后台推进；事件通过 onEvent 推送，异常不越过 IPC 边界
    void this.run({
      sessionId,
      requestId,
      text,
      origin: request.origin,
      config,
      controller,
      ...(request.extraContext === undefined ? {} : { extraContext: request.extraContext }),
    })
    return { requestId }
  }

  abort(requestId: string): boolean {
    for (const [sessionId, entry] of this.active) {
      if (entry.requestId !== requestId) continue
      entry.controller.abort()
      this.active.delete(sessionId)
      this.logger.info('已取消 Agent 请求', { requestId, sessionId })
      // 立即结束渲染层的 loading 状态；循环内部的 abort 会自然退出
      this.emit({ type: 'done', sessionId, requestId })
      return true
    }
    return false
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 当前是否已有请求在跑（供测试与状态展示） */
  isBusy(sessionId: string): boolean {
    return this.active.has(sessionId)
  }

  /**
   * 清空某会话的「不再询问」授权（会话被删除 / 新建同名会话时由主进程调用）。
   *
   * 为什么必须有这个出口：授权表的键只有 `sessionId`，会话删掉又重建（或换个项目复用
   * 同一个 id）时，旧授权会**静默继承**到新会话上——那是"用户批准过一次，之后永久免检"，
   * 与"会话 × 工具名"的口径不符。
   */
  clearSessionApprovals(sessionId: string): void {
    this.sessionApprovals.delete(sessionId)
  }

  // ───────────────────────── 内部 ─────────────────────────

  private async run(input: {
    sessionId: string
    requestId: string
    text: string
    origin: string
    config: ProviderConfig
    controller: AbortController
    extraContext?: string
  }): Promise<void> {
    const { sessionId, requestId } = input
    try {
      // user 消息广播（docs/06 §4）：user 消息此前没有任何事件，其它窗口（如提示条面板）
      // 看不到主界面发出的提问。content 用 trim 后的原始输入（不含技能改写），不带消息 id。
      // 事件早于 send 的 invoke 返回到达，渲染层按「末尾 30 秒内同文本 user 消息已存在则
      // 跳过」去重 —— requestId 过滤在这里不可靠（发送方此刻还没拿到 requestId）。
      this.emit({
        type: 'user-message',
        sessionId,
        requestId,
        content: input.text,
        createdAt: Date.now(),
      })
      const explicit = this.deps.skills.parseExplicitInvocation(input.text)
      const userInput =
        explicit === undefined ? input.text : explicit.rest === '' ? input.text : explicit.rest
      // 技能正文与附件文本共用 extraContext：都是「本轮要额外给模型看的内容」
      const extraContext = joinSections([
        explicit === undefined ? undefined : this.deps.skills.render(explicit.skillName),
        input.extraContext,
      ])

      // 会话压缩：超预算时把丢弃的旧消息压成摘要（跨轮次累计，存在内存里）。
      // summarizer 缺失 / 抛错时 compressHistory 会退回纯截断，不会让请求失败。
      //
      // quick 会话滑动窗口（docs/06 §4）：窗口启用时先把窗外消息滤掉再交给压缩组装，
      // 更早的仅留在存储 / 界面历史（过滤后为空 = 只有本轮输入，compressHistory 对
      // 空输入安全返回空历史）。窗口模式下同步跳过滚动摘要 —— 旧摘要本身就是同样的
      // 污染源：不读 previousSummary、不写 summaries，compression.summary 恒为
      // undefined，buildSystemPrompt 的 historySummary 小节随之自动省略。
      const quickWindowMs = this.deps.quickContextWindowMs ?? 0
      const quickWindowActive = sessionId === 'quick' && quickWindowMs > 0
      const storedMessages = await this.deps.sessions.get(sessionId)
      const scopedMessages = quickWindowActive
        ? filterMessagesWithinWindow(storedMessages, quickWindowMs)
        : storedMessages
      const compression = await compressHistory(scopedMessages, {
        maxChars: this.deps.maxChars ?? DEFAULT_MAX_CHARS,
        ...(quickWindowActive || this.deps.summarize === undefined
          ? {}
          : { summarize: this.deps.summarize }),
        ...(quickWindowActive || this.summaries.get(sessionId) === undefined
          ? {}
          : { previousSummary: this.summaries.get(sessionId) }),
      })
      if (!quickWindowActive && compression.summary !== undefined) {
        this.summaries.set(sessionId, compression.summary)
      }
      if (compression.compressed) {
        this.logger.info('已完成历史摘要压缩', {
          sessionId,
          dropped: compression.dropped,
          summaryChars: compression.summary?.length ?? 0,
        })
      }
      const history = compression.messages

      // 三个可选提示片段：读取失败一律降级为省略该小节，不让提示词问题拖垮请求
      const settingsHint = this.readSettingsHint()
      const todoSummary = await this.readTodoSummary(sessionId)
      const projectInstructions = await this.readProjectInstructions()

      const systemPrompt = buildSystemPrompt({
        ...(this.deps.modePrompt === undefined ? {} : { modePrompt: this.deps.modePrompt() }),
        ...(this.deps.perceptionSummary === undefined
          ? {}
          : { perceptionSummary: await this.deps.perceptionSummary() }),
        ...(compression.summary === undefined ? {} : { historySummary: compression.summary }),
        ...(todoSummary === undefined ? {} : { todoSummary }),
        ...(projectInstructions === undefined ? {} : { projectInstructions }),
        skillCatalog: this.deps.skills.catalogPrompt,
        ...(() => {
          // 用**同一个**有序列表（toLlmTools 已按名字排序）生成提示词里的工具清单：
          // 与请求体的 tools 数组同序，否则缓存与展示会拧（docs/06 §21.2）
          const catalog = describeTools(this.deps.tools.toLlmTools())
          return catalog === undefined ? {} : { toolCatalog: catalog }
        })(),
        ...(() => {
          const guidance = buildToolGuidance(this.deps.tools.list().map((tool) => tool.name))
          return guidance === undefined ? {} : { toolGuidance: guidance }
        })(),
        ...(settingsHint === undefined ? {} : { settingsHint }),
      })

      const loop = runAgentLoop({
        provider: input.config.provider,
        model: input.config.model,
        ...(input.config.temperature === undefined
          ? {}
          : { temperature: input.config.temperature }),
        // 思考等级（`auto` 已在装配层映射成 undefined，这里只做透传）
        ...(input.config.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: input.config.reasoningEffort }),
        systemPrompt,
        userInput,
        ...(extraContext === undefined ? {} : { extraContext }),
        history,
        tools: this.deps.tools,
        sessionId,
        signal: input.controller.signal,
        ...(this.deps.maxRounds === undefined ? {} : { maxRounds: this.deps.maxRounds }),
        ...(this.deps.confirmTool === undefined
          ? {}
          : { confirmTool: this.wrapConfirmTool(sessionId) }),
        append: (message: NewMessage) => this.deps.sessions.append(sessionId, message),
        // 正文流式的 id 预领（docs/06 §16.2）：与 append 共用同一个计数器，
        // 因此「边流边发」用的 id 就是落盘后的 id，渲染层那条消息不需要被替换
        nextMessageId: () => this.deps.sessions.nextMessageId(),
        updateToolCall: (messageId: string, call: StoredToolCall) =>
          this.deps.sessions.updateToolCall(messageId, call),
        onToolCall: (info) => {
          this.logger.info('工具调用', {
            name: info.name,
            sensitivity: info.sensitivity,
            isError: info.isError,
          })
        },
      })

      for await (const event of loop) {
        switch (event.type) {
          case 'reasoning': {
            // 思考链增量（Design/betav2-spec.md §5/§6）：带该轮预领的 messageId，
            // 渲染层据此把「正在思考」挂在正确的消息上（docs/06 §16.1）。
            this.emit({
              type: 'reasoning',
              sessionId,
              requestId,
              round: event.round,
              messageId: event.messageId,
              delta: event.delta,
            })
            break
          }
          case 'text': {
            this.emit({
              type: 'text',
              sessionId,
              requestId,
              round: event.round,
              messageId: event.messageId,
              delta: event.delta,
            })
            break
          }
          case 'tool': {
            this.emit({
              type: 'tool',
              sessionId,
              requestId,
              round: event.round,
              messageId: event.messageId,
              call: event.call,
            })
            break
          }
          case 'subagent': {
            // 子代理进度（docs/06 §19）：只转发，不落盘 —— 最终快照会随工具卡持久化
            this.emit({
              type: 'subagent',
              sessionId,
              requestId,
              round: event.round,
              messageId: event.messageId,
              callId: event.callId,
              subagent: event.snapshot,
            })
            break
          }
          case 'usage': {
            // token 用量（docs/06 §16.2）：只做展示（输入框底部的上下文详解），不落盘 ——
            // 它是「这一轮请求的上下文占用」，重放历史时重新收集没有意义
            this.emit({
              type: 'usage',
              sessionId,
              requestId,
              round: event.round,
              usage: event.usage,
            })
            break
          }
          case 'done': {
            this.emit({
              type: 'done',
              sessionId,
              requestId,
              ...(event.pending === true ? { pending: true } : {}),
            })
            break
          }
          case 'error': {
            this.emit({
              type: 'error',
              sessionId,
              requestId,
              code: event.code,
              message: event.message,
            })
            break
          }
          default:
            break
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error('Agent 请求失败', { requestId, sessionId, error: message })
      this.emit({ type: 'error', sessionId, requestId, code: 'E_UNKNOWN', message })
    } finally {
      const entry = this.active.get(sessionId)
      if (entry?.requestId === requestId) this.active.delete(sessionId)
    }
  }

  private emit(event: AgentEventInput): void {
    const withSeq = { ...event, seq: (this.seqCounter += 1) } as AgentEvent
    for (const listener of this.listeners) {
      try {
        listener(withSeq)
      } catch (error) {
        this.logger.warn('Agent 事件监听器抛错', { error: String(error) })
      }
    }
  }

  /**
   * 包一层 `confirmTool`：给循环的那份钩子自带「本会话已授权」的短路。
   *
   * 三条口径（缺一不可）：
   * ① 该会话已授权该工具名 → **直接返回 `true`，不调用 `deps.confirmTool`**
   *    （不再打扰用户是 `'always'` 的全部意义，多调一次就可能多弹一张卡）；
   * ② 否则照常问；答 `'always'` 时记入授权表并原样返回 `'always'`（调用方仍按一次放行处理）；
   * ③ 其余（`true` / `false` / 抛错）原样透传 —— 拒绝与异常的处理**只在循环那一层**，
   *    这里不做二次解释，否则两处判定迟早漂移。
   *
   * 每次 `run()` 现包一个闭包：钩子本身绑定了 `sessionId`，不会串会话。
   */
  private wrapConfirmTool(
    sessionId: string,
  ): (info: {
    name: string
    input: unknown
    sessionId: string
    sensitivity: 'confirm'
  }) => Promise<ConfirmDecision> {
    const confirm = this.deps.confirmTool
    return async (info) => {
      // `run()` 只在 deps.confirmTool 存在时才包装；这里再判一次是为了让类型收窄不依赖调用点
      if (confirm === undefined) return true
      if (this.sessionApprovals.get(sessionId)?.has(info.name) === true) return true
      const decision = await confirm(info)
      if (decision === 'always') {
        const approved = this.sessionApprovals.get(sessionId) ?? new Set<string>()
        approved.add(info.name)
        this.sessionApprovals.set(sessionId, approved)
      }
      return decision
    }
  }

  /** 「Agent 可修改的设置」清单：抛错时 warn 留痕并省略该节（不中断请求） */
  private readSettingsHint(): string | undefined {
    if (this.deps.settingsHint === undefined) return undefined
    try {
      return this.deps.settingsHint()
    } catch (error) {
      this.logger.warn('settingsHint 生成失败，本次请求省略该小节', {
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  /** 任务清单摘要：空串交由 buildSystemPrompt 的 normalize 省略；读取失败同样降级 */
  private async readTodoSummary(sessionId: string): Promise<string | undefined> {
    if (this.deps.todoSummary === undefined) return undefined
    try {
      return await this.deps.todoSummary(sessionId)
    } catch (error) {
      this.logger.warn('任务清单摘要读取失败，本次请求省略该小节', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  /**
   * 项目级约定（docs/06 §5.1）：空串交由 buildSystemPrompt 的 normalize 省略；
   * 无项目 / 读取失败同样降级为省略，**绝不因为读不到 AGENTS.md 就让整轮请求失败**。
   */
  private async readProjectInstructions(): Promise<string | undefined> {
    if (this.deps.projectInstructions === undefined) return undefined
    try {
      return await this.deps.projectInstructions()
    } catch (error) {
      this.logger.warn('项目约定读取失败，本次请求省略该小节', {
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }
}

export type { AgentToolCall }

/** 拼接若干可选文本段（去掉空段，用空行分隔）。 */
function joinSections(parts: Array<string | undefined>): string | undefined {
  const kept = parts.map((part) => part?.trim() ?? '').filter((part) => part !== '')
  return kept.length === 0 ? undefined : kept.join('\n\n')
}
