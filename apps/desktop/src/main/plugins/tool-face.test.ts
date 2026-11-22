import { describe, expect, it } from 'vitest'
import {
  PLUGIN_TOOL_FACE_LIMIT,
  type PluginInstallPreview,
  type PluginSummary,
} from '@aurora/shared'
import type { PluginToolContribution } from './manager.js'
import {
  applyToolFace,
  pluginInstallToolFaceWarnings,
  selectPluginTools,
} from './tool-face.js'

function contribution(
  pluginId: string,
  name: string,
  overrides: Partial<PluginToolContribution> = {},
): PluginToolContribution {
  return {
    pluginId,
    pluginName: pluginId,
    name,
    fullName: `plugin.${pluginId}.${name}`,
    description: `${pluginId}.${name}`,
    parameters: { type: 'object', properties: {} },
    sensitivity: 'confirm',
    readonly: false,
    ...overrides,
  }
}

function summaryOf(
  id: string,
  tools: ReadonlyArray<{ name: string; fullName: string }>,
): PluginSummary {
  return {
    id,
    name: id,
    version: '1.0.0',
    description: '',
    author: 'tester',
    enabled: true,
    trusted: false,
    source: 'local',
    status: 'ready',
    activeVersion: '1.0.0',
    installPath: 'C:/plugins',
    installedAt: '',
    updatedAt: '',
    isDev: false,
    permissions: ['tools'],
    tools: tools.map((tool) => ({
      name: tool.name,
      fullName: tool.fullName,
      description: '',
      sensitivity: 'confirm',
      readonly: false,
    })),
    commands: [],
    panels: [],
    widgets: [],
    dialogs: [],
    themes: [],
    automationActions: [],
    automationEvents: [],
    configFields: [],
    events: [],
    skills: [],
  }
}

const manyTools = (count: number): PluginToolContribution[] =>
  Array.from({ length: count }, (_, index) =>
    contribution('com.example.bulk', `t${String(index).padStart(2, '0')}`),
  )

describe('插件工具面全局上限（docs/14 §3.1.1）', () => {
  it('截断只由名字决定：乱序输入得到同一份 kept / skipped', () => {
    const input = [contribution('b', 'z'), contribution('a', 'z'), contribution('a', 'm')]
    const { kept, skipped } = selectPluginTools(input, { limit: 2 })
    expect(kept.map((item) => item.fullName)).toEqual(['plugin.a.m', 'plugin.a.z'])
    expect(skipped.map((item) => item.fullName)).toEqual(['plugin.b.z'])

    const reversed = selectPluginTools([...input].reverse(), { limit: 2 })
    expect(reversed.kept.map((item) => item.fullName)).toEqual(kept.map((item) => item.fullName))
    expect(reversed.skipped.map((item) => item.fullName)).toEqual(
      skipped.map((item) => item.fullName),
    )
  })

  it('恰好 64 个全部留下，第 65 个按字典序被跳过', () => {
    const exact = selectPluginTools(manyTools(64))
    expect(exact.kept).toHaveLength(64)
    expect(exact.skipped).toHaveLength(0)

    const overflow = selectPluginTools(manyTools(65))
    expect(overflow.kept).toHaveLength(64)
    expect(overflow.skipped.map((item) => item.name)).toEqual(['t64'])
  })

  it('只读档先过滤再计数：非只读工具既不占名额也不算被截断', () => {
    const input = [
      contribution('a', 'write_one'),
      contribution('a', 'read_one', { readonly: true }),
      contribution('a', 'write_two'),
    ]
    const { kept, skipped } = selectPluginTools(input, { readonlyMode: true })
    expect(kept.map((item) => item.name)).toEqual(['read_one'])
    expect(skipped).toHaveLength(0)
  })
})

describe('插件工具面 IPC 装饰', () => {
  it('逐工具写 registered，并给出本插件计数与全局已用', () => {
    const summary = summaryOf('x', [
      { name: 'a', fullName: 'plugin.x.a' },
      { name: 'b', fullName: 'plugin.x.b' },
    ])
    const decorated = applyToolFace(summary, {
      registered: ['plugin.x.a'],
      skipped: ['plugin.x.b'],
    })
    expect(decorated.tools.map((tool) => tool.registered)).toEqual([true, false])
    expect(decorated.toolFace).toEqual({ used: 1, registered: 1, skipped: 1 })
    // 纯函数：原摘要不被改写
    expect(summary.tools[0]?.registered).toBeUndefined()
    expect(summary.toolFace).toBeUndefined()
  })

  it('没有声明工具的插件也带全局 used（界面按 tools.length 决定是否渲染）', () => {
    const decorated = applyToolFace(summaryOf('y', []), {
      registered: ['plugin.x.a'],
      skipped: [],
    })
    expect(decorated.toolFace).toEqual({ used: 1, registered: 0, skipped: 0 })
  })
})

function previewOf(
  id: string,
  tools: ReadonlyArray<{ name: string; readonly?: boolean }>,
): Pick<PluginInstallPreview, 'id' | 'tools'> {
  return {
    id,
    tools: tools.map((tool) => ({
      name: tool.name,
      fullName: `plugin.${id}.${tool.name}`,
      description: '',
      sensitivity: 'confirm',
      readonly: tool.readonly ?? false,
    })),
  }
}

describe('安装确认弹窗的工具面预警（docs/14 §3.1.1）', () => {
  it('装得下时不产生任何预警', () => {
    const warnings = pluginInstallToolFaceWarnings(
      previewOf('new', [{ name: 'a' }, { name: 'b' }]),
      { registered: ['plugin.old.t'], skipped: [] },
    )
    expect(warnings).toEqual([])
  })

  it('插件自身超过上限：报告不会注册的数量', () => {
    const warnings = pluginInstallToolFaceWarnings(
      previewOf(
        'bulk',
        Array.from({ length: 70 }, (_, index) => ({ name: `t${String(index).padStart(2, '0')}` })),
      ),
      { registered: [], skipped: [] },
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('70 个可注册工具中有 6 个不会注册')
    expect(warnings[0]).toContain(`全局上限 ${PLUGIN_TOOL_FACE_LIMIT}`)
  })

  it('名字靠前的插件会挤掉已有工具：列出数量与名字', () => {
    const existing = Array.from(
      { length: 60 },
      (_, index) => `plugin.z.t${String(index).padStart(2, '0')}`,
    )
    const warnings = pluginInstallToolFaceWarnings(
      previewOf(
        'aa',
        Array.from({ length: 10 }, (_, index) => ({
          name: `t${String(index).padStart(2, '0')}`,
        })),
      ),
      { registered: existing, skipped: [] },
    )
    expect(warnings.some((line) => line.includes('挤掉已有插件工具 6 个'))).toBe(true)
    expect(warnings.some((line) => line.includes('plugin.z.t54'))).toBe(true)
  })

  it('同 id 重装 / 升级不把自己算成被挤掉', () => {
    const existing = Array.from(
      { length: 64 },
      (_, index) => `plugin.x.old${String(index).padStart(2, '0')}`,
    )
    const warnings = pluginInstallToolFaceWarnings(
      previewOf(
        'x',
        Array.from({ length: 64 }, (_, index) => ({
          name: `new${String(index).padStart(2, '0')}`,
        })),
      ),
      { registered: existing, skipped: [] },
    )
    expect(warnings).toEqual([])
  })

  it('只读档只按 readonly 工具计数：写工具不占名额也不触发预警', () => {
    const preview = previewOf(
      'bulk',
      Array.from({ length: 70 }, (_, index) => ({ name: `w${index}` })),
    )
    expect(
      pluginInstallToolFaceWarnings(
        preview,
        { registered: [], skipped: [] },
        { readonlyMode: true },
      ),
    ).toEqual([])
  })
})
