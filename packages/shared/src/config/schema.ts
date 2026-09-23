/**
 * 配置 Schema（SSOT：docs/08-settings-onboarding.md §1）
 *
 * 约束：新增配置字段必须先更新 docs/08，再更新本文件与 `defaults.ts`。
 * 本文件是纯声明式校验，不做跨字段业务校验（那属于 SettingsStore 职责）。
 */
import { z } from 'zod'

export const CONFIG_VERSION = 6 as const

/**
 * 模式展示 / 装配顺序：**ClassRoom 在前**（v1 首发且唯一完整实现）。
 * 08 §1 注释中的 `work / code / classroom` 为枚举列举顺序，不表示 UI 顺序；
 * 设置页与引导按本数组顺序渲染（docs/07 §2.5「三模式卡片」、docs/08 §3「ClassRoom 推荐」）。
 */
export const MODE_IDS = ['classroom', 'work', 'code'] as const
export type ModeId = (typeof MODE_IDS)[number]
export const ModeIdSchema = z.enum(MODE_IDS)

export const WINDOW_NAMES = ['edge-bar', 'chat', 'settings', 'onboarding'] as const
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

/**
 * 模型思考等级（docs/06 §3）：`auto` = 不下发 `reasoning_effort` 字段。
 *
 * `auto` 存在的原因是兼容性：不认这个参数的 OpenAI 兼容厂商收到它可能直接 400，
 * 所以「不选」必须能表达成「字段根本不出现」，而不是发一个空值。
 */
export const REASONING_EFFORT_LEVELS = ['auto', 'low', 'medium', 'high'] as const
export type ReasoningEffort = (typeof REASONING_EFFORT_LEVELS)[number]
export const ReasoningEffortSchema = z.enum(REASONING_EFFORT_LEVELS)

export const LlmProviderSchema = z.object({
  type: LlmProviderTypeSchema,
  baseUrl: z.string(),
  /** safeStorage 密文；解密值只存在于运行时内存。 */
  apiKeyEnc: z.string(),
  model: z.string(),
  /**
   * 该 provider 下可选的模型 id 列表（docs/08 §5）。
   * 用 `.default([])` 而不是「可选字段」：设置页与对话窗都必须能无条件读到一个数组，
   * 否则每一处消费都要写 `?? []`，漏一处就是一个运行时崩点。
   * 仅作**候选列表**用途：真正生效的仍是 `model`——列表里没有 `model` 时，
   * 选项串里要把当前值显示为「（不在列表中）」而不是把它悄悄替换掉。
   */
  modelList: z.array(z.string()).default([]),
  temperature: z.number().min(0).max(2),
  /** 思考等级；由主进程装配层把 `auto` 映射成「不下发」（docs/06 §11）。 */
  reasoningEffort: ReasoningEffortSchema,
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

/** AI 改配置（settings 工具）一律禁止触碰的路径前缀（docs/06 §12）。 */
export const SETTINGS_READONLY_PREFIXES = [
  // 凭据与密文：绝不让 AI 读回或改写（凭据只经 safeStorage / setSecret 落库）
  'llm.providers',
  'mcp.servers',
  // Schema 版本与窗口几何：改坏会让配置迁移 / 窗口位置出现难以复现的怪状
  'version',
  'general.windowState',
  // 代理：写错会让所有出网立刻失效，AI 连不上自己就没法改回来
  'advanced.proxy',
  // 引导与首次运行标记、开机自启、全局快捷键：改它会改变启动路径或抢占系统热键
  'general.onboarded',
  'general.firstRun',
  'general.launchAtLogin',
  'general.hotkey',
  // 敏感工具确认总闸门：`agent-host` 每次调用**即时判断**它，关掉后 `run_command` /
  // `write_file` / 全部 MCP 工具 / `set_setting` 自身都不再弹确认卡片 —— 等于 AI 自我提权。
  // 只保留「用户在设置页手动关」这一条路径（设置页走 `settings:update`，不经过本黑名单）。
  'advanced.confirmSensitiveTools',
] as const

export const AdvancedSchema = z.object({
  proxy: z.string(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']),
  quietHours: QuietHoursSchema,
  /**
   * 敏感工具（`sensitivity = 'confirm'`，含全部 MCP 工具）执行前是否要求用户确认
   * （docs/06 §5）。关闭后按 v0.3.0 行为降级：只记日志留痕、不拦截。
   *
   * 注意：本字段在 `SETTINGS_READONLY_PREFIXES` 里，**只能由用户在设置页 / 直接改配置**关闭，
   * AI 的 `set_setting` 一律拒绝（否则等于「AI 自己摘掉确认闸门」= 自我提权）。
   */
  confirmSensitiveTools: z.boolean(),
  /**
   * AI 改配置（`set_setting`）禁止触碰的路径前缀（docs/06 §12）。
   *
   * 默认值即 `SETTINGS_READONLY_PREFIXES`（不可变元组 → 展开成可变数组）。
   *
   * 语义：**只能在默认黑名单之上追加限制，不能放宽** —— `settingsReadonlyReason` 在查过用户配置项之后
   * 仍会**无条件**再走一遍硬编码常量（`canWriteSettingPath` 从不接收用户配置），所以删掉默认项
   * 甚至把它清空都**不会**放开对应路径（清空 = 回到默认项）。「Schema 必须识别该路径」那条兜底同样不随它变化。
   */
  readonlyPrefixes: z.array(z.string()).default([...SETTINGS_READONLY_PREFIXES]),
})
export type AdvancedSettings = z.infer<typeof AdvancedSchema>

/**
 * 电脑操控工具名（docs/06 §11）——工具注册、设置页静态展示、smoke 断言共用同一份常量，
 * 避免三处各写一份字符串导致改名时漏改。
 */
export const COMPUTER_TOOL_NAMES = [
  'run_command',
  'read_file',
  'write_file',
  'list_dir',
  'open_path',
] as const
export type ComputerToolName = (typeof COMPUTER_TOOL_NAMES)[number]

/**
 * 电脑操控工具配置（docs/08 §1、docs/06 §11）。
 *
 * `workspaceDir` 只是工具的**默认**工作目录（空串 = 用户主目录），**不是沙箱**：
 * 模型仍可显式传入其它路径，安全靠"逐次确认 + 输出上限 + 总开关"而不是路径限制。
 */
export const AgentToolsSchema = z.object({
  /** 总开关；false 时 5 个工具一个都不注册。 */
  enabled: z.boolean(),
  workspaceDir: z.string(),
  terminal: z.object({
    enabled: z.boolean(),
    timeoutMs: z.number().int().min(1_000).max(300_000),
    maxOutputChars: z.number().int().min(500).max(100_000),
  }),
  files: z.object({
    enabled: z.boolean(),
    maxReadBytes: z.number().int().min(1_024).max(4_194_304),
  }),
  open: z.object({
    enabled: z.boolean(),
  }),
})
export type AgentToolsConfig = z.infer<typeof AgentToolsSchema>

export const AgentSchema = z.object({
  tools: AgentToolsSchema,
})
export type AgentSettings = z.infer<typeof AgentSchema>

export const SettingsSchema = z.object({
  version: z.number().int().min(0),
  general: GeneralSchema,
  llm: LlmSchema,
  modes: ModesSchema,
  skills: SkillsSchema,
  mcp: McpSchema,
  advanced: AdvancedSchema,
  agent: AgentSchema,
})

export type Settings = z.infer<typeof SettingsSchema>

/** 黑名单前缀 → 给模型与审计日志看的中文原因（每个默认前缀都必须有一条）。 */
const READONLY_PREFIX_REASONS: Record<(typeof SETTINGS_READONLY_PREFIXES)[number], string> = {
  'llm.providers': '凭据字段不允许通过工具修改',
  'mcp.servers': '凭据字段不允许通过工具修改',
  version: '配置版本由迁移链维护，不允许通过工具修改',
  'general.windowState': '窗口位置由系统维护，不允许通过工具修改',
  'advanced.proxy': '代理设置写错会立即断网，不允许通过工具修改',
  'general.onboarded': '引导状态不允许通过工具修改',
  'general.firstRun': '首次运行标记不允许通过工具修改',
  'general.launchAtLogin': '开机自启不允许通过工具修改',
  'general.hotkey': '全局快捷键不允许通过工具修改',
  'advanced.confirmSensitiveTools': '关闭它等于摘掉敏感工具的确认闸门，不允许通过工具修改',
}

/**
 * 前缀匹配按**路径段**判断：`llm.providers` 命中 `llm.providers.x.apiKeyEnc`，
 * 但**不**命中 `llm.providerSuffix`（后者只是字符级前缀相同，段名并非 `providers`）；
 * `version` 同理不命中 `versionXxx`。逐段相等才算是命中，避免相近字段名被误伤进黑名单。
 */
function matchReadonlyPrefix(
  path: string,
): (typeof SETTINGS_READONLY_PREFIXES)[number] | undefined {
  const segments = path.split('.')
  for (const prefix of SETTINGS_READONLY_PREFIXES) {
    const prefixSegments = prefix.split('.')
    if (prefixSegments.length > segments.length) continue
    if (prefixSegments.every((segment, index) => segments[index] === segment)) return prefix
  }
  return undefined
}

/**
 * 路径是否被 Schema 登记：静态字段命中 `lookupSpec`（含 `*` / `[]` 通配兜底），
 * 或落在 `z.record` 这类动态键路径上（`llm.providers` / `general.windowState`）。
 */
function isKnownSettingPath(path: string): boolean {
  return lookupSpec(path) !== undefined || isDynamicPath(path)
}

/**
 * 工具传来的路径必须是**具体路径**，不是 Schema 的通配模式。
 *
 * `[]` / `*` 只属于 `lookupSpec` / `isDynamicPath` 的内部模式语言（它们服务于设置页门控与
 * 逐字段回退，另有用途，语义不动）。若把 `llm.providers[]` 当成可写，`canWriteSettingPath`
 * 会放行，而 `applyPatch` 写下去时 Zod 会把意外键 strip 掉 —— 结果是
 * 「`get` / `list` 说可写 + `set` 回报成功但配置一字未改」的**假成功**。
 * 同理拦掉空段（`llm..providers`）与首尾 `.`：它们同样不是任何真实字段的路径。
 */
function isConcreteSettingPath(path: string): boolean {
  if (path === '') return false
  if (path.includes('[') || path.includes(']') || path.includes('*')) return false
  if (path.startsWith('.') || path.endsWith('.')) return false
  return path.split('.').every((segment) => segment !== '')
}

/**
 * 路径不可写时给出人类可读的中文原因（可写则返回 `undefined`）。
 * 工具把原因回填给模型，写审计日志也复用它留痕（docs/06 §12）。
 */
export function settingsReadonlyReason(path: string): string | undefined {
  // 先做路径合法性检查（见 `isConcreteSettingPath`）：通配 / 畸形路径一律按未知路径拒绝
  if (!isConcreteSettingPath(path)) return '未知配置路径'
  const prefix = matchReadonlyPrefix(path)
  if (prefix !== undefined) return READONLY_PREFIX_REASONS[prefix]
  // `fieldAccepts` 对**未登记**的路径默认放行（见该函数注释「未登记的路径默认接受」），
  // 只靠它当白名单的话，拼错的字段（`modes.classrom.typo`）会被悄悄写进 config.json，
  // 再被 `SettingsSchema` 判为非法，把整份配置拖进备份 + 重建。
  if (!isKnownSettingPath(path)) return '未知配置路径'
  return undefined
}

/**
 * AI 改配置（`set_setting` 工具）的路径是否可写（docs/06 §12）。
 * 规则：① 命中 `SETTINGS_READONLY_PREFIXES` → 拒绝；
 *      ② 路径必须能被 Schema 识别（`lookupSpec` 登记过，或 `isDynamicPath` 认的通配路径）→ 否则拒绝
 *         （防拼错字段悄悄写进配置；**不能**用 `fieldAccepts`，它对未登记路径默认放行）。
 */
export function canWriteSettingPath(path: string): boolean {
  return settingsReadonlyReason(path) === undefined
}

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

/** 枚举字段的合法取值表（`z.enum`）：类型对不代表值合法，必须按值校验。 */
type EnumSpec = readonly unknown[]

const schemaSpecs = new Map<string, AcceptSpec>()
const enumPaths = new Map<string, EnumSpec>()
walk(SettingsSchema, '', schemaSpecs, enumPaths)
const dynamicPaths = collectDynamicPaths(SettingsSchema)

export const fieldAccepts: FieldValidator = (path, candidate) => {
  const allowedValues = lookupEnum(path)
  if (allowedValues !== undefined) return allowedValues.includes(candidate)
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

/**
 * 枚举路径查找（与 `lookupSpec` 同一套通配兜底）：
 * `llm.providers.<id>.reasoningEffort` 在 Schema 遍历时登记成 `llm.providers.*.reasoningEffort`，
 * 因此逐级用 `*` / `[]` 替换才找得到。
 */
function lookupEnum(path: string): EnumSpec | undefined {
  const exact = enumPaths.get(path)
  if (exact !== undefined) return exact

  const segments = path.split('.')
  for (let i = 0; i < segments.length; i++) {
    const alternatives = segments[i] === '[]' ? ['*'] : ['*', '[]']
    for (const alternative of alternatives) {
      if (alternative === segments[i]) continue
      const candidatePath = [...segments.slice(0, i), alternative, ...segments.slice(i + 1)].join(
        '.',
      )
      const found = enumPaths.get(candidatePath)
      if (found !== undefined) return found
    }
  }

  if (!path.endsWith('[]')) {
    const withSuffix = path.replace(/\.([^.]+)$/, '.$1[]')
    const found = enumPaths.get(withSuffix)
    if (found !== undefined) return found
  }
  return undefined
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

function walk(
  schema: z.ZodTypeAny,
  path: string,
  specs: Map<string, AcceptSpec>,
  enums: Map<string, EnumSpec>,
): void {
  const def = schema._def as { typeName: string; [key: string]: unknown }

  switch (def.typeName) {
    case 'ZodObject': {
      const shape = materialize(def['shape'])
      if (shape && typeof shape === 'object') {
        for (const [key, value] of Object.entries(shape as Record<string, z.ZodTypeAny>)) {
          walk(value, path === '' ? key : `${path}.${key}`, specs, enums)
        }
      }
      return
    }
    case 'ZodEnum': {
      // 类型层面枚举按"任意类型"处理（值本身是字符串），但**值**逐个登记以便按值校验：
      // 非法枚举值（如 `logLevel: 'verbose'`）此前会一路活到 `SettingsSchema.parse`，
      // 把**整份配置**判为损坏（备份 + 重建），而不是像其它非法字段那样只回退这一个字段。
      //
      // 注意生效范围：只对**静态**枚举路径有效（`advanced.logLevel`、`modes.current`、
      // `modes.classroom.schedule.{provider,classisland.source}`）。`llm.providers.*.reasoningEffort`
      // 虽然也是 `z.enum`，但它在 `z.record` 之下、而 record 路径被 `isDynamicPath` 判定为
      // "整体保留候选对象"（见 store.ts 的 sanitize），逐字段校验根本不会被问到；
      // 那边靠 `migrateV4ToV5` 把非法值回落成 `auto` 兜底。
      const values = def['values'] as readonly unknown[] | undefined
      if (values) enums.set(path, values)
      record(specs, path, 'any')
      return
    }
    case 'ZodRecord': {
      // 键是动态的：本级整体接受，值结构记在 `<path>.*` 下
      record(specs, path, 'any')
      const valueType = def['valueType']
      if (valueType) walk(valueType as z.ZodTypeAny, `${path}.*`, specs, enums)
      return
    }
    case 'ZodArray': {
      record(specs, path, ['array'])
      const element = materialize(def['type'])
      if (element) walk(element as z.ZodTypeAny, elementSegment(path), specs, enums)
      return
    }
    case 'ZodUnion':
      for (const option of def['options'] as z.ZodTypeAny[]) walk(option, path, specs, enums)
      return
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
    case 'ZodCatch':
    case 'ZodReadonly': {
      const inner = def['innerType']
      if (inner) walk(inner as z.ZodTypeAny, path, specs, enums)
      return
    }
    case 'ZodEffects': {
      // z.refine / z.transform：直接用输出类型继续（无输出类型时按"任意"处理）
      const inner = def['innerType'] as z.ZodTypeAny | undefined
      if (inner) walk(inner, path, specs, enums)
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
