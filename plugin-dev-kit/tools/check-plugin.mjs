#!/usr/bin/env node
/* global process, Buffer */
/**
 * 独立插件校验器（Aurora 插件 API v1，工具包 v0.5.9）。
 *
 * 只用 Node 内置模块，零依赖：
 *   node tools/check-plugin.mjs <插件目录> [--json]
 *
 * 检查范围与宿主清单 zod schema **手动同口径**（本工具不依赖 Aurora 工作区）：
 * 清单字段 / 权限与贡献对应 / 路径 containment / 面板与小组件约束 /
 * 主题令牌白名单 / 配置字段 / 自动化 / 宿主事件 / 引用文件存在 / 声明式 schema。
 *
 * 退出码：0 通过；1 校验失败；2 用法错误。
 *
 * 注意：这是在 Aurora 源码之外的**基础**校验；装进 Aurora 时宿主会用同一份
 * zod schema 再校验一次。zip 包请在 Aurora 仓库运行 `node scripts/verify-plugin.mjs <zip>`。
 */
import { promises as fs } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

const EXIT_OK = 0
const EXIT_INVALID = 1
const EXIT_USAGE = 2

const PERMISSIONS = new Set([
  'tools',
  'skills',
  'commands',
  'automation',
  'automation.events',
  'storage',
  'config',
  'usage',
  'net',
  'net.private',
  'notifications',
  'logging',
  'ui.panels',
  'ui.widgets',
  'themes',
  'events',
])

// 与 shared/src/plugin/ids.ts 同口径：保留段包含 system / core。
const RESERVED_ID_SEGMENTS = ['aurora', 'builtin', 'plugin', 'mcp', 'skill', 'system', 'core']

// 与 shared/src/plugin/ids.ts 的 RESERVED_COMMAND_NAMES 同口径。
const RESERVED_COMMAND_NAMES = new Set([
  'new',
  'clear',
  'init',
  'compact',
  'subagents',
  'settings',
  'stop',
])

// 与 shared/src/plugin/protocol.ts 的 PLUGIN_HOST_EVENTS 同口径。
const HOST_EVENTS = new Set([
  'settings.changed',
  'message.user',
  'message.assistant',
  'tool.after',
  'session.created',
  'session.deleted',
  'theme.changed',
])

// 与 shared/src/plugin/icons.ts 的 PLUGIN_PANEL_ICONS 同口径。
const PANEL_ICONS = new Set([
  'Blocks',
  'Puzzle',
  'ListChecks',
  'Gauge',
  'CalendarClock',
  'Bot',
  'Workflow',
  'FolderOpen',
  'Globe',
  'Terminal',
  'FileText',
  'Sparkles',
  'Bell',
  'BellRing',
  'Search',
  'Clock',
  'CirclePlay',
  'Play',
  'History',
  'MessageSquare',
])

// 与 shared/src/plugin/ui.ts 的 PLUGIN_UI_NODE_TYPES 同口径。
const UI_NODE_TYPES = new Set([
  'stack',
  'row',
  'grid',
  'card',
  'divider',
  'heading',
  'text',
  'badge',
  'progress',
  'image',
  'list',
  'table',
  'keyValue',
  'button',
  'input',
  'textarea',
  'select',
  'toggle',
  'number',
  'slider',
])

const UI_TONES = new Set(['default', 'muted', 'ok', 'warn', 'error'])

// 与 shared/src/plugin/themes.ts 同口径：只允许表面 / 文字 / 边框 / 圆角 / 状态色。
const THEME_COLOR_TOKENS = new Set([
  '--bg-base',
  '--bg-raised',
  '--bg-overlay',
  '--bg-glass',
  '--fill-1',
  '--fill-2',
  '--fill-3',
  '--border-subtle',
  '--border-strong',
  '--text-primary',
  '--text-secondary',
  '--text-muted',
  '--ok-text',
  '--ok-fill',
  '--error-text',
  '--error-fill',
  '--danger-text',
  '--danger-fill',
  '--selection-fill',
  '--scrollbar-hover',
])

const THEME_RADIUS_TOKENS = new Set([
  '--radius-xs',
  '--radius-sm',
  '--radius-md',
  '--radius-lg',
  '--radius-xl',
  '--radius-pill',
])

const COLOR_PATTERN =
  /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\(\s*(?:\d{1,3}%?\s*,\s*){2}\d{1,3}%?\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)|hsla?\(\s*-?\d{1,3}(?:deg)?\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\))$/i

const LENGTH_PATTERN = /^(?:0|\d+(?:\.\d+)?(?:px|rem|em|%))$/

const WIDGET_WINDOW_LEVELS = new Set(['floating', 'normal', 'desktop'])
const WIDGET_WINDOW_MATERIALS = new Set(['none', 'acrylic'])

const ID_PATTERN = /^[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])?)+$/
const PANEL_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
const ACTION_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,24}$/
const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9a-zA-Z.-]+)?$/
const CONFIG_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/
const BIND_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/
const ACTION_METHOD_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/
const IMAGE_SRC_PATTERN = /^[a-zA-Z0-9_./-]+$/

const LIMITS = {
  maxManifestBytes: 64 * 1024,
  maxTools: 32,
  maxSkills: 16,
  maxCommands: 32,
  maxPanels: 8,
  maxWidgets: 4,
  maxThemes: 8,
  maxAutomationActions: 16,
  maxAutomationEvents: 16,
  maxConfigFields: 32,
  maxPermissions: 16,
  maxToolSchemaBytes: 64 * 1024,
  maxThemeTokens: 64,
  maxUiBytes: 256 * 1024,
  maxNodes: 500,
  maxDepth: 20,
  maxText: 4000,
  maxChildren: 50,
  maxListItems: 200,
  maxTableRows: 200,
  maxTableColumns: 12,
  maxOptions: 100,
  maxActionParamsBytes: 8 * 1024,
}

const MANIFEST_KEYS = [
  'id',
  'name',
  'version',
  'apiVersion',
  'minAuroraVersion',
  'description',
  'author',
  'license',
  'homepage',
  'main',
  'activation',
  'permissions',
  'contributes',
  'config',
  'events',
  'icon',
]
const CONTRIBUTES_KEYS = [
  'tools',
  'skills',
  'commands',
  'automation',
  'panels',
  'widgets',
  'themes',
]
const AUTOMATION_KEYS = ['actions', 'events']
const TOOL_KEYS = ['name', 'description', 'parameters', 'sensitivity', 'readonly', 'timeoutMs']
const COMMAND_KEYS = ['name', 'title', 'description', 'mode']
const PANEL_KEYS = ['id', 'title', 'icon', 'schema', 'entry']
const WIDGET_KEYS = [
  'id',
  'title',
  'icon',
  'slot',
  'windowLevel',
  'windowMaterial',
  'hideCloseButton',
  'schema',
  'entry',
  'defaultSize',
]
const THEME_KEYS = ['id', 'name', 'tokens']
const CONFIG_FIELD_KEYS = [
  'key',
  'label',
  'type',
  'description',
  'placeholder',
  'default',
  'min',
  'max',
  'step',
  'options',
]
const AUTOMATION_ACTION_KEYS = ['name', 'title', 'description', 'fields']
const AUTOMATION_FIELD_KEYS = ['key', 'label', 'type', 'placeholder', 'hint', 'options']

const errors = []
const warnings = []

function error(message) {
  errors.push(message)
}

function warn(message) {
  warnings.push(message)
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUrl(value) {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

function byteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function normalizePluginPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const normalized = value.replace(/\\/g, '/')
  if (normalized.includes('\0')) return null
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('//')) {
    return null
  }
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '..' || segment === '.' || segment === '')) return null
  return segments.join('/')
}

function within(root, target) {
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

async function exists(path) {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

function warnUnknownKeys(value, allowed, label) {
  if (!isPlainObject(value)) return
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      warn(`${label} 含未知字段「${key}」（宿主会忽略，确认是否拼写错误）`)
    }
  }
}

function resolveInside(root, relativePath, label) {
  const normalized = normalizePluginPath(relativePath)
  if (normalized === null) {
    error(`${label} 不是合法的包内相对路径：${String(relativePath)}`)
    return null
  }
  const target = resolve(root, normalized)
  if (!within(root, target)) {
    error(`${label} 越出插件根：${relativePath}`)
    return null
  }
  return { normalized, target }
}

async function requireFile(root, relativePath, label) {
  const resolved = resolveInside(root, relativePath, label)
  if (resolved === null) return
  if (!(await exists(resolved.target))) error(`${label} 文件不存在：${relativePath}`)
}

/**
 * Skill 目录口径（docs/14 §3.3）：目录本身含 SKILL.md，或下一层技能子目录含 SKILL.md。
 * 比“必须直接含 SKILL.md”宽松，与宿主扫描顺序一致。
 */
async function checkSkillDirectory(root, relativePath, label) {
  const resolved = resolveInside(root, relativePath, label)
  if (resolved === null) return
  const stat = await fs.stat(resolved.target).catch(() => null)
  if (stat === null) {
    error(`${label} 目录不存在：${relativePath}`)
    return
  }
  if (!stat.isDirectory()) {
    error(`${label} 必须是目录：${relativePath}`)
    return
  }
  if (await exists(join(resolved.target, 'SKILL.md'))) return
  const entries = await fs.readdir(resolved.target, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (await exists(join(resolved.target, entry.name, 'SKILL.md'))) return
  }
  error(`${label} 缺少 SKILL.md（目录本身或下一层技能子目录里都要有）：${relativePath}`)
}

async function validateUiSchema(raw, label, root) {
  if (!isPlainObject(raw)) {
    error(`${label} 必须是对象`)
    return
  }
  if (byteLength(raw) > LIMITS.maxUiBytes) {
    error(`${label} 超过 256 KB`)
    return
  }
  if (!Array.isArray(raw.nodes)) {
    error(`${label} 必须是 { "version": 1, "nodes": [...] }`)
    return
  }

  let count = 0
  let tooMany = false
  const imageSources = []

  const walk = (node, depth) => {
    if (tooMany) return
    count += 1
    if (count > LIMITS.maxNodes) {
      tooMany = true
      error(`${label} 节点超过 ${LIMITS.maxNodes} 个`)
      return
    }
    if (depth > LIMITS.maxDepth) {
      error(`${label} 嵌套超过 ${LIMITS.maxDepth} 层`)
      return
    }
    if (!isPlainObject(node)) {
      error(`${label} 第 ${depth} 层存在非对象节点`)
      return
    }
    const type = node.type
    if (typeof type !== 'string' || !UI_NODE_TYPES.has(type)) {
      error(`${label} 未知节点类型：${String(type)}`)
      return
    }
    if (['text', 'heading', 'badge', 'button'].includes(type)) {
      if (node.text !== undefined && typeof node.text !== 'string') {
        error(`${label} 的 ${type}.text 必须是字符串`)
      }
      if (typeof node.text === 'string' && node.text.length > LIMITS.maxText) {
        error(`${label} 的 ${type}.text 超过 ${LIMITS.maxText} 字`)
      }
    }
    if (type === 'card' && node.title !== undefined && typeof node.title !== 'string') {
      error(`${label} 的 card.title 必须是字符串`)
    }
    if (node.tone !== undefined && !UI_TONES.has(String(node.tone))) {
      error(`${label} 的 tone 非法：${String(node.tone)}`)
    }
    if (type === 'progress') {
      if (typeof node.percent !== 'number' || !Number.isFinite(node.percent)) {
        error(`${label} 的 progress.percent 必须是数字`)
      }
    }
    if (type === 'image') {
      if (
        typeof node.src !== 'string' ||
        !IMAGE_SRC_PATTERN.test(node.src) ||
        node.src.includes('..')
      ) {
        error(`${label} 的 image.src 必须是插件内的相对路径`)
      } else {
        imageSources.push(node.src)
      }
    }
    if (type === 'select') {
      const options = node.options
      if (!Array.isArray(options) || options.length === 0) {
        error(`${label} 的 select.options 不能为空`)
      } else if (options.length > LIMITS.maxOptions) {
        error(`${label} 的 select.options 不能超过 ${LIMITS.maxOptions} 项`)
      } else if (
        options.some(
          (option) =>
            !isPlainObject(option) ||
            typeof option.value !== 'string' ||
            typeof option.label !== 'string',
        )
      ) {
        error(`${label} 的 select.options 每项必须有 value / label 字符串`)
      }
    }
    if (type === 'list' || type === 'keyValue') {
      const items = node.items
      if (!Array.isArray(items)) {
        error(`${label} 的 ${type}.items 必须是数组`)
      } else if (items.length > LIMITS.maxListItems) {
        error(`${label} 的 ${type}.items 不能超过 ${LIMITS.maxListItems} 项`)
      } else if (
        items.some(
          (item) =>
            !isPlainObject(item) ||
            typeof item.label !== 'string' ||
            (item.value !== undefined && typeof item.value !== 'string'),
        )
      ) {
        error(`${label} 的 ${type}.items 每项必须有 label 字符串`)
      }
    }
    if (type === 'table') {
      const columns = node.columns
      const rows = node.rows
      if (!Array.isArray(columns) || columns.length === 0) {
        error(`${label} 的 table.columns 不能为空`)
      } else if (columns.length > LIMITS.maxTableColumns) {
        error(`${label} 的 table.columns 不能超过 ${LIMITS.maxTableColumns} 列`)
      } else if (
        columns.some(
          (column) =>
            !isPlainObject(column) ||
            typeof column.key !== 'string' ||
            typeof column.label !== 'string',
        )
      ) {
        error(`${label} 的 table.columns 每项必须有 key / label 字符串`)
      }
      if (!Array.isArray(rows)) {
        error(`${label} 的 table.rows 必须是数组`)
      } else if (rows.length > LIMITS.maxTableRows) {
        error(`${label} 的 table.rows 不能超过 ${LIMITS.maxTableRows} 行`)
      } else if (rows.some((row) => !isPlainObject(row))) {
        error(`${label} 的 table.rows 每行必须是对象`)
      }
    }
    if (node.bind !== undefined) {
      if (typeof node.bind !== 'string' || !BIND_PATTERN.test(node.bind)) {
        error(`${label} 的 bind 必须是字母开头的标识符`)
      }
    }
    if (type === 'grid' && node.columnsCount !== undefined) {
      if (!Number.isInteger(node.columnsCount) || node.columnsCount < 1 || node.columnsCount > 4) {
        error(`${label} 的 grid.columnsCount 必须是 1–4 的整数`)
      }
    }
    if (node.action !== undefined) {
      const action = node.action
      if (!isPlainObject(action)) {
        error(`${label} 的 action 必须是对象`)
      } else {
        if (typeof action.method !== 'string' || !ACTION_METHOD_PATTERN.test(action.method)) {
          error(`${label} 的 action.method 非法`)
        }
        if (byteLength(action.params ?? {}) > LIMITS.maxActionParamsBytes) {
          error(`${label} 的 action.params 超过 8 KB`)
        }
        if (action.confirm !== undefined && typeof action.confirm !== 'string') {
          error(`${label} 的 action.confirm 必须是字符串`)
        }
        if (action.toast !== undefined && typeof action.toast !== 'string') {
          error(`${label} 的 action.toast 必须是字符串`)
        }
      }
    }
    if (Array.isArray(node.children)) {
      if (node.children.length > LIMITS.maxChildren) {
        error(`${label} 的 ${type}.children 不能超过 ${LIMITS.maxChildren} 个`)
      }
      for (const child of node.children) walk(child, depth + 1)
    }
  }

  for (const node of raw.nodes) walk(node, 1)

  for (const source of imageSources) {
    const normalized = normalizePluginPath(source)
    if (normalized === null) {
      error(`${label} 的 image.src 不是合法的包内相对路径：${source}`)
      continue
    }
    if (!(await exists(join(root, normalized)))) {
      error(`${label} 的 image.src 文件不存在：${source}`)
    }
  }
}

async function validateSchemaFile(root, relativePath, label) {
  const resolved = resolveInside(root, relativePath, label)
  if (resolved === null) return
  if (!(await exists(resolved.target))) {
    error(`${label} 文件不存在：${relativePath}`)
    return
  }
  let raw
  try {
    raw = JSON.parse(await fs.readFile(resolved.target, 'utf8'))
  } catch (cause) {
    error(`${label} 不是合法 JSON：${String(cause)}`)
    return
  }
  await validateUiSchema(raw, label, root)
}

function requirePermission(permissions, permission, present, label) {
  if (present && !permissions.has(permission)) error(`${label}：缺少权限「${permission}」`)
}

function checkTool(tool, index, pluginId, permissions) {
  const at = `contributes.tools[${index}]`
  if (!isPlainObject(tool)) {
    error(`${at} 必须是对象`)
    return
  }
  warnUnknownKeys(tool, TOOL_KEYS, at)
  if (typeof tool.name !== 'string' || !TOOL_NAME_PATTERN.test(tool.name)) {
    error(`${at}.name 必须是 a-z / 0-9 / 下划线，≤ 25 字符`)
  } else {
    const full = `plugin.${pluginId}.${tool.name}`
    if (full.length > 64) error(`${at} 的最终工具名超过 64 字符：${full}`)
  }
  if (
    typeof tool.description !== 'string' ||
    tool.description.trim() === '' ||
    tool.description.length > 500
  ) {
    error(`${at}.description 必填且 ≤ 500 字符`)
  }
  if (!isPlainObject(tool.parameters) || tool.parameters.type !== 'object') {
    error(`${at}.parameters 必须是 type:"object" 的 JSON Schema`)
  } else if (byteLength(tool.parameters) > LIMITS.maxToolSchemaBytes) {
    error(`${at}.parameters 超过 64 KB`)
  }
  if (tool.sensitivity !== undefined && !['safe', 'confirm'].includes(tool.sensitivity)) {
    error(`${at}.sensitivity 只能是 safe / confirm`)
  }
  if (tool.readonly !== undefined && typeof tool.readonly !== 'boolean') {
    error(`${at}.readonly 必须是布尔值`)
  }
  if (
    tool.timeoutMs !== undefined &&
    (!Number.isInteger(tool.timeoutMs) || tool.timeoutMs < 1000 || tool.timeoutMs > 600_000)
  ) {
    error(`${at}.timeoutMs 必须是 1000–600000 的整数`)
  }
  void permissions
}

function checkCommand(command, index, permissions) {
  const at = `contributes.commands[${index}]`
  if (!isPlainObject(command)) {
    error(`${at} 必须是对象`)
    return
  }
  warnUnknownKeys(command, COMMAND_KEYS, at)
  if (typeof command.name !== 'string' || !COMMAND_NAME_PATTERN.test(command.name)) {
    error(`${at}.name 必须是 a-z / 0-9 / 下划线 / 连字符，≤ 32 字符`)
  } else if (RESERVED_COMMAND_NAMES.has(command.name)) {
    error(`${at}.name「${command.name}」与内置命令重名`)
  }
  if (
    typeof command.title !== 'string' ||
    command.title.trim() === '' ||
    command.title.length > 60
  ) {
    error(`${at}.title 必填且 ≤ 60 字符`)
  }
  if (
    typeof command.description !== 'string' ||
    command.description.trim() === '' ||
    command.description.length > 200
  ) {
    error(`${at}.description 必填且 ≤ 200 字符`)
  }
  if (!['action', 'prompt'].includes(command.mode)) {
    error(`${at}.mode 只能是 action / prompt`)
  }
  void permissions
}

function checkAutomation(automation, permissions) {
  if (!isPlainObject(automation)) {
    if (automation !== undefined) error('contributes.automation 必须是对象')
    return
  }
  warnUnknownKeys(automation, AUTOMATION_KEYS, 'contributes.automation')
  const actions = Array.isArray(automation.actions) ? automation.actions : []
  const events = Array.isArray(automation.events) ? automation.events : []
  if (actions.length > LIMITS.maxAutomationActions) {
    error(`自动化动作不能超过 ${LIMITS.maxAutomationActions} 个`)
  }
  if (events.length > LIMITS.maxAutomationEvents) {
    error(`自动化事件不能超过 ${LIMITS.maxAutomationEvents} 个`)
  }
  requirePermission(permissions, 'automation', actions.length > 0, '声明自动化动作')
  requirePermission(permissions, 'automation.events', events.length > 0, '声明自动化事件')

  const actionNames = new Set()
  actions.forEach((action, index) => {
    const at = `contributes.automation.actions[${index}]`
    if (!isPlainObject(action)) {
      error(`${at} 必须是对象`)
      return
    }
    warnUnknownKeys(action, AUTOMATION_ACTION_KEYS, at)
    if (typeof action.name !== 'string' || !ACTION_NAME_PATTERN.test(action.name)) {
      error(`${at}.name 非法`)
    } else if (actionNames.has(action.name)) {
      error(`自动化动作名重复：${action.name}`)
    } else {
      actionNames.add(action.name)
    }
    if (
      typeof action.title !== 'string' ||
      action.title.trim() === '' ||
      action.title.length > 60
    ) {
      error(`${at}.title 必填且 ≤ 60 字符`)
    }
    if (
      typeof action.description !== 'string' ||
      action.description.trim() === '' ||
      action.description.length > 200
    ) {
      error(`${at}.description 必填且 ≤ 200 字符`)
    }
    const fields = Array.isArray(action.fields) ? action.fields : []
    if (fields.length > 16) error(`${at}.fields 不能超过 16 个`)
    fields.forEach((field, fieldIndex) => {
      const fieldAt = `${at}.fields[${fieldIndex}]`
      if (!isPlainObject(field)) {
        error(`${fieldAt} 必须是对象`)
        return
      }
      warnUnknownKeys(field, AUTOMATION_FIELD_KEYS, fieldAt)
      if (typeof field.key !== 'string' || !CONFIG_KEY_PATTERN.test(field.key)) {
        error(`${fieldAt}.key 非法`)
      }
      if (typeof field.label !== 'string' || field.label.trim() === '' || field.label.length > 60) {
        error(`${fieldAt}.label 必填且 ≤ 60 字符`)
      }
      if (!['text', 'number', 'select', 'json'].includes(field.type)) {
        error(`${fieldAt}.type 只能是 text / number / select / json`)
      }
      if (field.placeholder !== undefined && typeof field.placeholder !== 'string') {
        error(`${fieldAt}.placeholder 必须是字符串`)
      }
      if (field.hint !== undefined && typeof field.hint !== 'string') {
        error(`${fieldAt}.hint 必须是字符串`)
      }
      if (field.options !== undefined) {
        if (!Array.isArray(field.options) || field.options.length > 50) {
          error(`${fieldAt}.options 必须是不超过 50 项的数组`)
        } else if (
          field.options.some(
            (option) =>
              !isPlainObject(option) ||
              typeof option.value !== 'string' ||
              typeof option.label !== 'string',
          )
        ) {
          error(`${fieldAt}.options 每项必须有 value / label 字符串`)
        }
      }
    })
  })

  const eventNames = new Set()
  events.forEach((event, index) => {
    const at = `contributes.automation.events[${index}]`
    if (!isPlainObject(event)) {
      error(`${at} 必须是对象`)
      return
    }
    warnUnknownKeys(event, ['name', 'title', 'description'], at)
    if (typeof event.name !== 'string' || !ACTION_NAME_PATTERN.test(event.name)) {
      error(`${at}.name 非法`)
    } else if (eventNames.has(event.name)) {
      error(`自动化事件名重复：${event.name}`)
    } else {
      eventNames.add(event.name)
    }
    if (typeof event.title !== 'string' || event.title.trim() === '' || event.title.length > 60) {
      error(`${at}.title 必填且 ≤ 60 字符`)
    }
    if (
      event.description !== undefined &&
      (typeof event.description !== 'string' || event.description.length > 200)
    ) {
      error(`${at}.description ≤ 200 字符`)
    }
  })
}

async function checkPanels(panels, root, permissions) {
  if (panels.length > LIMITS.maxPanels) error(`面板不能超过 ${LIMITS.maxPanels} 个`)
  const ids = new Set()
  for (const [index, panel] of panels.entries()) {
    const at = `contributes.panels[${index}]`
    if (!isPlainObject(panel)) {
      error(`${at} 必须是对象`)
      continue
    }
    warnUnknownKeys(panel, PANEL_KEYS, at)
    if (typeof panel.id !== 'string' || !PANEL_ID_PATTERN.test(panel.id)) {
      error(`${at}.id 必须是 a-z / 0-9 / 连字符，≤ 32 字符`)
    } else if (ids.has(panel.id)) {
      error(`面板 id 重复：${panel.id}`)
    } else {
      ids.add(panel.id)
    }
    if (typeof panel.title !== 'string' || panel.title.trim() === '' || panel.title.length > 40) {
      error(`${at}.title 必填且 ≤ 40 字符`)
    }
    if (panel.icon !== undefined && !PANEL_ICONS.has(panel.icon)) {
      error(`${at}.icon 不在白名单：${String(panel.icon)}`)
    }
    const hasSchema = panel.schema !== undefined
    const hasEntry = panel.entry !== undefined
    if (hasSchema === hasEntry) {
      error(`面板 ${panel.id ?? index} 必须且只能声明 schema 或 entry 之一`)
      continue
    }
    if (hasSchema) {
      await validateSchemaFile(root, panel.schema, `面板 ${panel.id ?? index} schema`)
    }
    if (hasEntry) {
      await requireFile(root, panel.entry, `面板 ${panel.id ?? index} entry`)
    }
  }
  requirePermission(permissions, 'ui.panels', panels.length > 0, '声明面板')
}

async function checkWidgets(widgets, root, permissions) {
  if (widgets.length > LIMITS.maxWidgets) {
    error(`小组件不能超过 ${LIMITS.maxWidgets} 个`)
  }
  const ids = new Set()
  for (const [index, widget] of widgets.entries()) {
    const at = `contributes.widgets[${index}]`
    if (!isPlainObject(widget)) {
      error(`${at} 必须是对象`)
      continue
    }
    warnUnknownKeys(widget, WIDGET_KEYS, at)
    if (typeof widget.id !== 'string' || !PANEL_ID_PATTERN.test(widget.id)) {
      error(`${at}.id 必须是 a-z / 0-9 / 连字符，≤ 32 字符`)
    } else if (ids.has(widget.id)) {
      error(`小组件 id 重复：${widget.id}`)
    } else {
      ids.add(widget.id)
    }
    if (
      typeof widget.title !== 'string' ||
      widget.title.trim() === '' ||
      widget.title.length > 40
    ) {
      error(`${at}.title 必填且 ≤ 40 字符`)
    }
    if (widget.icon !== undefined && !PANEL_ICONS.has(widget.icon)) {
      error(`${at}.icon 不在白名单：${String(widget.icon)}`)
    }
    if (!['desktop', 'edge-bar'].includes(widget.slot)) {
      error(`${at}.slot 必须是 desktop 或 edge-bar`)
      continue
    }
    if (widget.windowLevel !== undefined && !WIDGET_WINDOW_LEVELS.has(widget.windowLevel)) {
      error(`${at}.windowLevel 必须是 floating / normal / desktop`)
    }
    if (
      widget.windowMaterial !== undefined &&
      !WIDGET_WINDOW_MATERIALS.has(widget.windowMaterial)
    ) {
      error(`${at}.windowMaterial 必须是 none / acrylic`)
    }
    if (widget.hideCloseButton !== undefined && typeof widget.hideCloseButton !== 'boolean') {
      error(`${at}.hideCloseButton 必须是布尔值`)
    }
    const hasSchema = widget.schema !== undefined
    const hasEntry = widget.entry !== undefined
    if (hasSchema === hasEntry) {
      error(`小组件 ${widget.id ?? index} 必须且只能声明 schema 或 entry 之一`)
      continue
    }
    if (widget.slot === 'edge-bar') {
      if (hasEntry) error(`提示条小组件 ${widget.id ?? index} 只允许 schema，不允许 entry`)
      if (widget.defaultSize !== undefined) {
        error(`提示条小组件 ${widget.id ?? index} 不支持 defaultSize`)
      }
      if (widget.windowLevel !== undefined && widget.windowLevel !== 'floating') {
        error(`提示条小组件 ${widget.id ?? index} 不支持 windowLevel（只允许默认 floating）`)
      }
      if (widget.windowMaterial !== undefined && widget.windowMaterial !== 'none') {
        error(`提示条小组件 ${widget.id ?? index} 不支持 windowMaterial（只允许默认 none）`)
      }
      if (widget.hideCloseButton === true) {
        error(`提示条小组件 ${widget.id ?? index} 不支持 hideCloseButton`)
      }
    }
    if (widget.defaultSize !== undefined) {
      const size = widget.defaultSize
      if (
        !isPlainObject(size) ||
        !Number.isInteger(size.width) ||
        !Number.isInteger(size.height) ||
        size.width < 120 ||
        size.width > 1200 ||
        size.height < 80 ||
        size.height > 900
      ) {
        error(`小组件 ${widget.id ?? index} 的 defaultSize 必须在 120–1200 × 80–900 之间`)
      }
    }
    if (hasSchema) {
      await validateSchemaFile(root, widget.schema, `小组件 ${widget.id ?? index} schema`)
    }
    if (hasEntry) {
      await requireFile(root, widget.entry, `小组件 ${widget.id ?? index} entry`)
    }
  }
  requirePermission(permissions, 'ui.widgets', widgets.length > 0, '声明小组件')
}

function checkThemes(themes, permissions) {
  if (themes.length > LIMITS.maxThemes) error(`主题不能超过 ${LIMITS.maxThemes} 个`)
  const ids = new Set()
  for (const [index, theme] of themes.entries()) {
    const at = `contributes.themes[${index}]`
    if (!isPlainObject(theme)) {
      error(`${at} 必须是对象`)
      continue
    }
    warnUnknownKeys(theme, THEME_KEYS, at)
    if (typeof theme.id !== 'string' || !PANEL_ID_PATTERN.test(theme.id)) {
      error(`${at}.id 必须是 a-z / 0-9 / 连字符，≤ 32 字符`)
    } else if (ids.has(theme.id)) {
      error(`主题 id 重复：${theme.id}`)
    } else {
      ids.add(theme.id)
    }
    if (typeof theme.name !== 'string' || theme.name.trim() === '' || theme.name.length > 40) {
      error(`${at}.name 必填且 ≤ 40 字符`)
    }
    if (!isPlainObject(theme.tokens)) {
      error(`${at}.tokens 必须是对象`)
      continue
    }
    const entries = Object.entries(theme.tokens)
    if (entries.length > LIMITS.maxThemeTokens) {
      error(`${at}.tokens 不能超过 ${LIMITS.maxThemeTokens} 个`)
    }
    for (const [token, value] of entries) {
      if (typeof value !== 'string') {
        error(`${at}.tokens「${token}」的值必须是字符串`)
        continue
      }
      if (THEME_COLOR_TOKENS.has(token)) {
        if (!COLOR_PATTERN.test(value.trim())) {
          error(`${at}.tokens「${token}」不是合法颜色`)
        }
      } else if (THEME_RADIUS_TOKENS.has(token)) {
        if (!LENGTH_PATTERN.test(value.trim())) {
          error(`${at}.tokens「${token}」必须是长度（如 12px）`)
        }
      } else {
        error(`${at}.tokens 不允许覆盖令牌「${token}」（强调色与毛玻璃由用户外观设置独占）`)
      }
    }
  }
  requirePermission(permissions, 'themes', themes.length > 0, '声明主题')
}

function checkConfig(config) {
  if (config === undefined) return
  if (!isPlainObject(config)) {
    error('config 必须是对象')
    return
  }
  warnUnknownKeys(config, ['fields'], 'config')
  const fields = Array.isArray(config.fields) ? config.fields : []
  if (config.fields !== undefined && !Array.isArray(config.fields)) {
    error('config.fields 必须是数组')
  }
  if (fields.length > LIMITS.maxConfigFields) {
    error(`配置项不能超过 ${LIMITS.maxConfigFields} 个`)
  }
  const keys = new Set()
  fields.forEach((field, index) => {
    const at = `config.fields[${index}]`
    if (!isPlainObject(field)) {
      error(`${at} 必须是对象`)
      return
    }
    warnUnknownKeys(field, CONFIG_FIELD_KEYS, at)
    if (typeof field.key !== 'string' || !CONFIG_KEY_PATTERN.test(field.key)) {
      error(`${at}.key 非法`)
    } else if (keys.has(field.key)) {
      error(`配置项 key 重复：${field.key}`)
    } else {
      keys.add(field.key)
    }
    if (typeof field.label !== 'string' || field.label.trim() === '' || field.label.length > 60) {
      error(`${at}.label 必填且 ≤ 60 字符`)
    }
    if (!['text', 'number', 'boolean', 'select', 'textarea'].includes(field.type)) {
      error(`${at}.type 只能是 text / number / boolean / select / textarea`)
    }
    if (
      field.description !== undefined &&
      (typeof field.description !== 'string' || field.description.length > 200)
    ) {
      error(`${at}.description ≤ 200 字符`)
    }
    if (
      field.placeholder !== undefined &&
      (typeof field.placeholder !== 'string' || field.placeholder.length > 120)
    ) {
      error(`${at}.placeholder ≤ 120 字符`)
    }
    if (
      field.default !== undefined &&
      typeof field.default !== 'string' &&
      typeof field.default !== 'number' &&
      typeof field.default !== 'boolean'
    ) {
      error(`${at}.default 只能是字符串 / 数字 / 布尔值`)
    }
    for (const metric of ['min', 'max', 'step']) {
      if (field[metric] !== undefined && typeof field[metric] !== 'number') {
        error(`${at}.${metric} 必须是数字`)
      }
    }
    if (field.type === 'select') {
      if (!Array.isArray(field.options) || field.options.length === 0) {
        error(`${at} 是 select，必须提供非空 options`)
      } else if (field.options.length > 50) {
        error(`${at}.options 不能超过 50 项`)
      } else if (
        field.options.some(
          (option) =>
            !isPlainObject(option) ||
            typeof option.value !== 'string' ||
            typeof option.label !== 'string',
        )
      ) {
        error(`${at}.options 每项必须有 value / label 字符串`)
      } else if (field.default !== undefined && typeof field.default !== 'string') {
        error(`${at}.default 在 select 字段上必须是字符串`)
      }
    }
  })
}

async function main() {
  const rawArgs = process.argv.slice(2)
  const json = rawArgs.includes('--json')
  const target = rawArgs.find((arg) => !arg.startsWith('--'))
  if (target === undefined) {
    console.error('用法：node tools/check-plugin.mjs <插件目录> [--json]')
    process.exit(EXIT_USAGE)
  }
  const root = resolve(process.cwd(), target)
  const stat = await fs.stat(root).catch(() => null)
  if (stat === null) {
    console.error(`✗ 路径不存在：${root}`)
    process.exit(EXIT_USAGE)
  }
  if (!stat.isDirectory()) {
    console.error(
      '✗ 本工具只校验目录；zip 请先解压，或在 Aurora 仓库运行 scripts/verify-plugin.mjs',
    )
    process.exit(EXIT_USAGE)
  }

  const manifestPath = join(root, 'manifest.json')
  const manifestStat = await fs.stat(manifestPath).catch(() => null)
  if (manifestStat === null) {
    console.error('✗ 缺少根目录 manifest.json')
    process.exit(EXIT_INVALID)
  }
  if (manifestStat.size > LIMITS.maxManifestBytes) {
    console.error('✗ manifest.json 超过 64 KB')
    process.exit(EXIT_INVALID)
  }
  let manifest
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  } catch (cause) {
    console.error(`✗ manifest.json 不是合法 JSON：${String(cause)}`)
    process.exit(EXIT_INVALID)
  }
  if (!isPlainObject(manifest)) {
    console.error('✗ manifest.json 必须是 JSON 对象')
    process.exit(EXIT_INVALID)
  }

  warnUnknownKeys(manifest, MANIFEST_KEYS, 'manifest')

  // ── 基础字段（与 zod schema 同口径）──
  if (typeof manifest.id !== 'string' || manifest.id.length > 40 || !ID_PATTERN.test(manifest.id)) {
    error('id 必须是 ≤ 40 的反向域名（小写字母 / 数字 / 连字符，至少两段）')
  } else if (manifest.id.split('.').some((segment) => RESERVED_ID_SEGMENTS.includes(segment))) {
    const reserved = manifest.id
      .split('.')
      .find((segment) => RESERVED_ID_SEGMENTS.includes(segment))
    error(
      `id 不能包含保留段「${reserved}」（aurora / builtin / plugin / mcp / skill / system / core）`,
    )
  }
  if (
    typeof manifest.name !== 'string' ||
    manifest.name.trim() === '' ||
    manifest.name.length > 60
  ) {
    error('name 必填且 ≤ 60 字符')
  }
  if (typeof manifest.version !== 'string' || !SEMVER_PATTERN.test(manifest.version)) {
    error('version 必须是 x.y.z')
  }
  if (manifest.apiVersion !== 1) error('apiVersion 必须是 1')
  if (
    manifest.minAuroraVersion !== undefined &&
    (typeof manifest.minAuroraVersion !== 'string' ||
      !SEMVER_PATTERN.test(manifest.minAuroraVersion))
  ) {
    error('minAuroraVersion 必须是 x.y.z')
  }
  if (
    typeof manifest.description !== 'string' ||
    manifest.description.trim() === '' ||
    manifest.description.length > 300
  ) {
    error('description 必填且 ≤ 300 字符')
  }
  if (
    !isPlainObject(manifest.author) ||
    typeof manifest.author.name !== 'string' ||
    manifest.author.name.trim() === '' ||
    manifest.author.name.length > 80
  ) {
    error('author.name 必填且 ≤ 80 字符')
  } else {
    warnUnknownKeys(manifest.author, ['name', 'url'], 'author')
    if (manifest.author.url !== undefined && !isUrl(manifest.author.url)) {
      error('author.url 必须是合法 URL')
    }
    if (typeof manifest.author.url === 'string' && manifest.author.url.length > 300) {
      error('author.url ≤ 300 字符')
    }
  }
  if (manifest.license !== undefined) {
    if (typeof manifest.license !== 'string' || manifest.license.length > 40) {
      error('license ≤ 40 字符')
    }
  }
  if (manifest.homepage !== undefined) {
    if (typeof manifest.homepage !== 'string' || !isUrl(manifest.homepage)) {
      error('homepage 必须是合法 URL')
    } else if (manifest.homepage.length > 300) {
      error('homepage ≤ 300 字符')
    }
  }
  if (typeof manifest.main !== 'string' || manifest.main.trim() === '') {
    error('main 入口必填')
  }
  if (manifest.activation !== undefined && !['startup', 'lazy'].includes(manifest.activation)) {
    error('activation 只能是 startup / lazy')
  }
  if (!Array.isArray(manifest.permissions)) {
    error('permissions 必须是数组')
  } else if (manifest.permissions.length > LIMITS.maxPermissions) {
    error(`permissions 不能超过 ${LIMITS.maxPermissions} 项`)
  }

  const permissions = new Set(Array.isArray(manifest.permissions) ? manifest.permissions : [])
  for (const permission of permissions) {
    if (!PERMISSIONS.has(permission)) error(`未知权限：${permission}`)
  }
  if (permissions.has('net.private') && !permissions.has('net')) {
    error('net.private 必须同时声明 net')
  }
  if (
    permissions.size !== (Array.isArray(manifest.permissions) ? manifest.permissions.length : 0)
  ) {
    warn('permissions 里有重复项')
  }

  const events = Array.isArray(manifest.events) ? manifest.events : []
  if (manifest.events !== undefined && !Array.isArray(manifest.events)) {
    error('events 必须是数组')
  }
  if (events.length > HOST_EVENTS.size) error('events 超出宿主事件上限')
  const eventNames = new Set()
  for (const event of events) {
    if (!HOST_EVENTS.has(event)) {
      error(`未知宿主事件：${String(event)}（只能订阅 ${[...HOST_EVENTS].join(' / ')}）`)
    } else if (eventNames.has(event)) {
      error(`宿主事件重复：${event}`)
    } else {
      eventNames.add(event)
    }
  }
  requirePermission(permissions, 'events', events.length > 0, '订阅宿主事件')

  if (typeof manifest.main === 'string' && manifest.main.trim() !== '') {
    await requireFile(root, manifest.main, 'main 入口')
  }
  if (manifest.icon !== undefined) {
    if (typeof manifest.icon !== 'string') {
      error('icon 必须是包内相对路径')
    } else {
      await requireFile(root, manifest.icon, '市场图标')
    }
  }

  const contributes = isPlainObject(manifest.contributes) ? manifest.contributes : {}
  if (manifest.contributes !== undefined && !isPlainObject(manifest.contributes)) {
    error('contributes 必须是对象')
  }
  warnUnknownKeys(contributes, CONTRIBUTES_KEYS, 'contributes')

  const tools = Array.isArray(contributes.tools) ? contributes.tools : []
  const skills = Array.isArray(contributes.skills) ? contributes.skills : []
  const commands = Array.isArray(contributes.commands) ? contributes.commands : []
  const panels = Array.isArray(contributes.panels) ? contributes.panels : []
  const widgets = Array.isArray(contributes.widgets) ? contributes.widgets : []
  const themes = Array.isArray(contributes.themes) ? contributes.themes : []
  const automation = isPlainObject(contributes.automation) ? contributes.automation : {}

  for (const [key, value] of Object.entries({
    tools,
    skills,
    commands,
    panels,
    widgets,
    themes,
  })) {
    const declared = contributes[key]
    if (declared !== undefined && !Array.isArray(declared)) {
      error(`contributes.${key} 必须是数组`)
    }
    void value
  }

  // ── 工具 ──
  if (tools.length > LIMITS.maxTools) error(`工具不能超过 ${LIMITS.maxTools} 个`)
  requirePermission(permissions, 'tools', tools.length > 0, '声明工具')
  const toolNames = new Set()
  tools.forEach((tool, index) => {
    checkTool(tool, index, manifest.id, permissions)
    if (isPlainObject(tool) && typeof tool.name === 'string') {
      if (toolNames.has(tool.name)) error(`工具名重复：${tool.name}`)
      toolNames.add(tool.name)
    }
  })

  // ── 命令 ──
  if (commands.length > LIMITS.maxCommands) {
    error(`命令不能超过 ${LIMITS.maxCommands} 个`)
  }
  requirePermission(permissions, 'commands', commands.length > 0, '声明命令')
  const commandNames = new Set()
  commands.forEach((command, index) => {
    checkCommand(command, index, permissions)
    if (isPlainObject(command) && typeof command.name === 'string') {
      if (commandNames.has(command.name)) error(`命令名重复：${command.name}`)
      commandNames.add(command.name)
    }
  })

  // ── 自动化 ──
  checkAutomation(contributes.automation, permissions)

  // ── Skill ──
  if (skills.length > LIMITS.maxSkills) {
    error(`Skill 不能超过 ${LIMITS.maxSkills} 个`)
  }
  requirePermission(permissions, 'skills', skills.length > 0, '声明 Skill')
  const skillPaths = new Set()
  for (const skill of skills) {
    if (typeof skill !== 'string') {
      error('contributes.skills 每项必须是包内相对目录字符串')
      continue
    }
    if (skillPaths.has(skill)) error(`Skill 目录重复：${skill}`)
    skillPaths.add(skill)
    await checkSkillDirectory(root, skill, 'Skill')
  }

  // ── 面板 / 小组件 / 主题 / 配置 ──
  await checkPanels(panels, root, permissions)
  await checkWidgets(widgets, root, permissions)
  checkThemes(themes, permissions)
  checkConfig(manifest.config)

  const summary = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    minAuroraVersion: manifest.minAuroraVersion ?? null,
    permissions: [...permissions],
    tools: tools
      .filter((tool) => isPlainObject(tool) && typeof tool.name === 'string')
      .map((tool) => ({
        name: `plugin.${manifest.id}.${tool.name}`,
        sensitivity: tool.sensitivity ?? 'confirm',
        readonly: tool.readonly === true,
      })),
    skills: skills.filter((skill) => typeof skill === 'string'),
    commands: commands
      .filter((command) => isPlainObject(command) && typeof command.name === 'string')
      .map((command) => command.name),
    panels: panels
      .filter((panel) => isPlainObject(panel) && typeof panel.id === 'string')
      .map((panel) => panel.id),
    widgets: widgets
      .filter((widget) => isPlainObject(widget) && typeof widget.id === 'string')
      .map((widget) => ({ id: widget.id, slot: widget.slot })),
    automationActions: (Array.isArray(automation.actions) ? automation.actions : [])
      .filter((action) => isPlainObject(action) && typeof action.name === 'string')
      .map((action) => action.name),
    automationEvents: (Array.isArray(automation.events) ? automation.events : [])
      .filter((event) => isPlainObject(event) && typeof event.name === 'string')
      .map((event) => event.name),
    themes: themes.filter((theme) => isPlainObject(theme) && typeof theme.id === 'string').length,
    config: Array.isArray(manifest.config?.fields) ? manifest.config.fields.length : 0,
    hostEvents: [...eventNames],
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: errors.length === 0,
          errors,
          warnings: [...new Set(warnings)],
          summary,
        },
        null,
        2,
      ),
    )
    process.exit(errors.length === 0 ? EXIT_OK : EXIT_INVALID)
  }

  if (errors.length === 0) {
    console.log(
      `✓ 清单通过：${summary.id} ${summary.name} v${summary.version}` +
        (summary.minAuroraVersion === null ? '' : `（要求 Aurora ≥ ${summary.minAuroraVersion}）`),
    )
    console.log(
      `  权限（${summary.permissions.length}）：${
        summary.permissions.length === 0 ? '（无）' : summary.permissions.join(', ')
      }`,
    )
    if (summary.tools.length > 0) {
      console.log(
        `  工具（${summary.tools.length}）：` +
          summary.tools
            .map((tool) => `${tool.name}（${tool.sensitivity}${tool.readonly ? '，只读' : ''}）`)
            .join('、'),
      )
    }
    if (summary.skills.length > 0)
      console.log(`  Skill（${summary.skills.length}）：${summary.skills.join('、')}`)
    if (summary.commands.length > 0) {
      console.log(
        `  命令（${summary.commands.length}）：${summary.commands.map((name) => `/${name}`).join('、')}`,
      )
    }
    if (summary.panels.length > 0)
      console.log(`  面板（${summary.panels.length}）：${summary.panels.join('、')}`)
    if (summary.widgets.length > 0) {
      console.log(
        `  小组件（${summary.widgets.length}）：` +
          summary.widgets
            .map((widget) => `${widget.id}（${widget.slot === 'desktop' ? '桌面' : '提示条'}）`)
            .join('、'),
      )
    }
    if (summary.automationActions.length > 0 || summary.automationEvents.length > 0) {
      console.log(
        `  自动化：动作 ${summary.automationActions.length} 个、事件 ${summary.automationEvents.length} 个`,
      )
    }
    if (summary.themes > 0) console.log(`  主题（${summary.themes}）`)
    if (summary.config > 0) console.log(`  配置项（${summary.config}）`)
    if (summary.hostEvents.length > 0) {
      console.log(`  宿主事件：${summary.hostEvents.join('、')}`)
    }
    for (const warning of [...new Set(warnings)]) console.log(`  ! ${warning}`)
    console.log(`\n插件目录校验通过（${root}）。`)
    console.log('安装前请确认来源可信：插件以你的用户权限运行，不是 OS 沙箱。')
    process.exit(EXIT_OK)
  }

  for (const message of errors) console.error(`✗ ${message}`)
  for (const warning of [...new Set(warnings)]) console.warn(`! ${warning}`)
  console.error(`\n共 ${errors.length} 项错误。`)
  process.exit(EXIT_INVALID)
}

main().catch((cause) => {
  console.error(`✗ 校验异常：${String(cause)}`)
  process.exit(EXIT_INVALID)
})
