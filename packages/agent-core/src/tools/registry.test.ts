import { describe, expect, it } from 'vitest'
import { ToolRegistry, allowTools, filterTools } from './registry.js'
import type { LlmToolParameterSchema } from '../llm/types.js'

const params: LlmToolParameterSchema = { type: 'object', properties: {} }

const makeTool = (name: string) => ({
  name,
  description: `tool ${name}`,
  parameters: params,
  execute: () => Promise.resolve({ content: 'ok' }),
})

/**
 * `toLlmTools()` 的确定性排序（docs/06 §21.2）。
 *
 * 这两条用例是「设置一改、缓存全失效」的直接证据：
 * `sync()` 的语义是先全量摘除再按当前配置重建，按 Map 插入序返回会让工具跑到数组末尾，
 * 请求体里的 `tools` 一变，网关的前缀缓存整段作废。
 */
describe('ToolRegistry.toLlmTools 的确定性顺序', () => {
  it('两种注册顺序注册同一组工具 → name 数组完全相同且按字典序', () => {
    const names = ['read_file', 'edit_file', 'glob', 'grep', 'todo_write']

    const forward = new ToolRegistry()
    for (const name of names) forward.register(makeTool(name))

    const backward = new ToolRegistry()
    for (const name of [...names].reverse()) backward.register(makeTool(name))

    const expected = ['edit_file', 'glob', 'grep', 'read_file', 'todo_write']
    expect(forward.toLlmTools().map((tool) => tool.name)).toEqual(expected)
    expect(backward.toLlmTools().map((tool) => tool.name)).toEqual(expected)
  })

  it('先注册全部、再对其中一个 unregister + register（模拟 sync() 的摘除重建）→ 顺序不变', () => {
    const tools = new ToolRegistry()
    // 刻意按非字典序注册：下面的「摘除重建」会把 read_file 从队首挪到队尾，
    // 不打乱顺序的话这条用例会红（这是本步反向自证的靶点）
    for (const name of ['read_file', 'grep', 'glob', 'edit_file']) tools.register(makeTool(name))
    const before = tools.toLlmTools().map((tool) => tool.name)
    expect(before).toEqual(['edit_file', 'glob', 'grep', 'read_file'])

    // 模拟 registerComputerTools.sync()：先摘除、再按当前配置重建
    expect(tools.unregister('read_file')).toBe(true)
    tools.register(makeTool('read_file'))

    expect(tools.toLlmTools().map((tool) => tool.name)).toEqual(before)
    // 底层注册序确实变了（read_file 从队首挪到队尾）——顺序稳定只来自排序，不是巧合
    expect(tools.list().map((tool) => tool.name)).toEqual([
      'grep',
      'glob',
      'edit_file',
      'read_file',
    ])
  })

  it('只带 name / description / parameters（execute 与 sensitivity 不出门）', () => {
    const tools = new ToolRegistry()
    tools.register({ ...makeTool('read_file'), sensitivity: 'confirm' })
    expect(Object.keys(tools.toLlmTools()[0] ?? {})).toEqual(['name', 'description', 'parameters'])
  })
})

/**
 * 按运行来源摘除工具（v0.2.8，docs/06 §5.2）：自动化会话不得再管理 / 触发自动化。
 *
 * 摘除必须是**请求级**的：全局注册表不动（`sync()` 按时重建它），视图只影响这一次请求。
 */
describe('filterTools', () => {
  const registry = (): ToolRegistry => {
    const tools = new ToolRegistry()
    for (const name of ['automation_list', 'automation_run', 'read_file']) {
      tools.register(makeTool(name))
    }
    return tools
  }

  it('被摘除的名字在 list / toLlmTools / get 三处同时消失（模型看不见也调不到）', () => {
    const source = registry()
    const view = filterTools(source, ['automation_run'])
    expect(view.list().map((tool) => tool.name)).toEqual(['automation_list', 'read_file'])
    expect(view.toLlmTools().map((tool) => tool.name)).toEqual(['automation_list', 'read_file'])
    expect(view.get('automation_run')).toBeUndefined()
    // 其余工具照常取到
    expect(view.get('read_file')?.name).toBe('read_file')
    // 原注册表不受影响（视图是只读的）
    expect(source.get('automation_run')?.name).toBe('automation_run')
    expect(source.list()).toHaveLength(3)
  })

  it('空摘除名单直接返回原注册表（普通会话零开销、零行为变化）', () => {
    const source = registry()
    expect(filterTools(source, [])).toBe(source)
  })
})

describe('allowTools', () => {
  const registry = (): ToolRegistry => {
    const tools = new ToolRegistry()
    for (const name of ['read_file', 'write_file']) tools.register(makeTool(name))
    return tools
  }

  it('白名单为空时模型看不见也调不到任何工具', () => {
    const view = allowTools(registry(), [])
    expect(view.list()).toEqual([])
    expect(view.toLlmTools()).toEqual([])
    expect(view.get('read_file')).toBeUndefined()
  })

  it('只保留列出的工具且复用同一缓存', () => {
    const view = allowTools(registry(), ['read_file'])
    expect(view.list().map((tool) => tool.name)).toEqual(['read_file'])
    expect(view.list()).toBe(view.list())
  })
})

/**
 * MCP 覆盖与恢复（P2-06）。
 *
 * MCP 优先于内置是设计（docs/06 §7），但**覆盖必须可逆**：服务器断开 / 出错时
 * hub 逐名 `unregister`，若不恢复旧定义，被覆盖的内置工具会消失到下一次 `sync()`。
 */
describe('ToolRegistry MCP 覆盖与恢复', () => {
  it('MCP 覆盖同名内置工具：unregister 恢复被覆盖的旧定义', () => {
    const tools = new ToolRegistry()
    const builtin = makeTool('read_file')
    const mcp = makeTool('read_file')
    tools.register(builtin)
    tools.register(mcp, 'mcp')

    expect(tools.get('read_file')).toBe(mcp)
    expect(tools.conflicts.some((item) => item.message.includes('MCP 工具覆盖'))).toBe(true)

    expect(tools.unregister('read_file')).toBe(true)
    expect(tools.get('read_file')).toBe(builtin)
  })

  it('内置 / Skill 覆盖同名工具仍被拒绝，且不会留下可恢复的遮蔽', () => {
    const tools = new ToolRegistry()
    const first = makeTool('read_file')
    tools.register(first)
    tools.register(makeTool('read_file'), 'skill')

    expect(tools.get('read_file')).toBe(first)
    tools.unregister('read_file')
    // 拒绝覆盖 → 无遮蔽记录 → 注销后不"复活"
    expect(tools.get('read_file')).toBeUndefined()
  })

  it('多次 MCP 覆盖只记最早的旧定义（tools/list_changed 重新注册不丢内置实现）', () => {
    const tools = new ToolRegistry()
    const builtin = makeTool('mcp.srv.read')
    tools.register(builtin)
    tools.register(makeTool('mcp.srv.read'), 'mcp')
    tools.register(makeTool('mcp.srv.read'), 'mcp')

    tools.unregister('mcp.srv.read')
    expect(tools.get('mcp.srv.read')).toBe(builtin)
  })

  it('unregisterByPrefix 同样恢复被覆盖的旧定义', () => {
    const tools = new ToolRegistry()
    const builtin = makeTool('mcp.srv.read')
    tools.register(builtin)
    tools.register(makeTool('mcp.srv.read'), 'mcp')

    expect(tools.unregisterByPrefix('mcp.srv.')).toBe(1)
    expect(tools.get('mcp.srv.read')).toBe(builtin)
  })

  it('遮蔽只恢复一次：恢复后再注销不会把它再"复活"', () => {
    const tools = new ToolRegistry()
    tools.register(makeTool('read_file'))
    tools.register(makeTool('read_file'), 'mcp')
    expect(tools.unregister('read_file')).toBe(true)
    expect(tools.get('read_file')).toBeDefined()

    expect(tools.unregister('read_file')).toBe(true)
    expect(tools.get('read_file')).toBeUndefined()
  })

  it('MCP 覆盖 Skill 工具后断开 → Skill 实现恢复（同一机制的另一来源）', () => {
    const tools = new ToolRegistry()
    const skill = { ...makeTool('use_skill'), description: 'Skill 实现' }
    tools.register(skill, 'skill')
    const mcp = makeTool('use_skill')
    tools.register(mcp, 'mcp')
    expect(tools.get('use_skill')).toBe(mcp)

    tools.unregister('use_skill')
    expect(tools.get('use_skill')?.description).toBe('Skill 实现')
  })
})
