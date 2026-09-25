/**
 * 配置版本迁移链（docs/08 §2「version 字段 + migrations 链式执行」）。
 *
 * 约定：每次 Schema 破坏性变更向 `MIGRATIONS` 追加一条，永不修改历史条目。
 */
import { CONFIG_VERSION, REASONING_EFFORT_LEVELS, SETTINGS_READONLY_PREFIXES } from './schema.js'
import {
  DEFAULT_AGENT_TOOLS,
  DEFAULT_CLASSIFICATION,
  DEFAULT_CLASSISLAND_SCHEDULE,
  DEFAULT_IMAGEGEN,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_STT,
  DEFAULT_TTS,
} from './defaults.js'
import type { Logger } from '../utils/logger.js'

export interface Migration {
  from: number
  to: number
  describe: string
  transform(raw: Record<string, unknown>): Record<string, unknown>
}

/** v0（无 version 字段的早期草稿）→ v1 */
const migrateV0ToV1: Migration = {
  from: 0,
  to: 1,
  describe: 'v0 → v1：补齐 version；扁平模式字段归一到 modes.*；llm.apiKey → apiKeyEnc',
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }

    // 旧的扁平模式字段
    const mode = raw['mode']
    if (typeof mode === 'string' && (mode === 'work' || mode === 'code' || mode === 'classroom')) {
      next['modes'] = { ...(asRecord(raw['modes']) ?? {}), current: mode }
      delete next['mode']
    }

    // 旧的扁平 LLM 字段
    const llm = asRecord(raw['llm'])
    if (llm) {
      const apiKey = llm['apiKey']
      if (typeof apiKey === 'string' && apiKey.length > 0) {
        const providers = asRecord(llm['providers']) ?? {}
        providers['deepseek'] = {
          type: 'openai-compat',
          baseUrl: typeof llm['baseUrl'] === 'string' ? llm['baseUrl'] : 'https://api.deepseek.com',
          apiKeyEnc: apiKey,
          model: typeof llm['model'] === 'string' ? llm['model'] : 'deepseek-chat',
          temperature: 0.7,
          ...(asRecord(providers['deepseek']) ?? {}),
        }
        next['llm'] = { ...llm, providers, active: 'deepseek' }
        delete (next['llm'] as Record<string, unknown>)['apiKey']
        delete (next['llm'] as Record<string, unknown>)['baseUrl']
        delete (next['llm'] as Record<string, unknown>)['model']
      }
    }

    next['version'] = 1
    return next
  },
}

/**
 * v1 → v2：为 P4 分类管线与 P5 敏感工具确认补齐配置字段。
 *
 * 只补缺失字段，**不覆盖**用户已写入的值（幂等：重复执行结果一致）。
 */
const migrateV1ToV2: Migration = {
  from: 1,
  to: 2,
  describe: 'v1 → v2：补齐 modes.classroom.classification 与 advanced.confirmSensitiveTools',
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }

    const modes = { ...(asRecord(raw['modes']) ?? {}) }
    const classroom = { ...(asRecord(modes['classroom']) ?? {}) }
    if (asRecord(classroom['classification']) === undefined) {
      classroom['classification'] = { ...DEFAULT_CLASSIFICATION }
    }
    modes['classroom'] = classroom
    next['modes'] = modes

    const advanced = { ...(asRecord(raw['advanced']) ?? {}) }
    if (typeof advanced['confirmSensitiveTools'] !== 'boolean') {
      advanced['confirmSensitiveTools'] = true
    }
    next['advanced'] = advanced

    next['version'] = 2
    return next
  },
}

/**
 * v2 → v3：为 ClassIsland 联动（docs/05 §3.4 v2）补齐 `schedule.classisland`。
 *
 * 只补缺失字段、**不覆盖**用户已写入的值（幂等）。
 */
const migrateV2ToV3: Migration = {
  from: 2,
  to: 3,
  describe: 'v2 → v3：补齐 modes.classroom.schedule.classisland（ClassIsland 桥接数据源）',
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }

    const modes = { ...(asRecord(raw['modes']) ?? {}) }
    const classroom = { ...(asRecord(modes['classroom']) ?? {}) }
    const schedule = { ...(asRecord(classroom['schedule']) ?? {}) }
    if (asRecord(schedule['classisland']) === undefined) {
      schedule['classisland'] = { ...DEFAULT_CLASSISLAND_SCHEDULE }
    }
    classroom['schedule'] = schedule
    modes['classroom'] = classroom
    next['modes'] = modes

    next['version'] = 3
    return next
  },
}

/**
 * v3 → v4：AI 悬浮窗（`service-dock`）已删除，清掉它的窗口几何记录。
 *
 * 只删该 key，**不动**其它字段与其它窗口的几何（幂等）。
 */
const migrateV3ToV4: Migration = {
  from: 3,
  to: 4,
  describe: "v3 → v4：移除 general.windowState['service-dock']（AI 悬浮窗已删除）",
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }
    const general = { ...(asRecord(raw['general']) ?? {}) }
    const windowState = { ...(asRecord(general['windowState']) ?? {}) }
    delete windowState['service-dock']
    general['windowState'] = windowState
    next['general'] = general
    next['version'] = 4
    return next
  },
}

/**
 * v4 → v5：补齐思考等级（`llm.providers.*.reasoningEffort`）与电脑操控工具配置（`agent.tools.*`）。
 *
 * 只补**缺失**字段：用户已写入的 provider 字段、已改过的上限值一个都不动（幂等）。
 * 唯一例外是 `reasoningEffort` —— 它必须是四个合法枚举值之一，非法值（含手改配置文件写错的）
 * 统一回落 `'auto'`，否则会一路活到 `SettingsSchema.parse` 把整份配置判为损坏。
 */
const migrateV4ToV5: Migration = {
  from: 4,
  to: 5,
  describe: 'v4 → v5：补齐 llm.providers.*.reasoningEffort 与 agent.tools.*',
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }

    // providers 里**已有**的条目逐条补 reasoningEffort；
    // 没有 providers 时不凭空造出这个键（保持「空的 llm 迁移后仍是空的」这一既有语义）。
    const llm = asRecord(raw['llm'])
    const providersRaw = asRecord(llm?.['providers'])
    if (llm !== undefined && providersRaw !== undefined) {
      const providers = { ...providersRaw }
      for (const [id, value] of Object.entries(providers)) {
        const provider = asRecord(value)
        if (provider === undefined) continue
        const effort = provider['reasoningEffort']
        if (typeof effort !== 'string' || !isReasoningEffort(effort)) {
          providers[id] = { ...provider, reasoningEffort: DEFAULT_REASONING_EFFORT }
        }
      }
      next['llm'] = { ...llm, providers }
    }

    const agent = { ...(asRecord(raw['agent']) ?? {}) }
    agent['tools'] = fillMissing(
      asRecord(agent['tools']) ?? {},
      DEFAULT_AGENT_TOOLS as unknown as Record<string, unknown>,
    )
    next['agent'] = agent

    next['version'] = 5
    return next
  },
}

function isReasoningEffort(value: string): boolean {
  return (REASONING_EFFORT_LEVELS as readonly string[]).includes(value)
}

/** 用默认值补齐 `target` 缺失的键（递归进嵌套对象）；已存在的值一律保留。 */
function fillMissing(
  target: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target }
  for (const [key, fallback] of Object.entries(defaults)) {
    const current = result[key]
    if (asRecord(fallback) !== undefined) {
      result[key] = fillMissing(asRecord(current) ?? {}, fallback as Record<string, unknown>)
      continue
    }
    if (current === undefined) result[key] = fallback
  }
  return result
}

/**
 * v5 → v6：独立小窗（`mini-chat`）已删除，清掉它的窗口几何记录；同时补上
 * `advanced.readonlyPrefixes`（AI 改配置的路径黑名单，见 `schema.ts`）与
 * `llm.providers.*.modelList`（模型候选列表，见 `schema.ts` / docs/08 §5）。
 *
 * 窗口几何半边：只删该 key，**不动**其它字段与其它窗口的几何（幂等）。
 * 与 v3 → v4 删 `service-dock` 的唯一差别：**只在 `general.windowState` 已存在时改写**，
 * 不给本来没有窗口几何的配置凭空造出一个空对象。
 * `advanced` 半边照 v4 → v5 对 `agent` 的做法**无条件**补默认值（用户已写入的黑名单一个都不动）。
 * `modelList` 半边照 v4 → v5 补 `reasoningEffort` 的做法：**遍历已有 provider、只补缺失键**，
 * 没有 `providers` 时不凭空造出 `llm.providers`（保持「空 llm 迁移后仍为空」这一既有语义）；
 * 唯一例外是非数组的 `modelList`（手改配置写错）统一归零 —— 同 `reasoningEffort` 的非法值回落。
 */
const migrateV5ToV6: Migration = {
  from: 5,
  to: 6,
  describe:
    "v5 → v6：移除 general.windowState['mini-chat']；补齐 llm.providers.*.modelList 与 advanced.readonlyPrefixes",
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }
    const general = asRecord(raw['general'])
    const windowState = asRecord(general?.['windowState'])
    if (general !== undefined && windowState !== undefined) {
      const cleaned = { ...windowState }
      delete cleaned['mini-chat']
      next['general'] = { ...general, windowState: cleaned }
    }

    // providers 里**已有**的条目逐条补 modelList：只补缺失的键（`fillMissing` 已存在的值一律保留），
    // 因此用户/设置页写入的候选列表在重复执行时一个都不动（幂等）。
    const llm = asRecord(raw['llm'])
    const providersRaw = asRecord(llm?.['providers'])
    if (llm !== undefined && providersRaw !== undefined) {
      const providers = { ...providersRaw }
      for (const [id, value] of Object.entries(providers)) {
        const provider = asRecord(value)
        if (provider === undefined) continue
        // 每轮新建 `[]`：不同 provider 之间不共享同一个数组实例
        const filled = fillMissing(provider, { modelList: [] })
        // 非数组（用户手改配置写错）一律归零：`llm.providers.*` 是 `z.record`，
        // `sanitizeWithDefaults` 对这棵子树**不做逐字段回退**，非法值会一路活到
        // `SettingsSchema.parse`，把整份配置判成损坏（备份 + 重建）。
        // v4 → v5 为 `reasoningEffort` 专门做「非法枚举回落 auto」就是同一个理由。
        const list = filled['modelList']
        if (list !== undefined && !Array.isArray(list)) filled['modelList'] = []
        providers[id] = filled
      }
      next['llm'] = { ...llm, providers }
    }

    next['advanced'] = fillMissing(asRecord(raw['advanced']) ?? {}, {
      readonlyPrefixes: [...SETTINGS_READONLY_PREFIXES],
    })

    next['version'] = 6
    return next
  },
}

/**
 * v6 → v7：为语音合成（TTS 朗读）补齐 `tts.*`（docs/06 §13、docs/08 §1）。
 *
 * 照 v4 → v5 对 `agent` 的做法**无条件**补默认值：`fillMissing` 对**已存在**的值一律保留，
 * 所以用户/设置页写过的 `enabled` / `active` / `autoRead` / `maxChars` 与已有 provider 条目
 * 一个都不动，重复执行结果也一致（幂等）。
 * 唯一被补出来的是缺失字段——老配置因此拿到「关闭自动朗读、无 provider」的干净默认态，
 * 不会被凭空打开朗读。
 */
const migrateV6ToV7: Migration = {
  from: 6,
  to: 7,
  describe:
    'v6 → v7：补齐 tts.*（语音合成配置：总开关 / 默认模型 / 自动朗读 / 截断上限 / providers）',
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }

    next['tts'] = fillMissing(
      asRecord(raw['tts']) ?? {},
      DEFAULT_TTS as unknown as Record<string, unknown>,
    )

    next['version'] = 7
    return next
  },
}

/**
 * v7 → v8：补齐语音输入（`stt.*`）、图像生成（`imagegen.*`）、Work 模式工作目录
 * （`modes.work.workspaceDir`）、课前提醒打开文件夹（`modes.classroom.preClassOpenFolder`）
 * 与对话思考过程开关（`general.chat.showThinking`）（Betav2 规格 §4）。
 *
 * 分三种既有套路：
 * - `stt` / `imagegen` 是**新增顶层分组**：照 v6 → v7 对 `tts` 的做法**无条件**补默认值
 *   （`fillMissing` 对已存在的值一律保留，幂等）；
 * - `modes.classroom` / `modes.work` 是**已存在分组里的新字段**：照 v5 → v6 对 `llm.providers`
 *   的做法**只在分组已存在时**补缺失键，不凭空造出半截对象（缺失时由默认配置兜底）；
 * - `general.chat` 是**已存在分组里的新子组**：同样只在 `general` 已存在时补，
 *   保持「缺少 general 分组时迁移不凭空造出 general」的既有语义。
 */
const migrateV7ToV8: Migration = {
  from: 7,
  to: 8,
  describe:
    'v7 → v8：补齐 stt.* 与 imagegen.*（语音输入 / 生图）、modes.work.workspaceDir、modes.classroom.preClassOpenFolder、general.chat.showThinking',
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }

    next['stt'] = fillMissing(
      asRecord(raw['stt']) ?? {},
      DEFAULT_STT as unknown as Record<string, unknown>,
    )
    next['imagegen'] = fillMissing(
      asRecord(raw['imagegen']) ?? {},
      DEFAULT_IMAGEGEN as unknown as Record<string, unknown>,
    )

    const modes = asRecord(raw['modes'])
    if (modes !== undefined) {
      const nextModes = { ...modes }
      const classroom = asRecord(nextModes['classroom'])
      if (classroom !== undefined) {
        nextModes['classroom'] = fillMissing(classroom, { preClassOpenFolder: true })
      }
      const work = asRecord(nextModes['work'])
      if (work !== undefined) {
        nextModes['work'] = fillMissing(work, { workspaceDir: '' })
      }
      next['modes'] = nextModes
    }

    const general = asRecord(raw['general'])
    if (general !== undefined) {
      next['general'] = fillMissing(general, { chat: { showThinking: true } })
    }

    next['version'] = 8
    return next
  },
}

/**
 * v8 → v9：为每个已有 `mcp.servers` 条目补 `headersEnc: {}`（HTTP 传输自定义请求头，
 * docs/08 §1 / docs/06 §7）。
 *
 * 照 v7 → v8 对「已存在分组里的新字段」的口径：**只在 `mcp` 分组已存在时**补，
 * 不凭空造出半截对象（缺失时由默认配置兜底）；`headersEnc` 已存在的条目原样保留（幂等）。
 */
const migrateV8ToV9: Migration = {
  from: 8,
  to: 9,
  describe: 'v8 → v9：为每个已有 mcp.servers 条目补 headersEnc: {}（HTTP 传输自定义请求头）',
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }

    const mcp = asRecord(raw['mcp'])
    const serversRaw = mcp?.['servers']
    if (mcp !== undefined && Array.isArray(serversRaw)) {
      const servers = serversRaw.map((value) => {
        const server = asRecord(value)
        if (server === undefined) return value
        // 每轮新建 `{}`：不同服务器之间不共享同一个对象实例
        if (asRecord(server['headersEnc']) === undefined) {
          return { ...server, headersEnc: {} }
        }
        return server
      })
      next['mcp'] = { ...mcp, servers }
    }

    next['version'] = 9
    return next
  },
}

export const MIGRATIONS: Migration[] = [
  migrateV0ToV1,
  migrateV1ToV2,
  migrateV2ToV3,
  migrateV3ToV4,
  migrateV4ToV5,
  migrateV5ToV6,
  migrateV6ToV7,
  migrateV7ToV8,
  migrateV8ToV9,
]

export interface MigrationOutcome {
  data: Record<string, unknown>
  /** 从哪个版本开始迁移 */
  fromVersion: number
  applied: string[]
  warnings: string[]
}

export function readVersion(raw: Record<string, unknown>): number {
  const version = raw['version']
  if (typeof version === 'number' && Number.isInteger(version) && version >= 0) return version
  return 0
}

export function migrate(
  raw: Record<string, unknown>,
  logger?: Logger,
  targetVersion: number = CONFIG_VERSION,
): MigrationOutcome {
  const warnings: string[] = []
  const applied: string[] = []
  const fromVersion = readVersion(raw)

  if (fromVersion > targetVersion) {
    warnings.push(
      `配置版本 ${fromVersion} 高于当前程序支持的 ${targetVersion}，已按当前版本读取（可能丢失新字段）`,
    )
    logger?.warn('配置版本高于程序支持版本', { fromVersion, targetVersion })
    return { data: raw, fromVersion, applied, warnings }
  }

  let data = raw
  let version = fromVersion
  let guard = 0

  while (version < targetVersion) {
    const step = MIGRATIONS.find((m) => m.from === version)
    if (!step) {
      warnings.push(`缺少 v${version} → v${targetVersion} 的迁移规则，已按默认值重建缺失字段`)
      logger?.warn('缺少迁移规则', { version, targetVersion })
      break
    }
    try {
      data = step.transform(data)
      applied.push(`v${step.from} → v${step.to}：${step.describe}`)
      logger?.info('已执行配置迁移', { describe: step.describe })
    } catch (error) {
      warnings.push(`迁移 v${step.from} → v${step.to} 失败：${String(error)}`)
      logger?.error('配置迁移失败', { error: String(error) })
      break
    }
    version = step.to
    if (++guard > MIGRATIONS.length + 1) break
  }

  data['version'] = targetVersion
  return { data, fromVersion, applied, warnings }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
