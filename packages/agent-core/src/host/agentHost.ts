/**
 * KernelAgentHost —— 把内核各模块装配成 `AgentHost`（docs/02 §3.1、docs/06 §5）。
 *
 * 纯逻辑：所有系统能力（模型凭据解密、模式提示词、感知摘要、会话存储）
 * 由主进程以依赖形式注入，因此可在 Node 里完整单测。
 */
import type {
  AgentCompactOutcome,
  AgentEvent,
  AgentHost as AgentHostContract,
  AgentToolCall,
} from '@aurora/shared'
import type { Logger } from '@aurora/shared'
import { createJob, toJobSummary, type AgentJob, type JobPendingReason } from '../jobs/types.js'
import type { JobPatch, JobStore } from '../jobs/store.js'
import { createNoopLogger } from '@aurora/shared'
import { buildSystemPrompt, buildToolGuidance, describeTools } from '../context/systemPrompt.js'
import {
  DEFAULT_MAX_ROUNDS,
  runAgentLoop,
  type ConfirmDecision,
  type LoopProvider,
} from '../loop/agentLoop.js'
import type { LlmImageInput, LlmImageResolver, ReasoningEffortLevel } from '../llm/types.js'
import type { SkillsBridge } from '../skills/bridge.js'
import {
  compressHistory,
  DEFAULT_MAX_CHARS,
  filterMessagesWithinWindow,
  trimForSummary,
  type SummarizeFn,
} from '../session/history.js'
import type { SessionStore } from '../session/store.js'
import type { NewMessage, StoredMessage, StoredToolCall } from '../session/types.js'
import { filterTools, type ToolRegistry, type ToolSource } from '../tools/registry.js'

export interface ProviderConfig {
  provider: LoopProvider
  model: string
  temperature?: number
  /** 思考等级（v5）；`undefined` = 不下发思考等级字段 */
  reasoningEffort?: ReasoningEffortLevel
  /**
   * 该模型是否支持**图片输入**（多模态，docs/06 §3.1，v22）：
   * 由装配层按当前生效模型的 `llm.providers.<id>.modelParams.<模型 id>.vision` 透传。**缺省 = 不支持** ——
   * 对不支持视觉的模型发图片分片会被服务端 400（整个对话都用不了），
   * 因此「没说不支持」不能当成支持；关闭时图片按未读取降级为一行文字。
   */
  vision?: boolean
}

/** 一次图片读盘的结果（`image` 缺省 = 这张图读不出来，按未读取处理）。 */
export interface LoadedImage {
  path: string
  image?: LlmImageInput
}

export interface AgentProviderFactory {
  /**
   * 每次请求即时构造（保证设置页改 Key 后立即生效）。
   *
   * `allowFallback` 只由**装配层的自愈路径**使用（step-02 §6）：配置被写坏、导致
   * `llm.active` 指向不存在的 provider 时，回退到「有 baseUrl + model + 可用 Key」的
   * 最近可用条目，避免 AI 彻底失能。缺省 `false`——正常路径行为与从前完全一致。
   *
   * `sessionId`（docs/06 §3 会话级模型）：给了它就按该会话的覆盖 `(providerId, model)`
   * 构造；未覆盖 / 覆盖失效（provider 已删）时回落全局档 —— 回落由装配层的实现负责，
   * 内核只传 id。**刻意是同步的**：调用点在 `send()` 的 `E_BUSY` 检查与 `active.set` 之间，
   * 那里不能出现 await（否则防双跑守卫失效）。缺省不传 = 全局档，与从前逐字一致。
   */
  create(options?: { allowFallback?: boolean; sessionId?: string }): ProviderConfig | undefined
}

/**
 * 一次运行的「运行档」（v20，docs/06 §5.2）：按 `origin` 定制人设、场景说明与工具面。
 *
 * 三个字段都可缺省，缺省即"与普通会话相同"：
 * - `persona` 替换 `BASE_PERSONA`（系统提示词的第一段）；
 * - `runContext` 渲染成独立的「## 本次运行」小节（紧随「## 当前模式」）；
 * - `hiddenTools` 是**本次运行从工具面摘除的工具名**：模型在「## 可用工具」里看不到它们，
 *   请求体的 `tools` 数组里也没有，调用时循环会回填「工具不存在」——三层同时成立。
 */
export interface RunProfile {
  persona?: string
  runContext?: string
  hiddenTools?: readonly string[]
}

export interface AgentHostDeps {
  sessions: SessionStore
  provider: AgentProviderFactory
  tools: ToolRegistry
  skills: SkillsBridge
  logger?: Logger
  /** 当前模式提示词片段 */
  modePrompt?(): string
  /**
   * 按运行来源定制的「运行档」（v20，docs/06 §5.2）。
   *
   * 使用场景只有一个：**自动化触发的会话**。它与交互式会话有两条硬差别 ——
   * ① 没人在旁边回答问题（不能把任务留给下一轮对话），② 它不得再管理 / 触发自动化
   * （否则「自动化 → 会话 → 自动化」是自我延续的闭环）。
   * 前者靠替换人设 + 注入「## 本次运行」小节表达，后者靠 `hiddenTools` 摘除工具名。
   *
   * 返回 `undefined` 时一切与从前逐字一致（普通会话因此完全不受影响）；
   * 抛错按「无运行档」降级（提示词与工具面都退回默认，不拖垮请求）。
   */
  runProfileFor?(context: { sessionId: string; origin: string }): RunProfile | undefined
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
   * 入参是**发起请求的会话**：装配层据此解析会话绑定的项目（未绑定回落全局当前项目），
   * 两个绑定不同项目的会话各拿各的 AGENTS.md。
   * 返回空串 / undefined / 抛错时整段省略（降级为"无项目约定"，不中断请求）。
   */
  projectInstructions?(sessionId: string): Promise<string | undefined>
  /**
   * 会话生效工作目录提示（docs/06 §4 会话三分 / §5.1，2026-09-30）：按会话解析
   * 回落链结果（Agent 空间 → `桌面\Aurora`、Work 空间 → 模式工作目录、项目对话 → 项目根），
   * 渲染为「## 工作目录」易变小节。返回空串 / undefined / 抛错时整段省略（不中断请求）。
   */
  workspaceHint?(sessionId: string): Promise<string | undefined>
  /**
   * 图片附件**读盘**（多模态输入，docs/06 §3.1）：把绝对路径读成可下发的图片内容。
   *
   * 内核不碰文件系统，因此这里是注入端口（与 `confirmTool` / `summarize` 同款）：
   * 主进程实现里带单图大小上限与失败降级。**未注入时图片一律不重放**（历史按纯文本下发、
   * 本轮的图片路径只落盘不发送），行为与 v22 之前完全一致。
   *
   * 返回与入参**一一对应**（读不出的条目 `image` 缺省），调用方据此只放行读成功的那些。
   */
  loadImages?(paths: readonly string[]): Promise<readonly LoadedImage[]>
  /**
   * Job 存储（docs/06 §4.1，v15）：有了它，一次请求就是一条可查询 / 可续跑的 job；
   * 未注入时行为与 v15 之前完全一致（不落 job、不发 `job` 事件）。
   */
  jobs?: JobStore
  /**
   * 轮次上限（**getter**，v15 起）：设置页改完下一次请求即生效。
   * v15 之前这里是常量值，改配置必须重启才生效。
   */
  maxRounds?: () => number
  /** 累计 token 预算；0 = 不限（触顶即暂停，附 `pendingReason: 'budget'`） */
  maxTotalTokens?: () => number
  /** 轮次用尽后允许自动再续几轮；0 = 不自动续，直接落 `paused` 等用户点「继续」 */
  autoContinueRounds?: () => number
  /** 时钟注入（单测用它造确定性的时间戳；缺省 `new Date()`） */
  clock?: () => Date
}

export const ERROR_NO_MODEL = 'E_NO_MODEL'
export const ERROR_BUSY = 'E_BUSY'
/** 续跑时 job 不处于 `paused`（已完成 / 在跑 / 出错）：拒绝而不是"假装续跑" */
export const ERROR_JOB_STATE = 'E_JOB_STATE'

/** 手动压缩结局：形状定义在 shared（`AgentCompactOutcome`，contracts 与内核共用一份） */
export type CompactOutcome = AgentCompactOutcome

/**
 * 发出事件时的入参形状：`seq` 由 `emit` 统一分配（docs/06 §16.1），
 * 调用点不必、也不该自己编号 —— 序号是「发出顺序」的单一事实来源。
 */
type AgentEventInput = AgentEvent extends infer T
  ? T extends { seq: number }
    ? Omit<T, 'seq'>
    : never
  : never

/**
 * `run()` 的终态口径（v15，docs/06 §4.1）：四选一，且各自要把话说清楚 ——
 * `paused` 必须带原因（否则界面只能显示"停了"），`error` 必须带消息。
 *
 * 做成联合类型而不是"一个 status 加几个可选字段"：后者允许构造出
 * `{ status: 'error' }`（没有 error）这种自相矛盾的终态，落盘后界面就只剩一个红点。
 */
type JobTerminal =
  | { status: 'paused'; pendingReason: 'max-rounds' | 'budget' }
  | { status: 'aborted' }
  | { status: 'done' }
  | { status: 'error'; error: string }

/**
 * 续跑：把存储里那条 `paused` job 变成"本次请求正在跑"（v15，docs/06 §4.1）。
 *
 * 刻意只动**内存副本**（随后 `update` 落盘），且**不碰**这些字段：
 * - `origin`：它记录的是"这条 job 最初从哪来"（chat / edge-bar），续跑**不改写**它 ——
 *   否则界面上一条从主界面发出的任务，续跑一次就变成了"resume 来源"；
 * - `createdAt` / `stepsDone` / `budget.autoContinued`：都是这段任务的历史账本，
 *   重置它们等于"续跑就洗掉之前的进度与已用额度"。
 *
 * 清掉上一次的收尾结论（`pendingReason` / `error`）：那是**上一段**的结论，
 * 续跑开始后界面不该一边显示"正在跑"一边挂着"轮次用尽"。
 */
function reviveJob(paused: AgentJob, requestId: string, clock: () => Date): AgentJob {
  const next: AgentJob = {
    ...paused,
    status: 'running',
    requestId,
    updatedAt: clock().toISOString(),
  }
  delete next.pendingReason
  delete next.error
  return next
}

export class KernelAgentHost implements AgentHostContract {
  private readonly deps: AgentHostDeps
  private readonly logger: Logger
  private readonly listeners = new Set<(event: AgentEvent) => void>()
  private readonly active = new Map<string, { requestId: string; controller: AbortController }>()
  /**
   * requestId → 本次请求的 job（v15）。
   *
   * 为什么需要这张表：`abort(requestId)` 手上只有 requestId，而 job 是按 id / 会话组织的；
   * 存一张"在跑的请求"的小表把两者对上，比在 abort 里线性扫全部会话便宜，
   * 也不会误伤已经跑完的历史 job。`run()` 开始时写入、`finally` 里删除。
   */
  private readonly jobsByRequest = new Map<string, AgentJob>()
  /** 每个会话的累计历史摘要（内存态；进程重启后由后续轮次重新压缩得出） */
  private readonly summaries = new Map<string, string>()
  /**
   * 图片路径 → 已读好的图片内容（多模态输入，docs/06 §3.1）。
   *
   * 进程内缓存，键是**绝对路径**：同一张图在后续轮次（含自动续轮的 attempt 重进）
   * 只读一次盘。刻意不设淘汰：一条会话里的图片数量本就有限，而按 LRU 逐出的代价是
   * 「同一张图被反复读盘 + 反复编码 base64」，那正是这条链上最贵的操作。
   */
  private readonly imageCache = new Map<string, LlmImageInput>()
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
    /**
     * 随本轮消息一起发出的**图片附件路径**（多模态输入，docs/06 §3.1）。
     *
     * 由装配层（主进程）按扩展名从附件里挑出来；内核经注入的 `loadImages` 读成内容，
     * 路径本身落进会话历史（`StoredMessage.images`）供跨轮次重放。
     * 当前 provider 的 `ProviderConfig.vision` 为假时**只落盘不发送** —— 能力开关那一层的
     * 判断在装配层已经做过一次（降级文案也在那边），这里是防止其它调用方绕过它。
     */
    images?: readonly string[]
    /**
     * 续跑哪条 job（v15，docs/06 §4.1）：只接受**同会话**且 `status === 'paused'` 的 job，
     * 其余一律回 `E_JOB_STATE` 且不开始执行。给了它时本轮**不重复落盘**那条用户消息。
     */
    resumeJobId?: string
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
      this.emitBusy(sessionId, requestId)
      return { requestId }
    }

    const config = this.deps.provider.create({ sessionId })
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

    // 续跑判定（v15，docs/06 §4.1）：刻意放在 `E_NO_MODEL` **之后**、建 AbortController
    // **之前**。往前挪会改变"没配置模型"的报错优先口径；往后挪则会让一次被拒的续跑占住
    // 会话的 active 槽 —— 用户得等一个"其实什么都没跑"的请求收尾才能再发消息。
    let resumeJob: AgentJob | undefined
    if (request.resumeJobId !== undefined) {
      const job = await this.deps.jobs?.get(request.resumeJobId)
      // 三种拒绝：job 不存在 / 不是这个会话的 / 不在 `paused`（在跑、已完成、出错）。
      // 一律明确拒绝，**不降级成一次新请求**：那会让用户以为在续跑，实际从头再来一遍
      // （还可能把那条提问写进历史两次）。
      if (job === undefined || job.sessionId !== sessionId || job.status !== 'paused') {
        this.emit({
          type: 'error',
          sessionId,
          requestId,
          code: ERROR_JOB_STATE,
          message: '这条任务已不在可继续的状态（可能已完成或正在执行），请刷新后重试',
        })
        return { requestId }
      }
      resumeJob = job
      // `jobs.get` 是本方法里**唯一一个 await**：两次快速连点「继续」会双双通过上面那次
      // E_BUSY 检查、然后一起跑起来 —— 同会话两条循环并行时 `active` 只记得住后一条
      //（abort 因此取消不掉前一条，两边的 token 也会重复计）。等完再确认一次"会话仍空闲"，
      // 把这条缝焊上：检查与 `active.set` 之间没有 await，因此不可能双双通过。
      if (this.active.has(sessionId)) {
        this.emitBusy(sessionId, requestId)
        return { requestId }
      }
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
      ...(request.images === undefined || request.images.length === 0
        ? {}
        : { images: request.images }),
      ...(resumeJob === undefined ? {} : { resumeJob }),
    })
    return { requestId }
  }

  abort(requestId: string): boolean {
    for (const [sessionId, entry] of this.active) {
      if (entry.requestId !== requestId) continue
      entry.controller.abort()
      this.active.delete(sessionId)
      this.logger.info('已取消 Agent 请求', { requestId, sessionId })
      // job 侧同步乐观落 `aborted`（v15）：**不 await** —— 见 `markJobAborted`
      this.markJobAborted(requestId)
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

  /**
   * 手动压缩会话上下文（`/compact`，2026-10-03，docs/06 §4）：把**当时的全部消息**
   * 交给注入的 summarizer 压成一段摘要，写进 `meta.compact`（随会话文件落盘）。
   *
   * 三条口径：
   * - **消息本体不删**：历史仍完整留在会话文件 / 界面上；压缩只改变「组装请求」的口径 ——
   *   `run()` 组装历史时只取 `compact.upToMessageId` **之后**的消息，摘要注入 systemPrompt；
   * - 在跑的会话**拒绝压缩**（E_BUSY 语义）：压缩点取「当前最后一条消息」，与在跑请求
   *   正在追加的消息会产生竞态（压完又长出窗口外的内容，摘要覆盖不全）；
   * - 内存 `summaries` Map **同步覆盖**为这份摘要：进程内的自动压缩链从它续写
   *   （`run()` 的 previousSummary 取值优先内存 Map，重启后才回落 `meta.compact`）。
   */
  async compact(sessionId: string): Promise<CompactOutcome> {
    if (this.active.has(sessionId)) {
      return { ok: false, error: '该会话正在回复中，请等待或先停止当前回复再压缩' }
    }
    const summarize = this.deps.summarize
    if (summarize === undefined) {
      return { ok: false, error: '当前没有可用的摘要能力（未配置模型或 summarizer 未注入）' }
    }
    const stored = await this.deps.sessions.get(sessionId)
    if (stored.length === 0) {
      return { ok: false, error: '会话还没有可压缩的内容' }
    }
    try {
      const text = await summarize({
        dropped: trimForSummary(stored),
        previousSummary: this.summaries.get(sessionId),
      })
      const summary = text.trim()
      if (summary === '') {
        return { ok: false, error: '摘要结果为空，未做压缩' }
      }
      const last = stored[stored.length - 1]
      await this.deps.sessions.setCompact(sessionId, {
        summary,
        at: (this.deps.clock ?? ((): Date => new Date()))().toISOString(),
        upToMessageId: last?.id ?? '',
      })
      this.summaries.set(sessionId, summary)
      this.logger.info('已手动压缩会话上下文', {
        sessionId,
        summaryChars: summary.length,
        coveredMessages: stored.length,
      })
      return { ok: true, summaryChars: summary.length, coveredMessages: stored.length }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  // ───────────────────────── 内部 ─────────────────────────

  /**
   * 解析本次运行的运行档（v20，docs/06 §5.2）。
   *
   * 装配层抛错时**降级为默认档**并记一条 warn：宁可让这次请求按普通会话跑，也不能
   * 因为「算提示词」失败而整个请求失败 —— 运行档是提示词层面的优化，不是请求的前置条件。
   */
  private resolveRunProfile(sessionId: string, origin: string): RunProfile | undefined {
    if (this.deps.runProfileFor === undefined) return undefined
    try {
      return this.deps.runProfileFor({ sessionId, origin })
    } catch (error) {
      this.logger.warn('运行档解析失败，已按默认档继续', {
        sessionId,
        origin,
        error: String(error),
      })
      return undefined
    }
  }

  private async run(input: {
    sessionId: string
    requestId: string
    text: string
    origin: string
    config: ProviderConfig
    controller: AbortController
    extraContext?: string
    /** 本轮的图片附件路径（多模态输入，docs/06 §3.1） */
    images?: readonly string[]
    /** 续跑的目标 job（`send` 已校验过：同会话 + `paused`）；缺省 = 一次全新请求 */
    resumeJob?: AgentJob
  }): Promise<void> {
    const { sessionId, requestId } = input
    const jobs = this.deps.jobs
    const clock = this.deps.clock ?? ((): Date => new Date())
    // 三个上限都是 **getter**（v15）：设置页改完下一次请求即生效，不必重启
    const maxRoundsLimit = this.deps.maxRounds?.() ?? DEFAULT_MAX_ROUNDS
    const maxTotalTokens = Math.max(0, this.deps.maxTotalTokens?.() ?? 0)
    const autoContinueLimit = Math.max(0, this.deps.autoContinueRounds?.() ?? 0)
    /**
     * 本次运行的运行档（v20）：按 `origin` 现取值。取值失败一律降级为「无运行档」
     * （提示词与工具面退回默认）——提示词细节永远不该让一次请求跑不起来。
     */
    const profile = this.resolveRunProfile(sessionId, input.origin)
    /**
     * 本次请求的工具面：有 `hiddenTools` 时是**过滤视图**（不污染全局注册表 ——
     * 注册表是进程级、按时重建的，而"哪些工具能用"是请求级的）。三处消费
     * （提示词工具清单 / 工具使用规范 / 循环执行）都走这一个来源，三处才同口径。
     */
    const tools: ToolSource =
      profile?.hiddenTools === undefined || profile.hiddenTools.length === 0
        ? this.deps.tools
        : filterTools(this.deps.tools, profile.hiddenTools)
    /** 本请求的 job；未注入 `jobs` 时恒为 undefined，行为与 v15 之前完全一致 */
    let job: AgentJob | undefined

    /**
     * 落终态 + 广播一条 `job` 事件（闭包持有本次请求的 job / 会话 / requestId）。
     *
     * 存储层的 `update` 永不抛（内部降级为 warn），因此"落终态"本身不会成为新的失败源。
     */
    const finishJob = async (terminal: JobTerminal): Promise<void> => {
      if (job === undefined || jobs === undefined) return
      const at = clock().toISOString()
      job.updatedAt = at
      const patch: JobPatch = { status: terminal.status, updatedAt: at }
      if (terminal.status === 'paused') {
        job.status = 'paused'
        job.pendingReason = terminal.pendingReason
        patch.pendingReason = terminal.pendingReason
      } else if (terminal.status === 'aborted') {
        job.status = 'aborted'
        job.pendingReason = 'aborted'
        patch.pendingReason = 'aborted'
      } else if (terminal.status === 'done') {
        job.status = 'done'
        // 正常收敛：把上一次的暂停原因清掉（续跑成功后它不该还挂在界面上）
        delete job.pendingReason
        patch.pendingReason = undefined
      } else {
        job.status = 'error'
        job.error = terminal.error
        patch.error = terminal.error
      }
      await jobs.update(job.id, patch)
      this.emit({ type: 'job', sessionId, requestId, job: toJobSummary(job) })
    }

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

      // job 建档（v15，docs/06 §4.1）：一次请求 = 一条 job。
      // 时机：user-message 之后（事件顺序上那条提问仍然最先）、组装历史之前 ——
      // 建档越早，"异常也有终态可落"的覆盖面越大。
      if (jobs !== undefined) {
        const paused = input.resumeJob
        if (paused === undefined) {
          job = createJob(
            {
              sessionId,
              text: input.text,
              origin: input.origin as AgentJob['origin'],
              maxRounds: maxRoundsLimit,
              maxTotalTokens,
              requestId,
            },
            { clock },
          )
          // `createJob` 本就置 `status: 'running'`；这里显式再写一次，是为了让
          // 「新请求从 running 起」这条口径在调用点肉眼可见，不依赖别处的默认值
          job.status = 'running'
        } else {
          job = reviveJob(paused, requestId, clock)
        }
        job.updatedAt = clock().toISOString()
        if (paused === undefined) {
          await jobs.create(job)
        } else {
          // 续跑走 `update` 而不是 `create`：`create` 的语义是"追加一条新 job"，
          // 对着同一条 job 再 create 一次，存储里就会出现两条同 id 记录
          await jobs.update(job.id, {
            status: 'running',
            pendingReason: undefined,
            error: undefined,
            updatedAt: job.updatedAt,
          })
        }
        this.jobsByRequest.set(requestId, job)
        this.emit({ type: 'job', sessionId, requestId, job: toJobSummary(job) })
      }

      const explicit = this.deps.skills.parseExplicitInvocation(input.text)
      const userInput =
        explicit === undefined ? input.text : explicit.rest === '' ? input.text : explicit.rest
      // 技能正文与附件文本共用 extraContext：都是「本轮要额外给模型看的内容」
      const extraContext = joinSections([
        explicit === undefined ? undefined : this.deps.skills.render(explicit.skillName),
        input.extraContext,
      ])

      // 一次请求可能跑好几个 attempt（自动续轮，docs/06 §4.1）：每个 attempt 都是
      // 「从游标起、最多 maxRounds 轮」的一个完整循环实例，因此事件映射被整段包进 `for (;;)`。
      /** 是否落盘本轮用户消息：只有本次请求的**第一次** attempt 落，续跑 / 自动续轮都不落 */
      let appendUserMessage = input.resumeJob === undefined
      /** 本次 attempt 的收尾结论（在下面 switch 的 `done` / `error` 分支里捕获） */
      let pendingReason: JobPendingReason | undefined
      let errorMessage: string | undefined
      for (;;) {
        // 历史与系统提示**在每个 attempt 内重算**（docs/06 §4.1）：自动续轮等价于一次自动
        // resume，`appendUserMessage = false` 的语义前提正是"提问已在 history 里"——只有
        // 在这里重读会话才成立。放在循环外算的话，续轮拿到的是**请求前**的旧快照：
        // 既没有本轮提问、也没有上一 attempt 已落盘的助手 / 工具消息，模型会重复
        // 已执行的写 / 命令操作。每 attempt 重算滚动摘要同样是本不变量的既定行为
        // （超预算时每次可能多一次 summarize 调用、压缩日志可能多条），不是回归。
        //
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
        // 手动压缩游标（/compact，docs/06 §4）：`upToMessageId` **之前**的消息不进组装，
        // 由 `meta.compact.summary` 顶替（元文本进 systemPrompt，下一条 compressHistory
        // 的 previousSummary 优先取内存 Map——compact() 会把两者写成同一份，
        // 进程内它总是最新的；重启后内存 Map 为空，才回落落盘的 meta.compact）。
        // 游标 id 已被条数环挤掉（找不到）时按「全部进组装」兜底：摘要链仍然连续，
        // 只是这部分旧消息会被重复计入 —— 这是极端长会话下的可接受退化。
        const compacted = await this.deps.sessions.compactOf(sessionId)
        const scopedMessages = sliceAfterCompact(
          quickWindowActive
            ? filterMessagesWithinWindow(storedMessages, quickWindowMs)
            : storedMessages,
          compacted?.upToMessageId,
        )
        const inMemorySummary = this.summaries.get(sessionId)
        const compression = await compressHistory(scopedMessages, {
          maxChars: this.deps.maxChars ?? DEFAULT_MAX_CHARS,
          ...(quickWindowActive || this.deps.summarize === undefined
            ? {}
            : { summarize: this.deps.summarize }),
          ...(quickWindowActive
            ? {}
            : {
                previousSummary:
                  inMemorySummary ??
                  (compacted === undefined || compacted.summary === ''
                    ? undefined
                    : compacted.summary),
              }),
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

        /**
         * 图片附件读盘（多模态输入，docs/06 §3.1）。
         *
         * 只在**当前 provider 声明支持图片输入**（`vision`）且装配层注入了 `loadImages` 时读：
         * 关掉开关的模型收到图片分片会被服务端 400，所以降级必须在**发出去之前**完成
         * （降级文案由装配层在 `extraContext` 里给出，内核这边只是不读、不发）。
         *
         * 缓存跨 attempt 复用（自动续轮会重进这个循环）：读过的路径不再读第二遍，
         * 因此续轮不会因为"重新读一遍图"而变慢；读不出的路径**不缓存**，
         * 于是也不会把一次偶发失败永久记成本轮失败。
         */
        const visionEnabled = input.config.vision === true
        const loadImages = this.deps.loadImages
        if (visionEnabled && loadImages !== undefined) {
          await primeImageCache(
            [...collectImagePaths(history), ...(input.images ?? [])],
            loadImages,
            this.imageCache,
            this.logger,
          )
        }
        const resolveImages: LlmImageResolver = (paths) => {
          /**
           * 能力开关**在解析处再判一次**，而不是只判「要不要读盘」。
           *
           * `imageCache` 是进程级、不淘汰的（同一张图跨轮次只读一次盘），因此
           * 「先开着开关跑一轮（图进了缓存）→ 再关掉」时，缓存里那几张图照样能被解析出来 ——
           * 于是关闭态仍然把图片发了出去。这条路径是 smoke 实测出来的：
           * 同一个进程里连续两次发送（开 / 关），第二次的内容分片里仍然有 `image_url`。
           */
          if (!visionEnabled) return []
          const out: LlmImageInput[] = []
          for (const path of paths) {
            const image = this.imageCache.get(path)
            if (image !== undefined) out.push(image)
          }
          return out
        }
        const userImages = resolveImages(input.images ?? [])

        // 三个可选提示片段：读取失败一律降级为省略该小节，不让提示词问题拖垮请求
        const settingsHint = this.readSettingsHint()
        const todoSummary = await this.readTodoSummary(sessionId)
        const projectInstructions = await this.readProjectInstructions(sessionId)
        const workspaceHint = await this.readWorkspaceHint(sessionId)

        const systemPrompt = buildSystemPrompt({
          ...(profile?.persona === undefined ? {} : { persona: profile.persona }),
          ...(profile?.runContext === undefined ? {} : { runContext: profile.runContext }),
          ...(this.deps.modePrompt === undefined ? {} : { modePrompt: this.deps.modePrompt() }),
          ...(this.deps.perceptionSummary === undefined
            ? {}
            : { perceptionSummary: await this.deps.perceptionSummary() }),
          ...(compression.summary === undefined ? {} : { historySummary: compression.summary }),
          ...(todoSummary === undefined ? {} : { todoSummary }),
          ...(workspaceHint === undefined ? {} : { workspaceHint }),
          ...(projectInstructions === undefined ? {} : { projectInstructions }),
          skillCatalog: this.deps.skills.catalogPrompt,
          ...(() => {
            // 用**同一个**有序列表（toLlmTools 已按名字排序）生成提示词里的工具清单：
            // 与请求体的 tools 数组同序，否则缓存与展示会拧（docs/06 §21.2）。
            // 注意这里用的是**本次请求的工具面**（可能是过滤视图）：命令行与清单必须一致，
            // 否则模型会看到"清单里有、请求体里没有"的工具并反复尝试（docs/06 §5.2）
            const catalog = describeTools(tools.toLlmTools())
            return catalog === undefined ? {} : { toolCatalog: catalog }
          })(),
          ...(() => {
            const guidance = buildToolGuidance(tools.list().map((tool) => tool.name))
            return guidance === undefined ? {} : { toolGuidance: guidance }
          })(),
          ...(settingsHint === undefined ? {} : { settingsHint }),
        })

        /** 本次 attempt 的用量基准（见 `onRoundComplete` 里的差值累加） */
        let attemptUsedTokens = 0
        // 游标每个 attempt 现读一次：自动续轮刚刚把 `nextRound` 推到了下一轮。
        // 新请求的游标是 0，与"不传 resume"等价；续跑则从被中断的那一轮接着跑
        const resume =
          job === undefined
            ? undefined
            : { nextRound: job.cursor.nextRound, stepsDone: job.stepsDone.length }
        /** 本次 attempt 收尾时的轮次（`done` 带回来；自动续轮据此推进游标） */
        let finalRound = resume?.nextRound ?? 0

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
          // 图片（docs/06 §3.1）：本轮读好的内容 + 供跨轮次重放的同步解析器。
          // 路径**无条件**落盘（即使 vision 关着）：用户后来在设置页打开开关，
          // 历史里那张图应该立刻能被重放，而不是要求他重新发一次。
          ...(userImages.length === 0 ? {} : { userImages }),
          ...(input.images === undefined || input.images.length === 0
            ? {}
            : { userImagePaths: input.images }),
          resolveImages,
          tools,
          sessionId,
          signal: input.controller.signal,
          // 轮次上限走上面那个 getter 解析出来的值（v15）：改设置后下一次请求即生效
          maxRounds: maxRoundsLimit,
          // 续跑（v15）：从游标那一轮继续，而不是从第 0 轮重来
          ...(resume === undefined ? {} : { resume }),
          // 续跑 / 自动续轮时**不落盘**用户消息：那条提问在上一个 job 里已经写过了，
          // 再 append 一次会话历史里就会出现两条一模一样的提问（续跑最经典的坑）
          appendUserMessage,
          budget: { maxTotalTokens },
          // 每轮结束（工具都跑完、结果都回填）时把游标 / 进度 / 用量落盘，
          // **在决定是否继续之前**：顺序反过来的话，"暂停"会把最后一轮的进度一起丢掉，
          // 续跑只能重跑它
          onRoundComplete: async ({ round, usedTokens, pendingCalls }) => {
            if (job === undefined || jobs === undefined) return
            const at = clock().toISOString()
            job.round = round
            job.cursor.nextRound = round + 1
            job.stepsDone.push(
              ...pendingCalls.map((call) => ({
                round,
                tool: call.name,
                // 走到这里工具都已执行完、`state` 已是终态：只有 `error` 算失败
                ok: call.state !== 'error',
                at,
              })),
            )
            // `usedTokens` 是**本次 attempt** 从 0 起的累计值，不是本轮增量 ——
            // 直接相加会在每次回调里把前面几轮重复计一遍（续轮时尤其明显）
            job.budget.usedTokens += usedTokens - attemptUsedTokens
            attemptUsedTokens = usedTokens
            job.updatedAt = at
            await jobs.update(job.id, {
              round: job.round,
              cursor: { ...job.cursor },
              stepsDone: [...job.stepsDone],
              budget: { usedTokens: job.budget.usedTokens },
              updatedAt: at,
            })
            this.emit({ type: 'job', sessionId, requestId, job: toJobSummary(job) })
          },
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
              // token 用量（docs/06 §16.2）：展示之外，本轮起同步累加进会话 meta
              //（meta.usage，随会话落盘）——渲染层切回会话时以它为种子恢复累计口径。
              // 刻意**先累计、后广播**：渲染层若在「累计之后、种子之前」的窗口里收到事件，
              // 种子（meta）也已包含这一轮，不会少计。
              void this.deps.sessions.addUsage(sessionId, event.usage).catch(() => undefined)
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
              // 收尾原因与轮次先收下来：终态判定与自动续轮都靠它们（渲染层同样需要，
              // 客户端据此把"静默收尾"变成"可解释的暂停"）
              pendingReason = event.pendingReason
              finalRound = event.round
              this.emit({
                type: 'done',
                sessionId,
                requestId,
                ...(event.pending === true ? { pending: true } : {}),
                ...(event.pendingReason === undefined
                  ? {}
                  : { pendingReason: event.pendingReason }),
                round: event.round,
                ...(event.usedTokens === undefined ? {} : { usedTokens: event.usedTokens }),
              })
              break
            }
            case 'error': {
              errorMessage = event.message
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

        // 后续 attempt 一律是"续轮"：用户消息已经落过盘了
        appendUserMessage = false

        // 循环自报的 error 事件 = 本次请求就此结束（`error` 在循环里就是终止语义）
        if (errorMessage !== undefined) {
          await finishJob({ status: 'error', error: errorMessage })
          return
        }

        // 自动续轮（v15）：轮次用尽但还有额度、且预算没触顶时，直接把下一轮接上继续跑。
        // 这是"长任务不必每 maxRounds 轮就让用户点一次继续"的全部实现 —— 额度持久化在
        // job 上（`budget.autoContinued`），否则重启一次又会拿到一份新额度，等于没有上限。
        if (
          pendingReason === 'max-rounds' &&
          job !== undefined &&
          jobs !== undefined &&
          autoContinueLimit > 0 &&
          job.budget.autoContinued < autoContinueLimit &&
          (maxTotalTokens === 0 || job.budget.usedTokens < maxTotalTokens)
        ) {
          job.budget.autoContinued += 1
          job.cursor.nextRound = finalRound + 1
          job.updatedAt = clock().toISOString()
          await jobs.update(job.id, {
            budget: { autoContinued: job.budget.autoContinued },
            cursor: { ...job.cursor },
            updatedAt: job.updatedAt,
          })
          this.emit({ type: 'job', sessionId, requestId, job: toJobSummary(job) })
          // 自动续轮是"用户没盯着也继续往下跑"的行为，必须留下可审计的痕迹
          this.logger.info('轮次用尽但仍有自动续轮额度，继续执行', {
            autoContinued: job.budget.autoContinued,
            autoContinueLimit,
            sessionId,
            jobId: job.id,
          })
          continue
        }

        // 终态（不再 continue）：`max-rounds` / `budget` → `paused`（可续跑），
        // `aborted` → `aborted`，**没有 pendingReason** = 正常收敛 → `done`
        if (pendingReason === 'max-rounds' || pendingReason === 'budget') {
          await finishJob({ status: 'paused', pendingReason })
        } else if (pendingReason === 'aborted') {
          await finishJob({ status: 'aborted' })
        } else {
          await finishJob({ status: 'done' })
        }
        return
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error('Agent 请求失败', { requestId, sessionId, error: message })
      this.emit({ type: 'error', sessionId, requestId, code: 'E_UNKNOWN', message })
      // 异常也要落终态（v15）：否则 job 会永远停在 `running` —— 界面上"一直在跑"，
      // 而续跑入口只认 `paused`，这条任务既看不到结束、也接不上。
      // 已经落过终态（paused / done / aborted）的不覆盖：那是这条 job 的真实结论，
      // 异常只是收尾路径上的问题。
      if (job !== undefined && job.status === 'running') {
        await finishJob({ status: 'error', error: message })
      }
    } finally {
      const entry = this.active.get(sessionId)
      if (entry?.requestId === requestId) this.active.delete(sessionId)
      // 请求结束就不再是"在跑的请求"：abort 只认在跑的请求，历史 job 由存储层负责
      this.jobsByRequest.delete(requestId)
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

  /** 「该会话正在回复中」的固定回绝（E_BUSY 的几个调用点共用同一句文案） */
  private emitBusy(sessionId: string, requestId: string): void {
    this.emit({
      type: 'error',
      sessionId,
      requestId,
      code: ERROR_BUSY,
      message: '该会话正在回复中，请等待或先停止当前回复',
    })
  }

  /**
   * 把某请求的 job 乐观标记成 `aborted`（v15），**刻意不 await**。
   *
   * `abort()` 是同步方法，"是否真的取消了"这个返回值不能被落盘速度绑架 ——
   * 用户点「停止」的瞬间界面就必须响应。落盘失败只记 warn：`run()` 的终态兜底
   * 还会再落一次，而内存里这一份已经改了，本次进程内的状态展示是对的。
   */
  private markJobAborted(requestId: string): void {
    const job = this.jobsByRequest.get(requestId)
    const jobs = this.deps.jobs
    if (job === undefined || jobs === undefined) return
    // 已经落过终态的不覆盖：done / error / aborted 是那条 job 的真实结论
    //（用户点停止时循环可能已经收敛），迟到的 abort 不该把它改写
    if (job.status !== 'running' && job.status !== 'paused') return
    const at = (this.deps.clock ?? ((): Date => new Date()))().toISOString()
    job.status = 'aborted'
    job.pendingReason = 'aborted'
    job.updatedAt = at
    void jobs
      .update(job.id, { status: 'aborted', pendingReason: 'aborted', updatedAt: at })
      .catch((error: unknown) => {
        this.logger.warn('job 落 aborted 失败，等循环收尾时再落一次', {
          jobId: job.id,
          error: String(error),
        })
      })
  }

  /**
   * 包一层 `confirmTool`：给循环的那份钩子自带「本会话已授权」的短路。
   *
   * 三条口径（缺一不可）：
   * ① 该会话已授权该工具名 → **直接返回 `'machine'`，不调用 `deps.confirmTool`**
   *    （不再打扰用户是 `'always'` 的全部意义，多调一次就可能多弹一张卡；
   *    但这是**历史授权**的机器放行，不是用户当次看卡片——不得免项目根边界，docs/06 §11.2）；
   * ② 否则照常问；答 `'always'` 时记入授权表并原样返回 `'always'`（首次仍是用户当次批准，
   *    调用方按一次带 `approvedByUser` 的放行处理）；
   * ③ 其余（`true` / `'machine'` / `false` / 抛错）原样透传 —— 拒绝与异常的处理**只在循环那一层**，
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
      // `run()` 只在 deps.confirmTool 存在时才包装；这里再判一次是为了让类型收窄不依赖调用点。
      // 返回 `'machine'` 而非 `true`：没有人看过卡片，不得算作"用户当次批准"
      if (confirm === undefined) return 'machine'
      // 已记住的会话授权是历史放行：照常跳过卡片，但出处算机器放行
      if (this.sessionApprovals.get(sessionId)?.has(info.name) === true) return 'machine'
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
   * 按会话解析项目根（会话绑定 > 全局当前项目，docs/06 §5.1）。
   */
  private async readProjectInstructions(sessionId: string): Promise<string | undefined> {
    if (this.deps.projectInstructions === undefined) return undefined
    try {
      return await this.deps.projectInstructions(sessionId)
    } catch (error) {
      this.logger.warn('项目约定读取失败，本次请求省略该小节', {
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  /** 会话工作目录提示（docs/06 §4 会话三分）：同一条降级口径 —— 读不到就省略该小节 */
  private async readWorkspaceHint(sessionId: string): Promise<string | undefined> {
    if (this.deps.workspaceHint === undefined) return undefined
    try {
      return await this.deps.workspaceHint(sessionId)
    } catch (error) {
      this.logger.warn('工作目录解析失败，本次请求省略该小节', {
        sessionId,
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

/**
 * 取「手动压缩游标之后」的消息（`run()` 组装用）：找不到游标 id（被条数环挤掉 /
 * 会话刚清理过）时**全量返回** —— 宁可让摘要与历史有一段重叠，也不能把窗口之后的
 * 真实历史丢掉。
 */
function sliceAfterCompact(
  messages: readonly StoredMessage[],
  upToMessageId: string | undefined,
): StoredMessage[] {
  if (upToMessageId === undefined || upToMessageId === '') return [...messages]
  let index = messages.length - 1
  while (index >= 0 && messages[index]?.id !== upToMessageId) index -= 1
  return index < 0 ? [...messages] : messages.slice(index + 1)
}

/**
 * 历史里出现过的图片路径（多模态输入，docs/06 §3.1）。
 *
 * 只收字符串：会话文件是磁盘数据，可能被手改过 —— 畸形值在这里就滤掉，
 * 不让它进到读盘端口（那边按路径读文件，拿到非字符串只会白报一次错）。
 */
function collectImagePaths(history: readonly StoredMessage[]): string[] {
  const paths: string[] = []
  for (const message of history) {
    if (!Array.isArray(message.images)) continue
    for (const path of message.images) {
      if (typeof path === 'string' && path !== '') paths.push(path)
    }
  }
  return paths
}

/**
 * 把还没读过的路径读进缓存（多模态输入，docs/06 §3.1）。
 *
 * 三条刻意的降级，都不让图片问题拖垮一次请求：
 * - 端口抛错 → 记 warn，本轮该批图片全部按未读取处理（**不写缓存**，下次还会再试）；
 * - 单张读不出（`image` 缺省）→ 记 warn，只跳过这一张；
 * - 端口回传的条目少于请求的路径 → 缺的那些视为未读取（不编造内容）。
 */
async function primeImageCache(
  paths: readonly string[],
  loadImages: NonNullable<AgentHostDeps['loadImages']>,
  cache: Map<string, LlmImageInput>,
  logger: Logger,
): Promise<void> {
  const missing = [...new Set(paths)].filter((path) => path !== '' && !cache.has(path))
  if (missing.length === 0) return
  try {
    const loaded = await loadImages(missing)
    for (const item of loaded) {
      if (item.image === undefined) {
        logger.warn('图片附件读取失败，本轮按未读取处理', { path: item.path })
        continue
      }
      cache.set(item.path, item.image)
    }
  } catch (error) {
    logger.warn('图片附件读取失败，本轮按未读取处理', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
