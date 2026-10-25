/**
 * Aurora Center 插件市场存储（docs/14 §4、docs/12）。
 *
 * 上传的 `.aurora-plugin`（zip）先落 staging：解压、校验清单与包内路径、
 * 计算 sha256；**publish 才原子切换 index 并归档到 files/<id>/<version>**。
 *
 * 与桌面安装器共用 `@aurora/shared` 的清单 schema，因此市场不会出现第二套契约。
 * v1 无签名：sha256 只保证完整性，不保证发布者身份。
 */
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import {
  compareVersions,
  normalizePluginPath,
  parsePluginManifest,
  type Logger,
  type PluginManifest,
  type PluginMarketEntry,
  type PluginMarketVersionInfo,
} from '@aurora/shared'
import { JsonStore } from './store.js'

export interface CenterPluginRecord {
  id: string
  name: string
  summary: string
  author: string
  license?: string
  homepage?: string
  /** 图标文件名（`icons/<id>.png`）；无图标时缺省 */
  icon?: string
  latestVersion: string
  updatedAt: string
  downloads: number
  versions: PluginMarketVersionInfo[]
}

export interface PluginIndex {
  version: 1
  plugins: Record<string, CenterPluginRecord>
}

export interface PluginArchiveInspection {
  manifest: PluginManifest
  sha256: string
  size: number
  /** 包内文件（相对路径，`/` 分隔） */
  files: string[]
}

export interface PluginStoreOptions {
  dataDir: string
  logger?: Logger
  /** 单次上传 zip 上限（字节） */
  maxZipBytes?: number
}

const MAX_ZIP_BYTES = 20 * 1024 * 1024
const MAX_ENTRIES = 2000
const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_TOTAL_BYTES = 50 * 1024 * 1024
const MAX_RATIO = 200
const MAX_STAGED = 20

/** 页面型面板资产：只发白名单内的类型（SVG 可带脚本，刻意不放行） */
const ASSET_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

/** 解压后的版本缓存：最多 4 个版本 / 64 MB（内存有界，未命中再读 zip） */
const ASSET_CACHE_VERSIONS = 4
const ASSET_CACHE_BYTES = 64 * 1024 * 1024

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex')
}

function zipPathProblem(name: string): string | null {
  const normalized = name.replace(/\\/g, '/')
  if (normalized.includes('\0')) return '路径包含 NUL'
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('//')) {
    return `不允许的绝对路径：${name}`
  }
  if (normalized.split('/').some((segment) => segment === '..')) {
    return `不允许的上级路径：${name}`
  }
  return null
}

/**
 * 解压 + 校验一个插件包（不落盘）。
 * 所有错误都是**可操作**的一句话（CLI / 管理页直接展示）。
 */
export function inspectPluginArchive(body: Buffer): PluginArchiveInspection {
  if (body.byteLength > MAX_ZIP_BYTES) throw new Error('插件包超过 20 MB 上限')
  if (body.byteLength === 0) throw new Error('插件包为空')

  let total = 0
  let entries = 0
  const issues: string[] = []
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(body), {
      filter: (file) => {
        entries += 1
        if (entries > MAX_ENTRIES) {
          issues.push(`压缩包条目超过 ${MAX_ENTRIES} 个`)
          return false
        }
        const problem = zipPathProblem(file.name)
        if (problem !== null) {
          issues.push(problem)
          return false
        }
        total += file.originalSize
        if (file.originalSize > MAX_FILE_BYTES) {
          issues.push(`单文件超过 10 MB：${file.name}`)
          return false
        }
        if (total > MAX_TOTAL_BYTES) {
          issues.push('解压总量超过 50 MB')
          return false
        }
        if (
          file.originalSize > 1024 * 1024 &&
          file.size > 0 &&
          file.originalSize / file.size > MAX_RATIO
        ) {
          issues.push(`压缩比异常（>${MAX_RATIO}:1）：${file.name}`)
          return false
        }
        return true
      },
    })
  } catch (error) {
    throw new Error(`不是合法的 zip：${String(error)}`)
  }
  if (issues.length > 0) throw new Error(issues[0] ?? '插件包校验失败')

  const names = Object.keys(files).filter((name) => !name.endsWith('/'))
  const nameSet = new Set(names)
  if (!nameSet.has('manifest.json')) throw new Error('清单必须位于插件包根目录（manifest.json）')
  for (const name of names) {
    if (name.toLowerCase().endsWith('manifest.json') && name !== 'manifest.json') {
      throw new Error('只允许根目录一个 manifest.json')
    }
  }

  const manifestBytes = files['manifest.json']
  if (manifestBytes === undefined) throw new Error('缺少 manifest.json')
  if (manifestBytes.byteLength > 64 * 1024) throw new Error('manifest.json 超过 64 KB')
  let json: unknown
  try {
    json = JSON.parse(Buffer.from(manifestBytes).toString('utf8'))
  } catch (error) {
    throw new Error(`manifest.json 不是合法 JSON：${String(error)}`)
  }
  const parsed = parsePluginManifest(json)
  if (!parsed.ok || parsed.manifest === undefined) {
    throw new Error(`清单校验失败：${parsed.errors.slice(0, 3).join('；')}`)
  }
  const manifest = parsed.manifest

  const requireFile = (relative: string, label: string): void => {
    const normalized = normalizePluginPath(relative)
    if (normalized === null || !nameSet.has(normalized)) {
      throw new Error(`${label} 不存在：${relative}`)
    }
  }
  requireFile(manifest.main, 'main 入口')
  for (const skill of manifest.contributes.skills) {
    const normalized = normalizePluginPath(skill)
    if (normalized === null || !nameSet.has(`${normalized}/SKILL.md`)) {
      throw new Error(`Skill 目录缺少 SKILL.md：${skill}`)
    }
  }
  for (const panel of manifest.contributes.panels) {
    const file = panel.schema ?? panel.entry
    if (file !== undefined) requireFile(file, `面板「${panel.id}」文件`)
  }
  if (manifest.icon !== undefined) requireFile(manifest.icon, '图标')

  return {
    manifest,
    sha256: sha256(body),
    size: body.byteLength,
    files: names.sort(),
  }
}

export class PluginStore {
  private readonly root: string
  private readonly filesRoot: string
  private readonly iconsRoot: string
  private readonly stagingRoot: string
  private readonly indexStore: JsonStore<PluginIndex>
  private readonly maxZipBytes: number
  private readonly logger?: Logger
  private index: PluginIndex = { version: 1, plugins: {} }
  /** 版本解压缓存（LRU）：`<id>@<version>` → 包内文件表 */
  private readonly assetCache = new Map<string, { files: Map<string, Uint8Array>; bytes: number }>()
  private assetCacheBytes = 0

  constructor(options: PluginStoreOptions) {
    this.root = join(options.dataDir, 'plugins')
    this.filesRoot = join(this.root, 'files')
    this.iconsRoot = join(this.root, 'icons')
    this.stagingRoot = join(this.root, '.staging')
    this.maxZipBytes = options.maxZipBytes ?? MAX_ZIP_BYTES
    this.logger = options.logger
    this.indexStore = new JsonStore<PluginIndex>(
      join(this.root, 'index.json'),
      () => ({ version: 1, plugins: {} }),
      options.logger,
    )
  }

  async init(): Promise<void> {
    await fs.mkdir(this.filesRoot, { recursive: true })
    await fs.mkdir(this.iconsRoot, { recursive: true })
    await fs.mkdir(this.stagingRoot, { recursive: true })
    this.index = await this.indexStore.load()
  }

  list(query: { q?: string; page?: number; limit?: number; sort?: 'updated' | 'downloads' }): {
    total: number
    entries: PluginMarketEntry[]
  } {
    const needle = (query.q ?? '').trim().toLowerCase()
    const all = Object.values(this.index.plugins)
      .filter((record) => {
        if (needle === '') return true
        return (
          record.id.toLowerCase().includes(needle) ||
          record.name.toLowerCase().includes(needle) ||
          record.summary.toLowerCase().includes(needle) ||
          record.author.toLowerCase().includes(needle)
        )
      })
      .sort((a, b) =>
        query.sort === 'downloads'
          ? b.downloads - a.downloads
          : b.updatedAt.localeCompare(a.updatedAt),
      )
    const limit = Math.min(50, Math.max(1, Math.floor(query.limit ?? 20)))
    const page = Math.max(1, Math.floor(query.page ?? 1))
    const start = (page - 1) * limit
    return {
      total: all.length,
      entries: all.slice(start, start + limit).map((record) => this.toMarketEntry(record)),
    }
  }

  get(id: string): PluginMarketEntry | undefined {
    const record = this.index.plugins[id]
    return record === undefined ? undefined : this.toMarketEntry(record)
  }

  private toMarketEntry(record: CenterPluginRecord): PluginMarketEntry {
    return {
      id: record.id,
      name: record.name,
      summary: record.summary,
      author: record.author,
      ...(record.license === undefined ? {} : { license: record.license }),
      ...(record.homepage === undefined ? {} : { homepage: record.homepage }),
      ...(record.icon === undefined ? {} : { iconUrl: `/api/plugins/${record.id}/icon` }),
      latestVersion: record.latestVersion,
      updatedAt: record.updatedAt,
      downloads: record.downloads,
      versions: structuredClone(record.versions),
    }
  }

  /** 把上传的 zip 落到 staging，返回 token 与解析出的清单（publish 才进 index）。 */
  async stage(body: Buffer): Promise<{ token: string; inspection: PluginArchiveInspection }> {
    if (body.byteLength > this.maxZipBytes) throw new Error('插件包超过 20 MB 上限')
    const inspection = inspectPluginArchive(body)
    await fs.mkdir(this.stagingRoot, { recursive: true })
    const existing = await fs.readdir(this.stagingRoot).catch(() => [] as string[])
    if (existing.length >= MAX_STAGED) {
      throw new Error('暂存区已满，请先发布或清理未完成的上传')
    }
    const token = `${Date.now()}-${randomBytes(6).toString('hex')}.zip`
    await fs.writeFile(join(this.stagingRoot, token), body)
    return { token, inspection }
  }

  /** 发布 staging 里的包：归档 + 更新 index（同版本不允许覆盖）。 */
  async publish(token: string, changelog?: string): Promise<PluginMarketEntry> {
    if (!/^[\w.-]+\.zip$/.test(token)) throw new Error('暂存 token 非法')
    const stagedPath = join(this.stagingRoot, token)
    let body: Buffer
    try {
      body = await fs.readFile(stagedPath)
    } catch {
      throw new Error('暂存包不存在或已过期，请重新上传')
    }
    const inspection = inspectPluginArchive(body)
    const manifest = inspection.manifest

    const record = this.index.plugins[manifest.id]
    if (record?.versions.some((item) => item.version === manifest.version)) {
      throw new Error(`版本 ${manifest.version} 已发布，不能覆盖（请升版本号）`)
    }

    const versionDir = join(this.filesRoot, manifest.id, manifest.version)
    await fs.mkdir(versionDir, { recursive: true })
    const fileName = `${manifest.id}-${manifest.version}.aurora-plugin`
    await fs.rename(stagedPath, join(versionDir, fileName)).catch(async () => {
      await fs.copyFile(stagedPath, join(versionDir, fileName))
      await fs.rm(stagedPath, { force: true })
    })

    const versionInfo: PluginMarketVersionInfo = {
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      ...(manifest.minAuroraVersion === undefined
        ? {}
        : { minAuroraVersion: manifest.minAuroraVersion }),
      sha256: inspection.sha256,
      size: inspection.size,
      publishedAt: new Date().toISOString(),
      ...(changelog === undefined || changelog.trim() === ''
        ? {}
        : { changelog: changelog.trim().slice(0, 4000) }),
    }
    const latest =
      record === undefined || compareVersions(manifest.version, record.latestVersion) > 0
        ? manifest.version
        : record.latestVersion
    this.index.plugins[manifest.id] = {
      id: manifest.id,
      name: manifest.name,
      summary: manifest.description,
      author: manifest.author.name,
      ...(manifest.license === undefined ? {} : { license: manifest.license }),
      ...(manifest.homepage === undefined ? {} : { homepage: manifest.homepage }),
      ...(record?.icon === undefined ? {} : { icon: record.icon }),
      latestVersion: latest,
      updatedAt: versionInfo.publishedAt,
      downloads: record?.downloads ?? 0,
      versions: [versionInfo, ...(record?.versions ?? [])].sort((a, b) =>
        compareVersions(b.version, a.version),
      ),
    }
    await this.indexStore.save(this.index)
    this.logger?.info('插件版本已发布', {
      pluginId: manifest.id,
      version: manifest.version,
      sha256: inspection.sha256,
    })
    return this.toMarketEntry(this.index.plugins[manifest.id]!)
  }

  /** 下载 / 回滚用的归档路径与元数据。 */
  assetOf(
    id: string,
    version?: string,
  ): { path: string; fileName: string; sha256: string } | undefined {
    const record = this.index.plugins[id]
    if (record === undefined) return undefined
    const targetVersion = version === undefined || version === '' ? record.latestVersion : version
    const info = record.versions.find((item) => item.version === targetVersion)
    if (info === undefined) return undefined
    return {
      path: join(this.filesRoot, id, targetVersion, `${id}-${targetVersion}.aurora-plugin`),
      fileName: `${id}-${targetVersion}.aurora-plugin`,
      sha256: info.sha256,
    }
  }

  /**
   * 读页面型面板的包内文件（`/p/<id>/<version>/<path>` 的实现在这里）。
   *
   * 版本必须在 index 里（未发布 / 已删除的版本一律 404）；路径逐段规范化挡穿越；
   * 只有 MIME 白名单内的扩展名会返回。解压结果按版本 LRU 缓存（≤4 版本 / 64 MB）。
   */
  async readAsset(
    id: string,
    version: string,
    relativePath: string,
  ): Promise<{ body: Buffer; mime: string; immutable: boolean } | undefined> {
    const normalized = normalizePluginPath(relativePath)
    if (normalized === null) return undefined
    const mime = ASSET_MIME[extensionOf(normalized)]
    if (mime === undefined) return undefined
    const asset = this.assetOf(id, version)
    if (asset === undefined) return undefined

    const key = `${id}@${version}`
    let entry = this.assetCache.get(key)
    if (entry === undefined) {
      let zip: Buffer
      try {
        zip = await fs.readFile(asset.path)
      } catch {
        return undefined
      }
      let unpacked: Record<string, Uint8Array>
      try {
        unpacked = unzipSync(new Uint8Array(zip))
      } catch {
        this.logger?.warn('插件包解压失败（页面型面板）', { pluginId: id, version })
        return undefined
      }
      const files = new Map<string, Uint8Array>()
      let bytes = 0
      for (const [name, data] of Object.entries(unpacked)) {
        if (name.endsWith('/')) continue
        const clean = normalizePluginPath(name)
        if (clean === null) continue
        files.set(clean, data)
        bytes += data.byteLength
      }
      entry = { files, bytes }
      this.evictAssetCache(bytes)
      this.assetCache.set(key, entry)
      this.assetCacheBytes += bytes
    } else {
      // 命中即刷新 LRU 位置（Map 插入序 = 使用序）
      this.assetCache.delete(key)
      this.assetCache.set(key, entry)
    }

    const file = entry.files.get(normalized)
    if (file === undefined) return undefined
    return { body: Buffer.from(file), mime, immutable: extensionOf(normalized) !== '.html' }
  }

  private evictAssetCache(incomingBytes: number): void {
    while (
      this.assetCache.size >= ASSET_CACHE_VERSIONS ||
      (this.assetCacheBytes + incomingBytes > ASSET_CACHE_BYTES && this.assetCache.size > 0)
    ) {
      const oldest = this.assetCache.keys().next()
      if (oldest.done === true) break
      const cached = this.assetCache.get(oldest.value)
      this.assetCache.delete(oldest.value)
      this.assetCacheBytes -= cached?.bytes ?? 0
    }
  }

  private dropAssetCache(id: string, version: string): void {
    const key = `${id}@${version}`
    const cached = this.assetCache.get(key)
    if (cached === undefined) return
    this.assetCache.delete(key)
    this.assetCacheBytes -= cached.bytes
  }

  async remove(id: string, version: string): Promise<boolean> {
    const record = this.index.plugins[id]
    if (record === undefined) return false
    const index = record.versions.findIndex((item) => item.version === version)
    if (index === -1) return false
    record.versions.splice(index, 1)
    this.dropAssetCache(id, version)
    await fs
      .rm(join(this.filesRoot, id, version), { recursive: true, force: true })
      .catch(() => undefined)
    if (record.versions.length === 0) {
      delete this.index.plugins[id]
      await fs.rm(join(this.iconsRoot, `${id}.png`), { force: true }).catch(() => undefined)
    } else {
      record.latestVersion = record.versions[0]!.version
      record.updatedAt = new Date().toISOString()
    }
    await this.indexStore.save(this.index)
    return true
  }

  /** 图标：只收 PNG（≤256 KB），写 `icons/<id>.png`。 */
  async setIcon(id: string, body: Buffer): Promise<void> {
    if (this.index.plugins[id] === undefined) throw new Error('插件不存在')
    if (body.byteLength > 256 * 1024) throw new Error('图标超过 256 KB')
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    if (body.byteLength < 8 || !body.subarray(0, 8).equals(png)) {
      throw new Error('图标必须是 PNG')
    }
    await fs.mkdir(this.iconsRoot, { recursive: true })
    await fs.writeFile(join(this.iconsRoot, `${id}.png`), body)
    this.index.plugins[id]!.icon = `${id}.png`
    await this.indexStore.save(this.index)
  }

  iconPathOf(id: string): string | undefined {
    const record = this.index.plugins[id]
    if (record?.icon === undefined) return undefined
    return join(this.iconsRoot, record.icon)
  }

  /** 公开下载计数（每次下载 +1；失败不影响下载本身）。 */
  async recordDownload(id: string): Promise<void> {
    const record = this.index.plugins[id]
    if (record === undefined) return
    record.downloads += 1
    await this.indexStore.save(this.index).catch(() => undefined)
  }
}
