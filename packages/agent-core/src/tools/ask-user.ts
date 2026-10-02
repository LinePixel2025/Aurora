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
/** 一次可以问几个问题（多问渲染成一张卡里的分节；再多就该拆成多轮对话） */
export const ASK_USER_MAX_QUESTIONS = 4
/** 问题与选项文案的长度上限（超长会被卡片撑爆，也会把用户的注意力稀释掉） */
export const ASK_USER_MAX_QUESTION_CHARS = 500
const ASK_USER_MAX_LABEL_CHARS = 60
const ASK_USER_MAX_DESCRIPTION_CHARS = 200
/** 等待时长的合法区间（毫秒）：太短等于没问，太长让整轮请求干等 */
export const ASK_USER_MIN_TIMEOUT_MS = 30_000
export const ASK_USER_MAX_TIMEOUT_MS = 10 * 60_000

export interface AskUserOption {
  label: string
  description?: string
}

/** 多问里的单问（与主问题同形，只是不带等待时长等整体设置） */
export interface AskUserQuestionPart {
  question: string
  header?: string
  options?: AskUserOption[]
  multiSelect: boolean
}

/** 一次提问的入参（工具层已校验过长度与数量） */
export interface AskUserQuestion {
  question: string
  /** 卡片上的短标签（如「目标目录」「发布范围」），缺省显示「需要你确认」 */
  header?: string
  options?: AskUserOption[]
  multiSelect: boolean
  /**
   * 是否允许自由文本作答（缺省 true）。`false` 时两端都**不渲染**自由输入框 ——
   * 用于「只能从这几个选项里选」的场合（如选一个已存在的 id）。
   */
  allowCustom?: boolean
  /** 这一次提问的等待时长（毫秒，缺省 180s；钳制在 30s–10min 之间） */
  timeoutMs?: number
  /**
   * 一次多问（1–4 个）：渲染成一张卡里的分节，用户一次提交后按顺序回填
   * `answersByQuestion`。缺省 = 单问（用顶层的 `question` / `options`）。
   */
  questions?: AskUserQuestionPart[]
}

/** 用户的回答；`answers` 为空表示没答（超时 / 跳过 / 请求被中止） */
export interface AskUserAnswer {
  /** 选中的选项 label 或用户自由输入的文本（多选时多条） */
  answers: string[]
  /**
   * 逐问作答（一次多问时按 `questions` 顺序；单问时缺省）。
   * `answers` 是它的扁平化副本，供旧消费方 / 审计使用 —— 两者同时存在。
   */
  answersByQuestion?: string[][]
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
      '能自己查（读文件 / 搜索 / 看设置）就先自己查；**不要**用它确认显而易见的默认值。' +
      '需要一起问两三件相关的事时用 `questions` 一次问完（比连着弹几张卡省事）；' +
      '不相干的问题仍应拆成多轮。' +
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
        allowCustom: {
          type: 'boolean',
          description:
            '是否允许自由文本作答（缺省 true）。设 false 时用户**只能**从 options 里选' +
            '（用于必须选一个已存在条目的场合）。',
        },
        timeoutMs: {
          type: 'number',
          description: '这一次提问的等待时长（毫秒，缺省 180000；最小 30000、最大 600000）。',
        },
        questions: {
          type: 'array',
          description:
            '一次问多个问题（1–4 个，渲染成一张卡里的分节，用户一次提交）。' +
            '每一项与顶层 question / header / options / multiSelect 同形。',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: '要问的问题' },
              header: { type: 'string', description: '短标签（2–6 字）' },
              options: {
                type: 'array',
                description: '备选项（2–4 个）',
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
              multiSelect: { type: 'boolean', description: '是否允许多选' },
            },
            required: ['question'],
            additionalProperties: false,
          },
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

  const timeoutRaw = record['timeoutMs']
  const timeoutMs =
    typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw)
      ? Math.min(ASK_USER_MAX_TIMEOUT_MS, Math.max(ASK_USER_MIN_TIMEOUT_MS, Math.round(timeoutRaw)))
      : undefined
  const allowCustom = record['allowCustom'] !== false

  // 一次多问（本轮）：给了 `questions` 就以它为准，顶层 question / options / multiSelect
  // 取**第一问**（老消费方天然降级成只显示第一问，不会渲染出空卡片）
  const rawQuestions = record['questions']
  if (rawQuestions !== undefined) {
    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
      return 'questions 必须是非空数组。'
    }
    if (rawQuestions.length > ASK_USER_MAX_QUESTIONS) {
      return `一次最多问 ${ASK_USER_MAX_QUESTIONS} 个问题（更多就拆成多轮）。`
    }
    const parts: AskUserQuestionPart[] = []
    for (const item of rawQuestions) {
      const parsed = parsePart(item)
      if (typeof parsed === 'string') return parsed
      parts.push(parsed)
    }
    const first = parts[0]!
    return {
      question: first.question,
      ...(first.header === undefined ? {} : { header: first.header }),
      ...(first.options === undefined ? {} : { options: first.options }),
      multiSelect: first.multiSelect,
      ...(allowCustom ? {} : { allowCustom: false }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      questions: parts,
    }
  }

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
    ...(allowCustom ? {} : { allowCustom: false }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }
}

/** 多问里单问的校验（与单问同一套长度 / 数量口径，减少两处漂移） */
function parsePart(input: unknown): AskUserQuestionPart | string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return 'questions 的每一项必须是对象。'
  }
  const record = input as Record<string, unknown>
  const question = typeof record['question'] === 'string' ? record['question'].trim() : ''
  if (question === '') return 'questions 的每一项都必须有 question。'
  if (question.length > ASK_USER_MAX_QUESTION_CHARS) {
    return `每个问题不能超过 ${ASK_USER_MAX_QUESTION_CHARS} 个字符。`
  }
  const header = typeof record['header'] === 'string' ? record['header'].trim() : ''
  const rawOptions = record['options']
  const options: AskUserOption[] = []
  if (rawOptions !== undefined) {
    if (!Array.isArray(rawOptions)) return 'questions[].options 必须是数组。'
    if (rawOptions.length > ASK_USER_MAX_OPTIONS) {
      return `每个问题的选项最多 ${ASK_USER_MAX_OPTIONS} 个。`
    }
    for (const item of rawOptions) {
      if (typeof item !== 'object' || item === null) return '选项的每一项必须是对象。'
      const option = item as Record<string, unknown>
      const label = typeof option['label'] === 'string' ? option['label'].trim() : ''
      if (label === '') return '选项的每一项都必须有 label。'
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
    question,
    ...(header === '' ? {} : { header: truncate(header, 12) }),
    ...(options.length === 0 ? {} : { options }),
    multiSelect: record['multiSelect'] === true && options.length > 1,
  }
}

/** 回填给模型的自述：把「问了什么、有没有选项、怎么答的」压成可读的两三行 */
function summarize(question: AskUserQuestion, answers: string[], answer: AskUserAnswer): string {
  const optionTextOf = (part: { options?: AskUserOption[] }): string =>
    part.options === undefined
      ? '（自由回答）'
      : `（选项：${part.options.map((item) => item.label).join(' / ')}）`
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
  // 一次多问（本轮）：逐问列出问答，避免只把第一问的回填抄给模型（那会让它以为别的没问过）
  if (question.questions !== undefined && question.questions.length > 1) {
    const lines = question.questions.map((part, index) => {
      const group = answer.answersByQuestion?.[index] ?? []
      const replied = group.length > 0 ? group.join(' / ') : '（未回答）'
      return `- ${part.question}${optionTextOf(part)} → ${replied}`
    })
    return [`你向用户一次问了 ${question.questions.length} 个问题${state}：`, ...lines].join('\n')
  }
  return `你向用户提问：${question.question}${optionTextOf(question)}${state}`
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
