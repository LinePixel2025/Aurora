/**
 * `ask_user` 工具：Agent 向用户提问并**等一个回答**（2026-09，docs/06 §21）。
 *
 * 定位与 `task` / `todo_write` 同级：它是 Agent 的**交互能力**，不是电脑操控，
 * 因此不走 `agent.tools.enabled` 门控，也不按权限档摘除（提问本身没有系统副作用）。
 *
 * 为什么需要它：模型碰到「用户没说清、但答案会决定后面几十步走向」的分叉时，
 * 此前的选择只有两个 —— 猜一个（猜错就把整轮做完才发现）或把问题写进正文里停住
 * （用户得手动再发一条消息，Agent 才继续）。`ask_user` 把这件事变成一次工具调用：
 * 问一次、拿到答案、**在同一次请求里继续**。
 *
 * 边界：
 * - **一次只问一个问题**（选项 2–4 个或自由文本）—— 批量提问会把用户淹没，
 *   真需要多轮澄清就多次调用；
 * - 超时 / 跳过都不算失败：回填「用户没有回答」并让模型按最合理的假设继续，
 *   绝不能让一次无人应答的问题把整轮请求挂死；
 * - 未注入端口（单测 / 别的壳层）时**不静默失败**：明确告诉模型"这里问不了人"，
 *   让它改用假设 + 说明，而不是以为问题已经问出去了。
 */
import type { Logger } from '@aurora/shared'
import type { ToolDefinition, ToolResult } from './registry.js'

export const ASK_USER_TOOL_NAME = 'ask_user'

/** 一次提问的选项上限（与界面渲染、卡片高度都对齐；再多就该拆成多轮） */
export const ASK_USER_MAX_OPTIONS = 4
/** 问题与选项文案的长度上限（超长会被卡片撑爆，也会把用户的注意力稀释掉） */
export const ASK_USER_MAX_QUESTION_CHARS = 500
const ASK_USER_MAX_LABEL_CHARS = 60
const ASK_USER_MAX_DESCRIPTION_CHARS = 200

export interface AskUserOption {
  label: string
  description?: string
}

/** 一次提问的入参（工具层已校验过长度与数量） */
export interface AskUserQuestion {
  question: string
  /** 卡片上的短标签（如「目标目录」「发布范围」），缺省显示「需要你确认」 */
  header?: string
  options?: AskUserOption[]
  multiSelect: boolean
}

/** 用户的回答；`answers` 为空表示没答（超时 / 跳过 / 请求被中止） */
export interface AskUserAnswer {
  /** 选中的选项 label 或用户自由输入的文本（多选时多条） */
  answers: string[]
  /** 用户超时未答（模型应说明假设后继续，而不是重复提问） */
  timedOut?: boolean
  /** 用户主动跳过（同上，语义比超时更明确） */
  skipped?: boolean
  /** 请求被中止（用户点了停止 / 应用退出） */
  aborted?: boolean
}

export interface AskUserRequestContext {
  sessionId: string
  toolCallId?: string
  signal?: AbortSignal
}

/**
 * 提问端口（装配层实现：推卡片到渲染层 + 等回执；内核只认这个签名）。
 * 实现必须**自己保证会返回**（超时 / 中止都要落一条结论），否则一次提问就能挂死循环。
 */
export interface AskUserPort {
  ask(question: AskUserQuestion, context: AskUserRequestContext): Promise<AskUserAnswer>
}

export interface AskUserToolDeps {
  /** 未注入 = 该环境问不了人（工具会如实回填，不抛错） */
  port?: AskUserPort
  logger?: Logger
}

export function createAskUserTool(deps: AskUserToolDeps): ToolDefinition {
  return {
    name: ASK_USER_TOOL_NAME,
    description:
      '向用户提一个选择题或填空题，并**等待**他的回答（同一次请求内继续）。' +
      '只在答案会显著改变后续做法、且你无法从上下文或已有文件推断时才用：' +
      '比如目标范围不明确、两种方案各有明显取舍、或要改动的东西无法撤销。' +
      '能自己查（读文件 / 搜索 / 看设置）就先自己查；**不要**用它确认显而易见的默认值、' +
      '也不要一次问多个问题（需要多轮澄清就多次调用）。' +
      '用户可能跳过或超时：拿到「没有回答」时说明你的假设并继续，不要重复提问。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问的问题（一句话，把背景压进这一句里）' },
        header: {
          type: 'string',
          description: '短标签（2–6 字，显示在卡片顶部，如「目标目录」）',
        },
        options: {
          type: 'array',
          description:
            '备选项（2–4 个）。**给选项比让人打字更省事**：把你认为最合理的放在第一个。' +
            '不给选项时用户看到的是自由输入框。',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '选项文案（≤ 20 字）' },
              description: { type: 'string', description: '该选项的补充说明（可选）' },
            },
            required: ['label'],
            additionalProperties: false,
          },
        },
        multiSelect: {
          type: 'boolean',
          description: '是否允许多选（缺省 false = 单选）。多选时用户可勾选多个选项。',
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
    // 提问没有系统副作用（不写盘、不执行命令）；它的"危险"是打扰用户，靠描述与
    // 「超时即继续」的语义约束，不靠确认卡片
    sensitivity: 'safe',
    execute: async (input, ctx): Promise<ToolResult> => {
      const question = parseQuestion(input)
      if (typeof question === 'string') {
        return { content: question, isError: true, summary: '提问参数不合法' }
      }
      if (deps.port === undefined) {
        return {
          content:
            '当前环境不支持向用户提问（没有接入问答通道）。请基于最合理的假设继续，' +
            '并在回答里明确说明你做了哪些假设。',
          isError: true,
          summary: '不支持提问',
        }
      }

      let answer: AskUserAnswer
      try {
        answer = await deps.port.ask(question, {
          sessionId: ctx.sessionId,
          ...(ctx.toolCallId === undefined ? {} : { toolCallId: ctx.toolCallId }),
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        })
      } catch (error) {
        // 端口异常按"没问到"处理：绝不因为问答通道坏了把整轮请求卡住
        const message = error instanceof Error ? error.message : String(error)
        deps.logger?.warn('提问通道异常', { message })
        return {
          content: `提问通道异常（${message}），已按你没有回答处理：请说明你的假设并继续。`,
          isError: true,
          summary: '提问通道异常',
        }
      }

      const answers = answer.answers.map((item) => item.trim()).filter((item) => item !== '')
      deps.logger?.info('用户回答提问', {
        sessionId: ctx.sessionId,
        answered: answers.length,
        timedOut: answer.timedOut === true,
        skipped: answer.skipped === true,
        aborted: answer.aborted === true,
      })

      const summary = summarize(question, answers, answer)
      if (answers.length === 0) {
        return {
          content: `${summary}\n用户没有回答这个问题。请说明你的假设（或改用最保守的方案）后继续，不要重复提问。`,
          ...(answer.aborted === true ? { isError: true } : {}),
          summary: answer.aborted === true ? '提问已取消' : '用户未回答',
        }
      }
      return {
        content: `${summary}\n用户回答：${answers.join('；')}`,
        summary: `用户回答：${truncate(answers.join('；'), 80)}`,
      }
    },
  }
}

/** 参数解析：不合法时返回**错误文案**（字符串），合法时返回问题对象 */
function parseQuestion(input: unknown): AskUserQuestion | string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return '参数必须是对象。'
  }
  const record = input as Record<string, unknown>
  const rawQuestion = record['question']
  if (typeof rawQuestion !== 'string' || rawQuestion.trim() === '') {
    return '缺少参数：question（要问的问题）。'
  }
  if (rawQuestion.trim().length > ASK_USER_MAX_QUESTION_CHARS) {
    return `question 不能超过 ${ASK_USER_MAX_QUESTION_CHARS} 个字符。`
  }

  const header = typeof record['header'] === 'string' ? record['header'].trim() : ''
  const multiSelect = record['multiSelect'] === true

  const options: AskUserOption[] = []
  const rawOptions = record['options']
  if (rawOptions !== undefined) {
    if (!Array.isArray(rawOptions)) return 'options 必须是数组。'
    if (rawOptions.length > ASK_USER_MAX_OPTIONS) {
      return `选项最多 ${ASK_USER_MAX_OPTIONS} 个（要问更多就拆成多轮提问）。`
    }
    for (const item of rawOptions) {
      if (typeof item !== 'object' || item === null) return 'options 的每一项必须是对象。'
      const option = item as Record<string, unknown>
      const label = typeof option['label'] === 'string' ? option['label'].trim() : ''
      if (label === '') return 'options 的每一项都必须有 label。'
      if (label.length > ASK_USER_MAX_LABEL_CHARS) {
        return `选项文案不能超过 ${ASK_USER_MAX_LABEL_CHARS} 个字符。`
      }
      const description =
        typeof option['description'] === 'string' ? option['description'].trim() : ''
      if (description.length > ASK_USER_MAX_DESCRIPTION_CHARS) {
        return `选项说明不能超过 ${ASK_USER_MAX_DESCRIPTION_CHARS} 个字符。`
      }
      options.push({ label, ...(description === '' ? {} : { description }) })
    }
  }

  return {
    question: rawQuestion.trim(),
    ...(header === '' ? {} : { header: truncate(header, 12) }),
    ...(options.length === 0 ? {} : { options }),
    multiSelect: multiSelect && options.length > 1,
  }
}

/** 回填给模型的自述：把「问了什么、有没有选项、怎么答的」压成可读的两三行 */
function summarize(question: AskUserQuestion, answers: string[], answer: AskUserAnswer): string {
  const optionText =
    question.options === undefined
      ? '（自由回答）'
      : `（选项：${question.options.map((item) => item.label).join(' / ')}）`
  const state =
    answers.length > 0
      ? ''
      : answer.timedOut === true
        ? '（用户超时未答）'
        : answer.skipped === true
          ? '（用户跳过）'
          : answer.aborted === true
            ? '（请求已中止）'
            : ''
  return `你向用户提问：${question.question}${optionText}${state}`
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
