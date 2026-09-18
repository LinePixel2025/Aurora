/**
 * 配置版本迁移链（docs/08 §2「version 字段 + migrations 链式执行」）。
 *
 * 约定：每次 Schema 破坏性变更向 `MIGRATIONS` 追加一条，永不修改历史条目。
 */
import { CONFIG_VERSION } from './schema.js'
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

export const MIGRATIONS: Migration[] = [migrateV0ToV1]

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
