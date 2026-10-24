/**
 * 插件安装态 registry（`<userData>/plugins/registry.json`，docs/14 §5）。
 *
 * **不进 settings**：安装 / 启用 / 信任是用户授权状态，与配置迁移链解耦；
 * `settings.plugins` 只有总开关、开发目录与当前主题三个字段。
 */
import type { PluginSource } from '@aurora/shared'
import type { Logger } from '@aurora/shared'
import { readJsonFile, writeJsonAtomic } from './fs-json.js'

export interface InstalledPluginRecord {
  id: string
  enabled: boolean
  trusted: boolean
  source: Exclude<PluginSource, 'dev'>
  activeVersion: string
  previousVersion?: string
  installPath: string
  checksum?: string
  installedAt: string
  updatedAt: string
  lastError?: string
}

export interface PluginRegistryFile {
  version: 1
  plugins: Record<string, InstalledPluginRecord>
}

const EMPTY: PluginRegistryFile = { version: 1, plugins: {} }

export class PluginRegistryStore {
  private readonly file: string
  private readonly logger: Logger

  constructor(file: string, logger: Logger) {
    this.file = file
    this.logger = logger
  }

  async load(): Promise<Record<string, InstalledPluginRecord>> {
    const raw = await readJsonFile<PluginRegistryFile>(this.file, EMPTY)
    if (raw.version !== 1 || typeof raw.plugins !== 'object' || raw.plugins === null) {
      this.logger.warn('插件 registry 形状异常，按空表处理', { file: this.file })
      return {}
    }
    const records: Record<string, InstalledPluginRecord> = {}
    for (const [id, value] of Object.entries(raw.plugins)) {
      if (typeof value !== 'object' || value === null) continue
      const record = value as Partial<InstalledPluginRecord>
      if (record.id !== id || typeof record.installPath !== 'string') continue
      records[id] = {
        id,
        enabled: record.enabled !== false,
        trusted: record.trusted === true,
        source: record.source === 'marketplace' ? 'marketplace' : 'local',
        activeVersion: typeof record.activeVersion === 'string' ? record.activeVersion : '0.0.0',
        ...(typeof record.previousVersion === 'string'
          ? { previousVersion: record.previousVersion }
          : {}),
        installPath: record.installPath,
        ...(typeof record.checksum === 'string' ? { checksum: record.checksum } : {}),
        installedAt: typeof record.installedAt === 'string' ? record.installedAt : '',
        updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
        ...(typeof record.lastError === 'string' ? { lastError: record.lastError } : {}),
      }
    }
    return records
  }

  async save(plugins: Record<string, InstalledPluginRecord>): Promise<void> {
    const payload: PluginRegistryFile = { version: 1, plugins }
    await writeJsonAtomic(this.file, payload)
  }
}
