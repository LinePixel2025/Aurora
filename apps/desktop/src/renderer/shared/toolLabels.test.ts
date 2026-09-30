import { describe, expect, it } from 'vitest'
import { toolLabelOf } from './toolLabels.js'

/**
 * 语义化行首标题的护栏（docs/07 §2.3 硬口径④）：核心风险不在「映射对不对」，
 * 而在**畸形输入不许抛错、不许渲染残缺短语** —— 模型输出的参数形状不受我们控制，
 * 解析失败一律回落工具名（与 `AgentToolRow.todosOf` 同一条规矩）。
 */
describe('toolLabelOf', () => {
  it('常见工具给出动词 + 关键参数', () => {
    expect(toolLabelOf('run_command', { command: 'pnpm test' })).toEqual({
      verb: '运行',
      object: 'pnpm test',
    })
    expect(toolLabelOf('read_file', { path: 'src/main/index.ts' })).toEqual({
      verb: '读取',
      object: 'src/main/index.ts',
    })
    expect(toolLabelOf('grep', { pattern: 'trace', path: 'src' })).toEqual({
      verb: '搜索',
      object: 'trace',
    })
  })

  it('没有值得摘参数的工具只给动词', () => {
    expect(toolLabelOf('clipboard_read', undefined)).toEqual({ verb: '读取剪贴板' })
    expect(toolLabelOf('center_status', {})).toEqual({ verb: '查询 Center 状态' })
  })

  it('候选键按序取第一个非空字符串，空白值跳过', () => {
    expect(toolLabelOf('notify_user', { title: '', message: '准备好了' })).toEqual({
      verb: '通知',
      object: '准备好了',
    })
    expect(toolLabelOf('read_file', { path: '  ' })).toEqual({ verb: '读取', object: undefined })
  })

  it('超长参数截断到 48 字符加省略号，内部换行折叠成空格', () => {
    const long = 'a'.repeat(80)
    const label = toolLabelOf('write_file', { path: long })
    expect(label?.object).toBe(`${'a'.repeat(48)}…`)
    expect(toolLabelOf('run_command', { command: 'echo a\nb  c' })?.object).toBe('echo a b c')
  })

  it('畸形入参不抛错：非对象 / 数组 / null 都回落', () => {
    expect(toolLabelOf('run_command', 'pnpm test')).toEqual({ verb: '运行', object: undefined })
    expect(toolLabelOf('run_command', null)).toEqual({ verb: '运行', object: undefined })
    expect(toolLabelOf('read_file', ['a', 'b'])).toEqual({ verb: '读取', object: undefined })
  })

  it('未登记 / 结构化的工具返回 null（行首回落工具名）', () => {
    expect(toolLabelOf('todo_write', { todos: [] })).toBeNull()
    expect(toolLabelOf('task', { description: 'x' })).toBeNull()
    expect(toolLabelOf('automation_list', {})).toBeNull()
    expect(toolLabelOf('totally_unknown', {})).toBeNull()
  })
})
