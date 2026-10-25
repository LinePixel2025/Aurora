#!/usr/bin/env node
/* global process, Buffer */
/**
 * 独立插件校验器（Aurora 插件 API v1）。
 *
 * 只用 Node 内置模块，零依赖：
 *   node tools/check-plugin.mjs <插件目录>
 *
 * 检查：清单字段、权限与贡献对应、路径 containment、面板 / 小组件约束、
 * 引用文件存在、声明式 schema 基本合法性。
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

// 桌面小组件窗口层级 / 原生材质：与宿主 zod schema 手动同口径（本工具不依赖 Aurora 工作区）。
const WIDGET_WINDOW_LEVELS = new Set(['floating', 'normal', 'desktop'])
const WIDGET_WINDOW_MATERIALS = new Set(['none', 'acrylic'])

const ID_PATTERN = /^[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])?)+$/
const PANEL_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,24}$/
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9a-zA-Z.-]+)?$/
const RESERVED_ID_SEGMENTS = ['aurora', 'builtin', 'plugin', 'mcp', 'skill']

const LAYOUT_LIMITS = {
  maxManifestBytes: 64 * 1024,
  maxPanels: 8,
  maxWidgets: 4,
  maxTools: 32,
  maxSkills: 16,
  maxCommands: 32,
  maxThemes: 8,
  maxUiBytes: 256 * 1024,
  maxNodes: 500,
  maxDepth: 20,
  maxText: 4000,
}

const errors = []
const warnings = []

function error(message) {
  errors.push(message)
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

function resolveInside(root, relativePath, label) {
  const normalized = normalizePluginPath(relativePath)
  if (normalized === null) {
    error(`${label} 不是合法的包内相对路径：${relativePath}`)
    return null
  }
  const target = resolve(root, normalized)
  if (!within(root, target)) {
    error(`${label} 越出插件根：${relativePath}`)
    return null
  }
  return { normalized, target }
}

function validateUiSchema(raw, label) {
  const text = JSON.stringify(raw)
  if (Buffer.byteLength(text, 'utf8') > LAYOUT_LIMITS.maxUiBytes) {
    error(`${label} 超过 256 KB`)
    return
  }
  if (typeof raw !== 'object' || raw === null || !Array.isArray(raw.nodes)) {
    error(`${label} 必须是 { "version": 1, "nodes": [...] }`)
    return
  }
  let count = 0
  const walk = (node, depth) => {
    count += 1
    if (count > LAYOUT_LIMITS.maxNodes) return
    if (depth > LAYOUT_LIMITS.maxDepth) {
      error(`${label} 嵌套超过 ${LAYOUT_LIMITS.maxDepth} 层`)
      return
    }
    if (typeof node !== 'object' || node === null) {
      error(`${label} 存在非对象节点`)
      return
    }
    if (!UI_NODE_TYPES.has(node.type)) {
      error(`${label} 未知节点类型：${String(node.type)}`)
      return
    }
    if (['text', 'heading', 'badge', 'button'].includes(node.type)) {
      if (typeof node.text === 'string' && node.text.length > LAYOUT_LIMITS.maxText) {
        error(`${label} 的 ${node.type}.text 超过 ${LAYOUT_LIMITS.maxText} 字`)
      }
    }
    if (node.type === 'image') {
      const src = normalizePluginPath(node.src)
      if (src === null) error(`${label} 的 image.src 必须是包内相对路径`)
    }
    if (node.type === 'select' && (!Array.isArray(node.options) || node.options.length === 0)) {
      error(`${label} 的 select.options 不能为空`)
    }
    if (node.type === 'table' && (!Array.isArray(node.columns) || node.columns.length === 0)) {
      error(`${label} 的 table.columns 不能为空`)
    }
    if (node.action !== undefined) {
      if (
        typeof node.action?.method !== 'string' ||
        !/^[a-z][a-z0-9_.-]{0,63}$/.test(node.action.method)
      ) {
        error(`${label} 的 action.method 非法`)
      }
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) walk(child, depth + 1)
    }
  }
  for (const node of raw.nodes) walk(node, 1)
  if (count > LAYOUT_LIMITS.maxNodes) error(`${label} 节点超过 ${LAYOUT_LIMITS.maxNodes} 个`)
}

async function validateSchemaFile(root, relativePath, label) {
  const resolved = resolveInside(root, relativePath, label)
  if (resolved === null) return
  if (!(await exists(resolved.target))) {
    error(`${label} 文件不存在：${relativePath}`)
    return
  }
  try {
    const raw = JSON.parse(await fs.readFile(resolved.target, 'utf8'))
    validateUiSchema(raw, label)
  } catch (cause) {
    error(`${label} 不是合法 JSON：${String(cause)}`)
  }
}

async function main() {
  const target = process.argv[2]
  if (target === undefined) {
    console.error('用法：node tools/check-plugin.mjs <插件目录>')
    process.exit(EXIT_USAGE)
  }
  const root = resolve(process.cwd(), target)
  const stat = await fs.stat(root).catch(() => null)
  if (stat === null) {
    console.error(`✗ 路径不存在：${root}`)
    process.exit(EXIT_USAGE)
  }
  if (!stat.isDirectory()) {
    console.error('✗ 本工具只校验目录；zip 请在 Aurora 仓库运行 scripts/verify-plugin.mjs')
    process.exit(EXIT_USAGE)
  }

  const manifestPath = join(root, 'manifest.json')
  const manifestStat = await fs.stat(manifestPath).catch(() => null)
  if (manifestStat === null) {
    console.error('✗ 缺少根目录 manifest.json')
    process.exit(EXIT_INVALID)
  }
  if (manifestStat.size > LAYOUT_LIMITS.maxManifestBytes) {
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

  // ── 基础字段 ──
  if (typeof manifest.id !== 'string' || manifest.id.length > 40 || !ID_PATTERN.test(manifest.id)) {
    error('id 必须是 ≤ 40 的反向域名（全小写）')
  } else if (manifest.id.split('.').some((segment) => RESERVED_ID_SEGMENTS.includes(segment))) {
    error('id 不能包含保留段（aurora / builtin / plugin / mcp / skill）')
  }
  if (typeof manifest.name !== 'string' || manifest.name.trim() === '') error('缺少 name')
  if (typeof manifest.version !== 'string' || !SEMVER_PATTERN.test(manifest.version)) {
    error('version 必须是 x.y.z')
  }
  if (manifest.apiVersion !== 1) error('apiVersion 必须是 1')
  if (typeof manifest.description !== 'string' || manifest.description.trim() === '') {
    error('缺少 description')
  }
  if (typeof manifest.author?.name !== 'string' || manifest.author.name.trim() === '') {
    error('缺少 author.name')
  }
  if (!Array.isArray(manifest.permissions)) error('permissions 必须是数组')

  const permissions = new Set(Array.isArray(manifest.permissions) ? manifest.permissions : [])
  for (const permission of permissions) {
    if (!PERMISSIONS.has(permission)) error(`未知权限：${permission}`)
  }
  if (permissions.has('net.private') && !permissions.has('net')) {
    error('net.private 必须同时声明 net')
  }

  const contributes = manifest.contributes ?? {}
  const tools = Array.isArray(contributes.tools) ? contributes.tools : []
  const skills = Array.isArray(contributes.skills) ? contributes.skills : []
  const commands = Array.isArray(contributes.commands) ? contributes.commands : []
  const panels = Array.isArray(contributes.panels) ? contributes.panels : []
  const widgets = Array.isArray(contributes.widgets) ? contributes.widgets : []
  const themes = Array.isArray(contributes.themes) ? contributes.themes : []
  const events = Array.isArray(manifest.events) ? manifest.events : []

  const requirePermission = (permission, present, label) => {
    if (present && !permissions.has(permission)) error(`${label}需要权限「${permission}」`)
  }
  requirePermission('tools', tools.length > 0, '声明工具')
  requirePermission('skills', skills.length > 0, '声明 Skill')
  requirePermission('commands', commands.length > 0, '声明命令')
  requirePermission(
    'automation',
    (contributes.automation?.actions?.length ?? 0) > 0,
    '声明自动化动作',
  )
  requirePermission(
    'automation.events',
    (contributes.automation?.events?.length ?? 0) > 0,
    '声明自动化事件',
  )
  requirePermission('ui.panels', panels.length > 0, '声明面板')
  requirePermission('ui.widgets', widgets.length > 0, '声明小组件')
  requirePermission('themes', themes.length > 0, '声明主题')
  requirePermission('events', events.length > 0, '订阅宿主事件')

  // ── main / Skill ──
  if (typeof manifest.main !== 'string') {
    error('缺少 main 入口')
  } else {
    const mainPath = resolveInside(root, manifest.main, 'main 入口')
    if (mainPath !== null && !(await exists(mainPath.target)))
      error(`main 入口不存在：${manifest.main}`)
  }
  if (skills.length > LAYOUT_LIMITS.maxSkills) error(`Skill 不能超过 ${LAYOUT_LIMITS.maxSkills} 个`)
  for (const skill of skills) {
    const resolved = resolveInside(root, skill, 'Skill 目录')
    if (resolved === null) continue
    if (!(await exists(join(resolved.target, 'SKILL.md')))) {
      error(`Skill 目录缺少 SKILL.md：${skill}`)
    }
  }

  // ── 工具 ──
  if (tools.length > LAYOUT_LIMITS.maxTools) error(`工具不能超过 ${LAYOUT_LIMITS.maxTools} 个`)
  const toolNames = new Set()
  for (const tool of tools) {
    if (typeof tool.name !== 'string' || !TOOL_NAME_PATTERN.test(tool.name)) {
      error(`工具名非法：${String(tool.name)}`)
      continue
    }
    if (toolNames.has(tool.name)) error(`工具名重复：${tool.name}`)
    toolNames.add(tool.name)
    const full = `plugin.${manifest.id}.${tool.name}`
    if (full.length > 64) error(`最终工具名超过 64 字符：${full}`)
    if (typeof tool.description !== 'string' || tool.description.trim() === '') {
      error(`工具 ${tool.name} 缺少 description`)
    }
    if (
      typeof tool.parameters !== 'object' ||
      tool.parameters === null ||
      tool.parameters.type !== 'object'
    ) {
      error(`工具 ${tool.name} 的 parameters 必须是 type:"object" 的 JSON Schema`)
    }
  }

  // ── 命令 ──
  if (commands.length > LAYOUT_LIMITS.maxCommands)
    error(`命令不能超过 ${LAYOUT_LIMITS.maxCommands} 个`)
  const commandNames = new Set()
  for (const command of commands) {
    if (typeof command.name !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(command.name)) {
      error(`命令名非法：${String(command.name)}`)
    } else if (commandNames.has(command.name)) {
      error(`命令名重复：${command.name}`)
    } else {
      commandNames.add(command.name)
    }
    if (!['action', 'prompt'].includes(command.mode)) error(`命令 ${command.name} 的 mode 非法`)
  }

  // ── 面板 ──
  if (panels.length > LAYOUT_LIMITS.maxPanels) error(`面板不能超过 ${LAYOUT_LIMITS.maxPanels} 个`)
  const panelIds = new Set()
  for (const panel of panels) {
    if (typeof panel.id !== 'string' || !PANEL_ID_PATTERN.test(panel.id)) {
      error(`面板 id 非法：${String(panel.id)}`)
      continue
    }
    if (panelIds.has(panel.id)) error(`面板 id 重复：${panel.id}`)
    panelIds.add(panel.id)
    if (panel.icon !== undefined && !PANEL_ICONS.has(panel.icon)) {
      warnings.push(`面板 ${panel.id} 的图标不在白名单，运行时会回落 Puzzle：${panel.icon}`)
    }
    const hasSchema = panel.schema !== undefined
    const hasEntry = panel.entry !== undefined
    if (hasSchema === hasEntry) error(`面板 ${panel.id} 必须且只能声明 schema 或 entry 之一`)
    if (hasSchema) await validateSchemaFile(root, panel.schema, `面板 ${panel.id} schema`)
    if (hasEntry) {
      const resolved = resolveInside(root, panel.entry, `面板 ${panel.id} entry`)
      if (resolved !== null && !(await exists(resolved.target))) {
        error(`面板 ${panel.id} entry 文件不存在：${panel.entry}`)
      }
    }
  }

  // ── 小组件 ──
  if (widgets.length > LAYOUT_LIMITS.maxWidgets) {
    error(`小组件不能超过 ${LAYOUT_LIMITS.maxWidgets} 个`)
  }
  const widgetIds = new Set()
  for (const widget of widgets) {
    if (typeof widget.id !== 'string' || !PANEL_ID_PATTERN.test(widget.id)) {
      error(`小组件 id 非法：${String(widget.id)}`)
      continue
    }
    if (widgetIds.has(widget.id)) error(`小组件 id 重复：${widget.id}`)
    widgetIds.add(widget.id)
    if (!['desktop', 'edge-bar'].includes(widget.slot)) {
      error(`小组件 ${widget.id} 的 slot 必须是 desktop 或 edge-bar`)
      continue
    }
    if (widget.icon !== undefined && !PANEL_ICONS.has(widget.icon)) {
      warnings.push(`小组件 ${widget.id} 的图标不在白名单，运行时会回落 Puzzle：${widget.icon}`)
    }
    if (widget.windowLevel !== undefined && !WIDGET_WINDOW_LEVELS.has(widget.windowLevel)) {
      error(`小组件 ${widget.id} 的 windowLevel 必须是 floating / normal / desktop`)
    }
    if (
      widget.windowMaterial !== undefined &&
      !WIDGET_WINDOW_MATERIALS.has(widget.windowMaterial)
    ) {
      error(`小组件 ${widget.id} 的 windowMaterial 必须是 none / acrylic`)
    }
    if (widget.hideCloseButton !== undefined && typeof widget.hideCloseButton !== 'boolean') {
      error(`小组件 ${widget.id} 的 hideCloseButton 必须是布尔值`)
    }
    const hasSchema = widget.schema !== undefined
    const hasEntry = widget.entry !== undefined
    if (hasSchema === hasEntry) {
      error(`小组件 ${widget.id} 必须且只能声明 schema 或 entry 之一`)
      continue
    }
    if (widget.slot === 'edge-bar') {
      if (hasEntry) error(`提示条小组件 ${widget.id} 只允许 schema，不允许 entry`)
      if (widget.defaultSize !== undefined) {
        error(`提示条小组件 ${widget.id} 不支持 defaultSize`)
      }
      if (WIDGET_WINDOW_LEVELS.has(widget.windowLevel) && widget.windowLevel !== 'floating') {
        error(`提示条小组件 ${widget.id} 不支持 windowLevel（只允许默认 floating）`)
      }
      if (WIDGET_WINDOW_MATERIALS.has(widget.windowMaterial) && widget.windowMaterial !== 'none') {
        error(`提示条小组件 ${widget.id} 不支持 windowMaterial（只允许默认 none）`)
      }
      if (widget.hideCloseButton === true) {
        error(`提示条小组件 ${widget.id} 不支持 hideCloseButton`)
      }
    }
    if (widget.defaultSize !== undefined) {
      const { width, height } = widget.defaultSize
      if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 120 ||
        width > 1200 ||
        height < 80 ||
        height > 900
      ) {
        error(`小组件 ${widget.id} 的 defaultSize 必须在 120–1200 × 80–900 之间`)
      }
    }
    if (hasSchema) await validateSchemaFile(root, widget.schema, `小组件 ${widget.id} schema`)
    if (hasEntry) {
      const resolved = resolveInside(root, widget.entry, `小组件 ${widget.id} entry`)
      if (resolved !== null && !(await exists(resolved.target))) {
        error(`小组件 ${widget.id} entry 文件不存在：${widget.entry}`)
      }
    }
  }

  // ── 主题 / 配置 / 事件 ──
  if (themes.length > LAYOUT_LIMITS.maxThemes) error(`主题不能超过 ${LAYOUT_LIMITS.maxThemes} 个`)
  for (const theme of themes) {
    if (typeof theme.id !== 'string' || !PANEL_ID_PATTERN.test(theme.id)) {
      error(`主题 id 非法：${String(theme.id)}`)
    }
    if (typeof theme.tokens !== 'object' || theme.tokens === null) {
      error(`主题 ${theme.id} 缺少 tokens`)
    }
  }
  for (const field of Array.isArray(manifest.config?.fields) ? manifest.config.fields : []) {
    if (typeof field.key !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(field.key)) {
      error(`配置 key 非法：${String(field.key)}`)
    }
  }

  // ── 输出 ──
  if (errors.length === 0) {
    console.log(`✓ 清单通过：${manifest.id} ${manifest.name} v${manifest.version}`)
    for (const warning of [...new Set(warnings)]) console.log(`  ! ${warning}`)
    console.log(`\n插件目录校验通过（${root}）。`)
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
