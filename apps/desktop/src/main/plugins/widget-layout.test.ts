import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clampWidgetBounds,
  defaultWidgetEntry,
  effectiveWidgetWindowLevel,
  parseWidgetLayout,
  readWidgetLayout,
  writeWidgetLayout,
} from './widget-layout.js'

describe('桌面小组件布局', () => {
  it('损坏 / 版本不符的布局按空布局重建，合法条目保留', () => {
    expect(parseWidgetLayout(null)).toEqual({ version: 1, widgets: {} })
    expect(parseWidgetLayout({ version: 2, widgets: {} })).toEqual({ version: 1, widgets: {} })
    const parsed = parseWidgetLayout({
      version: 1,
      widgets: {
        'com.example.hello/duty-week': { visible: false, x: 10, y: 20, width: 300, height: 200 },
        broken: { visible: 'yes' },
      },
    })
    expect(parsed.widgets['com.example.hello/duty-week']).toEqual({
      visible: false,
      x: 10,
      y: 20,
      width: 300,
      height: 200,
    })
    expect(parsed.widgets.broken).toBeUndefined()
  })

  it('新小组件默认在右上角级联，并带清单声明的尺寸', () => {
    const area = { x: 0, y: 0, width: 1920, height: 1040 }
    const first = defaultWidgetEntry(area, 0, { width: 300, height: 200 })
    const second = defaultWidgetEntry(area, 1)
    expect(first).toMatchObject({ visible: true, width: 300, height: 200 })
    expect(first.x).toBe(1920 - 300 - 24)
    expect(second.x).toBe(first.x - 26)
    expect(second.y).toBe(first.y + 26)
  })

  it('矩形夹到工作区内，并保留最小尺寸', () => {
    const area = { x: -1920, y: 0, width: 1920, height: 1080 }
    expect(clampWidgetBounds({ x: 100, y: -200, width: 300, height: 200 }, area)).toEqual({
      x: -300,
      y: 0,
      width: 300,
      height: 200,
    })
    expect(clampWidgetBounds({ x: 0, y: 0, width: 10, height: 10 }, area)).toEqual({
      x: -120,
      y: 0,
      width: 120,
      height: 80,
    })
  })

  it('读写往返保持原子写语义', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aurora-widget-layout-'))
    try {
      await writeWidgetLayout(dir, {
        version: 1,
        widgets: {
          'com.example.hello/duty-week': { visible: true, x: 1, y: 2, width: 300, height: 200 },
        },
      })
      const loaded = await readWidgetLayout(dir)
      expect(loaded.widgets['com.example.hello/duty-week']).toMatchObject({ x: 1, y: 2 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('windowLevelOverride 合法值原样保留，旧文件（无该字段）读出来仍没有', () => {
    const parsed = parseWidgetLayout({
      version: 1,
      widgets: {
        'com.example.hello/duty-week': {
          visible: true,
          x: 1,
          y: 2,
          width: 300,
          height: 200,
          windowLevelOverride: 'desktop',
        },
        'com.example.hello/legacy': { visible: false, x: 3, y: 4, width: 300, height: 200 },
      },
    })
    expect(parsed.widgets['com.example.hello/duty-week']).toMatchObject({
      windowLevelOverride: 'desktop',
    })
    const legacy = parsed.widgets['com.example.hello/legacy']
    expect(legacy).toMatchObject({ visible: false, x: 3, y: 4 })
    expect(legacy?.windowLevelOverride).toBeUndefined()
    expect(Object.hasOwn(legacy ?? {}, 'windowLevelOverride')).toBe(false)
    // 版本仍是 1（可选扩展字段，不升 layout 版本、更不升 CONFIG_VERSION）
    expect(parsed.version).toBe(1)
  })

  it('windowLevelOverride 非法值只丢该字段，其余字段照常保留', () => {
    const badValues: unknown[] = ['topmost', 'AUTO', 'floating ', 42, null, {}, ['normal']]
    for (const bad of badValues) {
      const parsed = parseWidgetLayout({
        version: 1,
        widgets: {
          'com.example.hello/duty-week': {
            visible: false,
            x: 5,
            y: 6,
            width: 300,
            height: 200,
            windowLevelOverride: bad,
          },
        },
      })
      const entry = parsed.widgets['com.example.hello/duty-week']
      expect(entry).toMatchObject({ visible: false, x: 5, y: 6, width: 300, height: 200 })
      expect(entry?.windowLevelOverride).toBeUndefined()
    }
  })

  it('层级覆盖写盘后能读回（读写往返不丢）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aurora-widget-layout-'))
    try {
      await writeWidgetLayout(dir, {
        version: 1,
        widgets: {
          'com.example.hello/duty-week': {
            visible: true,
            x: 1,
            y: 2,
            width: 300,
            height: 200,
            windowLevelOverride: 'normal',
          },
        },
      })
      const loaded = await readWidgetLayout(dir)
      expect(loaded.version).toBe(1)
      expect(loaded.widgets['com.example.hello/duty-week']?.windowLevelOverride).toBe('normal')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('effectiveWidgetWindowLevel 复用 widget-window 的解析器（覆盖优先，缺省跟随声明）', () => {
    expect(effectiveWidgetWindowLevel('floating', 'desktop')).toBe('desktop')
    expect(effectiveWidgetWindowLevel('desktop', 'normal')).toBe('normal')
    expect(effectiveWidgetWindowLevel('normal', undefined)).toBe('normal')
    expect(effectiveWidgetWindowLevel('desktop', undefined)).toBe('desktop')
  })
})
