/**
 * `submit_plan` —— 计划模式下把最终实施计划交给用户审批（docs/06 §29）。
 *
 * 工具本身不落盘：真正的「写 `<userData>/plans/*.md` + 更新会话 `meta.plan`」由主进程
 * 「计划端口」完成（与 `todo_write` / `office_*` 的端口注入套路一致）。这样：
 * - 内核保持纯 Node、可单测；
 * - 文件路径 / 索引 / 权限边界只在主进程实现一次。
 */
import type { SessionPlan } from '@aurora/shared'
import type { ToolDefinition, ToolResult } from './registry.js'

export const SUBMIT_PLAN_TOOL_NAME = 'submit_plan'

/** 单个计划的正文上限（字符）：避免会话文件与上下文被一份超长计划撑爆 */
export const SUBMIT_PLAN_MAX_CHARS = 32_000

export interface SubmitPlanPort {
  submit(input: {
    sessionId: string
    /** `ctx.toolCallId`；缺失时主进程会自行生成 */
    planId: string
    markdown: string
  }): Promise<{ ok: true; plan: SessionPlan } | { ok: false; error: string }>
}

/**
 * 计划提交工具。
 *
 * 只在计划模式下出现在请求工具面里（`planModeRunProfile` 的 allowedTools 白名单）；
 * 普通模式被 `hiddenTools` 摘掉，子代理侧另有一道显式过滤。
 */
export function createSubmitPlanTool(port: SubmitPlanPort): ToolDefinition {
  return {
    name: SUBMIT_PLAN_TOOL_NAME,
    description:
      '把最终实施计划提交给用户审批。**只在计划模式可用**。plan 必须是一份完整的 Markdown 计划，' +
      '以 `#` 标题开头，包含：目标与范围、现状与依据（引用具体文件）、实施步骤、验证方式、风险与未决问题。' +
      '提交后本轮结束并等待用户批准；用户提出修改时重新调研并再次调用本工具提交**完整新版**，不要打补丁。' +
      '不要在正文里声称已经执行或修改了任何文件。',
    parameters: {
      type: 'object',
      properties: {
        plan: {
          type: 'string',
          description:
            '完整实施计划的 Markdown 正文（以 # 标题开头，不超过 32000 字符）。不要只写摘要。',
        },
      },
      required: ['plan'],
      additionalProperties: false,
    },
    sensitivity: 'safe',
    // 提交是整表替换语义（同一轮并发提交会互相顶掉），默认串行（不声明 parallel）
    execute: async (input, ctx): Promise<ToolResult> => {
      const markdown = planMarkdownOf(input)
      if (markdown === undefined) {
        return {
          content: '缺少参数 plan（完整实施计划的 Markdown 正文）。',
          isError: true,
          summary: '缺少 plan 参数',
        }
      }
      const trimmed = markdown.trim()
      if (trimmed === '') {
        return { content: '计划正文为空。', isError: true, summary: '计划正文为空' }
      }
      if (!trimmed.startsWith('#')) {
        return {
          content: '计划必须以 `#` 标题开头（例如 `# 实施计划`），请补上标题后重新提交。',
          isError: true,
          summary: '计划缺少标题',
        }
      }
      if (trimmed.length > SUBMIT_PLAN_MAX_CHARS) {
        return {
          content: `计划正文过长（${trimmed.length} 字符，上限 ${SUBMIT_PLAN_MAX_CHARS}）。请精简后重新提交。`,
          isError: true,
          summary: '计划正文过长',
        }
      }
      try {
        const outcome = await port.submit({
          sessionId: ctx.sessionId,
          planId: ctx.toolCallId ?? '',
          markdown: trimmed,
        })
        if (!outcome.ok) {
          return { content: outcome.error, isError: true, summary: '计划未提交' }
        }
        const lines = trimmed.split(/\r?\n/).length
        return {
          content:
            '计划已提交，等待用户批准。不要重复粘贴计划正文，也不要继续调用其它工具；' +
            '用户批准后会另行通知开始执行。',
          summary: `已提交计划（${lines} 行）`,
        }
      } catch (error) {
        return {
          content: `提交计划失败：${error instanceof Error ? error.message : String(error)}`,
          isError: true,
          summary: '提交计划失败',
        }
      }
    },
  }
}

function planMarkdownOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  const value = (input as Record<string, unknown>)['plan']
  return typeof value === 'string' ? value : undefined
}
