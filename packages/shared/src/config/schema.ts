/**
 * 配置 Schema（SSOT：docs/08-settings-onboarding.md §1）
 *
 * 约束：新增配置字段必须先更新 docs/08，再更新本文件与 `defaults.ts`。
 * 本文件是纯声明式校验，不做跨字段业务校验（那属于 SettingsStore 职责）。
 */
import { z } from 'zod'

export const CONFIG_VERSION = 36 as const

/**
 * 模式展示 / 装配顺序：**ClassRoom 在前**（v1 首发且唯一完整实现）。
 * 08 §1 注释中的 `work / code / classroom` 为枚举列举顺序，不表示 UI 顺序；
 * 设置页与引导按本数组顺序渲染（docs/07 §2.5「三模式卡片」、docs/08 §3「ClassRoom 推荐」）。
 */
export const MODE_IDS = ['classroom', 'work', 'code'] as const
export type ModeId = (typeof MODE_IDS)[number]
export const ModeIdSchema = z.enum(MODE_IDS)

export const WINDOW_NAMES = [
  'edge-bar',
  'chat',
  'settings',
  'memory',
  'onboarding',
  'automation',
  'plugin-config',
] as const
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
  /**
   * 贴附显示器（v21）：`primary` 主显示器 / `cursor` 跟随鼠标所在显示器。
   * 窗口创建 / 显示 / 两态切换时现读（改完即生效），docs/08 §1 / docs/07 §2.2。
   */
  display: z.enum(['primary', 'cursor']),
  /** 贴附屏幕侧（v21）：`right` 屏幕右缘（默认）/ `left` 屏幕左缘。 */
  position: z.enum(['right', 'left']),
})

/**
 * 游戏模式联动（v30，docs/06 §8.3 / docs/08 §1）。
 *
 * 只控制 Aurora 的联动行为：检测到 Windows 游戏后隐藏提示条并暂停文件自感知。
 * 不修改 Windows Game Mode 自身设置，也不在非 Windows 平台启动检测。
 */
export const GameModeSchema = z.object({
  enabled: z.boolean().default(true),
})
export type GameModeSettings = z.infer<typeof GameModeSchema>

/**
 * 明暗档位（v32，docs/08 §1 / docs/07 §5.1）：`system` 跟随系统（默认，保持 v32 之前的行为），
 * `light` / `dark` 由用户显式锁定。主进程把它落到 `nativeTheme.themeSource`，
 * 渲染层照旧只读 `prefers-color-scheme`（**没有** `data-theme` 属性）。
 */
export const APPEARANCE_THEME_MODES = ['system', 'light', 'dark'] as const
export const AppearanceThemeSchema = z.enum(APPEARANCE_THEME_MODES)
export type AppearanceTheme = z.infer<typeof AppearanceThemeSchema>

/**
 * 强调色档位（v21）：`aurora` = 内置品牌蓝（默认）。**色值不在这一层** ——
 * 渲染层的色值与中文名在 `renderer/shared/appearance.ts` / 设置页，这里只保证
 * 「哪些键合法」只有一份（`set_appearance` 工具与设置页都照它校验，别各写一份枚举）。
 */
export const APPEARANCE_ACCENT_KEYS = ['aurora', 'teal', 'violet', 'rose', 'amber'] as const
export const AppearanceAccentSchema = z.enum(APPEARANCE_ACCENT_KEYS)
export type AppearanceAccent = z.infer<typeof AppearanceAccentSchema>

/**
 * 外观自定义（v21 新增强调色，v32 扩为三件套，v33 加流光开关，docs/08 §1）：
 * 用户在设置页「通用 → 外观」选，
 * Agent 也可经 `set_setting`（`appearance.*` 四条都在 `WRITABLE_PATH_OVERRIDES` 登记）
 * 或语义化工具 `set_appearance`（docs/06 §12.1）调。渲染层由
 * `shared/appearance.ts` 应用到文档根 —— `aurora` = 内置品牌蓝（移除覆盖，跟随明暗档）；
 * `glass: false` 在文档根挂 `data-glass="off"`，由 `theme.css` 把毛玻璃降级为实色。
 * `awarenessGlow` 不经过渲染层令牌：它由主进程的 `shouldShowAwarenessGlow` 门控那个
 * 自感知流光浮层（`main/awareness-glow.ts`），渲染层只把 `glowEnabled` 回读进显示条件。
 *
 * `theme` / `accent` / `glass` 三个字段都**不带** `.default()`：默认值只有
 * `createDefaultSettings()` 与迁移链两处来源
 * （与同文件 `general.edgeBar.display` 同款形状），避免「Schema 默认值」与「迁移补值」两份口径。
 *
 * `awarenessGlow` 是**例外，必须有** `.default(true)`：`settings:update` 的 `appearance` 是
 * **整组浅合并**（`Object.assign(draft.appearance, patch.appearance)`），设置页与 `set_appearance`
 * 都可能回传一个「按旧版字段集构造的完整对象」—— 没有默认值时它缺这一键，
 * 会被 `SettingsSchema.parse` 判为不合法 → 整份配置备份重建。默认值同时与迁移链补的
 * `true` 同口径（= 保持 v33 之前的行为）。
 */
export const AppearanceSchema = z.object({
  theme: AppearanceThemeSchema,
  accent: AppearanceAccentSchema,
  glass: z.boolean(),
  /** v33：文件自感知的四周流光总开关。`false` = 分析期间完全不出流光。 */
  awarenessGlow: z.boolean().default(true),
})
export type AppearanceSettings = z.infer<typeof AppearanceSchema>

export const GeneralSchema = z.object({
  language: z.string().min(2),
  launchAtLogin: z.boolean(),
  hotkey: z.string().min(1),
  edgeBar: EdgeBarSchema,
  gameMode: GameModeSchema,
  /** 各窗口位置 / 尺寸记忆（docs/02 §2.2、docs/07 §2）。 */
  windowState: z.record(WindowNameSchema, z.record(z.string(), z.unknown())),
  /**
   * 要求以管理员身份运行（v20，docs/08 §1 / docs/09 §9）：启动时若当前进程未提权，
   * 用 UAC 重新拉起一个管理员实例并退出自己（`main/elevation.ts`）。
   *
   * 开着它的意义是「不被权限卡住」：`run_command` 是当前用户权限，写入 Program Files /
   * 改系统设置 / `net session` 这类操作在非提权进程里会直接失败（`E_ACCESSDENIED`），
   * 用户看到的是"AI 说做了但没做成"。默认 `true`（出厂档）。
   *
   * 只能由用户在设置页改（在 `SETTINGS_READONLY_PREFIXES` 里：AI 把它关掉等于降低
   * 自己的权限边界，属自我提权路径）。注意这**不是沙箱**：提权只提高能做什么，
   * 不改变「越界要确认」的判定链。
   */
  requireAdmin: z.boolean(),
  /** 对话窗展示偏好（v8 新增）。 */
  chat: z.object({
    /** 对话界面展示思考过程（MessageList 可折叠思考块的门控，docs/07 §2.3）。 */
    showThinking: z.boolean(),
  }),
})
export type GeneralSettings = z.infer<typeof GeneralSchema>

/**
 * LLM provider 的接口协议（docs/06 §3.2，v22 扩枚举）：
 * - `openai-compat`：OpenAI 兼容 `POST <baseUrl>/chat/completions`（DeepSeek / Ollama / vLLM 等）；
 * - `openai-responses`：OpenAI **Responses API** `POST <baseUrl>/responses`。
 *
 * 纯增量枚举：v21 及更早的配置写的都是 `openai-compat`，天然合法，
 * 迁移只补缺失 / 非法的值，**不改正值**（旧配置升级后请求体逐字不变）。
 */
export const LlmProviderTypes = ['openai-compat', 'openai-responses'] as const
export const LlmProviderTypeSchema = z.enum(LlmProviderTypes)
export type LlmProviderType = z.infer<typeof LlmProviderTypeSchema>

/**
 * 接口协议的展示文案（**唯一来源**：设置页「AI 模型」折叠区的「接口类型」下拉）。
 *
 * 与 `REASONING_EFFORT_LABELS` 同款：新增取值时这个 `Record` 会强制补文案，
 * 不会出现「枚举加了、界面上是个空白选项」。
 */
export const LLM_PROVIDER_TYPE_LABELS: Record<LlmProviderType, string> = {
  'openai-compat': 'OpenAI 兼容（/chat/completions）',
  'openai-responses': 'OpenAI Responses API（/responses）',
}

/**
 * 模型思考等级（docs/06 §3）：`auto` = 不下发 `reasoning_effort` 字段。
 *
 * `auto` 存在的原因是兼容性：不认这个参数的 OpenAI 兼容厂商收到它可能直接 400，
 * 所以「不选」必须能表达成「字段根本不出现」，而不是发一个空值。
 */
export const REASONING_EFFORT_LEVELS = ['auto', 'low', 'medium', 'high'] as const
export type ReasoningEffort = (typeof REASONING_EFFORT_LEVELS)[number]
export const ReasoningEffortSchema = z.enum(REASONING_EFFORT_LEVELS)

/**
 * 思考等级的展示文案（**唯一来源**：对话窗 composer 的下拉与设置页「AI 模型」共用）。
 *
 * 两档文案不是"两套说法"：`short` 给**窄控件**（composer 里那个下拉只有约 90px，
 * 长文案会被省略号切掉 —— 「文字看不全」的抱怨就来自这里），
 * `full` 给设置页那份宽下拉与悬浮提示，两者描述的是同一件事。
 * 新增等级时这里的 `Record` 会强制补文案，不会只漏一处。
 */
export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, { short: string; full: string }> = {
  auto: { short: 'auto', full: 'auto（不指定，兼容性最好）' },
  low: { short: 'low', full: 'low（更快）' },
  medium: { short: 'medium', full: 'medium' },
  high: { short: 'high', full: 'high（更深入）' },
}

/**
 * 上下文窗口字段（token，v11 新增）：只用于对话窗「上下文详解」条的占用比例分母
 * （`promptTokens / contextWindow`，docs/07 §2.3、docs/06 §16.2）。
 * `0` = 未知 —— 分母不知道就不编，不显示进度条与百分比。
 */
const ContextWindowFieldSchema = z.number().int().min(0).max(2_000_000).default(0)

/**
 * 单个模型的生成参数（v23，docs/08 §1）。
 *
 * 为什么按模型走：同一个 provider（同一份 `baseUrl` / 凭据）下常常配多个模型，
 * 而「窗口多大、能不能收图、该用哪档思考」是**模型的事实**，不是 provider 的偏好 ——
 * provider 级单一值会让「切到另一个模型」之后窗口与图片开关变成另一套谎话。
 */
export const LlmModelParamsSchema = z.object({
  /**
   * 思考等级（docs/06 §3）：由主进程装配层把 `auto` 映射成「不下发」
   * `reasoning_effort` 字段 —— 不认这个参数的兼容网关收到它可能直接 400。
   *
   * `.default('auto')` 与两个兄弟字段同口径（它们也各有默认值）。这不只是好看：
   * `modelParams` 落在 `llm.providers`（`z.record`）之下，`SettingsStore` 的字段级回退
   * **不下钻**这棵子树 —— 一个缺字段（或非法）的条目会让 `SettingsSchema.parse` 抛错，
   * 走「备份 + 重建出厂配置」，用户的 provider / 凭据 / 项目配置**一起消失**。
   * 有默认值以后，手改配置漏写这一项只会回落成 `auto`，而不是赔上整份配置。
   * （写入方仍然三项一起写 —— 那是防御纵深，不再是「不写就炸」的单点。）
   */
  reasoningEffort: ReasoningEffortSchema.default('auto'),
  contextWindow: ContextWindowFieldSchema,
  /**
   * 该模型是否支持**图片输入**（多模态，docs/06 §3.1），默认 `false`。
   *
   * 出厂关闭是有意的：对不支持视觉的模型发图片分片会被服务端 400，
   * 「整个对话都用不了」比「图片没送进去」严重得多 —— 与 `reasoningEffort` 的
   * `auto`（不下发该参数）是同一个思路：默认值必须让最保守的网关也能工作。
   * 与 `contextWindow` 同款口径：**不做内置模型能力表**，由用户照服务商文档填。
   */
  vision: z.boolean().default(false),
})
export type LlmModelParams = z.infer<typeof LlmModelParamsSchema>

/**
 * `modelParams` 缺键 / 字段缺失 / 值非法时的回落值（v23）。
 *
 * 三个值与 v22 及更早的 provider 级出厂值**逐字相同**（`auto` / `0` / `false`，
 * 与 `defaults.ts` 的 `DEFAULT_REASONING_EFFORT` 一致），因此本次下沉不改变默认行为。
 */
export const LLM_MODEL_PARAM_DEFAULTS: LlmModelParams = {
  reasoningEffort: 'auto',
  contextWindow: 0,
  vision: false,
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把任意输入归一到一份合法的模型参数（**唯一的「什么算合法」口径**，v23）。
 *
 * 逐字段用各自的 Schema 试一次，失败的那一个回落 `LLM_MODEL_PARAM_DEFAULTS` ——
 * 复用 Schema 而不是手写第二套范围判断，避免「Schema 放宽了上限、这里忘了改」的漂移。
 *
 * 存在的理由有两条，都不是洁癖：
 * ① 迁移（`migrateV22ToV23`）必须用它：`llm.providers` 是 `z.record`，`SettingsStore`
 *    的字段级回退对这类动态键**整体保留候选对象**（`store.ts` 的 `sanitizeWithDefaults`
 *    命中 `isDynamicPath` 时直接 `deepClone(candidate)`）—— 手改过的非法旧值没法被逐字段
 *    回退，一旦原样搬进 `modelParams` 就会让 `SettingsSchema.parse` 抛错，走「备份 + 重建
 *    出厂配置」，用户的 provider / 凭据 / 项目配置一起消失；
 * ② 读取端（`resolveModelParams`）也要用它：无论配置从哪来，消费方**绝不**应拿到一个
 *    缺字段的对象 —— 在 `noUncheckedIndexedAccess` 下那会变成 `undefined` 参与运算。
 */
export function normalizeModelParams(raw: unknown): LlmModelParams {
  const source = isPlainRecord(raw) ? raw : {}
  const effort = ReasoningEffortSchema.safeParse(source['reasoningEffort'])
  const window = ContextWindowFieldSchema.safeParse(source['contextWindow'])
  const vision = z.boolean().safeParse(source['vision'])
  return {
    reasoningEffort: effort.success ? effort.data : LLM_MODEL_PARAM_DEFAULTS.reasoningEffort,
    contextWindow: window.success ? window.data : LLM_MODEL_PARAM_DEFAULTS.contextWindow,
    vision: vision.success ? vision.data : LLM_MODEL_PARAM_DEFAULTS.vision,
  }
}

/**
 * 取某个模型生效的生成参数（**唯一取值口径**，v23）。
 *
 * 三处消费方 —— 主进程装配层 / 渲染层（设置页与对话窗）/ Aurora Center 网页端 ——
 * 都**必须**走它，别在调用处再写 `provider.modelParams[id] ?? {…}`：各写一套的结果是
 * 「同一个模型在设置页显示 128K、在对话窗按未知处理」这类分叉迟早出现。
 *
 * `modelId` 缺省取 `provider.model`（真正生效的那个模型）。键未命中（模型不在表里、
 * 配置被手改、老配置漏迁移）或字段值非法时，**按字段**回落 `LLM_MODEL_PARAM_DEFAULTS`。
 */
export function resolveModelParams(
  provider: Pick<LlmProviderConfig, 'model' | 'modelParams'>,
  modelId?: string,
): LlmModelParams {
  return normalizeModelParams(provider.modelParams?.[modelId ?? provider.model])
}

/** 会话级模型覆盖的**存储形状**（会话文件 `meta.llm`，与 agent-core 的 `SessionModelOverride` 同形） */
export interface SessionModelOverrideLike {
  providerId: string
  model: string
}

/** 会话生效模型（`resolveSessionModel` 的结果） */
export interface EffectiveSessionModel {
  providerId: string
  model: string
  /** true = 该会话用自己的覆盖；false = 跟随全局 `llm.active` */
  overridden: boolean
}

/**
 * `resolveSessionModel` 的入参形状：**只取它真正用到的两个字段**。
 *
 * 刻意收窄而不是要整个 `LlmSettings`：Center 网页端手里只有脱敏后的配置切片
 * （provider 只有 `model` / `modelList` 等），拿不到也不该有 `apiKeyEnc` / `baseUrl`。
 * 收窄后两端都能传自己的快照，判定仍走同一份实现。
 */
export interface SessionModelSource {
  active: string
  providers: Record<string, { model: string } | undefined>
}

/**
 * 会话生效模型（**唯一口径**，docs/06 §3 会话级模型）。
 *
 * 解析链只有一级：**会话覆盖 > 全局 `llm.active` + 该 provider 的 `model`**。
 * 覆盖里的 provider 已被删除 / model 为空白 → **静默回落全局**（与主进程
 * `createProviderFactory` 的判据同源，两端不许各写一套；渲染层的模型下拉与
 * Center 网页端的会话行都走它）。
 */
export function resolveSessionModel(
  llm: SessionModelSource,
  override?: SessionModelOverrideLike | null,
): EffectiveSessionModel {
  const globalModel = llm.providers[llm.active]?.model ?? ''
  if (override !== null && override !== undefined) {
    const model = override.model.trim()
    if (llm.providers[override.providerId] !== undefined && model !== '') {
      return { providerId: override.providerId, model, overridden: true }
    }
  }
  return { providerId: llm.active, model: globalModel, overridden: false }
}

export const LlmProviderSchema = z.object({
  type: LlmProviderTypeSchema,
  baseUrl: z.string(),
  /** safeStorage 密文；解密值只存在于运行时内存。 */
  apiKeyEnc: z.string(),
  model: z.string(),
  /**
   * 按**模型 id** 键的生成参数表（v23，docs/08 §1）。
   *
   * 键是模型 id（`modelList` 的元素，或 `model` 本身）；键未命中时**不是** `undefined` ——
   * 消费方一律经 `resolveModelParams` 取值，那里回落 `LLM_MODEL_PARAM_DEFAULTS`。
   * 用 `.default({})` 的理由同 `modelList`：消费方必须能无条件读到一个对象。
   *
   * 与 `modelList` **不是**同一张表：往列表里加模型不会为它造条目（读到就按默认值），
   * 删列表项也不清它的参数（设置页落盘时按「候选列表 ∪ {model}」归一，见 docs/08 §5）。
   */
  modelParams: z.record(z.string(), LlmModelParamsSchema).default({}),
  /**
   * 该 provider 下可选的模型 id 列表（docs/08 §5）。
   * 用 `.default([])` 而不是「可选字段」：设置页与对话窗都必须能无条件读到一个数组，
   * 否则每一处消费都要写 `?? []`，漏一处就是一个运行时崩点。
   * 仅作**候选列表**用途：真正生效的仍是 `model`——列表里没有 `model` 时，
   * 选项串里要把当前值显示为「（不在列表中）」而不是把它悄悄替换掉。
   */
  modelList: z.array(z.string()).default([]),
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
 * STT provider 的接口协议（docs/06 §15.1、docs/08 §1）：
 *
 * - `openai-compat`：OpenAI 兼容 `POST <baseUrl>/audio/transcriptions`（multipart，回 `{text}`）；
 * - `dashscope-native`：阿里云百炼 / DashScope **原生**
 *   `POST <baseUrl>/api/v1/services/aigc/multimodal-generation/generation`
 *   （JSON，音频以 `data:` URI 放进 `input.messages`，文本在 `output.choices[0].message.content[].text`）。
 *
 * 纯增量枚举：v23 及更早的配置写的都是 `openai-compat`，天然合法，
 * 迁移只补缺失 / 非法的值，**不改正值**（旧配置升级后请求体逐字不变）。
 */
export const SttProviderTypes = ['openai-compat', 'dashscope-native'] as const
export const SttProviderTypeSchema = z.enum(SttProviderTypes)
export type SttProviderType = z.infer<typeof SttProviderTypeSchema>

/**
 * 接口协议的展示文案（**唯一来源**：设置页「语音」页 STT 区组的「接口协议」下拉）。
 *
 * 与 `LLM_PROVIDER_TYPE_LABELS` 同款：新增取值时这个 `Record` 会强制补文案，
 * 不会出现「枚举加了、界面上是个空白选项」。
 */
export const STT_PROVIDER_TYPE_LABELS: Record<SttProviderType, string> = {
  'openai-compat': 'OpenAI 兼容（/audio/transcriptions）',
  'dashscope-native': '阿里云百炼原生（数据 URI）',
}

/**
 * STT provider（docs/08 §1、Betav2 规格 §4）。
 *
 * 与 `tts.providers.<id>` **同构但独立**：语音输入（录音 → 文本）与语音输出（文本 → 语音）
 * 的可用性互不绑定，共用一份配置会让「换朗读服务」顺手把麦克风转写也弄坏。
 */
export const SttProviderSchema = z.object({
  type: SttProviderTypeSchema,
  baseUrl: z.string(),
  /** safeStorage 密文；明文只走 `settings:setSecrets`，渲染层与日志永远看不到明文。 */
  apiKeyEnc: z.string(),
  model: z.string(),
  /**
   * 识别语言（如 `zh` / `en`）；空串表示交给服务端自动检测。
   * 下发位置随 `type` 变：`openai-compat` 走 multipart 的 `language` 字段，
   * `dashscope-native` 走 `parameters.asr_options.language`（空串时该字段整个不出现）。
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

/**
 * provider id / MCP 服务器名的合法字符集：字母、数字、下划线、连字符（**禁 `.`**）。
 *
 * 名称会作为凭据路径的段（`llm.providers.<id>.apiKey`、`mcp.servers.<name>.env.<KEY>`），
 * 而 `.` 是路径分隔符 —— 含点的名称无法被 `SettingsStore` 的
 * `canonicalSecretPath` / `readSecretField` / `writeSecretField` 定位（P1-07），
 * 表现为「凭据永远存不进去」，MCP 添加流程还会丢 env 明文。
 *
 * 单一来源：`McpServerSchema.name` 用它做 Schema 校验，五个设置页入口经
 * `@aurora/shared/browser` 取**同一个常量**（`RESOURCE_NAME_RULE` 是同一句提示文案），
 * 不要再写第二份正则。口径见 docs/08 §1.3。
 */
export const RESOURCE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/
/** 名称不合规时的统一提示文案（Schema 与五个设置页共用，避免五份漂移）。 */
export const RESOURCE_NAME_RULE =
  '名称只能包含字母、数字、下划线或连字符（不能含「.」，它用于凭据路径分段）'

export const McpServerSchema = z.object({
  name: z.string().min(1).regex(RESOURCE_NAME_PATTERN, RESOURCE_NAME_RULE),
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
  /** 项目 id（设置页生成，稳定不变；会话绑定（`SessionMeta.projectId`）引用它）。 */
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
 * 项目分组只登记「可被会话绑定的项目清单」：哪个会话用哪个项目由会话数据
 * `SessionMeta.projectId`（`chat:setSessionProject` 写入）决定 —— 全局 `projects.current`
 * 已于 v25 退役（v17 起它就不再决定会话的实际工作目录 / 边界，界面的「设为当前」早已过时）。
 * 项目根仍决定两件事：① 绑定它的会话每轮注入哪份项目级 `AGENTS.md`；② 权限层判定
 * 「项目根之内 / 之外」的边界（step 2 的路径前缀校验）。
 *
 * 因此本分组在 `SETTINGS_READONLY_PREFIXES` 里 —— 改项目清单等于改 Agent 的权限面与指令面，
 * 属自我提权路径，只能由用户在设置页 / 界面改（走 `settings:update`，不经过该黑名单）。
 *
 * 每个字段都带 `.default()`：顶层分组整段缺失时，Schema 走"整体保留候选对象"路径，
 * 不过三个子字段现在都有默认值（`LlmModelParamsSchema`），缺字段只会回落默认，不牵连整份配置。
 */
export const ProjectsSchema = z.object({
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
  // 管理员提权（v20，docs/08 §1）：这是 Agent 自己能碰到的权限边界本身 ——
  // AI 把它关掉（或阻止自己重启提权）等于自己降低权限约束面，属自我提权路径。
  // 只保留「用户在设置页手动关」这一条路径（设置页走 `settings:update`）。
  'general.requireAdmin',
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
  // Work 模式的工作目录（docs/06 §5.1）：它是**权限边界根回落链的一级**（`boundaryRoot` →
  // Work 空间目录）—— AI 改写它等于把 `confirm` 档「根内免确认」
  // 扩到任意目录，与 `projects` 同构的自我提权路径。此前它登记在 `WRITABLE_PATH_OVERRIDES`
  // 里（覆盖表判定先于黑名单 → 双重放行）；只删覆盖表不够，会落回「Schema 登记过即默认可写」。
  // 只能由用户在设置页「模式 → Work」或引导问答改（都不经过本黑名单）。
  'modes.work.workspaceDir',
  // 三档权限（v13，docs/06 §12.2）：改档位等于自己给自己放宽确认闸门，同样只读。
  'agent.permissionMode',
  // 循环预算（v15，docs/06 §4.1）：AI 给自己放大轮次 / token 预算，等于绕过"该停下来问用户"的那道闸门。
  'agent.loop',
  // 写前快照（v14，docs/06 §11.8）：AI 关掉 `enabled` 或压低预算，等于在自己写文件前拆掉回滚保险。
  'agent.snapshots',
  // Agent 内置浏览器（v35，docs/06 §27、docs/08 §1）：整组是用户对 Agent 的授权边界 ——
  // 浏览器能力（含私网访问 / 媒体）与并发会话上限由用户显式开启与放宽，
  // AI 自行打开或放大等于给自己扩权。只能由用户在设置页操作。
  'agent.browser',
  // 黑名单配置自身（v15）：AI 往里追加路径等于自己收紧自己的可写面（自我 DoS）；
  // 放宽本就不生效（判定从不读用户配置）。用户经设置页 `settings:update` 修改不受影响。
  'advanced.readonlyPrefixes',
  // Aurora Center 连接（v16，docs/12 §7）：连接目标是数据外发通道 —— AI 自行启用、
  // 改向或填令牌等于把本机数据发往任意服务器。只能由用户在设置页操作。
  'center',
  // 自动化总开关（v19，docs/13 §2.2）：它是用户对「AI 能不能自己安排后台动作」的
  // 总闸门 —— AI 关掉它可以让用户的自动化静默失效，打开并配合 automation_* 工具
  // 等于自己给自己排程。AI 增删自动化走专用工具（逐次确认），不经这里。
  'automations',
  // 文件自感知（v28，docs/06 §26）：整组同时改变文件读取范围、正文出网与后台预算，
  // 属自我扩权 / 数据外发路径，只能由用户在设置页开启与调整。
  'fileAwareness',
  // 插件（v36，docs/14 §5）：安装 / 启停 / 信任 / 开发目录是用户的授权边界 ——
  // AI 自己装一个插件就等于给自己加任意代码执行与工具面，属自我提权路径。
  'plugins',
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
  'office_read',
  'office_help',
  'office_create',
  'office_edit',
  'office_render',
  'office_pdf',
  'office_raw_edit',
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
  /** 总开关；false 时全部电脑操控工具一个都不注册。 */
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
    /**
     * 模型打开 http(s) 网址时的去向（v27，docs/06 §11 / §14）：
     * `internal` = 右栏内置浏览器（默认）；`external` = 系统默认浏览器。
     *
     * 只约束模型发起的 `open_path` 与 `show_preview`；本地文件预览、自动化打开网址、
     * 设备授权登录和用户手动入口不读取本字段。
     */
    urlMode: z.enum(['internal', 'external']).default('internal'),
  }),
})
export type AgentToolsConfig = z.infer<typeof AgentToolsSchema>

/**
 * Agent 内置浏览器（v35，docs/06 §27、docs/08 §1）。
 * 整组在 SETTINGS_READONLY_PREFIXES 里：浏览器能力与并发上限是用户对 Agent 的授权边界，AI 不得自行开启或放宽。
 */
export const AgentBrowserSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxSessions: z.number().int().min(1).max(4).default(2),
    idleMinutes: z.number().int().min(1).max(60).default(10),
    allowPrivateNetwork: z.boolean().default(true),
    compatUserAgent: z.boolean().default(true),
    allowMedia: z.boolean().default(false),
  })
  .default({})
export type AgentBrowserConfig = z.infer<typeof AgentBrowserSchema>

export const AgentSchema = z.object({
  tools: AgentToolsSchema,
  /**
   * 三档权限（v13，docs/06 §12.2）：
   * - `readonly`：写 / 执行 / 有系统副作用的工具**根本不注册**，模型在工具清单里看不到它们；
   * - `confirm`：旧 auto 语义（未配置项目直接放行；有项目时根内免确认、根外弹卡）；
   * - `auto`：**默认档**（2026-09-29 起），完全权限，所有敏感工具不再弹确认卡。
   *
   * 默认档从 `confirm` 提到 `auto` 是产品决定：Aurora 是**系统级** Agent 工具，
   * 出厂就逐次确认会让绝大多数正常操作（改自己项目里的文件、跑一条构建）都要先点一次卡片，
   * 用户实测反馈「默认权限太低」。`auto` 是完全权限，不再出现确认卡；
   * `confirm` 档按项目根做「根内免确认、根外弹卡」，并由
   * `file-port.resolveWithin` 的 realpath 前缀校验兜底。
   *
   * 与 `advanced.confirmSensitiveTools` 双开关并存，优先级见 docs/06 §12.2：
   * `confirmSensitiveTools === false` 时非 readonly 档被强制按 `auto` 处理；readonly 档下该布尔无效。
   *
   * 本字段在 `SETTINGS_READONLY_PREFIXES` 里（AI 不可自我提权）。
   */
  permissionMode: z.enum(['readonly', 'confirm', 'auto']).default('auto'),
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
   * Agent 循环的执行旋钮（docs/06 §5 / §4.1，v34 起只剩一个）。
   *
   * **v34 删掉了 `maxRounds` / `maxTotalTokens` / `autoContinueRounds` 三项**（对齐主流编码代理）：
   * 一次请求应当跑到模型自己收敛，而不是在第 32 轮被墙打断、再靠"自动续轮额度"续命。
   * 防失控的兜底上限回到内核常量 `RUNAWAY_MAX_ROUNDS`（docs/06 §5），token 只统计不限制 ——
   * 它们从来不是用户会按任务去调的量，摆进设置页只会变成"改了不知道有没有生效"的旋钮。
   *
   * 留下的是**并发度**：同一轮里最多同时执行几个工具调用（超出排队等位，不丢弃）。
   * 这个值得配，是因为它换的是"响应快慢 vs 本机资源占用"，用户能按机器情况判断；
   * 而它不影响任务能否跑完（超出只是排队），所以调小也不会断任务。
   *
   * 本分组仍在 `SETTINGS_READONLY_PREFIXES` 里（AI 改不动）：让 AI 给自己放大执行预算，
   * 等于绕过"该停下来问用户"的那道闸门。用户当然可以调——设置页 / `settings:update` 不经过本黑名单。
   */
  loop: z
    .object({
      /** 同一轮工具调用最多几个**同时在跑**（1–32，默认 8）。只读类工具才会并发，见 docs/06 §5。 */
      maxParallelCalls: z.number().int().min(1).max(32).default(8),
    })
    .default({}),
  /**
   * Agent 内置浏览器（v35，docs/06 §27、docs/08 §1）：能力开关、并发会话上限与闲置回收分钟数。
   *
   * 整组在 `SETTINGS_READONLY_PREFIXES` 里（AI 改不动）：浏览器能访问什么（私网 / 媒体）与
   * 同时开几个会话是用户对 Agent 的授权边界 —— 让 AI 自行开启或放宽等于给自己扩权。
   * 用户走设置页 / `settings:update` 不受该黑名单影响。
   */
  browser: AgentBrowserSchema,
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
export const CENTER_OFFICIAL_CAPABILITIES = ['llm', 'imagegen', 'tts', 'stt'] as const
export type CenterOfficialCapability = (typeof CENTER_OFFICIAL_CAPABILITIES)[number]

/**
 * Center 官方模型的保留 Provider id。
 *
 * 这些条目由主进程在模型目录同步时维护，普通 Provider CRUD 不展示 / 不删除；
 * API Key 固定取 `center.token`，不写入普通 Provider 的 `apiKeyEnc`。
 */
export const CENTER_OFFICIAL_PROVIDER_IDS = {
  llm: 'center-llm',
  imagegen: 'center-imagegen',
  tts: 'center-tts',
  stt: 'center-stt',
} as const

export type CenterOfficialProviderId =
  (typeof CENTER_OFFICIAL_PROVIDER_IDS)[CenterOfficialCapability]

export const CENTER_OFFICIAL_PROVIDER_ID_VALUES = Object.values(
  CENTER_OFFICIAL_PROVIDER_IDS,
) as readonly CenterOfficialProviderId[]

export function isCenterOfficialProviderId(value: string): value is CenterOfficialProviderId {
  return (CENTER_OFFICIAL_PROVIDER_ID_VALUES as readonly string[]).includes(value)
}

const CenterOfficialSelectionSchema = z
  .object({
    enabled: z.boolean().default(false),
    model: z.string().default(''),
  })
  .default({})

export const CenterOfficialModelsSchema = z
  .object({
    llm: CenterOfficialSelectionSchema,
    imagegen: CenterOfficialSelectionSchema,
    tts: CenterOfficialSelectionSchema,
    stt: CenterOfficialSelectionSchema,
  })
  .default({})

export type CenterOfficialModelSelection = z.infer<typeof CenterOfficialSelectionSchema>
export type CenterOfficialModels = z.infer<typeof CenterOfficialModelsSchema>

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
  /** v31：Center 官方模型选择（全局覆盖；会话覆盖仍走 SessionMeta.llm）。 */
  officialModels: CenterOfficialModelsSchema,
})
export type CenterSettings = z.infer<typeof CenterSchema>

/**
 * 自动化总开关（v19，docs/13 §2.2）。
 *
 * 自动化的**定义与历史不在这里**——它们是用户数据（可多条、带运行历史），
 * 落在 `<userData>/automations/*.json` 独立存储（同会话 / 待办的口径，
 * 不占 CONFIG_VERSION 迁移链）。配置里只有这一个闸门：关闭 = 引擎停止评估与触发。
 *
 * 整组在 `SETTINGS_READONLY_PREFIXES`：这是用户对「AI 能不能自己安排后台动作」的
 * 总闸门，AI 的 `set_setting` 一律拒绝；AI 增删自动化走 `automation_*` 专用工具
 * （docs/13 §8，逐次确认）。
 */
export const AutomationsSchema = z.object({
  enabled: z.boolean().default(true),
})
export type AutomationsSettings = z.infer<typeof AutomationsSchema>

/**
 * 文件自感知（v29，docs/06 §26）。
 *
 * 整组只读：它同时决定本机文件读取范围、正文出网与后台任务预算，AI 不能自行开启或放宽。
 * 只有用户显式同意后，后台才允许把 `.docx/.pptx` 的截断正文发给你配置的模型。
 */
export const FileAwarenessSchema = z.object({
  enabled: z.boolean().default(false),
  contentConsentAccepted: z.boolean().default(false),
  watchedDirs: z.array(z.string()).max(3).default([]),
  knowledgeDir: z.string().default(''),
  includeRecent: z.boolean().default(true),
  suggestionsEnabled: z.boolean().default(true),
  dailyAnalysisLimit: z.number().int().min(1).max(200).default(20),
  maxFileMb: z.number().int().min(1).max(500).default(100),
  /**
   * 记忆默认有效期（天）。0 = 永不过期；跟随默认的记忆按最近一次 updatedAt 续期。
   */
  defaultMemoryTtlDays: z.number().int().min(0).max(3650).default(0),
  /**
   * 后台分析专用模型；providerId 为空时跟随全局 llm.active。
   * 显式选择后不再静默回退，避免把文件正文发给用户未指定的模型。
   */
  backgroundModel: z
    .object({
      providerId: z.string().default(''),
      model: z.string().default(''),
    })
    .default({ providerId: '', model: '' }),
})
export type FileAwarenessSettings = z.infer<typeof FileAwarenessSchema>

/**
 * 插件（v36，docs/14 §5）。
 *
 * 这里只放**总开关 / 开发目录 / 当前主题**；已安装插件、启用与否、信任状态
 * 落在 `<userData>/plugins/registry.json`（安装态数据，不进配置迁移链）。
 *
 * 整组在 `SETTINGS_READONLY_PREFIXES`：安装插件等于引入任意代码执行与新的工具面，
 * AI 的 `set_setting` 必须不能操作它。
 */
export const PluginsSchema = z.object({
  /** 插件总开关；false 时全部插件停用、贡献全部注销（进程也一起退出）。 */
  enabled: z.boolean().default(true),
  /** 开发目录（原地加载、文件变化自动重启；最多 8 个）。 */
  devDirs: z.array(z.string()).max(8).default([]),
  /** 当前启用的插件主题；空串 = 不使用插件主题。 */
  activeTheme: z
    .object({
      pluginId: z.string().default(''),
      themeId: z.string().default(''),
    })
    .default({ pluginId: '', themeId: '' }),
})
export type PluginsSettings = z.infer<typeof PluginsSchema>

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
  automations: AutomationsSchema,
  fileAwareness: FileAwarenessSchema,
  appearance: AppearanceSchema,
  plugins: PluginsSchema,
})

export type Settings = z.infer<typeof SettingsSchema>

/** 黑名单前缀 → 给模型与审计日志看的中文原因（每个默认前缀都必须有一条）。 */
const READONLY_PREFIX_REASONS: Record<(typeof SETTINGS_READONLY_PREFIXES)[number], string> = {
  // 这条前缀同时罩着凭据（baseUrl / apiKeyEnc）与「模型能力事实」（modelParams 下的
  // contextWindow / vision）—— 只放行 `model` 与 `modelParams.*.reasoningEffort`（见覆盖表），
  // 所以拒绝文案要覆盖两类，别把「窗口大小」这类事实说成凭据。
  'llm.providers': '凭据与模型能力事实字段不允许通过工具修改',
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
  'general.requireAdmin': '管理员提权是 Agent 自己的权限边界，不允许通过工具关闭（docs/08 §1）',
  'advanced.confirmSensitiveTools': '关闭它等于摘掉敏感工具的确认闸门，不允许通过工具修改',
  'agent.tools.terminal.allowPatterns':
    '免确认命令模式等于摘掉终端工具自己的确认闸门，不允许通过工具修改',
  projects: '项目根同时决定注入的指令与权限边界，不允许通过工具修改',
  'modes.work.workspaceDir':
    'Work 工作目录是权限边界根的一级，AI 改写它等于把免确认范围扩到任意目录，不允许通过工具修改',
  'agent.permissionMode': '权限档位等于 Agent 自己的确认闸门，不允许通过工具修改',
  'agent.loop': '循环的并发度与防失控口径属于 Agent 自己的停止闸门，不允许通过工具修改',
  'agent.snapshots': '写前快照是改动可回滚的兜底，不允许通过工具关闭',
  'agent.browser': '浏览器能力与并发上限是用户对 Agent 的授权边界，AI 不得自行开启或放宽',
  'advanced.readonlyPrefixes':
    '只读黑名单的配置自身不允许通过工具修改（防自我收紧；放宽本就不生效）',
  center: 'Center 连接是数据外发通道，不允许通过工具启用或改向（docs/12 §7）',
  automations: '自动化总开关是用户对后台动作的总闸门，不允许通过工具修改（docs/13 §2.2）',
  fileAwareness: '文件自感知会读取文件并发送正文，必须由用户显式配置，不允许通过工具修改',
  plugins: '插件的安装与信任是用户的授权边界，不允许通过工具修改（docs/14）',
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
 * 1. **真的放开**：`llm.providers.<id>.model` 与 `llm.providers.<id>.modelParams.<modelId>.reasoningEffort`
 *    落在 `llm.providers` 黑名单前缀之内，但「换模型 / 调思考等级」不碰凭据，必须显式放行
 *    （baseUrl / apiKeyEnc / modelList 等其余字段仍被前缀拒绝）；
 * 2. **显式登记**：`tts.enabled` / `agent.tools.*` 这类本就因「不在黑名单而可写」的路径，
 *    逐条登记成可写面清单（供工具 description 与审计使用），也防未来误加前缀时静默收窄。
 *
 * 注意：模式里的 `*` / `**` 只是本表的匹配语法（语义见 `matchesPattern`），
 * `canWriteSettingPath` 收到的**实际路径**仍必须是具体路径
 * （`isConcreteSettingPath` 会先拦掉带 `*` / `[]` 的输入）。
 */
export const WRITABLE_PATH_OVERRIDES: readonly WritablePathOverride[] = [
  // llm.providers.*：黑名单内显式放开两个「模型行为」字段（凭据与连接字段仍只读）。
  // 注意 `modelParams.*.contextWindow` / `.vision` **刻意不登记** —— 它们是**模型能力事实**
  // （窗口多大、能不能收图），不是用户偏好：登记进去等于让 AI 把一条假事实写进配置
  // （docs/08 §1）。采样温度字段已随 v23 从 Schema 删除，不再是可写路径（docs/06 §3）。
  { pattern: 'llm.providers.*.model', reason: '切换该 provider 实际使用的模型（不碰凭据）' },
  {
    // `**`（一个或多个段）而不是 `*`：**模型 id 里可以有点** —— `gpt-4.1` /
    // `gemini-2.5-pro` / `claude-3.5-sonnet` 都是常见写法，而路径是按 `.` 切段的。
    // 用 `*` 的话这类模型的思考等级会变成「文档说可写、实际必被拒」（v22 时代它是
    // provider 级路径 `llm.providers.*.reasoningEffort`，而 provider id 禁点，
    // 所以**任何**模型都能写 —— 这是下沉到模型级时新出现的收窄）。
    pattern: 'llm.providers.*.modelParams.**.reasoningEffort',
    reason: '调整该模型的思考等级（不碰凭据）',
  },
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
  { pattern: 'general.edgeBar.display', reason: '切换提示条贴附的显示器' },
  { pattern: 'general.edgeBar.position', reason: '切换提示条贴附的屏幕侧' },
  { pattern: 'general.gameMode.enabled', reason: '开关游戏模式联动' },
  { pattern: 'appearance.theme', reason: '切换界面明暗档位（跟随系统 / 亮色 / 暗色）' },
  { pattern: 'appearance.accent', reason: '切换界面强调色主题' },
  { pattern: 'appearance.glass', reason: '开关界面毛玻璃效果（关掉后窗口与面板变实色）' },
  { pattern: 'appearance.awarenessGlow', reason: '开关文件自感知的四周流光特效' },
  { pattern: 'general.chat.showThinking', reason: '开关对话界面的思考过程展示' },
  // 模式
  { pattern: 'modes.current', reason: '切换当前模式' },
  // 注意 `modes.work.workspaceDir` **刻意不登记**：它是权限边界根的一级（见
  // `SETTINGS_READONLY_PREFIXES`），覆盖表判定先于黑名单，登记进去等于放行（自我提权）。
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
 * 显式可写覆盖匹配：与 `matchReadonlyPrefix` 同一套「逐段相等」语义，另支持两种通配段：
 * - `*` 匹配**恰好一个**动态键段（如 provider id），且**整条路径与模式的段数一致** ——
 *   因此 `llm.providers.*.model` 命中 `llm.providers.deepseek.model`，但不命中
 *   `llm.providers.deepseek.modelList`（段名不同）也不命中 `llm.providers.a.model.x`（多一段）；
 * - `**` 匹配**一个或多个**段，且**后面必须还有字面量段**。它只有一个用途：
 *   **模型 id 里可以有点**（`gpt-4.1` / `claude-3.5-sonnet` 都是常见写法，见 `LlmProviderSchema.model`
 *   的注释 —— 那里没有任何字符集约束），而路径是按 `.` 切段的，`*` 匹配不了。
 *   收尾那个字面量段（`reasoningEffort`）是这条模式的**闸门**：`**` 只允许出现在它之前，
 *   所以 `contextWindow` / `vision` / 凭据子树仍然一个字都写不进去。
 */
function matchWritableOverride(path: string): WritablePathOverride | undefined {
  const segments = path.split('.')
  for (const override of WRITABLE_PATH_OVERRIDES) {
    if (matchesPattern(override.pattern.split('.'), segments)) return override
  }
  return undefined
}

/** 段级模式匹配（`*` = 恰好一段；`**` = 一段或更多，且不能在模式末尾）。 */
function matchesPattern(patternSegments: readonly string[], segments: readonly string[]): boolean {
  const globstar = patternSegments.indexOf('**')
  // 只支持**一个** `**`（多于一个时尾段里的那个会被当字面量、模式静默永不命中 ——
  // 那正是本轮要修的症状，宁可显式拒绝）。
  if (globstar !== patternSegments.lastIndexOf('**')) return false
  if (globstar === -1) {
    if (patternSegments.length !== segments.length) return false
    return patternSegments.every((segment, index) => segment === '*' || segment === segments[index])
  }
  const head = patternSegments.slice(0, globstar)
  const tail = patternSegments.slice(globstar + 1)
  // `**` 在末尾等于「以任意内容结尾」—— 那会把整棵子树放出去，直接判不匹配。
  if (tail.length === 0) return false
  const offset = segments.length - tail.length
  // `**` 至少要吃掉一段（`offset === head.length` 时它一段都没吃到）。
  if (offset <= head.length) return false
  if (!head.every((segment, index) => segment === '*' || segment === segments[index])) return false
  return tail.every((segment, index) => segment === '*' || segment === segments[offset + index])
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
 * record 动态键通配 `*`），校验时精确匹配 + 逐级通配兜底；对象型路径另走
 * `objectPaths` / `nullableObjectPaths` 的**形状校验**（见其定义）。
 */
export type { FieldValidator } from '../utils/object.js'

import type { FieldValidator } from '../utils/object.js'

/** 'any' 表示"该路径接受任意类型"（枚举 / 字面量） */
type AcceptSpec = 'any' | readonly string[]

/** 枚举字段的合法取值表（`z.enum`）：类型对不代表值合法，必须按值校验。 */
type EnumSpec = readonly unknown[]

const schemaSpecs = new Map<string, AcceptSpec>()
const enumPaths = new Map<string, EnumSpec>()
/**
 * 对象型字段路径（`z.object`）：候选值必须是**纯对象**。
 *
 * 与 `schemaSpecs` **刻意分开维护**（P2-26）：`walk` 对 `ZodObject` 只递归子键、不给分组自身
 * 登记类型，于是「标量 / 数组塞进对象型字段」（`general: 123`、`general.edgeBar.quietHours: "22:30"`）
 * 在 `fieldAccepts` 里被按「未登记路径默认接受」放行，一路活到 `SettingsSchema.parse`，
 * 把**整份配置**判为损坏并重建出厂。这里只补形状判定，
 * **不能**把对象路径写进 `schemaSpecs` —— 那会让 `lookupSpec('general')` 这类分组路径变成
 * 「已登记」，`isKnownSettingPath('general')` 随之为真 → `set_setting` 的路径存在性兜底
 * 对整组路径失效（`canWriteSettingPath('general')` 变成放行）。
 */
const objectPaths = new Set<string>()
/** 「对象或 null」的可空对象字段（`z.object(...).nullable()`，如 `general.edgeBar.quietHours`）。 */
const nullableObjectPaths = new Set<string>()
walk(SettingsSchema, '', schemaSpecs, enumPaths)
const dynamicPaths = collectDynamicPaths(SettingsSchema)

export const fieldAccepts: FieldValidator = (path, candidate) => {
  if (objectPaths.has(path) || nullableObjectPaths.has(path)) {
    // 可空对象（quietHours）接受 null；其余对象字段只接受纯对象。
    // 数组**不是**对象（`general.windowState[]` 这类畸形路径同样落到这里被拒）。
    return candidate === null ? nullableObjectPaths.has(path) : typeNameOf(candidate) === 'object'
  }
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
/**
 * 通配路径匹配（登记表的键 → 具体路径）。
 *
 * 登记表的键里，`*` 段代表 `z.record` 的动态键、`x[]` 段代表数组元素。老实现是
 * 「把具体路径的**某一段**替换成 `*` / `[]` 再查表」—— 一次只替换一段，于是**双动态段**的路径
 * （`llm.providers.<id>.modelParams.<模型 id>.<字段>`，v23 起存在）永远查不到登记项，
 * `fieldAccepts` 落到「未登记路径默认接受」分支、对任何候选值都放行。
 * 这里改成**逐段比对登记键**（每段允许 `*` / `[]` / 去尾的 `[]`），天然支持任意多段动态。
 */
function matchPathPattern(pattern: string, segments: readonly string[]): boolean {
  const parts = pattern.split('.')
  if (parts.length !== segments.length) return false
  return parts.every((part, index) => {
    const segment = segments[index]
    if (segment === undefined) return false
    if (part === segment) return true
    if (part === '*' || part === '[]') return true
    // 数组元素标记粘在该段尾巴上（`subjects[].name`）
    return part.endsWith('[]') && part.slice(0, -2) === segment
  })
}

function findByPattern<T>(map: ReadonlyMap<string, T>, path: string): T | undefined {
  const segments = path.split('.')
  for (const [key, value] of map) {
    if (matchPathPattern(key, segments)) return value
  }
  return undefined
}

function lookupSpec(path: string): AcceptSpec | undefined {
  return schemaSpecs.get(path) ?? findByPattern(schemaSpecs, path)
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
 * `llm.providers.<id>.modelParams.<modelId>.reasoningEffort` 在 Schema 遍历时登记成
 * `llm.providers.*.modelParams.*.reasoningEffort`，因此逐级用 `*` / `[]` 替换才找得到。
 *
 * ⚠️ **已知缺口**（`schema.test.ts` 有两条 `it.fails` 钉住）：替换一次只作用于**一段**，
 * 而 `modelParams` 的登记路径有**两个**动态段 —— 具体路径查不到登记项，`fieldAccepts`
 * 于是落到「未登记路径默认接受」分支。影响是**惰性**的：`fieldAccepts` 全仓只被
 * `sanitizeWithDefaults` 使用，而它对 `llm.providers`（`z.record`）整体保留候选对象、
 * 不下钻这棵子树（真正的取值闸门是 `SettingsSchema`）。同一形状早在
 * `mcp.servers[].headersEnc.*` 上就存在。
 */
function lookupEnum(path: string): EnumSpec | undefined {
  return enumPaths.get(path) ?? findByPattern(enumPaths, path)
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
      // 本级登记为「必须是纯对象」（P2-26）：只递归子键的话，`general: 123` 这类形状坏掉的
      // 分组在 `fieldAccepts` 里无人认领 → 默认放行 → 整份配置被判损坏重建。
      if (path !== '') objectPaths.add(path)
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
      // `modes.classroom.schedule.{provider,classisland.source}`）。`llm.providers.*.modelParams.*.reasoningEffort`
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
    case 'ZodNullable': {
      const inner = def['innerType']
      if (inner) {
        walk(inner as z.ZodTypeAny, path, specs, enums)
        // 可空对象（`z.object(...).nullable()`，当前只有两个 quietHours 字段）：
        // 内层是对象时 `walk` 刚把它记进 `objectPaths`，这里补一条「也接受 null」，
        // 否则 `fieldAccepts(path, null)` 会被形状校验误杀。
        if (path !== '' && objectPaths.has(path)) nullableObjectPaths.add(path)
      }
      return
    }
    case 'ZodOptional':
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
