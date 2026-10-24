/**
 * 插件包安装（docs/14 §4）：zip / 文件夹 → staging → 校验 → `versions/<version>`。
 *
 * 安全边界（安装期能做的全部）：
 * - 逐条目拒绝绝对路径 / 盘符 / UNC / `..` / NUL（先经 `normalizePluginPath` 归一化）；
 * - 条目数 ≤ 2000、单文件 ≤ 10 MB、解压总量 ≤ 50 MB、压缩比 > 200:1 拒绝；
 * - 解压后每个条目 `lstat`，符号链接一律拒绝；
 * - **绝不原地覆盖**当前版本：新版本落到独立目录，由 manager 停进程后再切换。
 *
 * 说明：SHA-256 只保证完整性，不保证发布者身份（v1 无签名，docs/14 §2.5）。
 */
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { unzipSync } from 'fflate'
import {
  normalizePluginPath,
  pluginToolName,
  type Logger,
  type PluginInstallPreview,
  type PluginManifest,
  type PluginPackageRef,
  type PluginPermission,
} from '@aurora/shared'
import type { InstalledPluginRecord } from './registry.js'
import { readPluginManifest, type LoadedPlugin } from './manifest-load.js'

export const PLUGIN_PACKAGE_LIMITS = {
  maxEntries: 2000,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
  maxCompressionRatio: 200,
} as const

export interface PluginInstallPaths {
  /** `<userData>/plugins` */
  plugins: string
  /** `<userData>/plugin-data` */
  data: string
}

export interface PluginInstallOptions {
  hostVersion: string
  logger: Logger
  /** 已安装记录（用于 `replaces` 与命令冲突检查） */
  installed: Record<string, InstalledPluginRecord>
  /** 需要一起查命令冲突的其他插件清单（含 dev 插件） */
  otherManifests?: Array<{ id: string; manifest: PluginManifest }>
}

export interface StagedPackage {
  /** staging 根（提交或清理） */
  stagingDir: string
  plugin: LoadedPlugin
  checksum: string
  sizeBytes: number
  sourcePath: string
}

export interface CommittedPackage {
  record: InstalledPluginRecord
  plugin: LoadedPlugin
}

export class PluginInstallError extends Error {
  readonly errors: string[]

  constructor(message: string, errors: string[] = []) {
    super(message)
    this.name = 'PluginInstallError'
    this.errors = errors.length > 0 ? errors : [message]
  }
}

function isZipPath(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.aurora-plugin') || lower.endsWith('.zip')
}

async function pathKind(path: string): Promise<'file' | 'dir' | 'missing'> {
  try {
    const stat = await fs.stat(path)
    return stat.isDirectory() ? 'dir' : 'file'
  } catch {
    return 'missing'
  }
}

async function removeTree(path: string): Promise<void> {
  await fs.rm(path, { recursive: true, force: true })
}

/** 目录指纹（文件夹安装没有压缩包可算 SHA-256，用排序后的路径 + 内容算一个等价校验和）。 */
async function hashDirectory(root: string): Promise<string> {
  const hash = createHash('sha256')
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const absolute = join(dir, entry.name)
      const rel = relative(root, absolute).replace(/\\/g, '/')
      if (entry.isSymbolicLink()) throw new PluginInstallError(`插件包含符号链接：${rel}`)
      if (entry.isDirectory()) {
        hash.update(`d:${rel}\0`)
        await walk(absolute)
      } else if (entry.isFile()) {
        hash.update(`f:${rel}\0`)
        hash.update(await fs.readFile(absolute))
      }
    }
  }
  await walk(root)
  return hash.digest('hex')
}

/** 从 zip 解到 staging（带全部安装期限制）。返回解压字节数。 */
async function extractZip(buffer: Buffer, stagingDir: string): Promise<number> {
  const errors: string[] = []
  let entries = 0
  let total = 0

  const collected = unzipSync(buffer, {
    filter: (file) => {
      entries += 1
      if (entries > PLUGIN_PACKAGE_LIMITS.maxEntries) {
        errors.push(`压缩包条目超过 ${PLUGIN_PACKAGE_LIMITS.maxEntries} 个`)
        return false
      }
      const normalized = normalizePluginPath(file.name)
      if (normalized === null) {
        errors.push(`压缩包含非法路径：${file.name}`)
        return false
      }
      if (file.originalSize > PLUGIN_PACKAGE_LIMITS.maxFileBytes) {
        errors.push(`文件超过 10 MB：${file.name}`)
        return false
      }
      total += file.originalSize
      if (total > PLUGIN_PACKAGE_LIMITS.maxTotalBytes) {
        errors.push('解压总量超过 50 MB')
        return false
      }
      if (
        file.size > 0 &&
        file.originalSize > file.size * PLUGIN_PACKAGE_LIMITS.maxCompressionRatio
      ) {
        errors.push(`压缩比异常（疑似 zip bomb）：${file.name}`)
        return false
      }
      return true
    },
  })

  if (errors.length > 0) throw new PluginInstallError('插件包安全检查未通过', errors)

  const writes: Array<Promise<void>> = []
  for (const [name, data] of Object.entries(collected)) {
    if (name.endsWith('/')) continue
    const normalized = normalizePluginPath(name)
    if (normalized === null) continue
    const target = join(stagingDir, normalized)
    const rel = relative(stagingDir, target)
    if (rel.startsWith('..') || rel === '') {
      throw new PluginInstallError(`插件包路径越界：${name}`)
    }
    writes.push(
      (async () => {
        await fs.mkdir(dirname(target), { recursive: true })
        await fs.writeFile(target, data)
      })(),
    )
  }
  await Promise.all(writes)
  return total
}

/** 文件夹安装：逐项复制并执行与 zip 相同的限制。 */
async function copyDirectory(source: string, target: string): Promise<void> {
  let entries = 0
  let total = 0
  const walk = async (from: string, to: string): Promise<void> => {
    const children = await fs.readdir(from, { withFileTypes: true })
    for (const child of children) {
      entries += 1
      if (entries > PLUGIN_PACKAGE_LIMITS.maxEntries) {
        throw new PluginInstallError(`目录条目超过 ${PLUGIN_PACKAGE_LIMITS.maxEntries} 个`)
      }
      const absolute = join(from, child.name)
      const destination = join(to, child.name)
      if (child.isSymbolicLink()) {
        throw new PluginInstallError(`插件目录含符号链接：${child.name}`)
      }
      if (child.isDirectory()) {
        await fs.mkdir(destination, { recursive: true })
        await walk(absolute, destination)
      } else if (child.isFile()) {
        const stat = await fs.stat(absolute)
        if (stat.size > PLUGIN_PACKAGE_LIMITS.maxFileBytes) {
          throw new PluginInstallError(`文件超过 10 MB：${child.name}`)
        }
        total += stat.size
        if (total > PLUGIN_PACKAGE_LIMITS.maxTotalBytes) {
          throw new PluginInstallError('插件目录总量超过 50 MB')
        }
        await fs.mkdir(dirname(destination), { recursive: true })
        await fs.copyFile(absolute, destination)
      }
    }
  }
  await walk(source, target)
}

/**
 * 把本地路径（zip 或文件夹）落到 staging 并校验清单。
 * 调用方负责 `cleanupStaged(stagingDir)`（成功提交后 staging 已被移走，无需再删）。
 */
export async function stageLocalPackage(
  ref: PluginPackageRef,
  paths: PluginInstallPaths,
  options: PluginInstallOptions,
): Promise<StagedPackage> {
  const sourcePath = typeof ref.path === 'string' ? ref.path.trim() : ''
  if ((ref.kind !== 'file' && ref.kind !== 'marketplace') || sourcePath === '') {
    throw new PluginInstallError('安装需要提供插件包路径')
  }
  const kind = await pathKind(sourcePath)
  if (kind === 'missing') throw new PluginInstallError(`插件包不存在：${sourcePath}`)

  await fs.mkdir(paths.plugins, { recursive: true })
  const stagingRoot = join(paths.plugins, '.staging')
  await fs.mkdir(stagingRoot, { recursive: true })
  const stagingDir = join(stagingRoot, randomUUID())
  await fs.mkdir(stagingDir, { recursive: true })

  let sizeBytes = 0
  let checksum = ''
  try {
    if (kind === 'file') {
      if (!isZipPath(sourcePath)) {
        throw new PluginInstallError('只支持 .aurora-plugin / .zip 插件包，或直接选择插件文件夹')
      }
      const buffer = await fs.readFile(sourcePath)
      if (buffer.byteLength > PLUGIN_PACKAGE_LIMITS.maxTotalBytes) {
        throw new PluginInstallError('插件包超过 50 MB')
      }
      sizeBytes = buffer.byteLength
      checksum = createHash('sha256').update(buffer).digest('hex')
      await extractZip(buffer, stagingDir)
    } else {
      await copyDirectory(sourcePath, stagingDir)
      checksum = await hashDirectory(sourcePath)
      sizeBytes = await directorySize(stagingDir)
    }
    const loaded = await readPluginManifest(stagingDir, {
      hostVersion: options.hostVersion,
      isDev: false,
    })
    if (!loaded.ok || loaded.plugin === undefined) {
      throw new PluginInstallError('清单校验失败', loaded.errors)
    }
    return {
      stagingDir,
      plugin: loaded.plugin,
      checksum,
      sizeBytes,
      sourcePath: resolve(sourcePath),
    }
  } catch (error) {
    await removeTree(stagingDir)
    throw error
  }
}

async function directorySize(root: string): Promise<number> {
  let total = 0
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.isFile()) total += (await fs.stat(absolute)).size
    }
  }
  await walk(root)
  return total
}

/** 安装前预览（不改任何状态；staging 会被清掉）。 */
export async function previewPackage(
  ref: PluginPackageRef,
  paths: PluginInstallPaths,
  options: PluginInstallOptions,
): Promise<PluginInstallPreview> {
  const staged = await stageLocalPackage(ref, paths, options)
  try {
    return buildPreview(staged, options)
  } finally {
    await removeTree(staged.stagingDir)
  }
}

export function buildPreview(
  staged: StagedPackage,
  options: PluginInstallOptions,
): PluginInstallPreview {
  const manifest = staged.plugin.manifest
  const existing = options.installed[manifest.id]
  const conflicts: string[] = []
  const warnings: string[] = []

  if (existing !== undefined && existing.activeVersion === manifest.version) {
    warnings.push(`同版本 ${manifest.version} 已安装，继续安装会覆盖该版本目录`)
  }
  if (existing !== undefined && existing.activeVersion !== manifest.version) {
    const compare = manifest.version.localeCompare(existing.activeVersion, undefined, {
      numeric: true,
    })
    if (compare < 0) warnings.push(`安装版本低于当前版本 ${existing.activeVersion}（降级）`)
  }

  // 斜杠命令跨插件同名会互相遮蔽：安装前就拒绝（工具 / 面板 / 主题都有命名空间）
  for (const other of options.otherManifests ?? []) {
    if (other.id === manifest.id) continue
    const otherCommands = new Set(other.manifest.contributes.commands.map((item) => item.name))
    for (const command of manifest.contributes.commands) {
      if (otherCommands.has(command.name)) {
        conflicts.push(`命令名 ${command.name} 已被插件 ${other.id} 使用`)
      }
    }
  }

  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    ...(manifest.minAuroraVersion === undefined
      ? {}
      : { minAuroraVersion: manifest.minAuroraVersion }),
    description: manifest.description,
    author: manifest.author.name,
    ...(manifest.license === undefined ? {} : { license: manifest.license }),
    ...(manifest.homepage === undefined ? {} : { homepage: manifest.homepage }),
    checksum: staged.checksum,
    sizeBytes: staged.sizeBytes,
    permissions: [...manifest.permissions] as PluginPermission[],
    tools: manifest.contributes.tools.map((tool) => ({
      name: tool.name,
      fullName: pluginToolName(manifest.id, tool.name),
      description: tool.description,
      sensitivity: tool.sensitivity,
      readonly: tool.readonly,
    })),
    commands: manifest.contributes.commands.map((command) => ({
      pluginId: manifest.id,
      pluginName: manifest.name,
      name: command.name,
      title: command.title,
      description: command.description,
      mode: command.mode,
    })),
    panels: manifest.contributes.panels.map((panel) => ({
      pluginId: manifest.id,
      pluginName: manifest.name,
      id: panel.id,
      title: panel.title,
      icon: panel.icon ?? 'Puzzle',
      kind: panel.schema === undefined ? 'page' : 'schema',
    })),
    widgets: manifest.contributes.widgets.map((widget) => ({
      pluginId: manifest.id,
      pluginName: manifest.name,
      id: widget.id,
      title: widget.title,
      ...(widget.icon === undefined ? {} : { icon: widget.icon }),
      slot: widget.slot,
      kind: widget.schema === undefined ? 'page' : 'schema',
      windowLevel: widget.windowLevel,
      windowMaterial: widget.windowMaterial,
      hideCloseButton: widget.hideCloseButton,
      ...(widget.entry === undefined ? {} : { entry: widget.entry }),
      ...(widget.defaultSize === undefined ? {} : { defaultSize: { ...widget.defaultSize } }),
    })),
    themes: manifest.contributes.themes.map((theme) => ({
      pluginId: manifest.id,
      pluginName: manifest.name,
      id: theme.id,
      name: theme.name,
      tokens: { ...theme.tokens },
    })),
    automationActions: manifest.contributes.automation.actions.map((action) => ({
      pluginId: manifest.id,
      pluginName: manifest.name,
      name: action.name,
      title: action.title,
      description: action.description,
    })),
    automationEvents: manifest.contributes.automation.events.map((event) => ({
      pluginId: manifest.id,
      pluginName: manifest.name,
      name: event.name,
      title: event.title,
      ...(event.description === undefined ? {} : { description: event.description }),
    })),
    configFields: manifest.config.fields.map((field) => ({ ...field })),
    events: [...manifest.events],
    conflicts,
    warnings,
    replaces:
      existing === undefined
        ? null
        : { version: existing.activeVersion, enabled: existing.enabled },
    sourcePath: staged.sourcePath,
  }
}

/**
 * 提交 staging：把目录移到 `plugins/<id>/versions/<version>` 并生成安装记录。
 * 调用前必须由 manager 停掉同 id 的插件进程（Windows 上文件锁会让 rename 失败）。
 */
export async function commitStagedPackage(
  staged: StagedPackage,
  paths: PluginInstallPaths,
  previous: InstalledPluginRecord | undefined,
  options: { source: InstalledPluginRecord['source']; logger?: Logger },
): Promise<CommittedPackage> {
  const manifest = staged.plugin.manifest
  const versionDir = join(paths.plugins, manifest.id, 'versions', manifest.version)
  await fs.mkdir(dirname(versionDir), { recursive: true })
  await removeTree(versionDir)
  try {
    await fs.rename(staged.stagingDir, versionDir)
  } catch (error) {
    // 跨盘 / 权限问题：退化为复制后删除
    await copyDirectory(staged.stagingDir, versionDir)
    await removeTree(staged.stagingDir)
    options.logger?.debug?.('插件安装 rename 失败，已退化为复制', { error: String(error) })
  }

  const now = new Date().toISOString()
  const record: InstalledPluginRecord = {
    id: manifest.id,
    enabled: previous?.enabled ?? true,
    trusted: previous?.trusted ?? false,
    source: options.source,
    activeVersion: manifest.version,
    ...(previous !== undefined && previous.activeVersion !== manifest.version
      ? { previousVersion: previous.activeVersion }
      : previous?.previousVersion === undefined
        ? {}
        : { previousVersion: previous.previousVersion }),
    installPath: versionDir,
    checksum: staged.checksum,
    installedAt: previous?.installedAt ?? now,
    updatedAt: now,
    ...(previous?.lastError === undefined ? {} : { lastError: previous.lastError }),
  }

  return {
    record,
    plugin: {
      manifest,
      root: versionDir,
      manifestPath: join(versionDir, 'manifest.json'),
      isDev: false,
    },
  }
}

/** 清理 staging 根下超过一定时间的残留（启动时调用，避免崩溃后越积越多）。 */
export async function cleanupStaging(paths: PluginInstallPaths, logger: Logger): Promise<void> {
  const stagingRoot = join(paths.plugins, '.staging')
  let entries: string[]
  try {
    entries = await fs.readdir(stagingRoot)
  } catch {
    return
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  for (const name of entries) {
    const absolute = join(stagingRoot, name)
    try {
      const stat = await fs.stat(absolute)
      if (stat.mtimeMs < cutoff) {
        await removeTree(absolute)
        logger.debug('已清理插件安装残留', { dir: basename(absolute) })
      }
    } catch {
      /* 并发删除或权限问题：下次启动再试 */
    }
  }
}
