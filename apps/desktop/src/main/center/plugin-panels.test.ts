import { describe, expect, it } from 'vitest'
import type { PluginPanelInfo, PluginSummary } from '@aurora/shared'
import { buildPluginCatalog, pluginPanelKey } from './plugin-panels.js'

function panel(patch: Partial<PluginPanelInfo> & Pick<PluginPanelInfo, 'id'>): PluginPanelInfo {
  return {
    pluginId: 'com.example.demo',
    pluginName: '示例',
    title: patch.id,
    icon: 'Puzzle',
    kind: 'schema',
    ...patch,
  }
}

function summary(patch: Partial<PluginSummary> & Pick<PluginSummary, 'id'>): PluginSummary {
  return {
    name: patch.id,
    version: '1.0.0',
    description: '',
    author: '',
    enabled: true,
    trusted: false,
    source: 'local',
    status: 'ready',
    activeVersion: '1.0.0',
    installPath: '',
    installedAt: '',
    updatedAt: '',
    isDev: false,
    permissions: [],
    tools: [],
    commands: [],
    panels: [],
    widgets: [],
    themes: [],
    automationActions: [],
    automationEvents: [],
    configFields: [],
    events: [],
    skills: [],
    ...patch,
  }
}

describe('buildPluginCatalog · Center 插件目录（docs/12 §6.5）', () => {
  it('只收启用且至少有一个侧栏面板的插件（小组件不进目录）', () => {
    const catalog = buildPluginCatalog([
      summary({
        id: 'com.example.on',
        name: '启用',
        panels: [panel({ id: 'board', title: '看板', icon: 'ListChecks' })],
      }),
      summary({ id: 'com.example.off', enabled: false, panels: [panel({ id: 'board' })] }),
      summary({ id: 'com.example.widget-only', widgets: [] }),
    ])
    expect(catalog.map((item) => item.id)).toEqual(['com.example.on'])
    expect(catalog[0]?.name).toBe('启用')
    expect(catalog[0]?.version).toBe('1.0.0')
    expect(catalog[0]?.panels).toEqual([
      { id: 'board', title: '看板', icon: 'ListChecks', kind: 'schema' },
    ])
  })

  it('按插件 id 排序；页面型面板带 entry，schema 面板不带', () => {
    const catalog = buildPluginCatalog([
      summary({
        id: 'com.example.zeta',
        panels: [panel({ id: 'info', kind: 'page', entry: 'ui/page.html', icon: '' })],
      }),
      summary({
        id: 'com.example.alpha',
        panels: [panel({ id: 'board', kind: 'schema', entry: 'ignored.html' })],
      }),
    ])
    expect(catalog.map((item) => item.id)).toEqual(['com.example.alpha', 'com.example.zeta'])
    expect(catalog[0]?.panels[0]).toEqual({
      id: 'board',
      title: 'board',
      icon: 'Puzzle',
      kind: 'schema',
    })
    // 空图标名不占字段（网页端按缺省渲染）
    expect(catalog[1]?.panels[0]).toEqual({
      id: 'info',
      title: 'info',
      kind: 'page',
      entry: 'ui/page.html',
    })
  })

  it('插件数上限 64（防失控常量），超出按排序截断', () => {
    const many = Array.from({ length: 70 }, (_item, index) =>
      summary({
        id: `com.example.p${String(index).padStart(2, '0')}`,
        panels: [panel({ id: 'board' })],
      }),
    )
    const catalog = buildPluginCatalog(many)
    expect(catalog).toHaveLength(64)
    expect(catalog[0]?.id).toBe('com.example.p00')
    expect(catalog[63]?.id).toBe('com.example.p63')
  })

  it('订阅键按 pluginId/panelId 唯一', () => {
    expect(pluginPanelKey('com.example.a', 'board')).toBe('com.example.a/board')
    expect(pluginPanelKey('com.example.a', 'board')).not.toBe(
      pluginPanelKey('com.example.a', 'other'),
    )
  })
})
