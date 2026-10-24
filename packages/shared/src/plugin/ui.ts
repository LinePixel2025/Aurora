/**
 * 声明式面板 schema（docs/14 §3.4、docs/15 §6）。
 *
 * 插件面板优先用这套组件渲染：它只有文本与受控控件，**没有 HTML / v-html**，
 * 因此不存在脚本注入面，也不依赖 webview 的沙箱。
 * 需要任意 HTML 的插件走 `entry`（`aurora-plugin://` 页面 + 专用 preload）。
 *
 * 本文件是纯函数 + 类型，渲染层与主进程（面板数据校验）共用；
 * **不得** import 任何 Node 内置模块。
 */

export const PLUGIN_UI_NODE_TYPES = [
  // 布局
  'stack',
  'row',
  'grid',
  'card',
  'divider',
  // 展示
  'heading',
  'text',
  'badge',
  'progress',
  'image',
  'list',
  'table',
  'keyValue',
  // 输入
  'button',
  'input',
  'textarea',
  'select',
  'toggle',
  'number',
  'slider',
] as const

export type PluginUiNodeType = (typeof PLUGIN_UI_NODE_TYPES)[number]

/** 面板 schema 的硬上限（主进程与渲染层各校验一次）。 */
export const PLUGIN_UI_LIMITS = {
  maxNodes: 500,
  maxDepth: 20,
  maxJsonBytes: 256 * 1024,
  maxTextLength: 4000,
  maxChildrenPerNode: 50,
  maxListItems: 200,
  maxTableRows: 200,
  maxTableColumns: 12,
  maxOptions: 100,
  maxActionParamsBytes: 8 * 1024,
} as const

export type PluginUiTone = 'default' | 'muted' | 'ok' | 'warn' | 'error'

export interface PluginUiAction {
  /** 调用 `invokePanel(panelId, method, params, ctx)` 的 method 名 */
  method: string
  params?: unknown
  /** 点击前的一句话确认文案（渲染层用内置确认条，不用 window.confirm） */
  confirm?: string
  /** 成功后的 toast（缺省沿用插件返回的 toast） */
  toast?: string
}

export interface PluginUiOption {
  value: string
  label: string
}

export interface PluginUiKeyValueItem {
  label: string
  value?: string
  tone?: PluginUiTone
}

export interface PluginUiTableColumn {
  key: string
  label: string
}

export interface PluginUiNode {
  type: PluginUiNodeType
  /** 布局子节点（stack / row / grid / card） */
  children?: PluginUiNode[]
  /** 通用文本（heading / text / badge / button 的标签 / 输入框标签） */
  text?: string
  /** card 标题 */
  title?: string
  tone?: PluginUiTone
  /** 进度 0–100 */
  percent?: number
  /** 列表 / keyValue 的条目 */
  items?: PluginUiKeyValueItem[]
  /** 表格列 */
  columns?: PluginUiTableColumn[]
  /** 表格行：列 key → 单元格文本 */
  rows?: Array<Record<string, string>>
  /** select 选项 */
  options?: PluginUiOption[]
  /** 输入类控件的占位与初始值 */
  placeholder?: string
  value?: string | number | boolean
  min?: number
  max?: number
  step?: number
  /** 控件 / 按钮的绑定键（插件侧从 `params.values` 读回） */
  bind?: string
  /** 按钮 / 表单提交动作 */
  action?: PluginUiAction
  /** 图片的相对路径（相对插件根，渲染层换成 aurora-plugin:// URI） */
  src?: string
  alt?: string
  disabled?: boolean
  /** grid 列数（1–4） */
  columnsCount?: number
  /** 节点级 id（供插件在返回的新 schema 里定位；仅用于 key） */
  id?: string
}

export interface PluginPanelSchema {
  version?: 1
  nodes: PluginUiNode[]
}

export interface PluginPanelValidation {
  ok: boolean
  errors: string[]
  schema?: PluginPanelSchema
}

const ACTION_METHOD_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/
const BIND_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/
const IMAGE_SRC_PATTERN = /^[a-zA-Z0-9_./-]+$/
const TONES: readonly string[] = ['default', 'muted', 'ok', 'warn', 'error']

function byteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 校验一份面板 schema：节点数 / 深度 / 文本长度 / 动作参数大小 / 图片路径逐项检查。
 * 任何一条不通过都返回 `ok: false`（整份拒绝，不做部分渲染）。
 */
export function validatePanelSchema(raw: unknown): PluginPanelValidation {
  const errors: string[] = []
  if (!isPlainObject(raw)) return { ok: false, errors: ['面板 schema 必须是对象'] }
  if (byteLength(raw) > PLUGIN_UI_LIMITS.maxJsonBytes) {
    return { ok: false, errors: ['面板 schema 超过 256 KB'] }
  }
  const nodes = raw['nodes']
  if (!Array.isArray(nodes)) return { ok: false, errors: ['面板 schema 缺少 nodes 数组'] }

  let count = 0
  let tooMany = false

  const walk = (node: unknown, depth: number): void => {
    if (tooMany) return
    count += 1
    if (count > PLUGIN_UI_LIMITS.maxNodes) {
      tooMany = true
      errors.push(`面板节点不能超过 ${PLUGIN_UI_LIMITS.maxNodes} 个`)
      return
    }
    if (depth > PLUGIN_UI_LIMITS.maxDepth) {
      errors.push(`面板嵌套不能超过 ${PLUGIN_UI_LIMITS.maxDepth} 层`)
      return
    }
    if (!isPlainObject(node)) {
      errors.push(`第 ${depth} 层存在非对象节点`)
      return
    }
    const type = node['type']
    if (typeof type !== 'string' || !(PLUGIN_UI_NODE_TYPES as readonly string[]).includes(type)) {
      errors.push(`未知节点类型 ${String(type)}`)
      return
    }
    if (type === 'text' || type === 'heading' || type === 'badge' || type === 'button') {
      if (node['text'] !== undefined && typeof node['text'] !== 'string') {
        errors.push(`${type}.text 必须是字符串`)
      }
      if (typeof node['text'] === 'string' && node['text'].length > PLUGIN_UI_LIMITS.maxTextLength) {
        errors.push(`${type}.text 不能超过 ${PLUGIN_UI_LIMITS.maxTextLength} 字`)
      }
    }
    if (type === 'card' && node['title'] !== undefined && typeof node['title'] !== 'string') {
      errors.push('card.title 必须是字符串')
    }
    if (node['tone'] !== undefined && !TONES.includes(String(node['tone']))) {
      errors.push(`非法 tone：${String(node['tone'])}`)
    }
    if (type === 'progress') {
      const percent = node['percent']
      if (typeof percent !== 'number' || !Number.isFinite(percent)) {
        errors.push('progress.percent 必须是数字')
      }
    }
    if (type === 'image') {
      const src = node['src']
      if (typeof src !== 'string' || !IMAGE_SRC_PATTERN.test(src) || src.includes('..')) {
        errors.push('image.src 必须是插件内的相对路径')
      }
    }
    if (type === 'select') {
      const options = node['options']
      if (!Array.isArray(options) || options.length === 0) {
        errors.push('select.options 不能为空')
      } else if (options.length > PLUGIN_UI_LIMITS.maxOptions) {
        errors.push(`select.options 不能超过 ${PLUGIN_UI_LIMITS.maxOptions} 项`)
      } else if (
        options.some(
          (option) =>
            !isPlainObject(option) ||
            typeof option['value'] !== 'string' ||
            typeof option['label'] !== 'string',
        )
      ) {
        errors.push('select.options 每项必须有 value / label 字符串')
      }
    }
    if (type === 'list' || type === 'keyValue') {
      const items = node['items']
      if (!Array.isArray(items)) {
        errors.push(`${type}.items 必须是数组`)
      } else if (items.length > PLUGIN_UI_LIMITS.maxListItems) {
        errors.push(`${type}.items 不能超过 ${PLUGIN_UI_LIMITS.maxListItems} 项`)
      } else if (
        items.some(
          (item) =>
            !isPlainObject(item) ||
            typeof item['label'] !== 'string' ||
            (item['value'] !== undefined && typeof item['value'] !== 'string'),
        )
      ) {
        errors.push(`${type}.items 每项必须有 label 字符串`)
      }
    }
    if (type === 'table') {
      const columns = node['columns']
      const rows = node['rows']
      if (!Array.isArray(columns) || columns.length === 0) {
        errors.push('table.columns 不能为空')
      } else if (columns.length > PLUGIN_UI_LIMITS.maxTableColumns) {
        errors.push(`table.columns 不能超过 ${PLUGIN_UI_LIMITS.maxTableColumns} 列`)
      } else if (
        columns.some(
          (column) =>
            !isPlainObject(column) ||
            typeof column['key'] !== 'string' ||
            typeof column['label'] !== 'string',
        )
      ) {
        errors.push('table.columns 每项必须有 key / label 字符串')
      }
      if (!Array.isArray(rows)) {
        errors.push('table.rows 必须是数组')
      } else if (rows.length > PLUGIN_UI_LIMITS.maxTableRows) {
        errors.push(`table.rows 不能超过 ${PLUGIN_UI_LIMITS.maxTableRows} 行`)
      } else if (rows.some((row) => !isPlainObject(row))) {
        errors.push('table.rows 每行必须是对象')
      }
    }
    if (node['bind'] !== undefined) {
      if (typeof node['bind'] !== 'string' || !BIND_PATTERN.test(node['bind'])) {
        errors.push('bind 必须是字母开头的标识符')
      }
    }
    if (node['action'] !== undefined) {
      const action = node['action']
      if (!isPlainObject(action)) {
        errors.push('action 必须是对象')
      } else {
        if (typeof action['method'] !== 'string' || !ACTION_METHOD_PATTERN.test(action['method'])) {
          errors.push('action.method 非法')
        }
        if (byteLength(action['params']) > PLUGIN_UI_LIMITS.maxActionParamsBytes) {
          errors.push('action.params 超过 8 KB')
        }
        if (action['confirm'] !== undefined && typeof action['confirm'] !== 'string') {
          errors.push('action.confirm 必须是字符串')
        }
      }
    }
    if (node['columnsCount'] !== undefined) {
      const value = node['columnsCount']
      if (typeof value !== 'number' || value < 1 || value > 4) {
        errors.push('grid.columnsCount 必须在 1–4 之间')
      }
    }
    const children = node['children']
    if (children !== undefined) {
      if (!Array.isArray(children)) {
        errors.push('children 必须是数组')
      } else if (children.length > PLUGIN_UI_LIMITS.maxChildrenPerNode) {
        errors.push(`单个节点的子节点不能超过 ${PLUGIN_UI_LIMITS.maxChildrenPerNode} 个`)
      } else {
        for (const child of children) walk(child, depth + 1)
      }
    }
  }

  for (const node of nodes) walk(node, 1)

  if (tooMany || errors.length > 0) {
    return { ok: false, errors: [...new Set(errors)] }
  }
  return { ok: true, errors: [], schema: raw as unknown as PluginPanelSchema }
}
