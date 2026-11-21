/**
 * `task` 子代理工具（docs/06 §19）。
 *
 * 派生一个**独立上下文**的子代理执行调研 / 排查 / 整理 / 实现类多步子任务：
 * - 子代理复用同一个 Agent 循环（`loop/agentLoop.ts`），最终文本报告作为工具结果回传主代理；
 * - 工具表从父表过滤：默认拿不到 confirm 敏感工具、不能递归派生 task、碰不到 MCP 工具
 *   （MCP 工具全是 confirm，前缀判断是双保险）；
 *   只读档下装配层可再注入一份工具名白名单（`subagentToolNames`），作为**交集**叠加；
 * - **三档工具权限（v46，docs/06 §19.6）**：`read`（默认）/ `write`（+ `write_file` /
 *   `edit_file`）/ `execute`（再 + `run_command`）。授予写 / 执行时，这些 confirm 级工具
 *   仍经**父会话的确认回调**逐次判定（根内按当前档位机器放行、根外弹卡），**不是**新的
 *   绕过通道；未注入回调 / 父表没提供工具时按只读执行并在结果里说明。MCP / 递归派生
 *   永远拿不到；
 * - **子代理定义（v46）**：装配层传入 `profiles`（用户在设置页配置的 Searcher / Coder /
 *   自定义代理），工具描述里列出名册，主代理用 `agent` 参数按「什么时候用谁」选型；
 *   可选 `model` 让某个子代理固定用自己的模型（装配层解析，失效时回落会话 / 全局）；
 * - 会话**不落盘**（内存收集器），sessionId 加 `-sub` 后缀，
 *   因此 todo 等按会话隔离的端口天然落在独立清单上，与主对话互不干扰。
 *
 * 安全取舍：`sensitivity: 'safe'` —— 子代理会消耗模型调用，但它是 Agent 核心能力，
 * 默认只能使用查询与只读类工具（敏感操作在过滤这一层就被挡住），不做逐次确认；
 * 显式授予写 / 执行时，这些操作自身的确认由内核既有链路逐次把关。
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
import { SUBAGENT_MAX_ROUNDS, runAgentLoop } from '../loop/agentLoop.js'
import type { ConfirmDecision } from '../loop/agentLoop.js'
import type { AgentProviderFactory, ProviderModelTarget } from '../host/agentHost.js'
import type { NewMessage, StoredMessage, StoredToolCall } from '../session/types.js'
import { ToolRegistry } from './registry.js'
import type { ToolDefinition, ToolProgress, ToolResult } from './registry.js'
import { ASK_USER_TOOL_NAME } from './ask-user.js'
import { SUBMIT_PLAN_TOOL_NAME } from './submit-plan.js'
import { createSubagentLimiter } from './subagent-limiter.js'
import type { SubagentLimiter, SubagentSlotRelease } from './subagent-limiter.js'

export const TASK_TOOL_NAME = 'task'
/** 回传给主代理的报告长度上限：超过从尾部截断（防子代理结果刷爆主对话上下文） */
export const MAX_TASK_RESULT_CHARS = 20_000
/** 子代理会话 id 后缀：todo 等按会话隔离的端口据此与主对话分清单 */
export const SUBAGENT_SESSION_SUFFIX = '-sub'

/**
 * 子代理的工具权限档（v46，docs/06 §19.6）：与配置面的 `agent.subagents[].access` 同值域。
 * 内核只认这个枚举，不认识"设置页 / config"这些词（与权限档同一分层口径）。
 */
export const SUBAGENT_ACCESS_LEVELS = ['read', 'write', 'execute'] as const
export type SubagentAccess = (typeof SUBAGENT_ACCESS_LEVELS)[number]

/**
 * 一个可派发的子代理定义（装配层从 `agent.subagents` 过滤后传入）。
 *
 * 刻意是内核本地形状而不是配置类型：内核不该依赖 config schema 的字段命名，
 * 装配层负责把"用户配置"翻译成"内核名册"（与 RunProfile / 权限档同一分工）。
 */
export interface SubagentProfile {
  id: string
  /** 展示名（报告摘要 / 快照 / 卡片徽章） */
  name: string
  /** 什么时候用它：原样进入 task 工具描述，主代理据此选型 */
  description: string
  /** 子代理的系统提示词（角色 / 工作方式 / 输出要求）；公共约束由内核追加 */
  instructions: string
  access: SubagentAccess
  /** 固定模型；缺省 = 跟随会话 / 全局档 */
  model?: ProviderModelTarget
}

/**
 * 进程级子代理限流器（docs/06 §19.5）：按**父会话**限制并发、写子代理串行。
 *
 * 刻意放在模块级而不是 `createTaskTool` 里：装配层每次 `settings:changed` 都会重建工具表，
 * 若限流器跟着工具实例走，旧实例里还在跑的子代理与新实例就各有一份额度，
 * 同一会话实际并发会超过 `SUBAGENT_MAX_PARALLEL`。
 */
const subagentLimiter = createSubagentLimiter()

/**
 * 子代理会话 id → 父会话 id：剥掉末尾的 `-sub` 后缀（幂等；无后缀原样返回）。
 *
 * 子代理的工具循环带着 `-sub` id 跑（todo 清单等**状态隔离**依赖它，docs/06 §19），
 * 但「按会话解析工作目录 / 边界根」的工具 deps 需要的是**父会话** id —— 否则 `-sub`
 * 在会话库查不到绑定，缺省 cwd / 搜索根 / 边界会恒落 Agent 空间（确认链同款问题，
 * 那边在 task.ts 里钉回父会话，工作目录这半边由装配层用本函数解决）。
 * 裸 `-sub`（剥完为空串）不是合法会话 id，原样返回。
 */
export function parentSessionIdOf(sessionId: string): string {
  if (
    sessionId.length > SUBAGENT_SESSION_SUFFIX.length &&
    sessionId.endsWith(SUBAGENT_SESSION_SUFFIX)
  ) {
    return sessionId.slice(0, sessionId.length - SUBAGENT_SESSION_SUFFIX.length)
  }
  return sessionId
}
/** 快照里保留的步骤上限（超出丢弃最早的中间步骤，保留首步与最近若干步） */
export const MAX_SUBAGENT_STEPS = 60
/** 单个步骤文本上限（快照只用于展示） */
const MAX_STEP_CHARS = 4_000
/** 步骤里工具入参的展示上限（只用于「它拿什么参数做了什么」这一眼） */
const MAX_STEP_ARGS_CHARS = 300

/**
 * 子代理被授予 `write`（含 `execute`）时**额外**可用的文件写工具（白名单制，不按 sensitivity 通配）。
 */
export const SUBAGENT_WRITE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file'])

/**
 * 子代理被授予 `execute` 时**额外**可用的命令工具（v46，docs/06 §19.6）。
 *
 * 只放 `run_command` 这一个名字，不是"按 sensitivity 通配"：命令的能力面（任意命令）
 * 是这三档里最大的，因此它需要用户显式把某个子代理配成 `execute` 才会出现在子表里，
 * 而且与写工具一样经父会话确认链逐次判定。MCP 工具**永远**不在任何档位里。
 */
export const SUBAGENT_EXECUTE_TOOLS: ReadonlySet<string> = new Set(['run_command'])

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
  /**
   * 装配层传入的**子代理名册**（v46，docs/06 §19.6）：只有启用中的定义。
   *
   * 缺省 `[]` = 没有具名子代理：工具描述回落成"通用只读子代理"，`agent` 参数不出现，
   * 行为与 v46 之前逐字一致（单测 / 旧装配直接复用这条路径）。
   */
  profiles?: readonly SubagentProfile[]
  /** 子代理轮次上限，缺省 `SUBAGENT_MAX_ROUNDS`（不跟主循环的防失控墙共用，见 §19） */
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
  /**
   * 并发限流器（docs/06 §19.5）。缺省用进程级单例 —— 装配层每次 `settings:changed`
   * 都会重建工具表，限流额度不能跟着工具实例走，否则同一会话会多出一份额度。
   * 单测可注入独立实例，避免用例之间通过模块级状态互相影响。
   */
  limiter?: SubagentLimiter
}

export function createTaskTool(options: TaskToolOptions): ToolDefinition {
  const profiles = options.profiles ?? []
  return {
    name: TASK_TOOL_NAME,
    description: describeTaskTool(profiles),
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: '任务简述（3–8 字，用于卡片摘要与日志）' },
        prompt: {
          type: 'string',
          description: '完整任务指令（自包含：目标、背景、约束与期望返回的内容）',
        },
        // 名册为空时不渲染 `agent` 参数：模型看不到用不了的东西就不会先承诺再报错。
        ...(profiles.length === 0
          ? {}
          : {
              agent: {
                type: 'string',
                enum: profiles.map((profile) => profile.id),
                description:
                  '子代理 id（见描述中的可用子代理；传名称也认）。不传 = 通用只读子代理。' +
                  '传了之后权限档由该子代理的配置决定，permission 参数被忽略。',
              },
            }),
        permission: {
          type: 'string',
          enum: ['read', 'write'],
          description:
            '授予**通用**子代理的权限：read（默认，只读查询类工具）/ write（额外允许 write_file 与 edit_file 改文件，写入仍受当前权限档与项目根边界约束）。指定 agent 时本参数被忽略。',
        },
      },
      required: ['description', 'prompt'],
      additionalProperties: false,
    },
    sensitivity: 'safe',
    // 同轮多个 task 可以并发起跑（docs/06 §5 / §19.5）：真正的同时执行数由模块级限流器
    // 按父会话压到 SUBAGENT_MAX_PARALLEL，写入 / 执行类子代理再串行；这里只声明"可入并发批"。
    parallel: true,
    // 子代理**不按墙钟中止**（docs/06 §5 的工具执行上限）：它的上限是轮次与取消 ——
    // 一次 32 轮的调研本就可能跑过默认 10 分钟，按时间砍它会误杀正常长任务，
    // 而那正是本节要避免的「把设计内的慢当成挂起」。
    timeoutMs: 0,
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
      const agentInput = readNonEmptyString(record, 'agent')
      const profile = agentInput === undefined ? undefined : resolveProfile(profiles, agentInput)
      if (agentInput !== undefined && profile === undefined) {
        // 不静默回落通用子代理：派错人比报错更难发现（报告看着正常，活儿没干）。
        const available =
          profiles.length === 0
            ? '当前没有可用的子代理定义，请去掉 agent 参数改用通用只读子代理。'
            : `可用：${profiles.map((item) => `${item.id}（${item.name}）`).join('、')}。`
        return {
          content: `没有 id 或名称为「${agentInput}」的启用中子代理。${available}`,
          isError: true,
          summary: '子代理不存在',
        }
      }
      // 指定了子代理时权限由配置决定，permission 参数忽略（不因旧参数报错）；
      // 未指定时沿用历史的通用子代理语义，参数照旧校验。
      const permission = profile === undefined ? readPermission(record) : 'read'
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
          ...(profile === undefined ? {} : { profile }),
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

/** 权限档 → 名册里的一句话（与设置页文案同义，不共用常量 —— 内核不认识 renderer） */
const ACCESS_HINT: Record<SubagentAccess, string> = {
  read: '只读',
  write: '可写文件',
  execute: '可写文件并执行命令',
}

/** task 工具描述：基础语义 + （有名册时）可派发的子代理清单 */
function describeTaskTool(profiles: readonly SubagentProfile[]): string {
  const base =
    '派生一个或多个子代理独立完成调研、排查、整理或实现类的多步子任务。' +
    '子代理拥有独立上下文（看不到当前对话），默认只能使用查询与只读类工具；' +
    '需要它改文件 / 执行命令时，选一个可写或可执行档的子代理（写入与命令仍按当前权限档确认）。' +
    '子代理不能访问 MCP、不能再派生子代理。' +
    '相互独立的任务可以在同一轮里发多个 `task`：它们会并发执行（同一会话最多 3 个同时跑，' +
    '超出的排队；写文件 / 执行命令的子代理串行）。' +
    '`prompt` 必须自包含：写清目标、背景、约束与期望返回的内容。' +
    '适合需要大量读取后汇总、或避免占用当前对话上下文预算的任务。'
  if (profiles.length === 0) return base
  const roster = profiles
    .map(
      (profile) =>
        `- ${profile.id}（${profile.name}，${ACCESS_HINT[profile.access]}）：` +
        truncateReport(profile.description, MAX_ROSTER_DESCRIPTION_CHARS),
    )
    .join('\n')
  return `${base}\n\n可用子代理（用 agent 参数指定；不传 = 通用只读子代理）：\n${roster}`
}

/** 名册里单条用途说明的展示上限：20 个子代理 × 200 字会白占工具面预算 */
const MAX_ROSTER_DESCRIPTION_CHARS = 120

/**
 * 按 id（大小写不敏感）解析子代理；没有命中再按名称兜底（模型偶尔会把 `Searcher` 当 id）。
 * 先 id 后名称：id 是稳定标识，名称是给人看的（可改、可重名由 Schema 挡不住，但 id 唯一）。
 */
function resolveProfile(
  profiles: readonly SubagentProfile[],
  raw: string,
): SubagentProfile | undefined {
  const key = raw.trim().toLowerCase()
  if (key === '') return undefined
  return (
    profiles.find((profile) => profile.id.toLowerCase() === key) ??
    profiles.find((profile) => profile.name.trim().toLowerCase() === key)
  )
}

// ───────────────────────── 内部 ─────────────────────────

interface SubagentRequest {
  description: string
  prompt: string
  permission: TaskPermission
  /** 具名子代理定义（v46）；缺省 = 通用只读 / 可写子代理（历史路径） */
  profile?: SubagentProfile
  sessionId: string
  toolCallId?: string
  emitProgress?(payload: ToolProgress): void
  signal?: AbortSignal
}

async function runSubagent(
  options: TaskToolOptions,
  request: SubagentRequest,
): Promise<ToolResult> {
  // 模型解析（docs/06 §3 / §19.6）：显式目标（子代理配置的模型）> 会话级覆盖 > 全局档。
  // 传的仍是**父会话** id —— 未指定模型的子代理因此继承父会话的模型覆盖（与 v46 之前一致）。
  const requestedModel = request.profile?.model
  const config = options.provider.create({
    sessionId: request.sessionId,
    ...(requestedModel === undefined ? {} : { model: requestedModel }),
  })
  if (config === undefined) {
    return {
      content: '还没有可用的 AI 模型配置，无法派生子代理。',
      isError: true,
      summary: '没有可用模型',
    }
  }
  const actualModel: ProviderModelTarget = {
    providerId: config.provider.id,
    model: config.model,
  }
  // 配置的模型不可用（provider 已删 / 未配 Key / 官方模型下线）时装配层会回落会话 / 全局档；
  // 这里比对实际模型，把"回退了"如实写进结果与快照 —— 静默换模型等于让用户以为选错了模型。
  const modelFallback =
    requestedModel !== undefined &&
    (actualModel.providerId !== requestedModel.providerId ||
      actualModel.model !== requestedModel.model)

  // 工具授权分两层（docs/06 §19.2 / §19.6）：
  // ① 子代理档位 > read 时，装配层必须注入父会话确认回调（没注入时连"能不能写"都无从判定）；
  // ② 子表里**真的**有写 / 命令工具（只读档父表根本不注册它们，白名单也可能把它滤掉）。
  // 只看 ① 会让快照写着「可读写」却一个写工具都没有 —— 那是说假话。
  const confirmForSubagent = options.confirmTool
  const requestedAccess: SubagentAccess =
    request.profile?.access ?? (request.permission === 'write' ? 'write' : 'read')
  const allowMutate = requestedAccess !== 'read' && confirmForSubagent !== undefined
  // write 与 execute 都放开文件写；execute 再多一个 run_command。
  const allowWrite = allowMutate
  const allowExecute = allowMutate && requestedAccess === 'execute'

  // 子工具表：从父表过滤出子代理可用的工具。
  // 默认拿不到敏感工具（confirm）、不能递归派生（task 自身）、碰不到 MCP 工具；
  // 授予 write / execute 时放开**固定白名单**（仍受白名单交集与确认链约束）。
  // `subagentToolNames` 是内核预留钩子（生产装配当前未注入）：只做减法，未注入即不过滤。
  const allowedNames =
    options.subagentToolNames === undefined ? undefined : new Set(options.subagentToolNames())
  const subTools = new ToolRegistry()
  for (const tool of options.tools.list()) {
    if (tool.name === TASK_TOOL_NAME) continue
    // 子代理**不向用户提问**（人设里也写明了）：`ask_user` 是 `safe` 级，不挡住的话
    // 一个后台子代理会弹卡片打断用户，而它自己又看不到回答之外的上下文 ——
    // 澄清需求是主代理的职责，子代理只负责把派下来的活干完。
    if (tool.name === ASK_USER_TOOL_NAME) continue
    // 计划提交只能由主代理做：子代理看不到父会话的计划模式，提交会得到「不在计划模式」
    if (tool.name === SUBMIT_PLAN_TOOL_NAME) continue
    if (tool.name.startsWith('mcp.')) continue
    const grantedByAccess =
      (allowWrite && SUBAGENT_WRITE_TOOLS.has(tool.name)) ||
      (allowExecute && SUBAGENT_EXECUTE_TOOLS.has(tool.name))
    if (tool.sensitivity === 'confirm' && !grantedByAccess) continue
    if (allowedNames !== undefined && !allowedNames.has(tool.name)) continue
    subTools.register(tool)
  }
  const grantedTools = subTools.list().map((tool) => tool.name)
  // 实际档位按**子表里真有的工具**回算（不拿请求参数充数）：只读档 / 白名单过滤 / 未接确认链都会降级。
  const actualAccess: SubagentAccess = grantedTools.some((name) => SUBAGENT_EXECUTE_TOOLS.has(name))
    ? 'execute'
    : grantedTools.some((name) => SUBAGENT_WRITE_TOOLS.has(name))
      ? 'write'
      : 'read'

  // 并发限流（docs/06 §19.5）：同一父会话最多 SUBAGENT_MAX_PARALLEL 个子代理；
  // 实际能变更环境（写文件 / 执行命令）的子代理再拿写锁，整段串行
  // （避免交错「读 → 改 → 写」与多张确认卡叠加）。只读子代理不受这把锁影响。
  // 排队中被父请求取消时 acquire 返回 undefined —— 不再启动、也不留下假快照。
  const mutating = actualAccess !== 'read'
  const release: SubagentSlotRelease | undefined = await (
    options.limiter ?? subagentLimiter
  ).acquire(request.sessionId, {
    write: mutating,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  })
  if (release === undefined) {
    return {
      content: '父请求已取消，子代理未启动。',
      isError: true,
      summary: '子代理已取消',
    }
  }

  try {
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
        // 具名子代理：先给它的角色 / 工作方式 / 输出要求，再追加内核公共约束
        // （看不到父对话、不提问、一次跑完、如实报告）—— 用户配置改不了这几条底线。
        persona:
          request.profile === undefined
            ? SUBAGENT_PERSONA
            : `${request.profile.instructions}\n\n${SUBAGENT_PERSONA}`,
        ...(catalog === undefined ? {} : { toolCatalog: catalog }),
      }),
      userInput: request.prompt,
      history: [],
      tools: subTools,
      sessionId: subSessionId,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      maxRounds: options.maxRounds ?? SUBAGENT_MAX_ROUNDS,
      append,
      updateToolCall,
      onToolCall: (info) => options.logger?.info('子代理工具调用', info),
      // 写入授权下把父会话的确认链交进子循环：循环只在 `sensitivity === 'confirm'` 时调用它，
      // 因此这一句的效果是「子代理的写操作与主对话走同一条判定」（档位 / 项目根 / 免确认模式）。
      // 会话 id **钉回父会话**：`-sub` 在会话库里不存在，按它解析项目根会换一条护栏。
      // 缺省 cwd / 搜索根 / 边界根的同一类钉回在**装配层**做（`session-project.ts` 的
      // `adaptForSubagent` 用 `parentSessionIdOf` 剥后缀）—— 那边的 getter 由主进程注入，
      // 内核只知道 `-sub`（todo 清单的状态隔离依赖它，不能整体换 id）。
      ...(mutating && confirmForSubagent !== undefined
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
        permission: actualAccess === 'read' ? ('read' as const) : ('write' as const),
        access: actualAccess,
        ...(request.profile === undefined
          ? {}
          : { agentId: request.profile.id, agentName: request.profile.name }),
        // 快照记**实际**模型：配置模型失效回落时，界面看到的是真在用的那个。
        model: { ...actualModel },
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
    // 请求了写 / 执行但实际没授到对应工具：如实说明降级（否则主代理会以为文件已经改好了）。
    // 两种原因分开写：确认链缺失是装配层问题；权限档 / 白名单没给工具是当前配置的正常结果。
    if (requestedAccess !== 'read' && actualAccess === 'read') {
      content +=
        confirmForSubagent === undefined
          ? '\n\n（装配层未接入确认链，本次已按只读执行：子代理没有写入 / 命令类工具。）'
          : '\n\n（当前权限档未提供写入 / 命令类工具，本次按只读执行。）'
    } else if (requestedAccess === 'execute' && actualAccess === 'write') {
      content += '\n\n（当前权限档未提供命令工具，本次只能改文件、不能执行命令。）'
    }
    if (modelFallback) {
      content +=
        `\n\n（该子代理配置的模型当前不可用，已回退到 ` +
        `${actualModel.providerId} · ${actualModel.model}。）`
    }

    status = isError === true ? 'error' : 'success'
    const endedAt = Date.now()
    publish(endedAt)

    options.logger?.info('子代理任务完成', {
      description: request.description,
      ...(request.profile === undefined ? {} : { agentId: request.profile.id }),
      access: actualAccess,
      model: actualModel.model,
      ...(modelFallback ? { modelFallback: true } : {}),
      tools: grantedTools.length,
      toolCalls: steps.filter((step) => step.kind === 'tool').length,
      reportChars: report.length,
      elapsedMs: endedAt - startedAt,
    })

    return {
      content,
      ...(isError === undefined ? {} : { isError }),
      summary:
        request.profile === undefined
          ? `子代理：${request.description}`
          : `${request.profile.name}：${request.description}`,
      subagent: snapshot(endedAt),
    }
  } finally {
    // 无论正常收尾、异常还是 abort，都必须把槽位 / 写锁还回去（释放是幂等的）
    release()
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
