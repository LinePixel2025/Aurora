/**
 * 配置 Schema（SSOT：docs/08-settings-onboarding.md §1）
 *
 * 约束：新增配置字段必须先更新 docs/08，再更新本文件与 `defaults.ts`。
 * 本文件是纯声明式校验，不做跨字段业务校验（那属于 SettingsStore 职责）。
 */
import { z } from 'zod'

export const CONFIG_VERSION = 17 as const

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
  /** 对话窗展示偏好（v8 新增）。 */
  chat: z.object({
    /** 对话界面展示思考过程（MessageList 可折叠思考块的门控，docs/07 §2.3）。 */
    showThinking: z.boolean(),
  }),
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
  /**
   * 该模型的上下文窗口（token），v11 新增（docs/08 §1）。
   *
   * 只用于对话窗输入框底部的**上下文占用**展示：`promptTokens / contextWindow` 即占用比例。
   * 取值来源是用户填写（服务商文档里的 context length），**不做内置模型表** ——
   * 模型名千变万化，猜错一个数量级比不显示更误导。
   * `0` = 未知：此时只显示 token 数与字符数，不显示占比与进度条（不编造分母）。
   */
  contextWindow: z.number().int().min(0).max(2_000_000).default(0),
})
export type LlmProviderConfig = z.infer<typeof LlmProviderSchema>

export const LlmSchema = z.object({
  /** 默认 provider id；空串表示尚未配置（此时主功能不可用）。 */
  active: z.string(),
  providers: z.record(z.string(), LlmProviderSchema),
})
export type LlmSettings = z.infer<typeof LlmSchema>

/** TTS 输出音频格式（docs/06 §13、docs/08 §1）——决定请求体的 `response_format` 与播放的 MIME。 */
export const TTS_FORMATS = ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'] as const
export type TtsFormat = (typeof TTS_FORMATS)[number]

/**
 * TTS provider 的接口协议类型（docs/06 §13.1 / §13.6）：
 * - `openai-compat`：OpenAI 兼容 `POST <baseUrl>/audio/speech`；
 * - `dashscope`：DashScope 原生非实时合成协议（百炼 / 千问AI平台等网关）。
 * 纯增量枚举，旧配置天然合法，无需版本迁移。
 */
export const TTS_PROVIDER_TYPES = ['openai-compat', 'dashscope'] as const
export type TtsProviderType = (typeof TTS_PROVIDER_TYPES)[number]

/**
 * TTS provider（docs/06 §13、docs/08 §1）。
 *
 * 与 `llm.providers.<id>` **同构但独立**：聊天模型与语音合成服务的可用性互不绑定，
 * 共用一份配置会让「换聊天模型」顺手把朗读也弄坏。
 */
export const TtsProviderSchema = z.object({
  type: z.enum(TTS_PROVIDER_TYPES),
  baseUrl: z.string(),
  /** safeStorage 密文；明文只走 `settings:setSecrets`，渲染层与日志永远看不到明文。 */
  apiKeyEnc: z.string(),
  model: z.string(),
  /** 音色 id，如 `alloy` / `FunAudioLLM/CosyVoice2-0.5B:alex`。 */
  voice: z.string(),
  /** 语速倍率。 */
  speed: z.number().min(0.25).max(4),
  format: z.enum(TTS_FORMATS),
})
export type TtsProviderConfig = z.infer<typeof TtsProviderSchema>

export const TtsSchema = z.object({
  /** 语音功能总开关。 */
  enabled: z.boolean(),
  /** 默认 TTS provider id；空串表示尚未配置（此时对话窗连朗读按钮都不出现）。 */
  active: z.string(),
  /** 回复结束后自动朗读。 */
  autoRead: z.boolean(),
  /** 单次朗读的文本上限（按字符截断，超出部分不合成）。 */
  maxChars: z.number().int().min(50).max(4096),
  providers: z.record(z.string(), TtsProviderSchema),
})
export type TtsSettings = z.infer<typeof TtsSchema>

/** 语音输入（STT）识别语言的最大长度（BCP-47 风格短码足够，超出视为手改配置写错）。 */
export const STT_LANGUAGE_MAX_CHARS = 32

/**
 * STT provider（docs/08 §1、Betav2 规格 §4）。
 *
 * 与 `tts.providers.<id>` **同构但独立**：语音输入（录音 → 文本）与语音输出（文本 → 语音）
 * 的可用性互不绑定，共用一份配置会让「换朗读服务」顺手把麦克风转写也弄坏。
 */
export const SttProviderSchema = z.object({
  type: z.enum(['openai-compat']),
  baseUrl: z.string(),
  /** safeStorage 密文；明文只走 `settings:setSecrets`，渲染层与日志永远看不到明文。 */
  apiKeyEnc: z.string(),
  model: z.string(),
  /**
   * 识别语言（如 `zh` / `en`），随转写请求的 `language` 字段下发；空串表示交给服务端自动检测。
   * `.default('zh')` 与 `modelList` 同理：`stt.providers` 是 `z.record`，字段级回退管不到它的子树，
   * 手改配置漏了该字段时由 parse 直接补齐，不让整份配置被判损坏。
   */
  language: z.string().max(STT_LANGUAGE_MAX_CHARS).default('zh'),
})
export type SttProviderConfig = z.infer<typeof SttProviderSchema>

export const SttSchema = z.object({
  /** 语音输入功能总开关（`false` 时 composer 连麦克风按钮都不渲染，docs/07 §2.3）。 */
  enabled: z.boolean(),
  /** 默认 STT provider id；空串表示尚未配置（此时对话窗的麦克风按钮不出现）。 */
  active: z.string(),
  providers: z.record(z.string(), SttProviderSchema),
})
export type SttSettings = z.infer<typeof SttSchema>

/** 生图尺寸白名单（docs/08 §1）：`auto` 表示把尺寸决定权交给服务端。 */
export const IMAGEGEN_SIZES = [
  '512x512',
  '768x768',
  '1024x1024',
  '1024x1792',
  '1792x1024',
  'auto',
] as const
export type ImageGenSize = (typeof IMAGEGEN_SIZES)[number]
export const ImageGenSizeSchema = z.enum(IMAGEGEN_SIZES)

/** 图像生成 provider（docs/08 §1、Betav2 规格 §4），与 `llm.providers.<id>` 同构但独立。 */
export const ImageGenProviderSchema = z.object({
  type: z.enum(['openai-compat']),
  baseUrl: z.string(),
  /** safeStorage 密文；明文只走 `settings:setSecrets`，渲染层与日志永远看不到明文。 */
  apiKeyEnc: z.string(),
  model: z.string(),
  /** 生成尺寸；enum 白名单 + 默认值（理由同 `language` / `modelList`：record 子树没有逐字段回退）。 */
  size: ImageGenSizeSchema.default('1024x1024'),
})
export type ImageGenProviderConfig = z.infer<typeof ImageGenProviderSchema>

export const ImageGenSchema = z.object({
  /** 图像生成功能总开关。 */
  enabled: z.boolean(),
  /** 默认生图 provider id；空串表示尚未配置。 */
  active: z.string(),
  providers: z.record(z.string(), ImageGenProviderSchema),
})
export type ImageGenSettings = z.infer<typeof ImageGenSchema>

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
  /** 课前提醒触发时是否自动打开科目文件夹（v8 新增；通知照发，docs/05 §3.3）。 */
  preClassOpenFolder: z.boolean(),
  /**
   * 课前提前多少分钟提醒（v10 新增，docs/05 §3.4）：整数 1–30，默认 5。
   * 装配层把它作为 `PreClassReminder.getLookaheadMinutes` 注入 —— 每次 tick 即时读取，
   * 因此设置页改完即时生效（此前恒为模块常量 5 分钟）。越界值由 Schema 拒绝。
   */
  preClassLeadMinutes: z.number().int().min(1).max(30),
  classification: ClassificationSchema,
})
export type ClassroomModeConfig = z.infer<typeof ClassroomModeSchema>

export const PlaceholderModeSchema = z.object({
  guideCompleted: z.boolean(),
})
export type PlaceholderModeConfig = z.infer<typeof PlaceholderModeSchema>

/**
 * Work 模式配置（v8 起实装，docs/05 §6）：占位字段 + 办公工作目录。
 * `workspaceDir` 为空串表示未配置（由引导 / 设置页收集）。
 */
export const WorkModeSchema = z.object({
  guideCompleted: z.boolean(),
  workspaceDir: z.string(),
})
export type WorkModeConfig = z.infer<typeof WorkModeSchema>

export const ModesSchema = z.object({
  current: ModeIdSchema,
  classroom: ClassroomModeSchema,
  work: WorkModeSchema,
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
  /**
   * key 为 HTTP 请求头名，value 为 safeStorage 密文（v9）；明文只经
   * `settings:setSecrets`（路径 `mcp.servers.<name>.headers.<key>`）。
   * 与 `envEnc` 完全同构（docs/08 §1 / §1.1）：字段在 stdio / HTTP 两种传输的条目上都存在，
   * 但只有 HTTP 传输消费它；渲染层只见 `headersSet` 只读标记，`headersEnc` 恒回传空对象。
   */
  headersEnc: z.record(z.string(), z.string()),
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

export const ProjectSchema = z.object({
  /** 项目 id（设置页生成，稳定不变，`projects.current` 引用它）。 */
  id: z.string(),
  /** 展示名（设置页可改；为空时界面回落成根目录末段）。 */
  name: z.string(),
  /** 项目根目录；绝对路径直接采用，相对路径按进程 cwd 解析（v13）。 */
  root: z.string(),
})
export type ProjectConfig = z.infer<typeof ProjectSchema>

/**
 * 项目机制（v13，docs/06 §5.1、docs/08 §1）。
 *
 * 「当前项目」决定两件事：① 每轮注入哪份项目级 `AGENTS.md`（项目根 → 当前工作目录逐层收集）；
 * ② 权限层判定「项目根之内 / 之外」的边界（step 2 的路径前缀校验）。
 *
 * 因此本分组在 `SETTINGS_READONLY_PREFIXES` 里 —— 切项目等于改 Agent 的权限面与指令面，
 * 属自我提权路径，只能由用户在设置页 / 界面改（走 `settings:update`，不经过该黑名单）。
 *
 * 每个字段都带 `.default()`：顶层分组整段缺失时，Schema 走"整体保留候选对象"路径，
 * 没有默认值会把整份配置判为非法并备份重建。
 */
export const ProjectsSchema = z.object({
  /** 当前项目 id；空串 = 无项目（行为与 v13 之前完全一致）。 */
  current: z.string().default(''),
  list: z.array(ProjectSchema).default([]),
  /** 每轮注入的项目级 AGENTS.md 字节预算（超出即截断并在注入文本里标注）。 */
  maxAgentsBytes: z.number().int().min(0).max(1_048_576).default(32768),
})
export type ProjectsSettings = z.infer<typeof ProjectsSchema>

/** AI 改配置（settings 工具）一律禁止触碰的路径前缀（docs/06 §12）。 */
export const SETTINGS_READONLY_PREFIXES = [
  // 凭据与密文：绝不让 AI 读回或改写（凭据只经 safeStorage / setSecret 落库）
  'llm.providers',
  'mcp.servers',
  // 同上：TTS / STT / 生图 provider 也含凭据密文（`*.providers.*.apiKeyEnc`）
  'tts.providers',
  'stt.providers',
  'imagegen.providers',
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
  // run_command 的免确认模式列表（v12，docs/06 §11.7）：命中即跳过确认卡片，同样等于摘掉 AI 自己的
  // 确认闸门 —— 否则 AI 给自己加一条 `git*` 就再也不用确认了，属自我提权。
  // 只保留「用户在设置页手动加白名单」这一条路径（设置页走 `settings:update`，不经过本黑名单）。
  'agent.tools.terminal.allowPatterns',
  // 项目机制（v13，docs/06 §5.1）：切项目会同时改「注入给模型的指令」与「权限层认定的项目根」，
  // 等于改 Agent 的权限面与行为面，属自我提权路径 —— 只能由用户在设置页 / 界面触发。
  'projects',
  // 三档权限（v13，docs/06 §12.2）：改档位等于自己给自己放宽确认闸门，同样只读。
  'agent.permissionMode',
  // 循环预算（v15，docs/06 §4.1）：AI 给自己放大轮次 / token 预算，等于绕过"该停下来问用户"的那道闸门。
  'agent.loop',
  // 写前快照（v14，docs/06 §11.8）：AI 关掉 `enabled` 或压低预算，等于在自己写文件前拆掉回滚保险。
  'agent.snapshots',
  // 黑名单配置自身（v15）：AI 往里追加路径等于自己收紧自己的可写面（自我 DoS）；
  // 放宽本就不生效（判定从不读用户配置）。用户经设置页 `settings:update` 修改不受影响。
  'advanced.readonlyPrefixes',
  // Aurora Center 连接（v16，docs/12 §7）：连接目标是数据外发通道 —— AI 自行启用、
  // 改向或填令牌等于把本机数据发往任意服务器。只能由用户在设置页操作。
  'center',
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
   *
   * ⚠️ 因此本字段的默认值是**持久化**的：老用户配置里存的是旧数组，不含后来新增的前缀
   * （如 v12 的 `agent.tools.terminal.allowPatterns`）。这**不影响安全性**（硬编码常量那一遍照样命中），
   * 上面那条「只能在默认之上追加」的语义也保证了这一点 —— 所以**不需要**为新增前缀写配置迁移。
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
  'edit_file',
  'list_dir',
  'open_path',
  'grep',
  'glob',
] as const
export type ComputerToolName = (typeof COMPUTER_TOOL_NAMES)[number]

/**
 * 电脑操控工具配置（docs/08 §1、docs/06 §11）。
 *
 * `workspaceDir` 只是工具的**默认**工作目录（生效值走 docs/06 §5.1 三级回落：
 * 项目根 > 本字段 > 用户主目录，本字段空串时按后两级），**不是沙箱**：
 * 模型仍可显式传入其它路径，安全靠"逐次确认 + 输出上限 + 总开关"而不是路径限制。
 */
export const AgentToolsSchema = z.object({
  /** 总开关；false 时 8 个工具一个都不注册。 */
  enabled: z.boolean(),
  workspaceDir: z.string(),
  terminal: z.object({
    enabled: z.boolean(),
    timeoutMs: z.number().int().min(1_000).max(300_000),
    maxOutputChars: z.number().int().min(500).max(100_000),
    /**
     * 命中即免确认的命令模式（v12，docs/06 §11.7）：glob **全串**匹配、大小写不敏感，
     * `*` 匹配任意字符（含空）、`?` 匹配单字符；全串锚定意味着 `git *` 不会命中 `echo git`。
     * ⚠️ 但 `*` **也匹配 `;` / `&&` / `|` 等命令分隔符**：`git status*` 等于放行「以 git status 开头的
     * 任意命令串」。这是已定稿的匹配语义（用户可见的口径写在 docs/06 §11.7 与设置页文案里）。
     * 空数组 = 全部逐次确认（默认值 = v12 之前的行为）。
     * 命中只跳过确认卡片，**仍写审计日志**，属于「减少打扰」而非安全加固。
     */
    allowPatterns: z
      .array(
        z
          .string()
          .max(200)
          // 纵深防御的第一道（第二道在 agent-core 的 `describeInvalidPattern`）：
          // **先整类拒绝花括号**，再要求至少含一个具体字符。只判后者会被 `{a,*}` 绕过 ——
          // 它去掉通配符后还剩 `a`，却编译成 `(?:a|.*)` = 放行全部命令。
          .refine(
            (value) => !/[{}]/.test(value) && /[^*?\s]/.test(value),
            '命令模式只允许字面字符与 * / ?（不支持花括号，且必须至少包含一个具体字符）',
          ),
      )
      .max(100),
  }),
  files: z.object({
    enabled: z.boolean(),
    maxReadBytes: z.number().int().min(1_024).max(4_194_304),
  }),
  /** 文件检索（`grep` / `glob`）配置（v12，docs/06 §11.5）。 */
  search: z.object({
    enabled: z.boolean(),
    /** 单次检索返回的结果条数上限（超出即截断并标注）。 */
    maxResults: z.number().int().min(1).max(1_000),
  }),
  open: z.object({
    enabled: z.boolean(),
  }),
})
export type AgentToolsConfig = z.infer<typeof AgentToolsSchema>

export const AgentSchema = z.object({
  tools: AgentToolsSchema,
  /**
   * 三档权限（v13，docs/06 §12.2）：
   * - `readonly`：写 / 执行 / 有系统副作用的工具**根本不注册**，模型在工具清单里看不到它们；
   * - `confirm`：默认档，行为与三档之前完全一致（敏感工具逐次确认）；
   * - `auto`：只在项目根之内免确认，越界仍逐次确认。
   *
   * 与 `advanced.confirmSensitiveTools` 双开关并存，优先级见 docs/06 §12.2：
   * `confirmSensitiveTools === false` 时非 readonly 档被强制按 `auto` 处理；readonly 档下该布尔无效。
   *
   * 本字段在 `SETTINGS_READONLY_PREFIXES` 里（AI 不可自我提权）。
   */
  permissionMode: z.enum(['readonly', 'confirm', 'auto']).default('confirm'),
  /**
   * 写前快照（docs/06 §11.8，v14）：`write_file` / `edit_file` 真正落盘前把**原内容**存一份。
   *
   * 注意它是 `agent.snapshots` 而**不是** `agent.tools.snapshots` —— 后者会被
   * `COMPUTER_TOOL_NAMES` 的门控语义牵连（那是"工具注册"的开关），而快照是**写盘行为的兜底**，
   * 与注册哪些工具无关。
   *
   * 本分组在 `SETTINGS_READONLY_PREFIXES` 里（AI 改不动：关掉写备份 / 压低预算等于拆掉回滚保险）；
   * 用户走设置页 / `settings:update` 不受影响（调整保留份数 / 上限是正当需求）。
   */
  snapshots: z
    .object({
      /** 关掉后写盘不再留快照（界面上明确告知"改动将不可回滚"）。 */
      enabled: z.boolean().default(true),
      /** 同一个文件最多保留几份（环形淘汰，最旧的先删）。 */
      keepPerFile: z.number().int().min(1).max(200).default(20),
      /** 单个快照的字节上限；超过即跳过（**不静默**：结果里回带"文件过大"）。 */
      maxSnapshotBytes: z
        .number()
        .int()
        .min(1024)
        .max(64 * 1024 * 1024)
        .default(524288),
      /** 快照目录总预算；超出时从最旧开始删（每文件环形之外的第二层上限）。 */
      totalBudgetBytes: z
        .number()
        .int()
        .min(1024 * 1024)
        .default(200 * 1024 * 1024),
    })
    .default({}),
  /**
   * Agent 循环的轮次与预算（docs/06 §5 / §4.1，v15）。
   *
   * 为什么这三个终于变成配置字段：`maxRounds` 此前是内核里写死的 8（`DEFAULT_MAX_ROUNDS`），
   * 用户遇到"长任务跑到一半停下"既看不到原因也改不了。现在轮次与 token 预算都可配，
   * 且用尽时 job 进入 `paused`（附 `pendingReason`）而不是静默收尾。
   *
   * 本分组在 `SETTINGS_READONLY_PREFIXES` 里（AI 改不动）：让 AI 给自己放大预算，
   * 等于绕过"该停下来问用户"的那道闸门。用户当然可以调——设置页 / `settings:update` 不经过本黑名单。
   */
  loop: z
    .object({
      /** 一次请求内最多几轮「工具调用 → 结果回填」（1–64，默认 8 = v15 之前的行为）。 */
      maxRounds: z.number().int().min(1).max(64).default(8),
      /** 累计 token 预算；**0 = 不限**（默认）。触顶时 job 暂停，不静默结束。 */
      maxTotalTokens: z.number().int().min(0).default(0),
      /** 轮次用尽后允许自动再续几轮（0–8，默认 2）；0 = 不自动续，直接暂停等用户点「继续」。 */
      autoContinueRounds: z.number().int().min(0).max(8).default(2),
    })
    .default({}),
})
export type AgentSettings = z.infer<typeof AgentSchema>

/**
 * Aurora Center 连接（v16，docs/12）。
 *
 * **整组在 `SETTINGS_READONLY_PREFIXES` 里**：连接目标是数据外发通道 —— AI 自行启用、
 * 改向或填令牌，等于把本机数据发往任意服务器（自我外联 = 数据外泄）。启用 / 改址 /
 * 填令牌只能由用户在设置页操作（走 `settings:update`，不经过该黑名单）。
 * 远程配置来自 Center 的另一条通道（docs/12 §6.2 白名单），也不走 `set_setting`。
 */
export const CenterSchema = z.object({
  /** 总开关；false 时不连接 Center，`center_*` 工具也不注册（未配置不注册，与 STT/TTS 同口径）。 */
  enabled: z.boolean().default(false),
  /** Center 服务器地址（`ws(s)://` 或 `http(s)://`，连接时统一换成 ws 协议）。 */
  serverUrl: z.string().default(''),
  /**
   * 客户端令牌（safeStorage 密文），由账号登录（`POST /api/client/login`）颁发或
   * 手动配对粘贴。**凭据路径**：`center.token` ⇄ `center.tokenEnc`，
   * 与 `apiKeyEnc` 同链路 —— `SettingsStore` 的 4 处 + `redactSettings` / `redactKeys`
   * 同步维护（docs/12 §7）。
   */
  tokenEnc: z.string().default(''),
  /** 已登录的 Center 账号名（v17；非凭据，仅展示与诊断；登录成功后由主进程写入）。 */
  account: z.string().default(''),
  /** 本机客户端 id（首次启用时生成并持久化；标识符而非凭据）。 */
  clientId: z.string().default(''),
  /** 在 Center 展示的名字；空串 = 主机名。 */
  displayName: z.string().default(''),
  /** 允许 Center 远程开 session 对话（客户端侧最终闸门，命令类别被拒时回 `E_REMOTE_DISABLED`）。 */
  allowRemoteSession: z.boolean().default(true),
  /** 允许 Center 远程改配置（仍受 docs/12 §6.2 白名单约束）。 */
  allowRemoteConfig: z.boolean().default(true),
  /** 允许 `center_send_file` 上传文件。 */
  allowFileTransfer: z.boolean().default(true),
  /** 单个上传文件上限（MB，1–512）。 */
  maxFileMb: z.number().int().min(1).max(512).default(64),
})
export type CenterSettings = z.infer<typeof CenterSchema>

export const SettingsSchema = z.object({
  version: z.number().int().min(0),
  general: GeneralSchema,
  llm: LlmSchema,
  tts: TtsSchema,
  stt: SttSchema,
  imagegen: ImageGenSchema,
  modes: ModesSchema,
  skills: SkillsSchema,
  mcp: McpSchema,
  projects: ProjectsSchema,
  advanced: AdvancedSchema,
  agent: AgentSchema,
  center: CenterSchema,
})

export type Settings = z.infer<typeof SettingsSchema>

/** 黑名单前缀 → 给模型与审计日志看的中文原因（每个默认前缀都必须有一条）。 */
const READONLY_PREFIX_REASONS: Record<(typeof SETTINGS_READONLY_PREFIXES)[number], string> = {
  'llm.providers': '凭据字段不允许通过工具修改',
  'mcp.servers': '凭据字段不允许通过工具修改',
  'tts.providers': '凭据字段不允许通过工具修改',
  'stt.providers': '凭据字段不允许通过工具修改',
  'imagegen.providers': '凭据字段不允许通过工具修改',
  version: '配置版本由迁移链维护，不允许通过工具修改',
  'general.windowState': '窗口位置由系统维护，不允许通过工具修改',
  'advanced.proxy': '代理设置写错会立即断网，不允许通过工具修改',
  'general.onboarded': '引导状态不允许通过工具修改',
  'general.firstRun': '首次运行标记不允许通过工具修改',
  'general.launchAtLogin': '开机自启不允许通过工具修改',
  'general.hotkey': '全局快捷键不允许通过工具修改',
  'advanced.confirmSensitiveTools': '关闭它等于摘掉敏感工具的确认闸门，不允许通过工具修改',
  'agent.tools.terminal.allowPatterns':
    '免确认命令模式等于摘掉终端工具自己的确认闸门，不允许通过工具修改',
  projects: '项目根同时决定注入的指令与权限边界，不允许通过工具修改',
  'agent.permissionMode': '权限档位等于 Agent 自己的确认闸门，不允许通过工具修改',
  'agent.loop': '循环轮次与 token 预算等于 Agent 自己的停止闸门，不允许通过工具修改',
  'agent.snapshots': '写前快照是改动可回滚的兜底，不允许通过工具关闭',
  'advanced.readonlyPrefixes':
    '只读黑名单的配置自身不允许通过工具修改（防自我收紧；放宽本就不生效）',
  center: 'Center 连接是数据外发通道，不允许通过工具启用或改向（docs/12 §7）',
}

/** 显式可写覆盖表的一条登记：模式 + 中文说明。 */
export interface WritablePathOverride {
  /**
   * 路径模式：按**路径段**匹配（与 `matchReadonlyPrefix` 同一套段语义），
   * `*` 段匹配恰好一个动态键段（如 provider id），其余段必须逐段相等。
   */
  pattern: string
  /** 给审计日志与 `set_setting` 工具描述看的中文说明。 */
  reason: string
}

/**
 * AI 改配置（`set_setting`）的**显式可写覆盖表**（docs/06 §12、Betav2 规格 §6.3）。
 *
 * 判定顺序在 `SETTINGS_READONLY_PREFIXES` **之前**：命中即视为可写。登记的意义有两类：
 * 1. **真的放开**：`llm.providers.<id>.model / reasoningEffort / temperature` 落在
 *    `llm.providers` 黑名单前缀之内，但「换模型 / 调参数」不碰凭据，必须显式放行
 *    （baseUrl / apiKeyEnc / modelList 等其余字段仍被前缀拒绝）；
 * 2. **显式登记**：`tts.enabled` / `agent.tools.*` 这类本就因「不在黑名单而可写」的路径，
 *    逐条登记成可写面清单（供工具 description 与审计使用），也防未来误加前缀时静默收窄。
 *
 * 注意：模式里的 `*` 只是本表的匹配语法，`canWriteSettingPath` 收到的**实际路径**仍必须是
 * 具体路径（`isConcreteSettingPath` 会先拦掉带 `*` / `[]` 的输入）。
 */
export const WRITABLE_PATH_OVERRIDES: readonly WritablePathOverride[] = [
  // llm.providers.*：黑名单内显式放开三个「模型行为」字段（凭据与连接字段仍只读）
  { pattern: 'llm.providers.*.model', reason: '切换该 provider 实际使用的模型（不碰凭据）' },
  { pattern: 'llm.providers.*.reasoningEffort', reason: '调整该 provider 的思考等级（不碰凭据）' },
  { pattern: 'llm.providers.*.temperature', reason: '调整该 provider 的采样温度（不碰凭据）' },
  // tts / stt / imagegen：总开关与默认 provider 选择对 AI 开放（providers 凭据子树仍只读）
  { pattern: 'tts.enabled', reason: '开关语音朗读' },
  { pattern: 'tts.active', reason: '切换默认 TTS provider' },
  { pattern: 'tts.autoRead', reason: '开关回复结束后自动朗读' },
  { pattern: 'tts.maxChars', reason: '调整单次朗读的截断上限' },
  { pattern: 'stt.enabled', reason: '开关语音输入' },
  { pattern: 'stt.active', reason: '切换默认 STT provider' },
  { pattern: 'imagegen.enabled', reason: '开关图像生成' },
  { pattern: 'imagegen.active', reason: '切换默认生图 provider' },
  // 提示条与对话展示
  { pattern: 'general.edgeBar.enabled', reason: '开关提示条' },
  { pattern: 'general.edgeBar.opacity', reason: '调整提示条透明度' },
  { pattern: 'general.edgeBar.quietHours', reason: '调整提示条的勿扰时段' },
  { pattern: 'general.chat.showThinking', reason: '开关对话界面的思考过程展示' },
  // 模式
  { pattern: 'modes.current', reason: '切换当前模式' },
  { pattern: 'modes.work.workspaceDir', reason: '设置 Work 模式的工作目录' },
  { pattern: 'modes.classroom.preClassLeadMinutes', reason: '调整课前提醒的提前分钟数' },
  // 电脑操控工具（advanced.confirmSensitiveTools 确认总闸门**不在**表内，仍只读防自我提权）
  { pattern: 'agent.tools.enabled', reason: '开关电脑操控工具' },
  { pattern: 'agent.tools.workspaceDir', reason: '设置电脑操控工具的默认工作目录' },
  { pattern: 'agent.tools.terminal.enabled', reason: '开关终端工具' },
  { pattern: 'agent.tools.terminal.timeoutMs', reason: '调整终端命令超时' },
  { pattern: 'agent.tools.terminal.maxOutputChars', reason: '调整终端输出截断上限' },
  { pattern: 'agent.tools.files.enabled', reason: '开关文件读写工具' },
  { pattern: 'agent.tools.files.maxReadBytes', reason: '调整单次文件读取上限' },
  // 文件检索（grep / glob）：开关与结果上限对 AI 开放。
  // 相邻的 `agent.tools.terminal.allowPatterns` **刻意不登记** —— 覆盖表判定先于黑名单，
  // 登记它等于把「免确认命令模式」放行给 AI（自我提权，见 SETTINGS_READONLY_PREFIXES）。
  { pattern: 'agent.tools.search.enabled', reason: '开关文件检索工具' },
  { pattern: 'agent.tools.search.maxResults', reason: '调整文件检索的结果上限' },
  { pattern: 'agent.tools.open.enabled', reason: '开关「打开路径」工具' },
  // 技能 / 全局勿扰时段
  { pattern: 'skills.userDir', reason: '切换用户技能目录' },
  { pattern: 'skills.disabled', reason: '启用 / 停用技能' },
  { pattern: 'advanced.quietHours', reason: '调整全局勿扰时段' },
]

/**
 * 显式可写覆盖匹配：与 `matchReadonlyPrefix` 同一套「逐段相等」语义，另支持 `*` 段
 * （匹配恰好一个动态键段），且要求**整条路径与模式的段数一致** ——
 * 因此 `llm.providers.*.model` 命中 `llm.providers.deepseek.model`，但不命中
 * `llm.providers.deepseek.modelList`（段名不同）也不命中 `llm.providers.a.model.x`（多一段）。
 */
function matchWritableOverride(path: string): WritablePathOverride | undefined {
  const segments = path.split('.')
  for (const override of WRITABLE_PATH_OVERRIDES) {
    const patternSegments = override.pattern.split('.')
    if (patternSegments.length !== segments.length) continue
    if (patternSegments.every((segment, index) => segment === '*' || segment === segments[index])) {
      return override
    }
  }
  return undefined
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
  // 显式可写覆盖表（v8）**先于**黑名单前缀判定：`llm.providers.<id>.model` 要能穿过
  // `llm.providers` 前缀放行（Betav2 规格 §6.3）。表内全部是 Schema 登记过的具体路径，
  // 因此命中后不需要再过 `isKnownSettingPath`。
  if (matchWritableOverride(path) !== undefined) return undefined
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
 * 规则：① 命中 `WRITABLE_PATH_OVERRIDES` → 放行（先于黑名单判定）；
 *      ② 命中 `SETTINGS_READONLY_PREFIXES` → 拒绝；
 *      ③ 路径必须能被 Schema 识别（`lookupSpec` 登记过，或 `isDynamicPath` 认的通配路径）→ 否则拒绝
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
