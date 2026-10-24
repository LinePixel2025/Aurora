/**
 * 插件清单 schema（docs/14 §3、docs/15 §3）。
 *
 * **清单优先**：工具 / Skill / 命令 / 自动化动作与事件 / 面板 / 主题 / 配置字段
 * 全部在这里声明，插件 `main.js` 只提供处理器。这样安装前就能完整展示权限与
 * 贡献，Center 市场也能在服务端独立校验同一份契约。
 *
 * 本文件是纯 zod schema（浏览器可运行），安装器 / 市场 / 校验脚本共用。
 */
import { z } from 'zod'
import {
  normalizePluginPath,
  PLUGIN_API_VERSION,
  PLUGIN_COMMAND_NAME_PATTERN,
  PLUGIN_PANEL_ID_PATTERN,
  PLUGIN_ACTION_NAME_PATTERN,
  PLUGIN_THEME_ID_PATTERN,
  PLUGIN_TOOL_FULL_NAME_MAX,
  PLUGIN_TOOL_NAME_PATTERN,
  pluginToolName,
  RESERVED_COMMAND_NAMES,
  validatePluginId,
} from './ids.js'
import { PLUGIN_PERMISSIONS, type PluginPermission } from './permissions.js'
import { PLUGIN_HOST_EVENTS } from './protocol.js'
import { PLUGIN_PANEL_ICONS } from './icons.js'
import { PLUGIN_THEME_MAX_TOKENS, validateThemeTokens } from './themes.js'

/** 清单各段的硬上限（安装器与市场共用）。 */
export const PLUGIN_MANIFEST_LIMITS = {
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
} as const

const relativePath = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => normalizePluginPath(value) !== null, '必须是插件包内的相对路径')

const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9a-zA-Z.-]+)?$/

const PluginAuthorSchema = z.object({
  name: z.string().min(1).max(80),
  url: z.string().url().max(300).optional(),
})

const PluginToolSchema = z.object({
  name: z.string().regex(PLUGIN_TOOL_NAME_PATTERN, '工具名必须是 a-z / 0-9 / 下划线，≤ 25 字符'),
  description: z.string().min(1).max(500),
  /** 工具参数 JSON Schema（必须 `type: "object"`；大小 ≤ 64 KB） */
  parameters: z.record(z.unknown()).default({ type: 'object', properties: {} }),
  sensitivity: z.enum(['safe', 'confirm']).default('confirm'),
  /** 只读档（`agent.permissionMode = 'readonly'`）下是否仍注册 */
  readonly: z.boolean().default(false),
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
})

const PluginCommandSchema = z.object({
  name: z
    .string()
    .regex(PLUGIN_COMMAND_NAME_PATTERN, '命令名必须是 a-z / 0-9 / 下划线 / 连字符，≤ 32 字符')
    .refine(
      (value) => !(RESERVED_COMMAND_NAMES as readonly string[]).includes(value),
      '命令名与内置命令重名',
    ),
  title: z.string().min(1).max(60),
  description: z.string().min(1).max(200),
  mode: z.enum(['action', 'prompt']),
})

const PluginAutomationFieldSchema = z.object({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/, '字段 key 非法'),
  label: z.string().min(1).max(60),
  type: z.enum(['text', 'number', 'select', 'json']),
  placeholder: z.string().max(120).optional(),
  hint: z.string().max(120).optional(),
  options: z
    .array(z.object({ value: z.string().max(80), label: z.string().max(80) }))
    .max(50)
    .optional(),
})

const PluginAutomationActionSchema = z.object({
  name: z.string().regex(PLUGIN_ACTION_NAME_PATTERN, '自动化动作名非法'),
  title: z.string().min(1).max(60),
  description: z.string().min(1).max(200),
  fields: z.array(PluginAutomationFieldSchema).max(16).default([]),
})

const PluginAutomationEventSchema = z.object({
  name: z.string().regex(PLUGIN_ACTION_NAME_PATTERN, '自动化事件名非法'),
  title: z.string().min(1).max(60),
  description: z.string().max(200).optional(),
})

const PluginPanelSchema = z
  .object({
    id: z.string().regex(PLUGIN_PANEL_ID_PATTERN, '面板 id 非法'),
    title: z.string().min(1).max(40),
    icon: z.enum(PLUGIN_PANEL_ICONS).optional(),
    /** 声明式面板的 schema 文件（与 entry 二选一） */
    schema: relativePath.optional(),
    /** 沙箱页面入口 HTML（与 schema 二选一） */
    entry: relativePath.optional(),
  })
  .refine(
    (panel) => (panel.schema === undefined) !== (panel.entry === undefined),
    '面板必须且只能声明 schema 或 entry 之一',
  )

/** 小组件形态：桌面浮动卡片，或提示条展开面板里的声明式条目。 */
export const PLUGIN_WIDGET_SLOTS = ['desktop', 'edge-bar'] as const
export type PluginWidgetSlot = (typeof PLUGIN_WIDGET_SLOTS)[number]

/**
 * 桌面小组件窗口层级（docs/14 §5.3）：
 * - `floating`：默认，置顶浮动卡片（与 0.5.1 行为一致）；
 * - `normal`：不置顶，按普通无边框窗口参与 z-order；
 * - `desktop`：不置顶，并在 Windows 上尽力做到显示桌面后仍可见（失败回落 normal）。
 *
 * 只对 `slot = "desktop"` 生效；提示条小组件在清单校验阶段拒绝非默认值。
 */
export const PLUGIN_WIDGET_WINDOW_LEVELS = ['floating', 'normal', 'desktop'] as const
export type PluginWidgetWindowLevel = (typeof PLUGIN_WIDGET_WINDOW_LEVELS)[number]

/** 桌面小组件原生材质：默认 `none`；`acrylic` 需要 Windows 11 22H2+ 且外观毛玻璃开启。 */
export const PLUGIN_WIDGET_WINDOW_MATERIALS = ['none', 'acrylic'] as const
export type PluginWidgetWindowMaterial = (typeof PLUGIN_WIDGET_WINDOW_MATERIALS)[number]

export const PLUGIN_WIDGET_SIZE_LIMITS = {
  minWidth: 120,
  minHeight: 80,
  maxWidth: 1200,
  maxHeight: 900,
} as const

const PluginWidgetSizeSchema = z.object({
  width: z
    .number()
    .int()
    .min(PLUGIN_WIDGET_SIZE_LIMITS.minWidth)
    .max(PLUGIN_WIDGET_SIZE_LIMITS.maxWidth),
  height: z
    .number()
    .int()
    .min(PLUGIN_WIDGET_SIZE_LIMITS.minHeight)
    .max(PLUGIN_WIDGET_SIZE_LIMITS.maxHeight),
})

const PluginWidgetSchema = z
  .object({
    id: z.string().regex(PLUGIN_PANEL_ID_PATTERN, '小组件 id 非法'),
    title: z.string().min(1).max(40),
    icon: z.enum(PLUGIN_PANEL_ICONS).optional(),
    slot: z.enum(PLUGIN_WIDGET_SLOTS),
    /** 桌面小组件的窗口层级（提示条忽略，且非默认值会在 superRefine 拒绝） */
    windowLevel: z.enum(PLUGIN_WIDGET_WINDOW_LEVELS).default('floating'),
    /** 桌面小组件的原生材质（提示条忽略，且非默认值会在 superRefine 拒绝） */
    windowMaterial: z.enum(PLUGIN_WIDGET_WINDOW_MATERIALS).default('none'),
    /** 声明式 schema 文件（与 entry 二选一） */
    schema: relativePath.optional(),
    /** 沙箱页面入口 HTML（只允许 desktop） */
    entry: relativePath.optional(),
    /** 桌面小组件的初始尺寸（提示条小组件忽略） */
    defaultSize: PluginWidgetSizeSchema.optional(),
  })
  .refine(
    (widget) => (widget.schema === undefined) !== (widget.entry === undefined),
    '小组件必须且只能声明 schema 或 entry 之一',
  )
  .refine(
    (widget) => widget.slot !== 'edge-bar' || widget.entry === undefined,
    '提示条小组件只支持声明式 schema',
  )

const PluginThemeSchema = z.object({
  id: z.string().regex(PLUGIN_THEME_ID_PATTERN, '主题 id 非法'),
  name: z.string().min(1).max(40),
  tokens: z.record(z.string().max(120)),
})

const PluginConfigFieldSchema = z
  .object({
    key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/, '配置 key 非法'),
    label: z.string().min(1).max(60),
    type: z.enum(['text', 'number', 'boolean', 'select', 'textarea']),
    description: z.string().max(200).optional(),
    placeholder: z.string().max(120).optional(),
    default: z.union([z.string().max(4000), z.number(), z.boolean()]).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    options: z
      .array(z.object({ value: z.string().max(80), label: z.string().max(80) }))
      .max(50)
      .optional(),
  })
  .refine(
    (field) => field.type !== 'select' || (field.options !== undefined && field.options.length > 0),
    'select 字段必须提供 options',
  )

const PluginContributesSchema = z.object({
  tools: z.array(PluginToolSchema).max(PLUGIN_MANIFEST_LIMITS.maxTools).default([]),
  skills: z.array(relativePath).max(PLUGIN_MANIFEST_LIMITS.maxSkills).default([]),
  commands: z.array(PluginCommandSchema).max(PLUGIN_MANIFEST_LIMITS.maxCommands).default([]),
  automation: z
    .object({
      actions: z
        .array(PluginAutomationActionSchema)
        .max(PLUGIN_MANIFEST_LIMITS.maxAutomationActions)
        .default([]),
      events: z
        .array(PluginAutomationEventSchema)
        .max(PLUGIN_MANIFEST_LIMITS.maxAutomationEvents)
        .default([]),
    })
    .default({ actions: [], events: [] }),
  panels: z.array(PluginPanelSchema).max(PLUGIN_MANIFEST_LIMITS.maxPanels).default([]),
  widgets: z.array(PluginWidgetSchema).max(PLUGIN_MANIFEST_LIMITS.maxWidgets).default([]),
  themes: z.array(PluginThemeSchema).max(PLUGIN_MANIFEST_LIMITS.maxThemes).default([]),
})

export const PluginManifestSchema = z
  .object({
    id: z.string().max(40),
    name: z.string().min(1).max(60),
    version: z.string().regex(semverPattern, '版本号必须是 x.y.z'),
    apiVersion: z.number().int(),
    minAuroraVersion: z.string().regex(semverPattern).optional(),
    description: z.string().min(1).max(300),
    author: PluginAuthorSchema,
    license: z.string().max(40).optional(),
    homepage: z.string().url().max(300).optional(),
    main: relativePath,
    activation: z.enum(['startup', 'lazy']).default('startup'),
    permissions: z
      .array(z.enum(PLUGIN_PERMISSIONS))
      .max(PLUGIN_MANIFEST_LIMITS.maxPermissions)
      .default([]),
    contributes: PluginContributesSchema.default({
      tools: [],
      skills: [],
      commands: [],
      automation: { actions: [], events: [] },
      panels: [],
      widgets: [],
      themes: [],
    }),
    config: z
      .object({
        fields: z
          .array(PluginConfigFieldSchema)
          .max(PLUGIN_MANIFEST_LIMITS.maxConfigFields)
          .default([]),
      })
      .default({ fields: [] }),
    /** 订阅的宿主事件；未在此声明的事件不会投递给插件 */
    events: z.array(z.enum(PLUGIN_HOST_EVENTS)).max(PLUGIN_HOST_EVENTS.length).default([]),
    /** 市场图标（PNG 相对路径；缺省由 Center 生成占位图） */
    icon: relativePath.optional(),
  })
  .superRefine((manifest, ctx) => {
    const idError = validatePluginId(manifest.id)
    if (idError) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['id'], message: idError })

    if (manifest.apiVersion !== PLUGIN_API_VERSION) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['apiVersion'],
        message: `插件 API 版本必须是 ${PLUGIN_API_VERSION}（当前清单为 ${manifest.apiVersion}）`,
      })
    }

    const permissions = new Set<string>(manifest.permissions)
    const require = (permission: PluginPermission, present: boolean, path: string[]): void => {
      if (present && !permissions.has(permission)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `声明了该贡献但缺少权限「${permission}」`,
        })
      }
    }
    require('tools', manifest.contributes.tools.length > 0, ['contributes', 'tools'])
    require('skills', manifest.contributes.skills.length > 0, ['contributes', 'skills'])
    require('commands', manifest.contributes.commands.length > 0, ['contributes', 'commands'])
    require('automation', manifest.contributes.automation.actions.length > 0, [
      'contributes',
      'automation',
      'actions',
    ])
    require('automation.events', manifest.contributes.automation.events.length > 0, [
      'contributes',
      'automation',
      'events',
    ])
    require('ui.panels', manifest.contributes.panels.length > 0, ['contributes', 'panels'])
    require('ui.widgets', manifest.contributes.widgets.length > 0, ['contributes', 'widgets'])
    require('themes', manifest.contributes.themes.length > 0, ['contributes', 'themes'])
    if (manifest.events.length > 0 && !permissions.has('events')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['events'],
        message: '订阅宿主事件需要「events」权限',
      })
    }
    if (permissions.has('net.private') && !permissions.has('net')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['permissions'],
        message: '「net.private」必须同时声明「net」',
      })
    }

    const unique = (values: string[], path: string[], label: string): void => {
      const seen = new Set<string>()
      for (const value of values) {
        if (seen.has(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path,
            message: `${label}「${value}」重复`,
          })
        }
        seen.add(value)
      }
    }
    unique(
      manifest.contributes.tools.map((tool) => tool.name),
      ['contributes', 'tools'],
      '工具名',
    )
    unique(
      manifest.contributes.commands.map((command) => command.name),
      ['contributes', 'commands'],
      '命令名',
    )
    unique(
      manifest.contributes.automation.actions.map((action) => action.name),
      ['contributes', 'automation', 'actions'],
      '自动化动作名',
    )
    unique(
      manifest.contributes.automation.events.map((event) => event.name),
      ['contributes', 'automation', 'events'],
      '自动化事件名',
    )
    unique(
      manifest.contributes.panels.map((panel) => panel.id),
      ['contributes', 'panels'],
      '面板 id',
    )
    unique(
      manifest.contributes.widgets.map((widget) => widget.id),
      ['contributes', 'widgets'],
      '小组件 id',
    )
    unique(
      manifest.contributes.themes.map((theme) => theme.id),
      ['contributes', 'themes'],
      '主题 id',
    )
    unique(
      manifest.config.fields.map((field) => field.key),
      ['config', 'fields'],
      '配置项 key',
    )
    unique(manifest.contributes.skills, ['contributes', 'skills'], 'Skill 目录')
    unique(manifest.events, ['events'], '事件名')

    // 工具最终名长度（`plugin.<id>.<name>` ≤ 64）与参数 schema 形状
    for (const [index, tool] of manifest.contributes.tools.entries()) {
      const full = pluginToolName(manifest.id, tool.name)
      if (full.length > PLUGIN_TOOL_FULL_NAME_MAX) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['contributes', 'tools', index, 'name'],
          message: `最终工具名 ${full} 超过 ${PLUGIN_TOOL_FULL_NAME_MAX} 字符`,
        })
      }
      if (tool.parameters['type'] !== 'object') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['contributes', 'tools', index, 'parameters'],
          message: '工具参数必须是 type: "object" 的 JSON Schema',
        })
      }
      if (JSON.stringify(tool.parameters).length > PLUGIN_MANIFEST_LIMITS.maxToolSchemaBytes) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['contributes', 'tools', index, 'parameters'],
          message: '工具参数 schema 超过 64 KB',
        })
      }
    }

    for (const [index, widget] of manifest.contributes.widgets.entries()) {
      if (widget.slot === 'edge-bar' && widget.defaultSize !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['contributes', 'widgets', index, 'defaultSize'],
          message: '提示条小组件不支持 defaultSize',
        })
      }
      if (widget.slot === 'edge-bar' && widget.windowLevel !== 'floating') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['contributes', 'widgets', index, 'windowLevel'],
          message: '提示条小组件不支持 windowLevel（只允许默认 floating）',
        })
      }
      if (widget.slot === 'edge-bar' && widget.windowMaterial !== 'none') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['contributes', 'widgets', index, 'windowMaterial'],
          message: '提示条小组件不支持 windowMaterial（只允许默认 none）',
        })
      }
    }

    for (const [index, theme] of manifest.contributes.themes.entries()) {
      if (Object.keys(theme.tokens).length > PLUGIN_THEME_MAX_TOKENS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['contributes', 'themes', index, 'tokens'],
          message: `主题令牌不能超过 ${PLUGIN_THEME_MAX_TOKENS} 个`,
        })
      }
      for (const error of validateThemeTokens(theme.tokens)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['contributes', 'themes', index, 'tokens'],
          message: error,
        })
      }
    }

    for (const [index, field] of manifest.config.fields.entries()) {
      if (
        field.type === 'select' &&
        field.default !== undefined &&
        typeof field.default !== 'string'
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['config', 'fields', index, 'default'],
          message: 'select 字段的默认值必须是字符串',
        })
      }
    }
  })

export type PluginManifest = z.infer<typeof PluginManifestSchema>
export type PluginToolContribution = PluginManifest['contributes']['tools'][number]
export type PluginCommandContribution = PluginManifest['contributes']['commands'][number]
export type PluginPanelContribution = PluginManifest['contributes']['panels'][number]
export type PluginWidgetContribution = PluginManifest['contributes']['widgets'][number]
export type PluginThemeContribution = PluginManifest['contributes']['themes'][number]
export type PluginConfigField = PluginManifest['config']['fields'][number]
export type PluginAutomationActionContribution =
  PluginManifest['contributes']['automation']['actions'][number]

export interface PluginManifestParseResult {
  ok: boolean
  manifest?: PluginManifest
  errors: string[]
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''
    return `${path}${issue.message}`
  })
}

/**
 * 解析清单：成功返回补齐默认值后的对象，失败返回**全部**错误（不是第一条）。
 * 安装器把它展示成「清单校验失败」列表，市场在服务端用同一函数拒绝上传。
 */
export function parsePluginManifest(raw: unknown): PluginManifestParseResult {
  const result = PluginManifestSchema.safeParse(raw)
  if (result.success) return { ok: true, manifest: result.data, errors: [] }
  return { ok: false, errors: formatIssues(result.error) }
}

/** 清单原始 JSON 的字节上限检查（读文件时先做，避免解析超大 JSON）。 */
export function isManifestTooLarge(bytes: number): boolean {
  return bytes > PLUGIN_MANIFEST_LIMITS.maxManifestBytes
}
