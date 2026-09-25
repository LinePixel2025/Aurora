/**
 * 任务清单工具的内核单测（docs/06 §18）。
 *
 * 全程用**假端口**（内存 Map + 写入留痕）：这里只验证工具层契约
 * （参数校验不触碰端口 / 整表替换 / id 生成 / 超长截断 / renderTodoList 格式）；
 * 真实按会话落盘由主进程注入的 TodoPort 承担。
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_TODOS,
  MAX_TODO_CONTENT_CHARS,
  TODO_READ_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  createTodoTools,
  renderTodoList,
} from './todo.js'
import type { TodoItem, TodoPort } from './todo.js'
import type { ToolDefinition } from './registry.js'

const CONTEXT = { sessionId: 'session-test' }

interface MemoryPort extends TodoPort {
  writes: Array<{ sessionId: string; todos: TodoItem[] }>
}

function createMemoryPort(): MemoryPort {
  const store = new Map<string, TodoItem[]>()
  const writes: Array<{ sessionId: string; todos: TodoItem[] }> = []
  return {
    writes,
    read: async (sessionId) => store.get(sessionId) ?? [],
    write: async (sessionId, todos) => {
      writes.push({ sessionId, todos })
      store.set(sessionId, todos)
    },
  }
}

function createHarness(error?: unknown): { tools: ToolDefinition[]; port: MemoryPort } {
  const port = createMemoryPort()
  if (error !== undefined) {
    port.write = async () => {
      throw error
    }
  }
  return { tools: createTodoTools({ port }), port }
}

function writeTool(tools: ToolDefinition[]): ToolDefinition {
  const tool = tools.find((item) => item.name === TODO_WRITE_TOOL_NAME)
  if (tool === undefined) throw new Error('todo_write 不存在')
  return tool
}

function readTool(tools: ToolDefinition[]): ToolDefinition {
  const tool = tools.find((item) => item.name === TODO_READ_TOOL_NAME)
  if (tool === undefined) throw new Error('todo_read 不存在')
  return tool
}

describe('createTodoTools · todo_write', () => {
  it('声明两个工具名与 safe 敏感级，todo_write 必填 todos', () => {
    const { tools } = createHarness()
    expect(tools.map((tool) => tool.name)).toEqual([TODO_WRITE_TOOL_NAME, TODO_READ_TOOL_NAME])
    expect(tools.every((tool) => tool.sensitivity === 'safe')).toBe(true)
    expect(writeTool(tools).parameters.required).toEqual(['todos'])
  })

  it('写入成功：整表替换落端口，id 按下标生成 t1..tn，content/summary 按口径', async () => {
    const { tools, port } = createHarness()
    const result = await writeTool(tools).execute(
      {
        todos: [
          { content: '调研现状', status: 'completed' },
          { content: '实现功能', status: 'in_progress' },
          { content: '补齐测试', status: 'pending' },
        ],
      },
      CONTEXT,
    )

    expect(result.isError).toBeUndefined()
    expect(port.writes).toEqual([
      {
        sessionId: 'session-test',
        todos: [
          { id: 't1', content: '调研现状', status: 'completed' },
          { id: 't2', content: '实现功能', status: 'in_progress' },
          { id: 't3', content: '补齐测试', status: 'pending' },
        ],
      },
    ])
    expect(result.summary).toBe('已更新任务清单（3 项）')
    expect(result.content).toBe(
      `任务清单已更新（共 3 项，进行中 1）：\n${renderTodoList(port.writes[0]?.todos ?? [])}`,
    )
  })

  it('缺少 todos / todos 非数组 → isError 且不触碰端口', async () => {
    const { tools, port } = createHarness()
    const missing = await writeTool(tools).execute({}, CONTEXT)
    expect(missing.isError).toBe(true)
    expect(missing.content).toContain('缺少参数 todos')

    const notArray = await writeTool(tools).execute({ todos: '写代码' }, CONTEXT)
    expect(notArray.isError).toBe(true)
    expect(notArray.content).toContain('数组')

    expect(port.writes).toEqual([])
  })

  it('单项缺 content / 非法 status → isError，错误信息带上第几项，不触碰端口', async () => {
    const { tools, port } = createHarness()
    const noContent = await writeTool(tools).execute(
      {
        todos: [{ content: '第一项', status: 'pending' }, { status: 'pending' }],
      },
      CONTEXT,
    )
    expect(noContent.isError).toBe(true)
    expect(noContent.content).toContain('第 2 项')
    expect(noContent.content).toContain('content')

    const badStatus = await writeTool(tools).execute(
      { todos: [{ content: '第一项', status: 'done' }] },
      CONTEXT,
    )
    expect(badStatus.isError).toBe(true)
    expect(badStatus.content).toContain('第 1 项')
    expect(badStatus.content).toContain('status')

    const emptyContent = await writeTool(tools).execute(
      { todos: [{ content: '   ', status: 'pending' }] },
      CONTEXT,
    )
    expect(emptyContent.isError).toBe(true)

    expect(port.writes).toEqual([])
  })

  it(`超过 ${MAX_TODOS} 项 → isError`, async () => {
    const { tools, port } = createHarness()
    const todos = Array.from({ length: MAX_TODOS + 1 }, (_, index) => ({
      content: `任务 ${index + 1}`,
      status: 'pending' as const,
    }))
    const result = await writeTool(tools).execute({ todos }, CONTEXT)
    expect(result.isError).toBe(true)
    expect(result.content).toContain(`${MAX_TODOS}`)
    expect(port.writes).toEqual([])
  })

  it(`content 超过 ${MAX_TODO_CONTENT_CHARS} 字符时静默截断（不报错）`, async () => {
    const { tools, port } = createHarness()
    const result = await writeTool(tools).execute(
      { todos: [{ content: '长'.repeat(MAX_TODO_CONTENT_CHARS + 50), status: 'pending' }] },
      CONTEXT,
    )
    expect(result.isError).toBeUndefined()
    const stored = port.writes[0]?.todos[0]
    expect(stored?.content).toHaveLength(MAX_TODO_CONTENT_CHARS)
  })

  it('空数组 = 清空清单（合法）', async () => {
    const { tools, port } = createHarness()
    const result = await writeTool(tools).execute({ todos: [] }, CONTEXT)
    expect(result.isError).toBeUndefined()
    expect(port.writes[0]?.todos).toEqual([])
    expect(result.content).toBe('任务清单已更新（共 0 项，进行中 0）：\n')
    expect(result.summary).toBe('已更新任务清单（0 项）')
  })

  it('端口写入抛错转为工具错误结果（不冒泡）', async () => {
    const { tools } = createHarness(new Error('磁盘不可写'))
    const result = await writeTool(tools).execute(
      { todos: [{ content: '任务', status: 'pending' }] },
      CONTEXT,
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('任务清单写入失败')
    expect(result.content).toContain('磁盘不可写')
  })
})

describe('createTodoTools · todo_read', () => {
  it('清单为空返回占位文案', async () => {
    const { tools } = createHarness()
    const result = await readTool(tools).execute({}, CONTEXT)
    expect(result.isError).toBeUndefined()
    expect(result.content).toBe('（任务清单为空）')
    expect(result.summary).toBe('读取任务清单')
  })

  it('清单非空返回 renderTodoList 结果', async () => {
    const { tools, port } = createHarness()
    await writeTool(tools).execute(
      {
        todos: [
          { content: '第一步', status: 'completed' },
          { content: '第二步', status: 'in_progress' },
        ],
      },
      CONTEXT,
    )
    const result = await readTool(tools).execute({}, CONTEXT)
    expect(result.content).toBe(renderTodoList(port.writes[0]?.todos ?? []))
    expect(result.content).toContain('1. [x] 第一步')
    expect(result.content).toContain('2. [~] 第二步')
  })
})

describe('renderTodoList', () => {
  it('三种状态各用对应标记，序号从 1 开始', () => {
    expect(
      renderTodoList([
        { id: 't1', content: '待办项', status: 'pending' },
        { id: 't2', content: '进行项', status: 'in_progress' },
        { id: 't3', content: '完成项', status: 'completed' },
      ]),
    ).toBe('1. [ ] 待办项\n2. [~] 进行项\n3. [x] 完成项')
  })

  it('空清单返回空串', () => {
    expect(renderTodoList([])).toBe('')
  })
})
