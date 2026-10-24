import { describe, expect, it } from 'vitest'
import { parsePluginManifest, PluginManifestSchema } from './manifest.js'
import { validatePluginId, compareVersions, normalizePluginPath } from './ids.js'
import { validateThemeTokens } from './themes.js'
import { PLUGIN_API_VERSION } from './ids.js'

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'com.example.todo',
    name: 'Todo',
    version: '1.0.0',
    apiVersion: PLUGIN_API_VERSION,
    description: '一个用于测试的插件',
    author: { name: 'Example' },
    main: 'main.js',
    ...overrides,
  }
}

describe('插件 id / 版本 / 路径', () => {
  it('接受反向域名 id，拒绝保留段与非法形状', () => {
    expect(validatePluginId('com.example.todo')).toBeNull()
    expect(validatePluginId('com.example')).toBeNull()
    expect(validatePluginId('todo')).not.toBeNull()
    expect(validatePluginId('com.aurora.todo')).toContain('保留段')
    expect(validatePluginId('com.example..todo')).not.toBeNull()
    expect(validatePluginId('com.Example.todo')).not.toBeNull()
  })

  it('比较语义化版本（预发布低于同版本正式版）', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.2.0', '1.1.9')).toBe(1)
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1)
    expect(compareVersions('2.0', '1.9.9')).toBe(1)
  })

  it('包内路径拒绝绝对路径 / 盘符 / UNC / 穿越', () => {
    expect(normalizePluginPath('skills/hello')).toBe('skills/hello')
    expect(normalizePluginPath('.\\ui\\panel.json')).toBe('ui/panel.json')
    expect(normalizePluginPath('/etc/passwd')).toBeNull()
    expect(normalizePluginPath('C:/Windows')).toBeNull()
    expect(normalizePluginPath('//server/share')).toBeNull()
    expect(normalizePluginPath('../outside')).toBeNull()
    expect(normalizePluginPath('a/../../b')).toBeNull()
  })
})

describe('插件清单 schema', () => {
  it('最小清单通过并补默认值', () => {
    const result = parsePluginManifest(baseManifest())
    expect(result.ok).toBe(true)
    expect(result.manifest?.activation).toBe('startup')
    expect(result.manifest?.permissions).toEqual([])
    expect(result.manifest?.contributes.tools).toEqual([])
  })

  it('apiVersion 不匹配时拒绝', () => {
    const result = parsePluginManifest(baseManifest({ apiVersion: 99 }))
    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain(`必须是 ${PLUGIN_API_VERSION}`)
  })

  it('声明贡献但缺少权限时拒绝', () => {
    const result = parsePluginManifest(
      baseManifest({
        contributes: {
          tools: [
            {
              name: 'echo',
              description: '回显',
              parameters: { type: 'object', properties: {} },
            },
          ],
        },
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain('缺少权限「tools」')
  })

  it('工具最终名超过 64 字符时拒绝', () => {
    const longId = `com.${'a'.repeat(20)}.${'b'.repeat(10)}`
    const result = parsePluginManifest(
      baseManifest({
        id: longId,
        permissions: ['tools'],
        contributes: {
          tools: [
            {
              name: `t_${'x'.repeat(24)}`,
              description: 'x',
              parameters: { type: 'object', properties: {} },
            },
          ],
        },
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain('超过 64 字符')
  })

  it('工具参数必须是 object schema', () => {
    const result = parsePluginManifest(
      baseManifest({
        permissions: ['tools'],
        contributes: {
          tools: [{ name: 'echo', description: 'x', parameters: { type: 'string' } }],
        },
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain('type: "object"')
  })

  it('命令名与内置命令重名时拒绝', () => {
    const result = parsePluginManifest(
      baseManifest({
        permissions: ['commands'],
        contributes: {
          commands: [{ name: 'clear', title: '清空', description: 'x', mode: 'action' }],
        },
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain('内置命令')
  })

  it('面板必须且只能声明 schema 或 entry 之一', () => {
    const both = parsePluginManifest(
      baseManifest({
        permissions: ['ui.panels'],
        contributes: {
          panels: [{ id: 'board', title: '面板', schema: 'ui/panel.json', entry: 'ui/page.html' }],
        },
      }),
    )
    expect(both.ok).toBe(false)

    const neither = parsePluginManifest(
      baseManifest({
        permissions: ['ui.panels'],
        contributes: { panels: [{ id: 'board', title: '面板' }] },
      }),
    )
    expect(neither.ok).toBe(false)
  })

  it('net.private 必须同时声明 net', () => {
    const result = parsePluginManifest(baseManifest({ permissions: ['net.private'] }))
    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain('必须同时声明「net」')
  })

  it('重复的工具名会被指出', () => {
    const tool = {
      name: 'echo',
      description: 'x',
      parameters: { type: 'object', properties: {} },
    }
    const result = parsePluginManifest(
      baseManifest({ permissions: ['tools'], contributes: { tools: [tool, { ...tool }] } }),
    )
    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain('工具名「echo」重复')
  })
})

describe('插件主题令牌', () => {
  it('允许表面 / 文字 / 圆角令牌', () => {
    expect(
      validateThemeTokens({
        '--bg-base': '#141210',
        '--text-primary': 'rgba(245, 240, 232, 0.95)',
        '--radius-md': '10px',
      }),
    ).toEqual([])
  })

  it('拒绝强调色 / 毛玻璃 / 非法颜色值', () => {
    expect(validateThemeTokens({ '--aurora-blue': '#ff0000' })[0]).toContain('不允许覆盖')
    expect(validateThemeTokens({ '--glass-tint': '#000000' })[0]).toContain('不允许覆盖')
    expect(validateThemeTokens({ '--bg-base': 'url(evil)' })[0]).toContain('不是合法颜色')
    expect(validateThemeTokens({ '--radius-md': '12' })[0]).toContain('必须是长度')
  })
})

describe('插件小组件清单', () => {
  function withWidgets(
    widgets: unknown[],
    permissions = ['ui.widgets'],
  ): ReturnType<typeof baseManifest> {
    return baseManifest({ permissions, contributes: { widgets } })
  }

  it('接受桌面声明式 / 提示条声明式小组件', () => {
    const result = parsePluginManifest(
      withWidgets([
        {
          id: 'duty-week',
          title: '本周值日',
          icon: 'CalendarClock',
          slot: 'desktop',
          schema: 'ui/widget.json',
          defaultSize: { width: 300, height: 200 },
        },
        { id: 'todo-strip', title: '事务', slot: 'edge-bar', schema: 'ui/strip.json' },
      ]),
    )
    expect(result.ok).toBe(true)
    expect(result.manifest?.contributes.widgets).toHaveLength(2)
  })

  it('声明 widgets 但缺 ui.widgets 权限时拒绝', () => {
    const result = parsePluginManifest(
      withWidgets([{ id: 'w', title: 'W', slot: 'edge-bar', schema: 'ui/w.json' }], []),
    )
    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain('缺少权限「ui.widgets」')
  })

  it('提示条小组件只允许声明式 schema', () => {
    const result = parsePluginManifest(
      withWidgets([{ id: 'w', title: 'W', slot: 'edge-bar', entry: 'ui/page.html' }]),
    )
    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain('提示条小组件只支持声明式 schema')
  })

  it('提示条小组件不接受 defaultSize', () => {
    const result = parsePluginManifest(
      withWidgets([
        {
          id: 'w',
          title: 'W',
          slot: 'edge-bar',
          schema: 'ui/w.json',
          defaultSize: { width: 300, height: 200 },
        },
      ]),
    )
    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain('不支持 defaultSize')
  })

  it('桌面小组件未声明层级 / 材质时补齐 floating / none 默认值', () => {
    const result = parsePluginManifest(
      withWidgets([
        { id: 'w', title: 'W', slot: 'desktop', schema: 'ui/w.json' },
        { id: 's', title: 'S', slot: 'edge-bar', schema: 'ui/s.json' },
      ]),
    )
    expect(result.ok).toBe(true)
    const widgets = result.manifest?.contributes.widgets ?? []
    expect(widgets[0]).toMatchObject({ windowLevel: 'floating', windowMaterial: 'none' })
    expect(widgets[1]).toMatchObject({ windowLevel: 'floating', windowMaterial: 'none' })
  })

  it('接受桌面小组件的 normal / desktop 层级与 acrylic 材质', () => {
    const result = parsePluginManifest(
      withWidgets([
        {
          id: 'w',
          title: 'W',
          slot: 'desktop',
          schema: 'ui/w.json',
          windowLevel: 'desktop',
          windowMaterial: 'acrylic',
        },
        { id: 'n', title: 'N', slot: 'desktop', schema: 'ui/n.json', windowLevel: 'normal' },
      ]),
    )
    expect(result.ok).toBe(true)
    expect(result.manifest?.contributes.widgets[0]).toMatchObject({
      windowLevel: 'desktop',
      windowMaterial: 'acrylic',
    })
    expect(result.manifest?.contributes.widgets[1]?.windowLevel).toBe('normal')
  })

  it('提示条小组件拒绝非默认层级 / 材质', () => {
    for (const patch of [
      { windowLevel: 'normal' },
      { windowLevel: 'desktop' },
      { windowMaterial: 'acrylic' },
    ]) {
      const result = parsePluginManifest(
        withWidgets([{ id: 's', title: 'S', slot: 'edge-bar', schema: 'ui/s.json', ...patch }]),
      )
      expect(result.ok).toBe(false)
      expect(result.errors.join('\n')).toContain('提示条小组件不支持')
    }
  })

  it('非法层级 / 材质枚举被拒绝', () => {
    for (const patch of [{ windowLevel: 'wallpaper' }, { windowMaterial: 'mica' }]) {
      const result = parsePluginManifest(
        withWidgets([{ id: 'w', title: 'W', slot: 'desktop', schema: 'ui/w.json', ...patch }]),
      )
      expect(result.ok).toBe(false)
    }
  })

  it('schema 与 entry 必须二选一', () => {
    const result = parsePluginManifest(withWidgets([{ id: 'w', title: 'W', slot: 'desktop' }]))
    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain('必须且只能声明 schema 或 entry 之一')
  })

  it('单插件小组件 ≤ 4、id 唯一、尺寸有上限', () => {
    const tooMany = Array.from({ length: 5 }, (_, index) => ({
      id: `w${index}`,
      title: `W${index}`,
      slot: 'edge-bar',
      schema: 'ui/w.json',
    }))
    expect(parsePluginManifest(withWidgets(tooMany)).ok).toBe(false)

    const duplicated = parsePluginManifest(
      withWidgets([
        { id: 'w', title: 'A', slot: 'edge-bar', schema: 'ui/a.json' },
        { id: 'w', title: 'B', slot: 'edge-bar', schema: 'ui/b.json' },
      ]),
    )
    expect(duplicated.errors.join('\n')).toContain('小组件 id「w」重复')

    const oversized = parsePluginManifest(
      withWidgets([
        {
          id: 'w',
          title: 'W',
          slot: 'desktop',
          schema: 'ui/w.json',
          defaultSize: { width: 5000, height: 200 },
        },
      ]),
    )
    expect(oversized.ok).toBe(false)
  })
})

describe('清单类型导出', () => {
  it('PluginManifestSchema 可用于运行时校验', () => {
    expect(PluginManifestSchema.safeParse(baseManifest()).success).toBe(true)
  })
})
