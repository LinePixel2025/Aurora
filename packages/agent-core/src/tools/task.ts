/**
 * `task` 子代理工具（docs/06 §19）。
 *
 * 派生一个**独立上下文**的子代理执行调研 / 排查 / 整理类多步子任务：
 * - 子代理复用同一个 Agent 循环（`loop/agentLoop.ts`），最终文本报告作为工具结果回传主代理；
 * - 工具表从父表过滤：拿不到 confirm 敏感工具、不能递归派生 task、碰不到 MCP 工具
 *   （MCP 工具全是 confirm，前缀判断是双保险）——子代理拿不到敏感工具与递归派生能力；
 * - 会话**不落盘**（内存收集器），sessionId 加 `-sub` 后缀，
 *   因此 todo 等按会话隔离的端口天然落在独立清单上，与主对话互不干扰。
 *
 * 安全取舍：`sensitivity: 'safe'` —— 子代理会消耗模型调用，但它是 Agent 核心能力，
 * 且只能使用查询与只读类工具（敏感操作在过滤这一层就被挡住），不做逐次确认。
 */
import type { Logger } from '@aurora/shared'
import { buildSystemPrompt, describeTools } from '../context/systemPrompt.js'
import { DEFAULT_MAX_ROUNDS, runAgentLoop } from '../loop/agentLoop.js'
import type { AgentProviderFactory } from '../host/agentHost.js'
import type { NewMessage, StoredMessage, StoredToolCall } from '../session/types.js'
import { ToolRegistry } from './registry.js'
import type { ToolDefinition, ToolResult } from './registry.js'

export const TASK_TOOL_NAME = 'task'
/** 回传给主代理的报告长度上限：超过从尾部截断（防子代理结果刷爆主对话上下文） */
export const MAX_TASK_RESULT_CHARS = 20_000
/** 子代理会话 id 后缀：todo 等按会话隔离的端口据此与主对话分清单 */
export const SUBAGENT_SESSION_SUFFIX = '-sub'

/**
 * 子代理人设（docs/06 §19）：主代理派生、上下文隔离、对用户不可见、
 * 只以最终文本报告结果、无法完成的部分如实说明。
 */
export const SUBAGENT_PERSONA = [
  '你是 Aurora 主代理派生的子代理，独立完成主代理交给你的一个子任务。',
  '你看不到主对话的任何上下文，任务所需信息都在指令里；你的对话过程对用户不可见。',
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
}

export function createTaskTool(options: TaskToolOptions): ToolDefinition {
  return {
    name: TASK_TOOL_NAME,
    description:
      '派生一个子代理独立完成调研、排查、整理类的多步子任务。' +
      '子代理拥有独立上下文（看不到当前对话），只能使用查询与只读类工具，无法执行命令或写文件。' +
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
      try {
        return await runSubagent(options, {
          description,
          prompt,
          sessionId: ctx.sessionId,
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
  sessionId: string
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

  // 子工具表：从父表过滤出查询与只读类工具。
  // 子代理拿不到敏感工具（confirm）、不能递归派生（task 自身）、碰不到 MCP 工具。
  const subTools = new ToolRegistry()
  for (const tool of options.tools.list()) {
    if (
      tool.sensitivity !== 'confirm' &&
      tool.name !== TASK_TOOL_NAME &&
      !tool.name.startsWith('mcp.')
    ) {
      subTools.register(tool)
    }
  }

  // 内存会话收集器（不落盘）：子代理的对话过程只存在于本次调用的闭包里
  const collected: StoredMessage[] = []
  let sequence = 0
  const append = async (message: NewMessage): Promise<StoredMessage> => {
    sequence += 1
    const stored: StoredMessage = {
      id: `sub-${sequence}`,
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
  })

  // 遍历循环事件：文本 delta 累积成最终报告；首个 error 留痕；tool 只计数
  let report = ''
  let firstError: string | undefined
  let pending = false
  let toolEvents = 0
  for await (const event of events) {
    if (event.type === 'text') {
      report += event.delta
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
    if (event.type === 'tool') toolEvents += 1
  }

  // 结果组装：报告为主；异常路径转 isError；截断与附注按口径追加
  let content: string
  let isError: boolean | undefined
  if (report !== '') {
    content =
      report.length > MAX_TASK_RESULT_CHARS
        ? report.slice(0, MAX_TASK_RESULT_CHARS) + '…（子代理结果过长，已截断）'
        : report
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

  options.logger?.info('子代理任务完成', {
    description: request.description,
    toolCalls: toolEvents,
    reportChars: report.length,
  })

  return {
    content,
    ...(isError === undefined ? {} : { isError }),
    summary: `子代理：${request.description}`,
  }
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
