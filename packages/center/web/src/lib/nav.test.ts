import { describe, expect, it } from 'vitest'
import { buildPluginNav, PLUGIN_NAV_LIMIT } from './nav.js'

const panel = (id: string, title: string, icon?: string) => ({
  id,
  title,
  kind: 'schema' as const,
  ...(icon === undefined ? {} : { icon }),
})

describe('buildPluginNav · Center 侧栏插件分区（docs/12 §6.5）', () => {
  it('只取本人名下且在线的设备；离线 / 他人的设备不产生入口', () => {
    const items = buildPluginNav(
      [
        {
          clientId: 'c1',
          online: true,
          ownerUserId: 'u1',
          plugins: [
            { id: 'com.example.a', name: 'A', version: '1.0.0', panels: [panel('board', '看板')] },
          ],
        },
        {
          clientId: 'c2',
          online: false,
          ownerUserId: 'u1',
          plugins: [
            { id: 'com.example.b', name: 'B', version: '1.0.0', panels: [panel('board', '看板')] },
          ],
        },
        {
          clientId: 'c3',
          online: true,
          ownerUserId: 'u2',
          plugins: [
            { id: 'com.example.c', name: 'C', version: '1.0.0', panels: [panel('board', '看板')] },
          ],
        },
      ],
      'u1',
    )
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      pluginId: 'com.example.a',
      panelId: 'board',
      clientIds: ['c1'],
    })
    expect(items[0]?.icon).toBeUndefined()
  })

  it('多设备同名面板合并为一条，收集候选 clientIds；同名面板加插件名前缀', () => {
    const items = buildPluginNav(
      [
        {
          clientId: 'c1',
          online: true,
          ownerUserId: 'u1',
          plugins: [
            { id: 'com.example.a', name: '甲', version: '1.0.0', panels: [panel('board', '看板')] },
            { id: 'com.example.b', name: '乙', version: '1.0.0', panels: [panel('board', '看板')] },
          ],
        },
        {
          clientId: 'c2',
          online: true,
          ownerUserId: 'u1',
          plugins: [
            { id: 'com.example.a', name: '甲', version: '1.0.0', panels: [panel('board', '看板')] },
          ],
        },
      ],
      'u1',
    )
    expect(items).toHaveLength(2)
    expect(items.map((item) => item.label)).toEqual(['甲 · 看板', '乙 · 看板'])
    const first = items.find((item) => item.pluginId === 'com.example.a')
    expect(first?.clientIds).toEqual(['c1', 'c2'])
  })

  it('不同面板名不前缀；上限 24 条', () => {
    const panels = Array.from({ length: 30 }, (_item, index) =>
      panel(`p${String(index).padStart(2, '0')}`, `面板 ${index}`),
    )
    const items = buildPluginNav(
      [
        {
          clientId: 'c1',
          online: true,
          ownerUserId: 'u1',
          plugins: [{ id: 'com.example.a', name: 'A', version: '1.0.0', panels }],
        },
      ],
      'u1',
    )
    expect(items).toHaveLength(PLUGIN_NAV_LIMIT)
    expect(items[0]?.label).toBe('面板 0')
  })
})
