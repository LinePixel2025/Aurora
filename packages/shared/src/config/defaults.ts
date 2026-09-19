/** 全量默认配置（docs/08 §1）。必须与 `schema.ts` 一一对应，由单测保证。 */
import {
  CONFIG_VERSION,
  DEFAULT_SUBJECT_FOLDER_PREFIX,
  DEFAULT_SUBJECT_NAMES,
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
  },
  llm: {
    active: '',
    providers: {},
  },
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
      classification: { ...DEFAULT_CLASSIFICATION },
    },
    work: { guideCompleted: false },
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
  advanced: {
    proxy: '',
    logLevel: 'info',
    quietHours: null,
    confirmSensitiveTools: true,
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
