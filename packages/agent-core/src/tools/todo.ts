/**
 * 任务清单工具 `todo_write` / `todo_read`（docs/06 §18）。
 *
 * 分层与 `tools/notify.ts` 同一套：内核只定义工具与 `TodoPort` 端口，
 * 清单的真实读写（按会话落盘）由主进程注入实现，本文件保持纯 Node 可单测。
 *
 * 语义对齐主流编码代理的 todo_write：**整表替换**——每次提交完整清单，
 * 而不是增量增删。数量与单条长度在工具层设上限，防止清单刷爆上下文；
 * `renderTodoList` 同时供系统提示词的任务清单摘要复用（见 `context/systemPrompt.ts`）。
 */
import type { Logger } from '@aurora/shared'
import type { ToolDefinition, ToolResult, ToolContext } from './registry.js'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  id: string
  content: string
  status: TodoStatus
}

export interface TodoPort {
  /** 读取某会话的任务清单（没有清单时返回空数组） */
  read(sessionId: string): Promise<TodoItem[]>
  /** 整表写入某会话的任务清单 */
  write(sessionId: string, todos: TodoItem[]): Promise<void>
}

export const TODO_WRITE_TOOL_NAME = 'todo_write'
export const TODO_READ_TOOL_NAME = 'todo_read'
/** 清单条数上限：超过直接报错（防刷屏） */
export const MAX_TODOS = 100
/** 单条内容上限：超过静默截断（不报错） */
export const MAX_TODO_CONTENT_CHARS = 500

const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed']

/** 渲染标记：待办 / 进行中 / 已完成 */
const STATUS_MARKERS: Record<TodoStatus, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
}

export function createTodoTools(options: { port: TodoPort; logger?: Logger }): ToolDefinition[] {
  const writeTool: ToolDefinition = {
    name: TODO_WRITE_TOOL_NAME,
    description:
      '维护当前会话的任务清单（整表替换：每次提交完整的清单）。' +
      '多步/多项任务先建立清单；一次只保留一个 in_progress；完成一项立即更新状态。',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: '完整的任务清单（整表替换）',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '任务内容（一句话）' },
              status: { type: 'string', description: 'pending / in_progress / completed' },
            },
          },
        },
      },
      required: ['todos'],
      additionalProperties: false,
    },
    sensitivity: 'safe',
    execute: async (input, ctx): Promise<ToolResult> => {
      const parsed = parseTodoInput(input)
      if (typeof parsed === 'string') {
        return { content: parsed, isError: true, summary: '任务清单参数非法' }
      }
      try {
        await options.port.write(ctx.sessionId, parsed)
        options.logger?.debug('任务清单已更新', {
          sessionId: ctx.sessionId,
          count: parsed.length,
        })
        const inProgress = parsed.filter((item) => item.status === 'in_progress').length
        return {
          content: `任务清单已更新（共 ${parsed.length} 项，进行中 ${inProgress}）：\n${renderTodoList(parsed)}`,
          summary: `已更新任务清单（${parsed.length} 项）`,
        }
      } catch (error) {
        return {
          content: `任务清单写入失败：${describeError(error)}`,
          isError: true,
          summary: '任务清单写入失败',
        }
      }
    },
  }

  const readTool: ToolDefinition = {
    name: TODO_READ_TOOL_NAME,
    description: '读取当前会话的任务清单。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    sensitivity: 'safe',
    execute: async (_input, ctx: ToolContext): Promise<ToolResult> => {
      try {
        const todos = await options.port.read(ctx.sessionId)
        return {
          content: todos.length === 0 ? '（任务清单为空）' : renderTodoList(todos),
          summary: '读取任务清单',
        }
      } catch (error) {
        return {
          content: `任务清单读取失败：${describeError(error)}`,
          isError: true,
          summary: '任务清单读取失败',
        }
      }
    },
  }

  return [writeTool, readTool]
}

/**
 * 把清单渲染成给模型 / 用户看的文本：
 * `1. [ ] 内容`（pending）/ `2. [~] 内容`（in_progress）/ `3. [x] 内容`（completed），
 * 空清单返回空串。工具结果与系统提示词摘要共用（见 `context/systemPrompt.ts`）。
 */
export function renderTodoList(todos: readonly TodoItem[]): string {
  return todos
    .map((todo, index) => `${index + 1}. ${STATUS_MARKERS[todo.status]} ${todo.content}`)
    .join('\n')
}

// ───────────────────────── 内部 ─────────────────────────

/**
 * 校验并规范化 todo_write 的入参；非法时返回错误文案（不触碰端口）。
 * 合法时生成 id（`t1..tn`，按下标），content 超长截断（不报错）。
 */
function parseTodoInput(input: unknown): TodoItem[] | string {
  const record = asRecord(input)
  const rawTodos = record?.['todos']
  if (rawTodos === undefined) return '缺少参数 todos（完整任务清单）。'
  if (!Array.isArray(rawTodos)) return '参数 todos 必须是数组（整表替换的完整清单）。'
  if (rawTodos.length > MAX_TODOS) {
    return `任务清单最多 ${MAX_TODOS} 项，本次提交了 ${rawTodos.length} 项；请合并或精简条目。`
  }

  const items: TodoItem[] = []
  for (const [index, raw] of rawTodos.entries()) {
    const item = asRecord(raw)
    if (item === undefined) return `第 ${index + 1} 项必须是对象（content / status）。`
    const content = readNonEmptyString(item, 'content')
    if (content === undefined) return `第 ${index + 1} 项缺少 content（非空字符串的任务内容）。`
    const status = item['status']
    if (!isTodoStatus(status)) {
      return `第 ${index + 1} 项的 status 非法（${formatValue(status)}），只能是 pending / in_progress / completed。`
    }
    items.push({
      id: `t${index + 1}`,
      content: truncateContent(content),
      status,
    })
  }
  return items
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
}

function truncateContent(content: string): string {
  return content.length > MAX_TODO_CONTENT_CHARS
    ? content.slice(0, MAX_TODO_CONTENT_CHARS)
    : content
}

function formatValue(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value)
  return text.length > 50 ? `${text.slice(0, 50)}…` : text
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  return input as Record<string, unknown>
}

/** 必填字符串：非字符串或纯空白一律视为缺参（**不触碰端口**） */
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
