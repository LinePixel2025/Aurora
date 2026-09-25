/**
 * `todo_write` 工具入参的渲染层解析（2026-09 新增，docs/07 §2.3「任务清单与子代理卡」）。
 *
 * 内核侧的清单形状见 `packages/agent-core/src/tools/todo.ts`：`todo_write` 的 input 是
 * `{ todos: [{ content, status }] }`，status ∈ pending / in_progress / completed。
 * 工具调用经 `AgentToolCall.input`（unknown）进消息流，这里负责把它安全地解析成
 * MessageList 的清单卡与右栏「任务清单」卡共用的视图形状——
 * 解析失败（模型输出不合约定 / 历史数据畸形）返回 null，调用方回落成通用工具卡，不抛错。
 */

export type TodoStatusView = 'pending' | 'in_progress' | 'completed'

export interface TodoRow {
  content: string
  status: TodoStatusView
}

const STATUSES: readonly TodoStatusView[] = ['pending', 'in_progress', 'completed']

/**
 * 解析 `todo_write` 的入参。
 * 返回 `[]`（**合法的空清单**，整表替换语义下等于「清空任务」）与返回 `null`
 * （畸形入参，调用方回落通用工具卡 / 继续沿用上一份清单）是两回事，不可混为一谈。
 */
export function parseTodoWriteInput(input: unknown): TodoRow[] | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const raw = (input as Record<string, unknown>)['todos']
  if (!Array.isArray(raw)) return null
  const rows: TodoRow[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
    const record = item as Record<string, unknown>
    const content = typeof record['content'] === 'string' ? record['content'].trim() : ''
    const status = record['status']
    if (content === '' || typeof status !== 'string') return null
    if (!(STATUSES as readonly string[]).includes(status)) return null
    rows.push({ content, status: status as TodoStatusView })
  }
  return rows
}

/** `task` 子代理卡的入参视图：description 用于卡头，prompt 用于展开体 */
export interface TaskInputView {
  description: string
  prompt: string
}

/** 解析 `task` 的入参；字段缺失（参数非法路径）返回 null */
export function parseTaskInput(input: unknown): TaskInputView | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  const description = typeof record['description'] === 'string' ? record['description'] : ''
  const prompt = typeof record['prompt'] === 'string' ? record['prompt'] : ''
  if (description.trim() === '' && prompt.trim() === '') return null
  return { description, prompt }
}
