/**
 * 桌面小组件布局文件（docs/14 §5.3）—— 纯 Node，**不 import electron**，
 * 因此默认值 / 读取 / 夹取都能脱离 Electron 单测。
 *
 * 布局独立于 settings（不升 `CONFIG_VERSION`）：
 * `<userData>/plugin-widget-layout.json`
 */
import { join } from 'node:path'
import {
  PLUGIN_WIDGET_WINDOW_LEVELS,
  type PluginWidgetLayout,
  type PluginWidgetLayoutEntry,
  type PluginWidgetWindowLevel,
} from '@aurora/shared'
import { readJsonFile, writeJsonAtomic } from './fs-json.js'

/**
 * 用户覆盖优先的实际层级。判定只有 `widget-window.ts` 一份，这里只是给它一个和
 * 「布局解析」同组的顺手别名，避免调用方为了一个 `??` 再记两条口径。
 */
export { resolveWidgetWindowLevel as effectiveWidgetWindowLevel } from './widget-window.js'

export const WIDGET_LAYOUT_FILE = 'plugin-widget-layout.json'
export const WIDGET_LAYOUT_VERSION = 1
export const WIDGET_DEFAULT_WIDTH = 300
export const WIDGET_DEFAULT_HEIGHT = 200
export const WIDGET_CASCADE_STEP = 26
export const WIDGET_MIN_WIDTH = 120
export const WIDGET_MIN_HEIGHT = 80

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export function widgetLayoutPath(userData: string): string {
  return join(userData, WIDGET_LAYOUT_FILE)
}

/** 布局里 `windowLevelOverride` 的合法取值（v37）；非法值读取时丢弃，不影响其余字段。 */
function isWidgetWindowLevel(value: unknown): value is PluginWidgetWindowLevel {
  return (
    typeof value === 'string' && (PLUGIN_WIDGET_WINDOW_LEVELS as readonly string[]).includes(value)
  )
}

function isEntry(value: unknown): value is PluginWidgetLayoutEntry {
  if (typeof value !== 'object' || value === null) return false
  const raw = value as Record<string, unknown>
  return (
    typeof raw['visible'] === 'boolean' &&
    typeof raw['x'] === 'number' &&
    typeof raw['y'] === 'number' &&
    typeof raw['width'] === 'number' &&
    typeof raw['height'] === 'number'
  )
}

/**
 * 解析单个布局条目：基础字段非法整条丢弃；`windowLevelOverride` 非法只丢该字段。
 *
 * 显式拷贝已知字段（而不是 `{ ...value }`）：布局文件是用户可手改的，
 * 不把未知 / 未来字段带着走，也保证「旧文件（没有 override）读出来就是没有」。
 */
function parseEntry(value: unknown): PluginWidgetLayoutEntry | undefined {
  if (!isEntry(value)) return undefined
  const entry: PluginWidgetLayoutEntry = {
    visible: value.visible,
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
  }
  const override = (value as { windowLevelOverride?: unknown }).windowLevelOverride
  if (isWidgetWindowLevel(override)) entry.windowLevelOverride = override
  return entry
}

/** 解析布局 JSON：版本不符 / 条目损坏按住空布局重建（只丢位置，不丢数据）。 */
export function parseWidgetLayout(raw: unknown): PluginWidgetLayout {
  if (typeof raw !== 'object' || raw === null) {
    return { version: WIDGET_LAYOUT_VERSION, widgets: {} }
  }
  const record = raw as { version?: unknown; widgets?: unknown }
  if (record.version !== WIDGET_LAYOUT_VERSION) {
    return { version: WIDGET_LAYOUT_VERSION, widgets: {} }
  }
  const widgets: Record<string, PluginWidgetLayoutEntry> = {}
  if (typeof record.widgets === 'object' && record.widgets !== null) {
    for (const [key, value] of Object.entries(record.widgets as Record<string, unknown>)) {
      const entry = parseEntry(value)
      if (entry !== undefined) widgets[key] = entry
    }
  }
  return { version: WIDGET_LAYOUT_VERSION, widgets }
}

export async function readWidgetLayout(userData: string): Promise<PluginWidgetLayout> {
  return parseWidgetLayout(await readJsonFile<unknown>(widgetLayoutPath(userData), {}))
}

export async function writeWidgetLayout(
  userData: string,
  layout: PluginWidgetLayout,
): Promise<void> {
  await writeJsonAtomic(widgetLayoutPath(userData), {
    version: WIDGET_LAYOUT_VERSION,
    widgets: layout.widgets,
  })
}

/** 新小组件的默认位置：从工作区右上角向左下级联，避免叠在一起。 */
export function defaultWidgetEntry(
  area: Rect,
  index: number,
  size?: { width: number; height: number },
): PluginWidgetLayoutEntry {
  const width = Math.min(
    size?.width ?? WIDGET_DEFAULT_WIDTH,
    Math.max(WIDGET_MIN_WIDTH, area.width),
  )
  const height = Math.min(
    size?.height ?? WIDGET_DEFAULT_HEIGHT,
    Math.max(WIDGET_MIN_HEIGHT, area.height),
  )
  return {
    visible: true,
    x: area.x + area.width - width - 24 - index * WIDGET_CASCADE_STEP,
    y: area.y + 80 + index * WIDGET_CASCADE_STEP,
    width,
    height,
  }
}

/** 把窗口矩形夹到显示器工作区内（保留尺寸上限，防止横跨屏幕）。 */
export function clampWidgetBounds(bounds: Rect, area: Rect): Rect {
  const width = Math.min(
    Math.max(bounds.width, WIDGET_MIN_WIDTH),
    Math.max(WIDGET_MIN_WIDTH, area.width),
  )
  const height = Math.min(
    Math.max(bounds.height, WIDGET_MIN_HEIGHT),
    Math.max(WIDGET_MIN_HEIGHT, area.height),
  )
  return {
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
    width,
    height,
  }
}
