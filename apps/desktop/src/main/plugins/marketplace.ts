/**
 * 桌面端插件市场客户端（docs/14 §4，P4）。
 *
 * 只做三件事：拉 Center 的公开插件列表、下载并校验 sha256 后交给安装器、检查更新。
 * 出网走注入的 `fetchImpl`（生产 = `main/net.ts` 的 `netFetch`，受代理设置约束）；
 * 下载与安装的信任边界仍由 `PluginManager` 负责（安装即信任，见 docs/14 §6）。
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  Logger,
  PluginMarketEntry,
  PluginMarketplaceListResult,
  PluginSummary,
  PluginUpdateInfo,
} from '@aurora/shared'
import { compareVersions } from '@aurora/shared'
import { httpBaseUrlOf } from '../center/client-login.js'
import type { PluginManager } from './manager.js'

export interface PluginMarketplaceOptions {
  manager: PluginManager
  /** 当前 Center 配置（未启用 / 未配置地址时列表返回明确空态） */
  getCenter: () => { enabled: boolean; serverUrl: string; token: string }
  fetchImpl: () => typeof fetch | undefined
  logger?: Logger
  /** 列表缓存（默认 60 秒；`refresh` 强制绕过） */
  cacheTtlMs?: number
  /** 下载超时（默认 60 秒） */
  downloadTimeoutMs?: number
}

const DEFAULT_CACHE_TTL_MS = 60_000
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

export class PluginMarketplaceClient {
  private readonly options: PluginMarketplaceOptions
  private cache: { at: number; base: string; result: PluginMarketplaceListResult } | undefined

  constructor(options: PluginMarketplaceOptions) {
    this.options = options
  }

  /** 当前 Center 的 http 基址；未配置 / 非 http(s) 时返回原因。 */
  private endpoint(): { base: string } | { error: string } {
    const center = this.options.getCenter()
    if (!center.enabled) return { error: 'Aurora Center 未启用' }
    if (center.serverUrl.trim() === '') return { error: '尚未配置 Aurora Center 服务器地址' }
    const base = httpBaseUrlOf(center.serverUrl)
    if (base === undefined) return { error: `无法解析 Center 地址：${center.serverUrl}` }
    return { base: base.replace(/\/+$/, '') }
  }

  async list(refresh = false): Promise<PluginMarketplaceListResult> {
    const endpoint = this.endpoint()
    if ('error' in endpoint) {
      return { serverUrl: this.options.getCenter().serverUrl, entries: [], error: endpoint.error }
    }
    const ttl = this.options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    if (
      !refresh &&
      this.cache !== undefined &&
      this.cache.base === endpoint.base &&
      Date.now() - this.cache.at < ttl
    ) {
      return this.annotate(this.cache.result)
    }
    const fetchImpl = this.options.fetchImpl()
    if (fetchImpl === undefined) {
      return { serverUrl: endpoint.base, entries: [], error: '网络不可用' }
    }
    try {
      const response = await fetchImpl(`${endpoint.base}/api/plugins?limit=50&sort=updated`, {
        headers: this.authHeaders(),
      })
      const body = (await response.json().catch(() => ({}))) as {
        entries?: PluginMarketEntry[]
        error?: string
      }
      if (!response.ok) {
        throw new Error(body.error ?? `HTTP ${response.status}`)
      }
      const result: PluginMarketplaceListResult = {
        serverUrl: endpoint.base,
        entries: Array.isArray(body.entries) ? body.entries : [],
      }
      this.cache = { at: Date.now(), base: endpoint.base, result }
      return this.annotate(result)
    } catch (error) {
      this.options.logger?.warn('读取插件市场失败', { error: String(error) })
      return {
        serverUrl: endpoint.base,
        entries: [],
        error: `读取插件市场失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  private authHeaders(): Record<string, string> {
    const token = this.options.getCenter().token
    return token === '' ? {} : { Authorization: `Bearer ${token}` }
  }

  /** 标注本机已安装版本与是否有更新（每次返回都现读，避免缓存里的旧安装态）。 */
  private annotate(result: PluginMarketplaceListResult): PluginMarketplaceListResult {
    const installed = new Map(
      this.options.manager.updateCandidates().map((item) => [item.pluginId, item.currentVersion]),
    )
    return {
      ...result,
      entries: result.entries.map((entry) => {
        const current = installed.get(entry.id)
        return {
          ...entry,
          ...(current === undefined ? {} : { installedVersion: current }),
          ...(current === undefined
            ? {}
            : { updateAvailable: compareVersions(entry.latestVersion, current) > 0 }),
        }
      }),
    }
  }

  /**
   * 下载指定版本 → 校验 sha256 → 交给 `PluginManager.install`（kind = marketplace）。
   * 校验和不匹配时**不落盘任何安装状态**。
   */
  async install(pluginId: string, version?: string): Promise<PluginSummary> {
    const endpoint = this.endpoint()
    if ('error' in endpoint) throw new Error(endpoint.error)
    const list = await this.list()
    if (list.error !== undefined) throw new Error(list.error)
    const entry = list.entries.find((item) => item.id === pluginId)
    if (entry === undefined) throw new Error(`市场里没有插件 ${pluginId}`)
    const targetVersion = version === undefined || version === '' ? entry.latestVersion : version
    const info = entry.versions.find((item) => item.version === targetVersion)
    if (info === undefined) throw new Error(`市场里没有版本 ${pluginId}@${targetVersion}`)

    const fetchImpl = this.options.fetchImpl()
    if (fetchImpl === undefined) throw new Error('网络不可用')
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
    )
    let buffer: Buffer
    try {
      const response = await fetchImpl(
        `${endpoint.base}/api/plugins/${encodeURIComponent(pluginId)}/download?version=${encodeURIComponent(targetVersion)}`,
        { headers: this.authHeaders(), signal: controller.signal },
      )
      if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
      buffer = Buffer.from(await response.arrayBuffer())
    } finally {
      clearTimeout(timeout)
    }
    if (buffer.byteLength !== info.size) {
      throw new Error(`下载大小不一致（期望 ${info.size}，实际 ${buffer.byteLength}）`)
    }
    const actual = sha256(buffer)
    if (actual !== info.sha256) {
      throw new Error('下载内容校验失败（SHA-256 不匹配），已拒绝安装')
    }

    const tempPath = join(
      tmpdir(),
      `aurora-market-${pluginId.replace(/[^a-z0-9.-]/gi, '_')}-${targetVersion}.aurora-plugin`,
    )
    await fs.writeFile(tempPath, buffer)
    try {
      this.options.logger?.info('从市场安装插件', { pluginId, version: targetVersion })
      const summary = await this.options.manager.install({
        kind: 'marketplace',
        path: tempPath,
        pluginId,
        version: targetVersion,
      })
      this.cache = undefined
      return summary
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => undefined)
    }
  }

  /** 检查已安装插件是否有新版本（只返回有更新的条目）。 */
  async checkUpdates(): Promise<PluginUpdateInfo[]> {
    const list = await this.list(true)
    if (list.error !== undefined) throw new Error(list.error)
    const result: PluginUpdateInfo[] = []
    for (const entry of list.entries) {
      if (entry.installedVersion === undefined || entry.updateAvailable !== true) continue
      result.push({
        pluginId: entry.id,
        name: entry.name,
        currentVersion: entry.installedVersion,
        latestVersion: entry.latestVersion,
        sha256: entry.versions.find((item) => item.version === entry.latestVersion)?.sha256 ?? '',
      })
    }
    return result
  }
}
