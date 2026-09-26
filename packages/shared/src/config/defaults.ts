/** 全量默认配置（docs/08 §1）。必须与 `schema.ts` 一一对应，由单测保证。 */
import {
  CONFIG_VERSION,
  DEFAULT_SUBJECT_FOLDER_PREFIX,
  DEFAULT_SUBJECT_NAMES,
  SETTINGS_READONLY_PREFIXES,
  type ReasoningEffort,
  type Settings,
  type WindowName,
} from './schema.js'

export const DEEPSEEK_PRESET = {
  id: 'deepseek',
  label: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
} as const

export const OPENAI_PRESET = {
  id: 'openai',
  label: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
} as const

export const LOCAL_PRESET = {
  id: 'local',
  label: '本地 / 自定义 (OpenAI 兼容)',
  baseUrl: 'http://localhost:11434/v1',
  model: 'qwen2.5:7b',
} as const

export const PROVIDER_PRESETS = [DEEPSEEK_PRESET, OPENAI_PRESET, LOCAL_PRESET] as const

/**
 * TTS provider 预设（docs/08 §1、docs/06 §13）：设置页「添加 TTS 模型」的 chips。
 *
 * 与 `PROVIDER_PRESETS` 一样只提供 id / label / baseUrl / model / voice 五个字段，
 * 其余字段（语速 / 输出格式）由新建流程用 `DEFAULT_TTS` 之外的页面默认值补齐。
 */
export const TTS_PRESETS = [
  {
    id: 'openai',
    label: 'OpenAI TTS',
    baseUrl: 'https://api.openai.com/v1',
    model: 'tts-1',
    voice: 'alloy',
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow 语音',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/CosyVoice2-0.5B',
    voice: 'alex',
  },
] as const

/** TTS 配置默认值（docs/08 §1）：默认无 provider（`active` 空 = 未配置，朗读入口不出现）。 */
export const DEFAULT_TTS = {
  enabled: true,
  active: '',
  autoRead: false,
  maxChars: 2000,
  providers: {},
} as const

/**
 * STT provider 预设（docs/08 §1）：设置页「添加语音输入模型」的 chips。
 *
 * 与 `TTS_PRESETS` 一样只提供 id / label / baseUrl / model / language，
 * 其余字段由新建流程用页面默认值补齐。
 */
export const STT_PRESETS = [
  {
    id: 'openai',
    label: 'OpenAI 语音识别',
    baseUrl: 'https://api.openai.com/v1',
    model: 'whisper-1',
    language: 'zh',
  },
] as const

/**
 * 生图 provider 预设（docs/08 §1）：设置页「添加生图模型」的 chips。
 */
export const IMAGEGEN_PRESETS = [
  {
    id: 'openai',
    label: 'OpenAI 生图',
    baseUrl: 'https://api.openai.com/v1',
    model: 'dall-e-3',
    size: '1024x1024',
  },
] as const

/**
 * STT 配置默认值（docs/08 §1）：默认**关闭**且无 provider ——
 * 未配置时对话窗连麦克风按钮都不渲染（门控口径同 TTS，docs/07 §2.3）。
 */
export const DEFAULT_STT = {
  enabled: false,
  active: '',
  providers: {},
} as const

/** 生图配置默认值（docs/08 §1）：默认关闭且无 provider。 */
export const DEFAULT_IMAGEGEN = {
  enabled: false,
  active: '',
  providers: {},
} as const

/**
 * 新建 provider 时的思考等级默认值（docs/08 §1、docs/06 §11）。
 *
 * 单独抽成常量而不是到处写字符串 `'auto'`：`auto` 表示「请求体里不带 `reasoning_effort`」，
 * 是不认该参数的厂商唯一能正常工作的取值，所有创建 provider 的入口都必须用它。
 */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'auto'

/** 05 §2 默认科目模板 → 科目/文件夹映射 */
export function createDefaultSubjects(): Settings['modes']['classroom']['subjects'] {
  return DEFAULT_SUBJECT_NAMES.map((name) => ({
    name,
    folder: `${DEFAULT_SUBJECT_FOLDER_PREFIX}/${name}`,
    keywords: [],
  }))
}

/** 05 §3.2 分类管线默认行为 */
export const DEFAULT_CLASSIFICATION = {
  autoMove: true,
  confidenceThreshold: 0.6,
  fallbackFolder: '待分类',
} as const

/** 05 §3.4 ClassIsland 桥接默认：文件源 + 未配置端点（此时 provider 返回空课表） */
export const DEFAULT_CLASSISLAND_SCHEDULE = {
  source: 'file',
  endpoint: '',
  timeoutMs: 3000,
} as const

/**
 * 电脑操控工具默认配置（docs/08 §1、docs/06 §11）。
 *
 * 默认全开，但每一个敏感工具（`run_command` / `write_file` / `open_path`）执行前都要用户确认，
 * 所以"默认开"并不等于"默认能被静默操控"。
 */
export const DEFAULT_AGENT_TOOLS = {
  enabled: true,
  workspaceDir: '',
  terminal: {
    enabled: true,
    timeoutMs: 60_000,
    maxOutputChars: 8000,
    /**
     * 命中即免确认的命令模式（v12，docs/06 §11.7）：默认空数组 = 全部逐次确认（v12 之前的行为）。
     * 加 `as string[]` 是因为本对象是 `as const`：否则 `[]` 会被推断成只读空元组
     * `readonly []`，无法赋给 Schema 推出的可变 `string[]`。
     * 该字段在 `SETTINGS_READONLY_PREFIXES` 里（AI 改不动，防自我提权）。
     */
    allowPatterns: [] as string[],
  },
  files: {
    enabled: true,
    maxReadBytes: 262_144,
  },
  /** 文件检索（`grep` / `glob`）配置（v12，docs/06 §11.5）：默认开启、单次最多 200 条结果。 */
  search: {
    enabled: true,
    maxResults: 200,
  },
  open: {
    enabled: true,
  },
} as const

export const DEFAULT_TOOLCHAIN_CONFIG: Settings = {
  version: CONFIG_VERSION,
  general: {
    language: 'zh-CN',
    launchAtLogin: false,
    hotkey: 'Alt+Space',
    edgeBar: {
      enabled: true,
      opacity: 0.9,
      quietHours: null,
    },
    windowState: {},
    chat: {
      showThinking: true,
    },
  },
  llm: {
    active: '',
    providers: {},
  },
  tts: { ...DEFAULT_TTS },
  stt: { ...DEFAULT_STT },
  imagegen: { ...DEFAULT_IMAGEGEN },
  modes: {
    current: 'classroom',
    classroom: {
      guideCompleted: false,
      watchDir: '',
      subjects: createDefaultSubjects(),
      schedule: {
        provider: 'manual',
        lessons: [],
        classisland: { ...DEFAULT_CLASSISLAND_SCHEDULE },
      },
      preClassReminder: true,
      preClassOpenFolder: true,
      // v10 新增：课前提前分钟数（装配层注入 PreClassReminder，改完即时生效）
      preClassLeadMinutes: 5,
      classification: { ...DEFAULT_CLASSIFICATION },
    },
    work: { guideCompleted: false, workspaceDir: '' },
    code: { guideCompleted: false },
  },
  skills: {
    userDir: '',
    disabled: [],
  },
  mcp: {
    servers: [],
    lazyConnect: false,
  },
  /**
   * 项目机制（v13，docs/06 §5.1）：默认**无项目**（`current: ''` + 空列表），
   * 行为与 v13 之前完全一致；AGENTS.md 只在用户显式登记项目后才注入。
   * `maxAgentsBytes` 是每轮注入的字节预算（32 KiB，够放一份长 AGENTS.md）。
   */
  projects: {
    current: '',
    list: [],
    maxAgentsBytes: 32768,
  },
  advanced: {
    proxy: '',
    logLevel: 'info',
    quietHours: null,
    confirmSensitiveTools: true,
    readonlyPrefixes: [...SETTINGS_READONLY_PREFIXES],
  },
  agent: {
    tools: { ...DEFAULT_AGENT_TOOLS },
    // 三档权限默认 `confirm` = 与 v13 之前的行为完全一致（敏感工具逐次确认）
    permissionMode: 'confirm',
    /**
     * 写前快照（v14，docs/06 §11.8）：默认开启、每文件留 20 份、单份 ≤512 KiB、
     * 目录总预算 200 MiB。默认值刻意"够用不夸张"——用户第一次改文件就应该能回滚。
     */
    snapshots: {
      enabled: true,
      keepPerFile: 20,
      maxSnapshotBytes: 524288,
      totalBudgetBytes: 200 * 1024 * 1024,
    },
  },
}

/** 返回一份全新的默认配置（避免调用方共享同一引用）。 */
export function createDefaultSettings(): Settings {
  return structuredClone(DEFAULT_TOOLCHAIN_CONFIG)
}

/** 记忆窗口几何信息时的默认结构。 */
export function defaultWindowGeometry(
  window: WindowName,
): Record<string, unknown> & { name: WindowName } {
  return { name: window }
}
