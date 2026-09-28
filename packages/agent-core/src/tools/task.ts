/**
 * `task` 子代理工具（docs/06 §19）。
 *
 * 派生一个**独立上下文**的子代理执行调研 / 排查 / 整理类多步子任务：
 * - 子代理复用同一个 Agent 循环（`loop/agentLoop.ts`），最终文本报告作为工具结果回传主代理；
 * - 工具表从父表过滤：默认拿不到 confirm 敏感工具、不能递归派生 task、碰不到 MCP 工具
 *   （MCP 工具全是 confirm，前缀判断是双保险）；
 *   只读档下装配层可再注入一份工具名白名单（`subagentToolNames`），作为**交集**叠加；
 * - **`permission: 'write'`（2026-09 新增）**：主代理可显式授予子代理**文件写**能力
 *   （`write_file` / `edit_file`，见 `SUBAGENT_WRITE_TOOLS`）—— 前提是装配层注入了
 *   父会话的确认回调（`confirmTool`），写操作因此仍走**同一条**确认链
 *   （根内按当前档位机器放行、根外弹卡），**不是**新的绕过通道；未注入时本次按只读执行
 *   并在结果里说明。`run_command` / MCP / 递归派生**永远**拿不到（不在写入白名单里）；
 * - 会话**不落盘**（内存收集器），sessionId 加 `-sub` 后缀，
 *   因此 todo 等按会话隔离的端口天然落在独立清单上，与主对话互不干扰。
 *
 * 安全取舍：`sensitivity: 'safe'` —— 子代理会消耗模型调用，但它是 Agent 核心能力，
 * 默认只能使用查询与只读类工具（敏感操作在过滤这一层就被挡住），不做逐次确认；
 * 显式授予 `write` 时，写操作自身的确认由内核既有链路逐次把关。
 */
import type {
  AgentToolCall,
  Logger,
  SubagentSnapshot,
  SubagentStep,
  SubagentTranscriptMessage,
  SubagentTranscriptToolCall,
} from '@aurora/shared'
import { buildSystemPrompt, describeTools } from '../context/systemPrompt.js'
import { DEFAULT_MAX_ROUNDS, runAgentLoop } from '../loop/agentLoop.js'
import type { ConfirmDecision } from '../loop/agentLoop.js'
import type { AgentProviderFactory } from '../host/agentHost.js'
import type { NewMessage, StoredMessage, StoredToolCall } from '../session/types.js'
import { ToolRegistry } from './registry.js'
import type { ToolDefinition, ToolProgress, ToolResult } from './registry.js'
import { ASK_USER_TOOL_NAME } from './ask-user.js'

export const TASK_TOOL_NAME = 'task'
/** 回传给主代理的报告长度上限：超过从尾部截断（防子代理结果刷爆主对话上下文） */
export const MAX_TASK_RESULT_CHARS = 20_000
/** 子代理会话 id 后缀：todo 等按会话隔离的端口据此与主对话分清单 */
export const SUBAGENT_SESSION_SUFFIX = '-sub'
/** 快照里保留的步骤上限（超出丢弃最早的中间步骤，保留首步与最近若干步） */
export const MAX_SUBAGENT_STEPS = 60
/** 单个步骤文本上限（快照只用于展示） */
const MAX_STEP_CHARS = 4_000
/** 步骤里工具入参的展示上限（只用于「它拿什么参数做了什么」这一眼） */
const MAX_STEP_ARGS_CHARS = 300

/**
 * 子代理被授予 `write` 时**额外**可用的工具名（白名单制，不按 sensitivity 通配）。
 *
 * 刻意只放文件写：`run_command` 的能力面（任意命令）远超"写几个文件"，
 * 而它一旦进了子表，子代理就能在无人细看的情况下改环境；需要跑命令的场景
 * 请回主对话做，那里的确认链有完整的项目根与免确认模式口径。
 */
export const SUBAGENT_WRITE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file'])

// ───────────────────────── 独立对话视图的投影上限 ─────────────────────────

/** 对话记录条数上限：超出保留开头与结尾，中间省略（由 `transcriptTruncated` 告知界面） */
export const MAX_TRANSCRIPT_MESSAGES = 40
/** 单条正文上限 */
const MAX_TRANSCRIPT_TEXT_CHARS = 2_000
/** 单次工具结果正文上限 */
const MAX_TRANSCRIPT_TOOL_CHARS = 1_200
/** 单次工具入参上限 */
const MAX_TRANSCRIPT_ARGS_CHARS = 400

/** 子代理权限档：`read` = 只读（默认，等价于历史行为）；`write` = 额外授予文件写 */
export type TaskPermission = 'read' | 'write'

/** 子代理人设（docs/06 §19）：主代理派生、上下文隔离、对用户不可见、
 * 只以最终文本报告结果、无法完成的部分如实说明。 */
export const SUBAGENT_PERSONA = [
  '你是 Aurora 主代理派生的子代理，独立完成主代理交给你的一个子任务。',
  '你看不到主对话的任何上下文，任务所需信息都在指令里；你的对话过程对用户不可见，',
  '因此不要向用户提问、也不要把结论留到"下一轮"——一次跑完并给出报告。',
  '完成后以最终文本报告结果，这段报告会作为工具结果回传给主代理，请直接给出结论与依据。',
  '无法完成的部分如实说明，不要编造。',
].join('\n')

export interface TaskToolOptions {
  /** 复用装配层的 provider 工厂（每次派生即时构造，保证设置改动立即生效） */
  provider: AgentProviderFactory
  /** 父工具表：内部过滤出子代理可用工具 */
  tools: ToolRegistry
  /** 子代理轮次上限，缺省 `DEFAULT_MAX_ROUNDS` */
  maxRounds?: number
  logger?: Logger
  /**
   * 只读档下由装配层传入「子代理可见的工具名白名单」；未注入 = 不过滤（保持今天的行为）。
   *
   * 语义是**交集**：注入时子代理只拿到这些名字的工具，原有的三道过滤
   * （confirm 敏感工具 / `task` 自身 / `mcp.*`）继续生效 —— 白名单只做减法，
   * 不可能因为装配层写错而让子代理多拿到一个工具。
   *
   * 为什么做成钩子而不是在这里判档位：三档权限的解析在 `apps/desktop/src/main`
   * （`resolvePermissionMode`），内核不认识 `settings`，也不该认识"只读档"这个词；
   * 钩子抛错时整次派生直接失败（`isError`），**不做静默放行**——
   * 拿不到白名单就等于不知道子代理能用什么，此时放行比失败危险得多。
   */
  subagentToolNames?: () => readonly string[]
  /**
   * 父会话的敏感工具确认回调（装配层注入，2026-09）。
   *
   * **只有它存在时 `permission: 'write'` 才生效**：写入类工具（`write_file` / `edit_file`）
   * 一律经这条回调逐次判定，判定口径与主对话完全一致（档位 / 项目根 / 免确认模式都在
   * `createConfirmTool` 里，内核不重复实现）。未注入 = 本次派生一律只读。
   *
   * `sessionId` 由本文件填**父会话**的 id（不是循环看到的 `-sub`）：子代理会话在会话库里
   * 不存在，按它解析项目根会落到另一套边界上（`session-project.ts` 的回落链），那等于换了一条护栏。
   */
  confirmTool?: (info: {
    name: string
    input: unknown
    sensitivity: 'confirm'
    sessionId: string
  }) => Promise<ConfirmDecision>
}

export function createTaskTool(options: TaskToolOptions): ToolDefinition {
  return {
    name: TASK_TOOL_NAME,
    description:
      '派生一个子代理独立完成调研、排查、整理类的多步子任务。' +
      '子代理拥有独立上下文（看不到当前对话），默认只能使用查询与只读类工具；' +
      '需要它改文件时把 `permission` 设为 `write`（此时它还能用 write_file / edit_file，' +
      '每次写入仍会按当前权限档确认）。子代理不能执行命令、不能访问 MCP、不能再派生子代理。' +
      '`prompt` 必须自包含：写清目标、背景、约束与期望返回的内容。' +
      '适合需要大量读取后汇总、或避免占用当前对话上下文预算的任务。',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: '任务简述（3–8 字，用于卡片摘要与日志）' },
        prompt: {
          type: 'string',
          description: '完整任务指令（自包含：目标、背景、约束与期望返回的内容）',
        },
        permission: {
          type: 'string',
          enum: ['read', 'write'],
          description:
            '授予子代理的权限：read（默认，只读查询类工具）/ write（额外允许 write_file 与 edit_file 改文件，写入仍受当前权限档与项目根边界约束）。',
        },
      },
      required: ['description', 'prompt'],
      additionalProperties: false,
    },
    sensitivity: 'safe',
    execute: async (input, ctx): Promise<ToolResult> => {
      const record = asRecord(input)
      const description = readNonEmptyString(record, 'description')
      const prompt = readNonEmptyString(record, 'prompt')
      if (description === undefined || prompt === undefined) {
        const missing = [
          description === undefined ? 'description（任务简述）' : undefined,
          prompt === undefined ? 'prompt（完整任务指令）' : undefined,
        ].filter((part) => part !== undefined)
        return {
          content: `缺少参数：${missing.join('、')}。`,
          isError: true,
          summary: '子代理参数缺失',
        }
      }
      const permission = readPermission(record)
      if (permission === undefined) {
        return {
          content: '参数 permission 只能是 read 或 write。',
          isError: true,
          summary: '子代理参数非法',
        }
      }
      try {
        return await runSubagent(options, {
          description,
          prompt,
          permission,
          sessionId: ctx.sessionId,
          ...(ctx.toolCallId === undefined ? {} : { toolCallId: ctx.toolCallId }),
          ...(ctx.emitProgress === undefined ? {} : { emitProgress: ctx.emitProgress }),
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        })
      } catch (error) {
        // 工具循环约定：execute 不允许抛异常冒泡，内部意外一律转 isError
        return {
          content: `子代理执行异常：${describeError(error)}`,
          isError: true,
          summary: '子代理执行异常',
        }
      }
    },
  }
}

// ───────────────────────── 内部 ─────────────────────────

interface SubagentRequest {
  description: string
  prompt: string
  permission: TaskPermission
  sessionId: string
  toolCallId?: string
  emitProgress?(payload: ToolProgress): void
  signal?: AbortSignal
}

async function runSubagent(
  options: TaskToolOptions,
  request: SubagentRequest,
): Promise<ToolResult> {
  const config = options.provider.create()
  if (config === undefined) {
    return {
      content: '还没有可用的 AI 模型配置，无法派生子代理。',
      isError: true,
      summary: '没有可用模型',
    }
  }

  // 写入授权：需要装配层注入了父会话的确认回调才算数（没注入时连"能不能写"都无从判定，
  // 一律降级为只读，并把降级事实写进结果 —— 静默降级会让主代理误以为文件已经改好了）。
  const confirmForSubagent = options.confirmTool
  const writeGranted = request.permission === 'write' && confirmForSubagent !== undefined

  // 子工具表：从父表过滤出子代理可用的工具。
  // 默认拿不到敏感工具（confirm）、不能递归派生（task 自身）、碰不到 MCP 工具；
  // 授予 write 时放开**文件写白名单**（仍受白名单交集与确认链约束）。
  // 只读档下装配层再叠一层白名单（`subagentToolNames`）：白名单只做减法，未注入即不过滤。
  const allowedNames =
    options.subagentToolNames === undefined ? undefined : new Set(options.subagentToolNames())
  const subTools = new ToolRegistry()
  for (const tool of options.tools.list()) {
    if (tool.name === TASK_TOOL_NAME) continue
    // 子代理**不向用户提问**（人设里也写明了）：`ask_user` 是 `safe` 级，不挡住的话
    // 一个后台子代理会弹卡片打断用户，而它自己又看不到回答之外的上下文 ——
    // 澄清需求是主代理的职责，子代理只负责把派下来的活干完。
    if (tool.name === ASK_USER_TOOL_NAME) continue
    if (tool.name.startsWith('mcp.')) continue
    const writable = writeGranted && SUBAGENT_WRITE_TOOLS.has(tool.name)
    if (tool.sensitivity === 'confirm' && !writable) continue
    if (allowedNames !== undefined && !allowedNames.has(tool.name)) continue
    subTools.register(tool)
  }
  const grantedTools = subTools.list().map((tool) => tool.name)

  // 内存会话收集器（不落盘）：子代理的对话过程只存在于本次调用的闭包里
  const collected: StoredMessage[] = []
  let sequence = 0
  const append = async (message: NewMessage): Promise<StoredMessage> => {
    sequence += 1
    const stored: StoredMessage = {
      // 循环预领的 id 优先（`NewMessage.id`，见 docs/06 §16.2）：子代理的 text / reasoning 增量
      // 事件带的是**预领的那个 id**，落盘若另发一个 `sub-N`，同一轮就会出现两个 id —— 今天不炸
      // 只是因为子代理不把这些事件的 messageId 往外发，但这属于「将来一转发就写错消息」的雷。
      id: message.id ?? `sub-${sequence}`,
      role: message.role,
      content: message.content,
      createdAt: new Date().toISOString(),
      ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls }),
      ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
      ...(message.reasoning === undefined ? {} : { reasoning: message.reasoning }),
    }
    collected.push(stored)
    return stored
  }
  const updateToolCall = async (messageId: string, call: StoredToolCall): Promise<void> => {
    const target = collected.find((message) => message.id === messageId)
    const calls = target?.toolCalls
    if (calls === undefined) return
    const index = calls.findIndex((item) => item.id === call.id)
    if (index >= 0) calls[index] = call // 原地替换，保持收集器内状态与循环同步
  }

  const subSessionId = `${request.sessionId}${SUBAGENT_SESSION_SUFFIX}`
  const catalog = describeTools(subTools.list())

  const events = runAgentLoop({
    provider: config.provider,
    model: config.model,
    ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
    ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    systemPrompt: buildSystemPrompt({
      persona: SUBAGENT_PERSONA,
      ...(catalog === undefined ? {} : { toolCatalog: catalog }),
    }),
    userInput: request.prompt,
    history: [],
    tools: subTools,
    sessionId: subSessionId,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    maxRounds: options.maxRounds ?? DEFAULT_MAX_ROUNDS,
    append,
    updateToolCall,
    onToolCall: (info) => options.logger?.info('子代理工具调用', info),
    // 写入授权下把父会话的确认链交进子循环：循环只在 `sensitivity === 'confirm'` 时调用它，
    // 因此这一句的效果是「子代理的写操作与主对话走同一条判定」（档位 / 项目根 / 免确认模式）。
    // 会话 id **钉回父会话**：`-sub` 在会话库里不存在，按它解析项目根会换一条护栏。
    ...(writeGranted && confirmForSubagent !== undefined
      ? {
          confirmTool: (info: { name: string; input: unknown; sensitivity: 'confirm' }) =>
            confirmForSubagent({ ...info, sessionId: request.sessionId }),
        }
      : {}),
  })

  // 运行快照（docs/06 §19）：子代理的过程不落盘，这份快照是它唯一的对外可见形态。
  // 内存里随事件流实时推给渲染层（「子代理」页面），结束时随工具卡一起持久化。
  const startedAt = Date.now()
  const taskId = `sub-${startedAt.toString(36)}-${(taskSequence += 1)}`
  const callId = request.toolCallId ?? ''
  const steps: SubagentStep[] = []
  let stepSequence = 0
  let report = ''
  let firstError: string | undefined
  let pending = false
  let status: SubagentSnapshot['status'] = 'running'

  /** 组一份快照；`endedAt` 只在收尾时给（运行中不给，页面据此显示已运行时长） */
  const snapshot = (endedAt?: number): SubagentSnapshot => {
    const transcript = projectTranscript(collected)
    return {
      taskId,
      callId,
      description: request.description,
      prompt: request.prompt,
      status,
      startedAt,
      ...(endedAt === undefined ? {} : { endedAt }),
      steps: steps.map((step) => ({ ...step })),
      toolCalls: steps.filter((step) => step.kind === 'tool').length,
      ...(report === '' ? {} : { report: truncateReport(report, MAX_TASK_RESULT_CHARS) }),
      // 本次授予的权限与**实际**拿到的工具（不是请求的权限：降级时要看得出来）
      permission: writeGranted ? ('write' as const) : ('read' as const),
      tools: [...grantedTools],
      messages: transcript.messages,
      ...(transcript.truncated ? { transcriptTruncated: true } : {}),
    }
  }
  const publish = (endedAt?: number): void => {
    request.emitProgress?.({ kind: 'subagent', snapshot: snapshot(endedAt) })
  }
  // 立刻推一份「已开始」的空快照：页面上卡片要在派生的瞬间就出现，而不是等第一个事件
  publish()

  // 遍历循环事件：文本 delta 累积成最终报告；工具调用落成步骤；首个 error 留痕
  for await (const event of events) {
    if (event.type === 'text') {
      report += event.delta
      // 连续的正文增量**合并成一段**：早先每个 delta 各成一步，时间线上是一堆半句，
      // 读起来像卡带（「思考/工具展示不够优雅」的原始症状之一）。
      const last = steps[steps.length - 1]
      if (last !== undefined && last.kind === 'text') {
        last.text = truncateReport(`${last.text ?? ''}${event.delta}`, MAX_STEP_CHARS)
      } else {
        steps.push({
          id: `s${(stepSequence += 1)}`,
          kind: 'text',
          text: truncateReport(event.delta, MAX_STEP_CHARS),
        })
      }
      pruneSteps(steps)
      publish()
      continue
    }
    if (event.type === 'error') {
      firstError ??= event.message
      continue
    }
    if (event.type === 'done') {
      pending = event.pending === true
      continue
    }
    if (event.type === 'tool') {
      upsertToolStep(steps, event.call, `s${(stepSequence += 1)}`)
      pruneSteps(steps)
      publish()
    }
  }

  // 结果组装：报告为主；异常路径转 isError；截断与附注按口径追加
  let content: string
  let isError: boolean | undefined
  if (report !== '') {
    content = truncateReport(report, MAX_TASK_RESULT_CHARS, '…（子代理结果过长，已截断）')
    if (firstError !== undefined) {
      content += `\n\n（子代理执行中出现过一次错误：${firstError}）`
    }
  } else if (firstError !== undefined) {
    content = `子代理执行失败：${firstError}`
    isError = true
  } else {
    content = '（子代理没有返回文本结果，请调整任务指令后重试。）'
  }
  if (pending) {
    content += '\n\n（子代理已到轮次上限，以上为部分结果。）'
  }
  // 请求了 write 但没有确认链可交接：如实说明降级（否则主代理会以为文件已经改好了）
  if (request.permission === 'write' && !writeGranted) {
    content += '\n\n（装配层未接入确认链，本次已按只读执行：子代理没有写入类工具。）'
  }

  status = isError === true ? 'error' : 'success'
  const endedAt = Date.now()
  publish(endedAt)

  options.logger?.info('子代理任务完成', {
    description: request.description,
    permission: writeGranted ? 'write' : 'read',
    tools: grantedTools.length,
    toolCalls: steps.filter((step) => step.kind === 'tool').length,
    reportChars: report.length,
    elapsedMs: endedAt - startedAt,
  })

  return {
    content,
    ...(isError === undefined ? {} : { isError }),
    summary: `子代理：${request.description}`,
    subagent: snapshot(endedAt),
  }
}

/** 子代理任务序号（同进程内保证 taskId 唯一；仅用于日志与页面展示） */
let taskSequence = 0

/**
 * 工具事件 → 步骤：同一个 `call.id` 先 `running` 后终态，
 * 因此按 id 原地更新而不是重复追加（否则工具卡会在子代理页面上出现两遍）。
 */
function upsertToolStep(steps: SubagentStep[], call: AgentToolCall, fallbackId: string): void {
  const existing = steps.find((step) => step.kind === 'tool' && step.id === call.id)
  const args = compactArgs(call.input)
  const next: SubagentStep = {
    id: call.id === '' ? fallbackId : call.id,
    kind: 'tool',
    name: call.name,
    state: call.state,
    ...(call.outputSummary === undefined ? {} : { summary: call.outputSummary }),
    ...(args === undefined ? {} : { args }),
  }
  if (existing === undefined) {
    steps.push(next)
    return
  }
  Object.assign(existing, next)
}

/** 工具入参 → 单行紧凑文本（`JSON.stringify` 失败时给 undefined，绝不因展示把工具搞挂） */
function compactArgs(input: unknown, max = MAX_STEP_ARGS_CHARS): string | undefined {
  if (input === undefined) return undefined
  try {
    const text = typeof input === 'string' ? input : JSON.stringify(input)
    if (text === undefined) return undefined
    return truncateReport(text, max, '…')
  } catch {
    return undefined
  }
}

/** 步骤上限：超出时丢弃最早的中间步骤（保留首步与最近的部分，进度感不丢） */
function pruneSteps(steps: SubagentStep[]): void {
  while (steps.length > MAX_SUBAGENT_STEPS) steps.splice(1, 1)
}

function truncateReport(text: string, max: number, suffix = '…（已截断）'): string {
  return text.length <= max ? text : `${text.slice(0, max)}${suffix}`
}

/**
 * 内存消息收集器 → 独立对话视图的投影（docs/06 §19）。
 *
 * 两步：
 * 1. 逐条投影（`user` / `assistant` + 它的工具调用；工具结果**回填**到发起它的那次调用上，
 *    与主对话工具卡的信息组织一致 —— 结果的正文在主对话里是看不到的，这里才看得到）；
 * 2. 限流：条数超上限时**保留开头与结尾**（开头是任务、结尾是结论），中间省略，
 *    并由 `truncated` 让界面如实标出「中间已省略」而不是假装完整。
 */
function projectTranscript(messages: StoredMessage[]): {
  messages: SubagentTranscriptMessage[]
  truncated: boolean
} {
  const out: SubagentTranscriptMessage[] = []
  const calls = new Map<string, SubagentTranscriptToolCall>()
  for (const message of messages) {
    if (message.role === 'user') {
      out.push({
        id: message.id,
        role: 'user',
        text: truncateReport(message.content, MAX_TRANSCRIPT_TEXT_CHARS),
      })
      continue
    }
    if (message.role === 'assistant') {
      const toolCalls = (message.toolCalls ?? []).map((call) => {
        const args = compactArgs(call.arguments, MAX_TRANSCRIPT_ARGS_CHARS)
        const item: SubagentTranscriptToolCall = {
          id: call.id,
          name: call.name,
          state: call.state,
          ...(args === undefined ? {} : { args }),
          ...(call.outputSummary === undefined ? {} : { summary: call.outputSummary }),
        }
        calls.set(call.id, item)
        return item
      })
      out.push({
        id: message.id,
        role: 'assistant',
        ...(message.content === ''
          ? {}
          : { text: truncateReport(message.content, MAX_TRANSCRIPT_TEXT_CHARS) }),
        ...(toolCalls.length === 0 ? {} : { toolCalls }),
      })
      continue
    }
    // `role: 'tool'`：结果正文回填到发起它的那次调用（找不到就丢弃 —— 只影响展示）
    const target = message.toolCallId === undefined ? undefined : calls.get(message.toolCallId)
    if (target !== undefined) {
      target.output = truncateReport(message.content, MAX_TRANSCRIPT_TOOL_CHARS)
    }
  }

  if (out.length <= MAX_TRANSCRIPT_MESSAGES) return { messages: out, truncated: false }
  // 首 2 条（任务指令 + 第一轮）与尾部消息保留，中间省略
  const head = out.slice(0, 2)
  const tail = out.slice(out.length - (MAX_TRANSCRIPT_MESSAGES - 2))
  return { messages: [...head, ...tail], truncated: true }
}

/** 权限参数：未给按只读；给了就必须是合法取值（非法一律回错，不做"猜一个"） */
function readPermission(record: Record<string, unknown> | undefined): TaskPermission | undefined {
  const value = record?.['permission']
  if (value === undefined || value === null || value === '') return 'read'
  return value === 'read' || value === 'write' ? value : undefined
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  return input as Record<string, unknown>
}

/** 必填字符串：非字符串或纯空白一律视为缺参 */
function readNonEmptyString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
