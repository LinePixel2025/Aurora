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
 * 与 `TTS_PRESETS` 一样只提供 id / label / type / baseUrl / model / language，
 * 其余字段由新建流程用页面默认值补齐。
 *
 * `type` 必须写在预设里（不能由页面写死）：两条预设走的是**两套协议**
 * —— `openai-compat` 的 baseUrl 是 `<端点根>`（页面拼 `/audio/transcriptions`），
 * `dashscope-native` 的 baseUrl 是**服务根**（主进程拼
 * `/api/v1/services/aigc/multimodal-generation/generation`，见 docs/06 §15.1）。
 * 阿里云那条填**官方域名**：qianwenai 之类的 MaaS 专属网关把同一原生路径
 * 挂在 `/compatible-mode/v1` 之外的根路径上，改用网关时把 baseUrl 换成
 * 网关根地址（或 `…/api`）即可，协议不用改。
 */
export const STT_PRESETS = [
  {
    id: 'openai',
    label: 'OpenAI 语音识别',
    type: 'openai-compat',
    baseUrl: 'https://api.openai.com/v1',
    model: 'whisper-1',
    language: 'zh',
  },
  {
    id: 'dashscope',
    label: '阿里云百炼（原生 ASR）',
    type: 'dashscope-native',
    baseUrl: 'https://dashscope.aliyuncs.com',
    model: 'qwen3-asr-flash',
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
    // v20 出厂档：要求管理员身份（docs/08 §1）。用户可在设置页「常规」关掉。
    requireAdmin: true,
    edgeBar: {
      enabled: true,
      opacity: 0.9,
      quietHours: null,
      // v21：提示条贴附的显示器与屏幕侧（docs/08 §1 / docs/07 §2.2）
      display: 'primary',
      position: 'right',
    },
    windowState: {},
    chat: {
      showThinking: true,
    },
  },
  appearance: {
    accent: 'aurora',
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
   * 项目机制（v13，docs/06 §5.1）：默认**空列表**；AGENTS.md 只在用户显式登记项目、
   * 且会话绑定它之后才注入（v25 起无全局 `current`）。
   * `maxAgentsBytes` 是每轮注入的字节预算（32 KiB，够放一份长 AGENTS.md）。
   */
  projects: {
    list: [],
    maxAgentsBytes: 32768,
  },
  advanced: {
    proxy: '',
    logLevel: 'info',
    quietHours: null,
    /*
     * 老开关（v13 之前唯一的确认闸门）与 `agent.permissionMode` 是**镜像**关系：
     * 界面每次改档位都同时写两个字段（`mode !== 'auto'`）。默认档既然提到 `auto`，
     * 这里就必须一起是 `false` —— 否则出厂配置本身就处在「两个字段互相矛盾」的状态，
     * 任何直接读这个老开关的消费方（Center 状态映射 / 老版本回退）都会读到一个谎。
     */
    confirmSensitiveTools: false,
    readonlyPrefixes: [...SETTINGS_READONLY_PREFIXES],
  },
  agent: {
    tools: { ...DEFAULT_AGENT_TOOLS },
    /*
     * 三档权限默认 `auto`（完全权限，2026-09-29 起）：项目根之内免确认、越界仍确认 ——
     * 逐次确认（`confirm`）不再是出厂档，用户随时能在对话窗 / 设置页切回去。
     * 改这条的理由与护栏见 schema.ts 上的长注释。
     */
    permissionMode: 'auto',
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
    /**
     * Agent 循环（v15 引入，v18 放宽，docs/06 §5 / §4.1）：轮次上限 32、token 预算不限、
     * 轮次用尽后允许自动再续 8 轮 —— 对齐业界（Codex / OpenHands 等都不在个位数轮次上
     * 卡断长任务），复杂任务不必频繁手动点「继续」。用尽即 job 暂停（附原因），不再静默收尾。
     */
    loop: {
      maxRounds: 32,
      maxTotalTokens: 0,
      autoContinueRounds: 8,
    },
  },
  /**
   * Aurora Center 连接（v16；v17 补 `account`，docs/12）：默认**不启用**（`enabled: false` + 空 serverUrl）
   * —— 不配置时零行为变化：不出站连接、不注册 Center 工具、设置页之外无任何入口。
   */
  center: {
    enabled: false,
    serverUrl: '',
    tokenEnc: '',
    account: '',
    clientId: '',
    displayName: '',
    allowRemoteSession: true,
    allowRemoteConfig: true,
    allowFileTransfer: true,
    maxFileMb: 64,
  },
  /**
   * 自动化（v19，docs/13）：总开关默认开启。自动化的定义与历史是用户数据，
   * 落在 `<userData>/automations/*.json` 独立存储、不进配置（见 AutomationsSchema 注释）。
   */
  automations: {
    enabled: true,
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
