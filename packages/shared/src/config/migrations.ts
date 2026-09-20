/**
 * 配置版本迁移链（docs/08 §2「version 字段 + migrations 链式执行」）。
 *
 * 约定：每次 Schema 破坏性变更向 `MIGRATIONS` 追加一条，永不修改历史条目。
 */
import { CONFIG_VERSION, REASONING_EFFORT_LEVELS } from './schema.js'
import {
  DEFAULT_AGENT_TOOLS,
  DEFAULT_CLASSIFICATION,
  DEFAULT_CLASSISLAND_SCHEDULE,
  DEFAULT_REASONING_EFFORT,
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

export const MIGRATIONS: Migration[] = [
  migrateV0ToV1,
  migrateV1ToV2,
  migrateV2ToV3,
  migrateV3ToV4,
  migrateV4ToV5,
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
