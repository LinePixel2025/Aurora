import { describe, expect, it } from 'vitest'
import { PLUGIN_UI_LIMITS, validatePanelSchema, type PluginUiNode } from './ui.js'

function schema(nodes: PluginUiNode[]): Record<string, unknown> {
  return { nodes }
}

describe('声明式面板 schema', () => {
  it('接受常用节点并原样返回', () => {
    const raw = schema([
      { type: 'heading', text: '待办' },
      {
        type: 'stack',
        children: [
          { type: 'text', text: '今天' },
          { type: 'badge', text: '3 项', tone: 'ok' },
        ],
      },
      { type: 'progress', percent: 60 },
      { type: 'button', text: '刷新', action: { method: 'refresh' } },
    ])
    const result = validatePanelSchema(raw)
    expect(result.ok).toBe(true)
    expect(result.schema?.nodes).toHaveLength(4)
  })

  it('拒绝未知节点类型与非法 tone', () => {
    expect(validatePanelSchema(schema([{ type: 'script' } as never])).errors[0]).toContain(
      '未知节点类型',
    )
    expect(
      validatePanelSchema(schema([{ type: 'text', text: 'x', tone: 'loud' as never }])).errors[0],
    ).toContain('非法 tone')
  })

  it('拒绝 HTML 注入面之外的越界图片路径', () => {
    expect(validatePanelSchema(schema([{ type: 'image', src: '../secret.png' }])).ok).toBe(false)
    expect(validatePanelSchema(schema([{ type: 'image', src: 'assets/logo.png' }])).ok).toBe(true)
  })

  it('节点数与深度超限时整份拒绝', () => {
    const tooMany = schema(
      Array.from({ length: PLUGIN_UI_LIMITS.maxNodes + 1 }, () => ({
        type: 'divider',
      })) as PluginUiNode[],
    )
    expect(validatePanelSchema(tooMany).ok).toBe(false)

    let node: PluginUiNode = { type: 'text', text: 'x' }
    for (let depth = 0; depth <= PLUGIN_UI_LIMITS.maxDepth; depth += 1) {
      node = { type: 'stack', children: [node] }
    }
    expect(validatePanelSchema(schema([node])).ok).toBe(false)
  })

  it('select / table / action 的形状被校验', () => {
    expect(validatePanelSchema(schema([{ type: 'select', text: 'x' }])).ok).toBe(false)
    expect(
      validatePanelSchema(
        schema([{ type: 'select', text: 'x', options: [{ value: 'a', label: 'A' }] }]),
      ).ok,
    ).toBe(true)
    expect(
      validatePanelSchema(schema([{ type: 'button', text: 'x', action: { method: 'Bad Method' } }]))
        .ok,
    ).toBe(false)
    expect(
      validatePanelSchema(
        schema([{ type: 'table', columns: [{ key: 'a', label: 'A' }], rows: [{ a: '1' }] }]),
      ).ok,
    ).toBe(true)
  })
})
