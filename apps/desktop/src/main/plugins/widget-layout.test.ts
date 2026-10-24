import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clampWidgetBounds,
  defaultWidgetEntry,
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
})
