/**
 * 自动化管理工具（docs/13 §8）：automation_list / create / update / delete / run / history。
 *
 * 需求：「也可以与 Agent 对话来新增自动化」——模型经这组工具读写自动化定义，
 * 配合内置技能 `automation`（skills/automation/SKILL.md）完成自然语言 → 定义的翻译。
 *
 * 分层与 `tools/classisland-remind.ts` 一致：本文件只认识**注入的管理端口**
 * （`AutomationManagePort`），真实存储与调度在 `main/automation/engine.ts`，纯 Node 可单测。
 *
 * **sensitivity 口径**：`list` / `history` 是 `'safe'`（纯读元数据）；
 * `create` / `update` / `delete` / `run` 是 `'confirm'` —— 虽然操作组件面是封闭的
 * （没有命令与任意写），但「AI 自己给自己排程后台动作」仍应让用户点一次头
 * （与 `automations.*` 进 `SETTINGS_READONLY_PREFIXES` 同一个道理）。
 *
 * **门控口径**：不受 `agent.tools.enabled` 门控（管的是自动化元数据，不是本机操控）；
 * **只读档摘掉写类工具**（create / update / delete / run），保留 list / history
 * —— 档位叫「只读」就必须真的没有副作用（同 todo_write 的处理）；
 * **自动化会话摘掉同一组**（`run-profile.ts` 的 `hiddenTools`），且写类工具的 `execute`
 * 里另有一道拒绝（`refuseInAutomationSession`）—— 摘除让模型看不见，拒绝保证绕不过去。
 */
import type {
  AutomationAction,
  AutomationCatalog,
  AutomationDefinition,
  AutomationRun,
  AutomationTrigger,
} from '@aurora/shared'
import type { ToolContext, ToolDefinition, ToolResult } from '@aurora/agent-core'
import { MAX_RUNS_MAX } from '../automation/catalog.js'
import { isAutomationSession } from '../automation/session-id.js'

export const AUTOMATION_LIST_TOOL_NAME = 'automation_list'
export const AUTOMATION_CREATE_TOOL_NAME = 'automation_create'
export const AUTOMATION_UPDATE_TOOL_NAME = 'automation_update'
export const AUTOMATION_DELETE_TOOL_NAME = 'automation_delete'
export const AUTOMATION_RUN_TOOL_NAME = 'automation_run'
export const AUTOMATION_HISTORY_TOOL_NAME = 'automation_history'

export const AUTOMATION_TOOL_NAMES = [
  AUTOMATION_LIST_TOOL_NAME,
  AUTOMATION_CREATE_TOOL_NAME,
  AUTOMATION_UPDATE_TOOL_NAME,
  AUTOMATION_DELETE_TOOL_NAME,
  AUTOMATION_RUN_TOOL_NAME,
  AUTOMATION_HISTORY_TOOL_NAME,
] as const

/** 只读档下摘除的写类工具 */
export const AUTOMATION_WRITE_TOOL_NAMES = [
  AUTOMATION_CREATE_TOOL_NAME,
  AUTOMATION_UPDATE_TOOL_NAME,
  AUTOMATION_DELETE_TOOL_NAME,
  AUTOMATION_RUN_TOOL_NAME,
] as const

/** 管理端口（`main/automation/engine.ts` 的 AutomationEngine 适配） */
export interface AutomationManagePort {
  list(): Promise<{ user: AutomationDefinition[]; builtin: AutomationDefinition[] }>
  save(
    input: unknown,
  ): Promise<{ ok: true; definition: AutomationDefinition } | { ok: false; error: string }>
  delete(id: string): Promise<{ ok: boolean; error?: string }>
  run(id: string): Promise<{ ok: true; runId: string } | { ok: false; error: string }>
  history(query?: {
    automationId?: string
    mode?: 'agent' | 'normal'
    limit?: number
  }): Promise<AutomationRun[]>
  catalog(): AutomationCatalog
}

// ───────────────────────── 触发器 / 操作的文本描述（给模型看） ─────────────────────────

const TRIGGER_REFERENCE = [
  '触发器（trigger）类型与参数：',
  '- daily：{ at: "HH:mm", weekdays?: number[] }（weekdays 缺省 = 每天，0 = 周日）',
  '- interval：{ everyMinutes: number }（5–1440 分钟）',
  '- pre-class：{ leadMinutes: number }（距某节课开始 ≤ N 分钟，每节课一次）',
  '- class-start：{}（进入某节课时）',
  '- pre-end：{ leadMinutes: number }（正在上的课距结束 ≤ N 分钟）',
  '- class-end：{}（某节课结束时）',
  '- next-lesson：{ subject: string }（下节课变为指定科目，科目名须与课程表一致）',
].join('\n')

const ACTION_REFERENCE = [
  '操作组件（actions）类型与参数（普通模式专用的封闭能力集，没有命令与任意写）：',
  '- system-notify：{ title: string, body: string, openPath?: string }（系统通知，openPath 为点击通知打开的目录）',
  '- classisland-remind：{ title: string, body: string, channel?: "custom"|"class-started"|"pre-class" }（需已配置 ClassIsland 桥接）',
  '- open-folder：{ target: "subject"|"path", subject?: string, path?: string }（打开科目文件夹或指定路径）',
].join('\n')

/**
 * 自动化会话拒绝写类工具（docs/13 §7.1）。
 *
 * 「自动化 → 会话 → 自动化」是把 AI 变成可自我延续的排程器的闭环：一条自动化跑起来的
 * 会话若能再创建 / 触发自动化，就不需要用户点头也能不断给自己排后台动作。
 * 正常路径上这些工具**根本不在**该会话的工具面里（`run-profile.ts` 的 `hiddenTools`），
 * 因此走到这里只有两种可能：装配层漏了、或调用来自没走过滤视图的通道
 * （如 `task` 子代理从父表取工具）。两种都不该放行 —— 摘除负责"看不见"，这里负责"做不到"。
 */
function refuseInAutomationSession(ctx: ToolContext): ToolResult | undefined {
  if (!isAutomationSession(ctx.sessionId)) return undefined
  return {
    content:
      '自动化运行中的会话不能管理或触发自动化（避免自动化自我延续）。' +
      '如果确实需要调整，请把需求告诉用户，由用户在自动化页面操作。',
    isError: true,
    summary: '自动化会话不可管理自动化',
  }
}

/** 触发器的一句话描述（列表 / 历史输出用） */
export function describeTrigger(trigger: AutomationTrigger, catalog: AutomationCatalog): string {
  const descriptor = catalog.conditions.find((item) => item.kind === trigger.kind)
  const label = descriptor?.label ?? trigger.kind
  const params = isRecord(trigger.params) ? trigger.params : {}
  switch (trigger.kind) {
    case 'daily': {
      const at = typeof params['at'] === 'string' ? params['at'] : '--:--'
      const weekdays = Array.isArray(params['weekdays']) ? (params['weekdays'] as number[]) : []
      const dayText =
        weekdays.length === 0
          ? '每天'
          : weekdays.map((day) => WEEKDAY_NAMES[day] ?? String(day)).join('、')
      return `${dayText} ${at}`
    }
    case 'interval':
      return `每 ${String(params['everyMinutes'] ?? '?')} 分钟`
    case 'pre-class':
      return `距上课 ≤ ${String(params['leadMinutes'] ?? '?')} 分钟`
    case 'pre-end':
      return `距下课 ≤ ${String(params['leadMinutes'] ?? '?')} 分钟`
    case 'class-start':
      return '上课时'
    case 'class-end':
      return '下课时'
    case 'next-lesson':
      return `下节课是 ${String(params['subject'] ?? '?')}`
    default:
      return label
  }
}

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function describeAction(action: AutomationAction): string {
  const params = isRecord(action.params) ? action.params : {}
  switch (action.kind) {
    case 'system-notify':
      return `系统通知「${String(params['title'] ?? '')}」`
    case 'classisland-remind':
      return `ClassIsland 提醒「${String(params['title'] ?? '')}」`
    case 'open-folder':
      return params['target'] === 'path'
        ? `打开 ${String(params['path'] ?? '')}`
        : `打开科目文件夹 ${String(params['subject'] ?? '')}`
    default:
      return action.kind
  }
}

function describeDefinition(
  definition: AutomationDefinition,
  catalog: AutomationCatalog,
  builtin: boolean,
): string {
  const max = definition.maxRuns ?? 0
  const used = definition.runCount ?? 0
  const quota = max > 0 ? `，已调用 ${used}/${max}${used >= max ? '（已用尽，自动停用）' : ''}` : ''
  const lines = [
    `${builtin ? '[内置] ' : ''}${definition.name}（id: ${definition.id}，${definition.enabled ? '已启用' : '已停用'}${quota}）`,
    `  模式：${definition.mode === 'agent' ? 'Agent Mode（跑一次 Agent 会话）' : 'Normal Mode（执行预设操作）'}`,
    `  触发：${describeTrigger(definition.trigger, catalog)}`,
  ]
  if (definition.mode === 'agent') {
    lines.push(`  任务指令：${(definition.prompt ?? '').slice(0, 120)}`)
  } else {
    for (const action of definition.actions ?? []) {
      lines.push(`  操作：${describeAction(action)}`)
    }
  }
  return lines.join('\n')
}

// ───────────────────────── 工具定义 ─────────────────────────

export function createAutomationListTool(port: AutomationManagePort): ToolDefinition {
  return {
    name: AUTOMATION_LIST_TOOL_NAME,
    description: `列出所有自动化（含内置的课前提醒 / 课前打开科目文件夹），含 id、模式、触发条件与启停状态。管理自动化前先调用它拿到 id。\n${TRIGGER_REFERENCE}`,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    sensitivity: 'safe',
    execute: async (): Promise<ToolResult> => {
      const { user, builtin } = await port.list()
      const catalog = port.catalog()
      if (user.length === 0 && builtin.length === 0) {
        return {
          content: '当前没有任何自动化。可以用 automation_create 新建。',
          summary: '暂无自动化',
        }
      }
      const sections = [
        user.length > 0
          ? `自建自动化（${user.length} 个）：\n${user.map((item) => describeDefinition(item, catalog, false)).join('\n')}`
          : '',
        builtin.length > 0
          ? `内置自动化（启停见设置页「模式 → ClassRoom」）：\n${builtin.map((item) => describeDefinition(item, catalog, true)).join('\n')}`
          : '',
      ].filter((section) => section !== '')
      return {
        content: sections.join('\n\n'),
        summary: `共 ${user.length + builtin.length} 个自动化`,
      }
    },
  }
}

export function createAutomationCreateTool(port: AutomationManagePort): ToolDefinition {
  return {
    name: AUTOMATION_CREATE_TOOL_NAME,
    description: `新建一份自动化（需用户确认）。参数：name（名称）、mode（"agent" = 触发后跑一次 Agent 会话，须给 prompt 任务指令；"normal" = 执行预设操作组件，须给 actions 数组）、trigger（触发器，见下方类型表）、maxRuns（可选的调用次数上限，0 / 不填 = 不限，用尽自动停用）。\n${TRIGGER_REFERENCE}\n${ACTION_REFERENCE}\n创建成功返回定义 id；建议再用 automation_run 试跑一次并向用户汇报结果。`,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '自动化名称（一句话说清它做什么）' },
        mode: {
          type: 'string',
          enum: ['agent', 'normal'],
          description: 'agent = 跑 Agent 会话；normal = 执行预设操作',
        },
        trigger: {
          type: 'object',
          description: '触发器 { kind, params }，kind 与参数见工具描述的类型表',
        },
        prompt: { type: 'string', description: 'Agent Mode 的任务指令（mode=agent 时必填）' },
        actions: {
          type: 'array',
          description:
            'Normal Mode 的操作组件列表（mode=normal 时必填，元素为 { kind, params }，见类型表）',
        },
        maxRuns: {
          type: 'number',
          description: `调用次数上限（可选，0 = 不限，最大 ${MAX_RUNS_MAX}）；用满后自动停用`,
        },
      },
      required: ['name', 'mode', 'trigger'],
      additionalProperties: false,
    },
    sensitivity: 'confirm',
    execute: async (input, ctx): Promise<ToolResult> => {
      const refused = refuseInAutomationSession(ctx)
      if (refused !== undefined) return refused
      const record = asRecord(input)
      if (record === undefined) {
        return { content: '缺少参数。', isError: true, summary: '参数缺失' }
      }
      const maxRuns = readMaxRuns(record)
      if (maxRuns.error !== undefined) {
        return { content: maxRuns.error, isError: true, summary: '参数无效' }
      }
      if (maxRuns.value !== undefined) record['maxRuns'] = maxRuns.value
      const result = await port.save(record)
      if (!result.ok) {
        return { content: `创建自动化失败：${result.error}`, isError: true, summary: '创建失败' }
      }
      return {
        content: `已创建自动化「${result.definition.name}」（id: ${result.definition.id}，${result.definition.enabled ? '已启用' : '已停用'}）。可用 automation_run 立即试跑。`,
        summary: `已创建自动化「${result.definition.name}」`,
      }
    },
  }
}

export function createAutomationUpdateTool(port: AutomationManagePort): ToolDefinition {
  return {
    name: AUTOMATION_UPDATE_TOOL_NAME,
    description: `修改一份已有自动化（需用户确认）：id 必填，其余字段（name / enabled / trigger / prompt / actions / maxRuns）给了就整体替换对应字段。enabled: false = 停用。maxRuns = 调用次数上限（0 = 不限，最大 ${MAX_RUNS_MAX}），runCount 达到上限时引擎会自动停用该自动化；resetRunCount: true 把已调用次数清零（用尽停用后要再用它，需先提高上限或清零）。内置自动化（id 以 builtin. 开头）只能改其配置来源（ClassRoom 设置），不能经本工具修改。\n${TRIGGER_REFERENCE}\n${ACTION_REFERENCE}`,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要修改的自动化 id（automation_list 里拿到）' },
        name: { type: 'string', description: '新名称（可选）' },
        enabled: { type: 'boolean', description: '启停（可选）' },
        trigger: { type: 'object', description: '新触发器（可选，整体替换）' },
        prompt: { type: 'string', description: '新任务指令（可选）' },
        actions: { type: 'array', description: '新操作组件列表（可选，整体替换）' },
        maxRuns: {
          type: 'number',
          description: `调用次数上限（可选，0 = 不限，最大 ${MAX_RUNS_MAX}）`,
        },
        resetRunCount: {
          type: 'boolean',
          description: '把已调用次数清零（可选；用于「用尽停用后重新开始」）',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    sensitivity: 'confirm',
    execute: async (input, ctx): Promise<ToolResult> => {
      const refused = refuseInAutomationSession(ctx)
      if (refused !== undefined) return refused
      const record = asRecord(input)
      const id = readString(record, 'id')
      if (record === undefined || id === undefined) {
        return { content: '缺少参数：id。', isError: true, summary: '参数缺失' }
      }
      const { user, builtin } = await port.list()
      const existing = user.find((item) => item.id === id) ?? builtin.find((item) => item.id === id)
      if (existing === undefined) {
        return { content: `自动化不存在：${id}。`, isError: true, summary: '自动化不存在' }
      }
      if (existing.id.startsWith('builtin.')) {
        return {
          content:
            '内置自动化不可直接修改；如需调整课前提醒行为，请提示用户到「设置 → 模式 → ClassRoom」修改对应开关与提前分钟数。',
          isError: true,
          summary: '内置自动化不可修改',
        }
      }
      const maxRuns = readMaxRuns(record)
      if (maxRuns.error !== undefined) {
        return { content: maxRuns.error, isError: true, summary: '参数无效' }
      }
      const merged: Record<string, unknown> = { ...existing }
      if (typeof record['name'] === 'string') merged['name'] = record['name']
      if (typeof record['enabled'] === 'boolean') merged['enabled'] = record['enabled']
      if (isRecord(record['trigger'])) merged['trigger'] = record['trigger']
      if (typeof record['prompt'] === 'string') {
        merged['prompt'] = record['prompt']
        merged['mode'] = 'agent'
      }
      if (Array.isArray(record['actions'])) {
        merged['actions'] = record['actions']
        merged['mode'] = 'normal'
      }
      if (maxRuns.value !== undefined) merged['maxRuns'] = maxRuns.value
      if (record['resetRunCount'] === true) merged['runCount'] = 0
      const result = await port.save(merged)
      if (!result.ok) {
        return { content: `修改自动化失败：${result.error}`, isError: true, summary: '修改失败' }
      }
      const quota =
        (result.definition.maxRuns ?? 0) > 0
          ? `，已调用 ${result.definition.runCount ?? 0}/${result.definition.maxRuns}`
          : ''
      return {
        content: `已更新自动化「${result.definition.name}」（${result.definition.enabled ? '已启用' : '已停用'}${quota}）。`,
        summary: `已更新自动化「${result.definition.name}」`,
      }
    },
  }
}

export function createAutomationDeleteTool(port: AutomationManagePort): ToolDefinition {
  return {
    name: AUTOMATION_DELETE_TOOL_NAME,
    description: '删除一份自建自动化（需用户确认；内置自动化不可删除）。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '要删除的自动化 id' } },
      required: ['id'],
      additionalProperties: false,
    },
    sensitivity: 'confirm',
    execute: async (input, ctx): Promise<ToolResult> => {
      const refused = refuseInAutomationSession(ctx)
      if (refused !== undefined) return refused
      const record = asRecord(input)
      const id = readString(record, 'id')
      if (record === undefined || id === undefined) {
        return { content: '缺少参数：id。', isError: true, summary: '参数缺失' }
      }
      const result = await port.delete(id)
      if (!result.ok) {
        return {
          content: `删除失败：${result.error ?? '未知原因'}`,
          isError: true,
          summary: '删除失败',
        }
      }
      return { content: `已删除自动化 ${id}。`, summary: '已删除自动化' }
    },
  }
}

export function createAutomationRunTool(port: AutomationManagePort): ToolDefinition {
  return {
    name: AUTOMATION_RUN_TOOL_NAME,
    description:
      '手动触发一次自动化（需用户确认）。Agent 模式会在后台跑一次完整会话（结果在 automation_history 里看）；普通模式立即执行预设操作。适合创建 / 修改后试跑。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '要触发的自动化 id' } },
      required: ['id'],
      additionalProperties: false,
    },
    sensitivity: 'confirm',
    execute: async (input, ctx): Promise<ToolResult> => {
      const refused = refuseInAutomationSession(ctx)
      if (refused !== undefined) return refused
      const record = asRecord(input)
      const id = readString(record, 'id')
      if (record === undefined || id === undefined) {
        return { content: '缺少参数：id。', isError: true, summary: '参数缺失' }
      }
      const result = await port.run(id)
      if (!result.ok) {
        return { content: `触发失败：${result.error}`, isError: true, summary: '触发失败' }
      }
      return {
        content: `已触发自动化（运行记录 id: ${result.runId}）。稍后可用 automation_history 查看结果。`,
        summary: '已触发自动化',
      }
    },
  }
}

export function createAutomationHistoryTool(port: AutomationManagePort): ToolDefinition {
  return {
    name: AUTOMATION_HISTORY_TOOL_NAME,
    description:
      '查询自动化运行历史（触发时间 / 用时 / 状态；Agent 模式的运行还带会话 id）。可用 automationId 过滤某个自动化。',
    parameters: {
      type: 'object',
      properties: {
        automationId: { type: 'string', description: '只看某个自动化的历史（可选）' },
        limit: { type: 'number', description: '返回条数上限（默认 20，最大 200）' },
      },
      required: [],
      additionalProperties: false,
    },
    sensitivity: 'safe',
    execute: async (input): Promise<ToolResult> => {
      const record = asRecord(input)
      const automationId = readString(record, 'automationId')
      const rawLimit = record?.['limit']
      const limit =
        typeof rawLimit === 'number' && Number.isFinite(rawLimit)
          ? Math.min(200, Math.max(1, Math.round(rawLimit)))
          : 20
      const runs = await port.history({
        ...(automationId === undefined ? {} : { automationId }),
        limit,
      })
      if (runs.length === 0) {
        return { content: '暂无运行记录。', summary: '暂无运行记录' }
      }
      const lines = runs.map((run) => {
        const duration =
          run.durationMs === undefined ? '' : `，用时 ${Math.round(run.durationMs / 1000)}s`
        const session = run.sessionId === undefined ? '' : `，会话 ${run.sessionId}`
        return `- ${run.triggeredAt} 「${run.automationName}」（${run.mode === 'agent' ? 'Agent' : 'Normal'}）→ ${STATUS_LABELS[run.status] ?? run.status}${duration}${session}`
      })
      return { content: lines.join('\n'), summary: `${runs.length} 条运行记录` }
    },
  }
}

const STATUS_LABELS: Record<AutomationRun['status'], string> = {
  running: '进行中',
  success: '成功',
  failed: '失败',
  interrupted: '已中断',
}

export function createAutomationTools(port: AutomationManagePort): ToolDefinition[] {
  return [
    createAutomationListTool(port),
    createAutomationCreateTool(port),
    createAutomationUpdateTool(port),
    createAutomationDeleteTool(port),
    createAutomationRunTool(port),
    createAutomationHistoryTool(port),
  ]
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  return input as Record<string, unknown>
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 读取可选的 `maxRuns` 参数（0 = 不限）。
 *
 * 三种结果：字段没给（`undefined`，调用方保持原值）、给了合法值（取整后返回）、
 * 给了非法值（返回中文错误，调用方**不落盘**——半个定义比没有定义更难查）。
 * 非法值不静默取整成 0：那会把"上限写错"变成"永久不限"，语义正好反了。
 */
function readMaxRuns(record: Record<string, unknown>): { value?: number; error?: string } {
  const raw = record['maxRuns']
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { error: '调用次数上限必须是数字（0 = 不限）。' }
  }
  const value = Math.round(raw)
  if (value < 0 || value > MAX_RUNS_MAX) {
    return { error: `调用次数上限必须在 0–${MAX_RUNS_MAX} 之间（0 = 不限）。` }
  }
  return { value }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
