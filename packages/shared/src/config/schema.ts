/**
 * 配置 Schema（SSOT：docs/08-settings-onboarding.md §1）
 *
 * 约束：新增配置字段必须先更新 docs/08，再更新本文件与 `defaults.ts`。
 * 本文件是纯声明式校验，不做跨字段业务校验（那属于 SettingsStore 职责）。
 */
import { z } from 'zod'

export const CONFIG_VERSION = 4 as const

/**
 * 模式展示 / 装配顺序：**ClassRoom 在前**（v1 首发且唯一完整实现）。
 * 08 §1 注释中的 `work / code / classroom` 为枚举列举顺序，不表示 UI 顺序；
 * 设置页与引导按本数组顺序渲染（docs/07 §2.5「三模式卡片」、docs/08 §3「ClassRoom 推荐」）。
 */
export const MODE_IDS = ['classroom', 'work', 'code'] as const
export type ModeId = (typeof MODE_IDS)[number]
export const ModeIdSchema = z.enum(MODE_IDS)

export const WINDOW_NAMES = ['edge-bar', 'chat', 'mini-chat', 'settings', 'onboarding'] as const
export type WindowName = (typeof WINDOW_NAMES)[number]
export const WindowNameSchema = z.enum(WINDOW_NAMES)

/** 05 §2 默认科目模板 */
export const DEFAULT_SUBJECT_NAMES = [
  '语文',
  '数学',
  '英语',
  '物理',
  '化学',
  '生物',
  '历史',
  '地理',
  '政治',
] as const

/** 默认科目根目录（相对感知文件夹） */
export const DEFAULT_SUBJECT_FOLDER_PREFIX = '分类'

export const QuietHoursSchema = z
  .object({
    start: z.string(), // "22:30"
    end: z.string(), // "07:00"
  })
  .nullable()

export const EdgeBarSchema = z.object({
  enabled: z.boolean(),
  opacity: z.number().min(0.2).max(1),
  quietHours: QuietHoursSchema,
})

export const GeneralSchema = z.object({
  language: z.string().min(2),
  launchAtLogin: z.boolean(),
  hotkey: z.string().min(1),
  edgeBar: EdgeBarSchema,
  /** 各窗口位置 / 尺寸记忆（docs/02 §2.2、docs/07 §2）。 */
  windowState: z.record(WindowNameSchema, z.record(z.string(), z.unknown())),
})
export type GeneralSettings = z.infer<typeof GeneralSchema>

export const LlmProviderTypeSchema = z.enum(['openai-compat'])
export type LlmProviderType = z.infer<typeof LlmProviderTypeSchema>

export const LlmProviderSchema = z.object({
  type: LlmProviderTypeSchema,
  baseUrl: z.string(),
  /** safeStorage 密文；解密值只存在于运行时内存。 */
  apiKeyEnc: z.string(),
  model: z.string(),
  temperature: z.number().min(0).max(2),
})
export type LlmProviderConfig = z.infer<typeof LlmProviderSchema>

export const LlmSchema = z.object({
  /** 默认 provider id；空串表示尚未配置（此时主功能不可用）。 */
  active: z.string(),
  providers: z.record(z.string(), LlmProviderSchema),
})
export type LlmSettings = z.infer<typeof LlmSchema>

export const SubjectSchema = z.object({
  name: z.string().min(1),
  /** 目标文件夹，相对 watchDir 或绝对路径。 */
  folder: z.string().min(1),
  /** 分类关键词，P4 规则缓存使用（docs/05 §3.2）。 */
  keywords: z.array(z.string()),
})
export type SubjectConfig = z.infer<typeof SubjectSchema>

export const ScheduleProviderSchema = z.enum(['manual', 'classisland'])
export type ScheduleProviderId = z.infer<typeof ScheduleProviderSchema>

export const LessonSchema = z.object({
  /** 0=周日 … 6=周六 */
  weekday: z.number().int().min(0).max(6),
  /** "HH:mm" */
  startTime: z.string(),
  endTime: z.string(),
  subject: z.string(),
})
export type Lesson = z.infer<typeof LessonSchema>

/**
 * ClassIsland 桥接数据源（docs/05 §3.4 v2）。
 *
 * ClassIsland 自身只提供 .NET 插件体系与命名管道 IPC，没有可供 Node 侧直接消费的
 * HTTP API；因此 Aurora 只认一份**本地 JSON 契约**（`classisland.ts` 的
 * `ClassIslandPayload`），由随仓库附带的桥接插件（`integrations/classisland-bridge`）
 * 以文件或本地 HTTP 端点两种方式暴露。
 */
export const ClassIslandSourceSchema = z.enum(['http', 'file'])
export type ClassIslandSource = z.infer<typeof ClassIslandSourceSchema>

export const ClassIslandScheduleSchema = z.object({
  source: ClassIslandSourceSchema,
  /** `http` 为桥接端点 URL；`file` 为 JSON 文件绝对路径。空串表示尚未配置。 */
  endpoint: z.string(),
  /** 单次读取/请求超时（毫秒） */
  timeoutMs: z.number().int().min(200).max(30_000),
})
export type ClassIslandScheduleConfig = z.infer<typeof ClassIslandScheduleSchema>

export const ScheduleSchema = z.object({
  provider: ScheduleProviderSchema,
  lessons: z.array(LessonSchema),
  classisland: ClassIslandScheduleSchema,
})
export type ScheduleConfig = z.infer<typeof ScheduleSchema>

/** 分类管线行为（docs/05 §3.2、docs/08 §1）。 */
export const ClassificationSchema = z.object({
  /** 判定成功后就地移动文件；false 时只记录流水、不动文件。 */
  autoMove: z.boolean(),
  /** 低于该置信度的判定进「待分类」，不猜（docs/05 §3.2）。 */
  confidenceThreshold: z.number().min(0).max(1),
  /** 兜底目录，相对 watchDir 或绝对路径。 */
  fallbackFolder: z.string().min(1),
})
export type ClassificationConfig = z.infer<typeof ClassificationSchema>

export const ClassroomModeSchema = z.object({
  guideCompleted: z.boolean(),
  /** 智慧感知文件夹绝对路径；空串表示未配置。 */
  watchDir: z.string(),
  subjects: z.array(SubjectSchema),
  schedule: ScheduleSchema,
  preClassReminder: z.boolean(),
  classification: ClassificationSchema,
})
export type ClassroomModeConfig = z.infer<typeof ClassroomModeSchema>

export const PlaceholderModeSchema = z.object({
  guideCompleted: z.boolean(),
})
export type PlaceholderModeConfig = z.infer<typeof PlaceholderModeSchema>

export const ModesSchema = z.object({
  current: ModeIdSchema,
  classroom: ClassroomModeSchema,
  work: PlaceholderModeSchema,
  code: PlaceholderModeSchema,
})
export type ModesSettings = z.infer<typeof ModesSchema>

export const SkillsSchema = z.object({
  /** 用户技能目录，空串表示使用默认 userData/skills。 */
  userDir: z.string(),
  disabled: z.array(z.string()),
})
export type SkillsSettings = z.infer<typeof SkillsSchema>

export const McpServerSchema = z.object({
  name: z.string().min(1),
  transport: z.enum(['stdio', 'http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  /** key 为环境变量名，value 为 safeStorage 密文。 */
  envEnc: z.record(z.string(), z.string()),
  enabled: z.boolean(),
})
export type McpServerConfig = z.infer<typeof McpServerSchema>

export const McpSchema = z.object({
  servers: z.array(McpServerSchema),
  /**
   * 连接策略（docs/06 §7）：`true` 时首次使用才连接（懒连接）；
   * `false` 为默认——启动即连，失败降级为状态灯 error。
   */
  lazyConnect: z.boolean(),
})
export type McpSettings = z.infer<typeof McpSchema>

export const AdvancedSchema = z.object({
  proxy: z.string(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']),
  quietHours: QuietHoursSchema,
  /**
   * 敏感工具（`sensitivity = 'confirm'`，含全部 MCP 工具）执行前是否要求用户确认
   * （docs/06 §5）。关闭后按 v0.3.0 行为降级：只记日志留痕、不拦截。
   */
  confirmSensitiveTools: z.boolean(),
})
export type AdvancedSettings = z.infer<typeof AdvancedSchema>

export const SettingsSchema = z.object({
  version: z.number().int().min(0),
  general: GeneralSchema,
  llm: LlmSchema,
  modes: ModesSchema,
  skills: SkillsSchema,
  mcp: McpSchema,
  advanced: AdvancedSchema,
})

export type Settings = z.infer<typeof SettingsSchema>

/**
 * 逐字段回退用的路径感知校验器：`fieldAccepts('general.language', 42) === false`，
 * 但 `fieldAccepts('llm.providers.deepseek.apiKeyEnc', 'x') === true`。
 *
 * 实现方式：遍历 Schema 收集"路径 → 可接受类型"表（含数组元素通配 `[]`、
 * record 动态键通配 `*`），校验时精确匹配 + 逐级通配兜底。
 */
export type { FieldValidator } from '../utils/object.js'

import type { FieldValidator } from '../utils/object.js'

/** 'any' 表示"该路径接受任意类型"（枚举 / 字面量） */
type AcceptSpec = 'any' | readonly string[]

const schemaSpecs = buildSpecs(SettingsSchema)
const dynamicPaths = collectDynamicPaths(SettingsSchema)

export const fieldAccepts: FieldValidator = (path, candidate) => {
  const spec = lookupSpec(path)
  if (spec === undefined || spec === 'any') return true
  return spec.includes(typeNameOf(candidate))
}

/**
 * 动态键字段（`z.record`，如 `llm.providers` / `general.windowState`）：
 * 其键不受 Schema 约束，逐字段回退时必须**整体保留**候选对象，
 * 否则用户新增的 provider / 窗口位置会被吞掉。
 */
export function isDynamicPath(path: string): boolean {
  if (dynamicPaths.has(path)) return true
  if (dynamicPaths.has(stripElementSuffix(path))) return true
  return lookupDynamic(path)
}

function stripElementSuffix(path: string): string {
  return path.endsWith('[]') ? path.slice(0, -2) : path
}

function collectDynamicPaths(root: z.ZodTypeAny, path = '', out = new Set<string>()): Set<string> {
  const def = root._def as { typeName: string; [key: string]: unknown }
  const elementPath = path.endsWith('[]') ? path : `${path}[]`

  switch (def.typeName) {
    case 'ZodObject': {
      const shape = materialize(def['shape'])
      if (shape && typeof shape === 'object') {
        for (const [key, value] of Object.entries(shape as Record<string, z.ZodTypeAny>)) {
          collectDynamicPaths(value, path === '' ? key : `${path}.${key}`, out)
        }
      }
      return out
    }
    case 'ZodRecord':
      out.add(path)
      return out
    case 'ZodArray': {
      const element = materialize(def['type'])
      if (element) collectDynamicPaths(element as z.ZodTypeAny, elementPath, out)
      return out
    }
    case 'ZodUnion':
      for (const option of def['options'] as z.ZodTypeAny[]) collectDynamicPaths(option, path, out)
      return out
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
    case 'ZodEffects':
    case 'ZodCatch':
    case 'ZodReadonly': {
      const inner = def['innerType']
      if (inner) collectDynamicPaths(inner as z.ZodTypeAny, path, out)
      return out
    }
    default:
      return out
  }
}

function lookupDynamic(path: string): boolean {
  const segments = path.split('.')
  for (let i = 0; i < segments.length; i++) {
    for (const alternative of ['*', '[]']) {
      if (segments[i] === alternative) continue
      const candidatePath = [...segments.slice(0, i), alternative, ...segments.slice(i + 1)].join(
        '.',
      )
      if (dynamicPaths.has(candidatePath)) return true
    }
  }
  return false
}

/**
 * 路径查找：优先精确匹配；
 * 动态键字段的键名是运行时才知道的，用逐级替换为通配段（`*` = record 键）兜底；
 * 数组元素路径形如 `modes.classroom.subjects[]`，与 Schema 遍历时的命名一致。
 */
function lookupSpec(path: string): AcceptSpec | undefined {
  const exact = schemaSpecs.get(path)
  if (exact !== undefined) return exact

  const segments = path.split('.')
  for (let i = 0; i < segments.length; i++) {
    const alternatives = segments[i] === '[]' ? ['*'] : ['*', '[]']
    for (const alternative of alternatives) {
      if (alternative === segments[i]) continue
      const candidatePath = [...segments.slice(0, i), alternative, ...segments.slice(i + 1)].join(
        '.',
      )
      const found = schemaSpecs.get(candidatePath)
      if (found !== undefined) return found
    }
  }

  // 元素路径本身可能带 `[]` 后缀（`subjects[].name`）
  if (!path.endsWith('[]')) {
    const withSuffix = path.replace(/\.([^.]+)$/, '.$1[]')
    const found = schemaSpecs.get(withSuffix)
    if (found !== undefined) return found
  }
  return undefined
}

/** 调试 / 测试用：已登记的字段路径数量。 */
export function schemaPathCount(): number {
  return schemaSpecs.size
}

/** 调试 / 测试用：导出"路径 → 可接受类型"表。 */
export function debugSchemaSpecs(): Record<string, AcceptSpec | undefined> {
  return Object.fromEntries(schemaSpecs)
}

function buildSpecs(root: z.ZodTypeAny, path = ''): Map<string, AcceptSpec> {
  const specs = new Map<string, AcceptSpec>()
  walk(root, path, specs)
  return specs
}

function record(specs: Map<string, AcceptSpec>, path: string, spec: AcceptSpec): void {
  const existing = specs.get(path)
  if (existing === undefined) {
    specs.set(path, spec)
    return
  }
  if (existing === 'any' || spec === 'any') {
    specs.set(path, 'any')
    return
  }
  const merged = new Set<string>([...existing, ...spec])
  specs.set(path, [...merged])
}

/** 数组元素路径：`modes.classroom.subjects` → `modes.classroom.subjects[]` */
function elementSegment(path: string): string {
  return path.endsWith('[]') ? path : `${path}[]`
}

function walk(schema: z.ZodTypeAny, path: string, specs: Map<string, AcceptSpec>): void {
  const def = schema._def as { typeName: string; [key: string]: unknown }

  switch (def.typeName) {
    case 'ZodObject': {
      const shape = materialize(def['shape'])
      if (shape && typeof shape === 'object') {
        for (const [key, value] of Object.entries(shape as Record<string, z.ZodTypeAny>)) {
          walk(value, path === '' ? key : `${path}.${key}`, specs)
        }
      }
      return
    }
    case 'ZodRecord': {
      // 键是动态的：本级整体接受，值结构记在 `<path>.*` 下
      record(specs, path, 'any')
      const valueType = def['valueType']
      if (valueType) walk(valueType as z.ZodTypeAny, `${path}.*`, specs)
      return
    }
    case 'ZodArray': {
      record(specs, path, ['array'])
      const element = materialize(def['type'])
      if (element) walk(element as z.ZodTypeAny, elementSegment(path), specs)
      return
    }
    case 'ZodUnion':
      for (const option of def['options'] as z.ZodTypeAny[]) walk(option, path, specs)
      return
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
    case 'ZodCatch':
    case 'ZodReadonly': {
      const inner = def['innerType']
      if (inner) walk(inner as z.ZodTypeAny, path, specs)
      return
    }
    case 'ZodEffects': {
      // z.refine / z.transform：直接用输出类型继续（无输出类型时按"任意"处理）
      const inner = def['innerType'] as z.ZodTypeAny | undefined
      if (inner) walk(inner, path, specs)
      else record(specs, path, 'any')
      return
    }
    default: {
      const typeName = typeNameForZod(def.typeName)
      record(specs, path, typeName === 'any' ? 'any' : [typeName])
      return
    }
  }
}

/** zod v3 的 `_def.shape` / `_def.type` 可能是惰性函数。 */
function materialize(value: unknown): unknown {
  return typeof value === 'function' ? (value as () => unknown)() : value
}

function typeNameForZod(typeName: string): string {
  switch (typeName) {
    case 'ZodString':
      return 'string'
    case 'ZodNumber':
      return 'number'
    case 'ZodBoolean':
      return 'boolean'
    case 'ZodNull':
      return 'null'
    case 'ZodEnum':
    case 'ZodNativeEnum':
    case 'ZodLiteral':
      return 'any'
    case 'ZodDate':
      return 'date'
    default:
      return 'any'
  }
}

function typeNameOf(candidate: unknown): string {
  if (candidate === null) return 'null'
  if (Array.isArray(candidate)) return 'array'
  if (candidate instanceof Date) return 'date'
  return typeof candidate
}
