/**
 * 插件管理器（docs/14 §2）：安装态、进程生命周期、贡献聚合与宿主 API 落地。
 *
 * 职责边界：
 * - **不 import electron**：进程由注入的 `PluginProcessFactory` 创建（生产实现见 process.ts），
 *   因此状态机 / 权限 / 存储 / 配置都能在纯 Node 下单测；
 * - 贡献（工具 / Skill / 命令 / 面板 / 主题 / 自动化）只在内存聚合，由主进程装配层
 *   订阅 `onChanged` 后同步到各自注册表 —— 管理器不认识 ToolRegistry。
 *
 * 权限是 **API 级门控**，不是 OS 沙箱：插件进程仍有当前用户权限（docs/14 §2.6）。
 */
import { promises as fs, watch, type FSWatcher } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'
import {
  hasPermission,
  normalizePluginPanelIcon,
  PLUGIN_CLIENT_CALLS,
  PLUGIN_HEARTBEAT,
  PLUGIN_HOST_CALLS,
  PLUGIN_MAX_RUNNING,
  PLUGIN_NET_MAX_RESPONSE_BYTES,
  PLUGIN_PANEL_EVENT,
  PLUGIN_RESTART_BACKOFF,
  PLUGIN_RESTART_WINDOW_MS,
  PLUGIN_RPC_TIMEOUTS,
  PLUGIN_STORAGE_MAX_BYTES,
  PLUGIN_STORAGE_VALUE_MAX_BYTES,
  PLUGIN_TOOL_CONTENT_MAX,
  pluginToolName,
  type Logger,
  type PluginCommandInfo,
  type PluginConfigField,
  type PluginManifest,
  type PluginPackageRef,
  type PluginPanelInfo,
  type PluginPermission,
  type PluginPushEvent,
  type PluginRuntimeStatus,
  type PluginSummary,
  type PluginThemeInfo,
  type PluginToolInfo,
  type PluginWidgetInfo,
  type PluginAutomationActionInfo,
  type PluginAutomationEventInfo,
  type PluginInstallPreview,
  type PluginRunCommandResult,
  type Settings,
} from '@aurora/shared'
import { PluginRpcFailure } from './protocol.js'
import type { PluginProcessFactory, PluginProcessHandle } from './process.js'
import {
  commitStagedPackage,
  buildPreview,
  cleanupStaging,
  previewPackage,
  PluginInstallError,
  stageLocalPackage,
  type PluginInstallPaths,
} from './install.js'
import { readPluginManifest } from './manifest-load.js'
import { readJsonFile, writeJsonAtomic } from './fs-json.js'
import { PluginRegistryStore, type InstalledPluginRecord } from './registry.js'

export interface PluginManagerOptions {
  userData: string
  hostVersion: string
  logger: Logger
  processFactory: PluginProcessFactory
  getSettings: () => Settings
  /** 贡献或运行时状态变化（装配层据此同步工具表 / Skill 目录 / 渲染层） */
  onChanged?: (reason: string) => void
  /** 插件 `emitEvent` → 自动化引擎（plugin-event 触发器） */
  onAutomationEvent?: (payload: {
    pluginId: string
    pluginName: string
    event: string
    data: unknown
  }) => void
  /** 插件请求打开右栏面板 */
  onOpenPanel?: (pluginId: string, panelId: string) => void
  /** 插件 toast（复用主界面的轻提示通道） */
  onToast?: (pluginId: string, message: string, kind: 'info' | 'error') => void
  /** 插件主动推送面板 / 小组件事件（主进程 → 渲染层） */
  onPanelEvent?: (event: PluginPushEvent) => void
  /** 系统通知（notifications 权限） */
  notify?: (input: { title: string; body: string }) => boolean
  /** 出网 fetch（走主进程的代理链） */
  resolveFetch?: () => typeof fetch | undefined
}

export interface PluginToolContribution {
  pluginId: string
  pluginName: string
  name: string
  fullName: string
  description: string
  parameters: Record<string, unknown>
  sensitivity: 'safe' | 'confirm'
  readonly: boolean
  timeoutMs?: number
}

interface PluginEntry {
  manifest: PluginManifest
  root: string
  isDev: boolean
  record?: InstalledPluginRecord
  status: PluginRuntimeStatus
  lastError?: string
  config: Record<string, unknown>
  storage: Record<string, unknown>
  loadedAt: string
  process?: PluginProcessHandle
  startPromise?: Promise<void>
  heartbeat?: NodeJS.Timeout
  heartbeatMisses: number
  crashTimes: number[]
  restartTimer?: NodeJS.Timeout
}

const STORAGE_KEY_MAX = 128
const STORAGE_KEY_PATTERN = /^[a-zA-Z0-9_.:-]{1,128}$/
const LOG_MESSAGE_MAX = 4000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 开发目录里不值得触发重载的写入（依赖目录 / 编辑器临时文件 / 日志）。 */
function isIgnoredDevFile(filename: string): boolean {
  const value = filename.replace(/\\/g, '/')
  if (value.includes('node_modules/') || value.includes('/.git/')) return true
  return /(?:~|\.tmp|\.swp|\.log)$/.test(value)
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true
  if (host.endsWith('.local') || host.endsWith('.internal')) return true
  if (isIP(host) === 4) {
    const [a = 0, b = 0] = host.split('.').map((part) => Number.parseInt(part, 10))
    if (a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }
  if (isIP(host) === 6) {
    return host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')
  }
  return false
}

function sanitizeConfig(
  fields: PluginConfigField[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const field of fields) {
    const value = values[field.key]
    if (value === undefined) continue
    if (field.type === 'boolean') {
      if (typeof value === 'boolean') result[field.key] = value
    } else if (field.type === 'number') {
      if (typeof value === 'number' && Number.isFinite(value)) {
        const min = field.min ?? Number.NEGATIVE_INFINITY
        const max = field.max ?? Number.POSITIVE_INFINITY
        result[field.key] = Math.min(Math.max(value, min), max)
      }
    } else if (field.type === 'select') {
      if (typeof value === 'string' && (field.options ?? []).some((o) => o.value === value)) {
        result[field.key] = value
      }
    } else {
      if (typeof value === 'string') result[field.key] = value
    }
  }
  return result
}

function defaultsFor(fields: PluginConfigField[]): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const field of fields) {
    if (field.default !== undefined) values[field.key] = field.default
  }
  return values
}

export class PluginManager {
  private readonly options: PluginManagerOptions
  private readonly paths: PluginInstallPaths
  private readonly registry: PluginRegistryStore
  private readonly entries = new Map<string, PluginEntry>()
  private readonly devDirs = new Set<string>()
  private settings: Settings
  private started = false
  private stopping = false
  private changedTimer: NodeJS.Timeout | undefined
  private devWatchers: FSWatcher[] = []
  private devReloadTimers = new Map<string, NodeJS.Timeout>()
  /** 每插件的 `ui.panelEvent` 时间戳（滑动 1s 窗口限速） */
  private readonly panelEventTimes = new Map<string, number[]>()

  constructor(options: PluginManagerOptions) {
    this.options = options
    this.paths = {
      plugins: join(options.userData, 'plugins'),
      data: join(options.userData, 'plugin-data'),
    }
    this.registry = new PluginRegistryStore(
      join(this.paths.plugins, 'registry.json'),
      options.logger,
    )
    this.settings = options.getSettings()
  }

  // ───────────────────────── 生命周期 ─────────────────────────

  async init(): Promise<void> {
    await fs.mkdir(this.paths.plugins, { recursive: true })
    await fs.mkdir(this.paths.data, { recursive: true })
    await cleanupStaging(this.paths, this.options.logger)
    const records = await this.registry.load()
    for (const [id, record] of Object.entries(records)) {
      await this.loadInstalledEntry(id, record)
    }
    await this.reloadDevEntries(this.settings.plugins.devDirs, { notify: false })
    this.startDevWatching()
    this.options.logger.info('插件管理器已初始化', {
      installed: Object.keys(records).length,
      devDirs: this.devDirs.size,
      total: this.entries.size,
    })
  }

  /** 启动所有 `activation: startup` 的启用插件（不等待就绪）。 */
  async start(): Promise<void> {
    this.started = true
    this.stopping = false
    if (!this.settings.plugins.enabled) return
    for (const entry of this.entries.values()) {
      if (!this.isEnabled(entry)) continue
      if (entry.manifest.activation !== 'startup') continue
      void this.ensureStarted(entry).catch((error: unknown) => {
        entry.status = 'error'
        entry.lastError = errorMessage(error)
        this.options.logger.warn('插件启动失败', {
          pluginId: entry.manifest.id,
          error: entry.lastError,
        })
        this.emitChanged('start-failed')
      })
    }
  }

  async stopAll(): Promise<void> {
    this.stopping = true
    this.closeDevWatching()
    for (const entry of this.entries.values()) {
      await this.stopEntry(entry, { status: 'stopped' })
    }
    this.started = false
  }

  /** `settings:changed` 入口：总开关 / 开发目录 / 当前主题。 */
  async onSettingsChanged(): Promise<void> {
    const previous = this.settings
    this.settings = this.options.getSettings()
    const wasStarted = this.started
    const totalDisabled = previous.plugins.enabled && !this.settings.plugins.enabled
    const totalEnabled = !previous.plugins.enabled && this.settings.plugins.enabled

    if (totalDisabled) {
      await this.stopAll()
      // `stopAll()` 会把 started 置回 false（那是退出流程的语义）；仅停用总开关时
      // 管理器仍处于「已启动」状态，否则重新打开总开关后 startup 插件不会自动回来。
      this.started = wasStarted
      for (const entry of this.entries.values()) entry.status = 'disabled'
      this.emitChanged('plugins-disabled')
      return
    }

    const nextDevDirs = this.settings.plugins.devDirs
    const sameDirs =
      nextDevDirs.length === this.devDirs.size && nextDevDirs.every((dir) => this.devDirs.has(dir))
    if (!sameDirs) {
      await this.reloadDevEntries(nextDevDirs, { notify: true })
      this.startDevWatching()
    }

    if (totalEnabled && wasStarted) {
      this.started = true
      this.stopping = false
      void this.start()
      this.startDevWatching()
    }
    this.emitChanged('settings')
  }

  /**
   * 监听开发目录（300ms 防抖）：改 `main.js` / 清单即重启该插件。
   * 监听失败只告警 —— 开发目录仍可手动 `plugins:restart`。
   */
  startDevWatching(): void {
    this.closeDevWatching()
    for (const dir of this.devDirs) {
      try {
        const watcher = watch(dir, { recursive: true }, (_event, filename) => {
          if (typeof filename === 'string' && isIgnoredDevFile(filename)) return
          this.scheduleDevReload(dir)
        })
        watcher.on('error', () => {
          watcher.close()
          this.devWatchers = this.devWatchers.filter((item) => item !== watcher)
        })
        this.devWatchers.push(watcher)
      } catch (error) {
        this.options.logger.warn('插件开发目录监听失败（可手动重启插件）', {
          dir,
          error: errorMessage(error),
        })
      }
    }
  }

  private closeDevWatching(): void {
    for (const watcher of this.devWatchers) watcher.close()
    this.devWatchers = []
    for (const timer of this.devReloadTimers.values()) clearTimeout(timer)
    this.devReloadTimers.clear()
  }

  private scheduleDevReload(dir: string): void {
    const existing = this.devReloadTimers.get(dir)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.devReloadTimers.delete(dir)
      void this.reloadDevDir(dir).catch((error: unknown) => {
        this.options.logger.warn('开发目录插件重载失败', { dir, error: errorMessage(error) })
      })
    }, 300)
    timer.unref?.()
    this.devReloadTimers.set(dir, timer)
  }

  // ───────────────────────── 查询 ─────────────────────────

  list(): PluginSummary[] {
    return [...this.entries.values()]
      .map((entry) => this.toSummary(entry))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  get(pluginId: string): PluginSummary | undefined {
    const entry = this.entries.get(pluginId)
    return entry === undefined ? undefined : this.toSummary(entry)
  }

  /** 安装目录（`openFolder` 用）；开发目录插件返回它的源目录。 */
  installPathOf(pluginId: string): string | undefined {
    return this.entries.get(pluginId)?.root
  }

  /** 插件日志文件（`openLog` 用）；文件可能尚未创建。 */
  logFileOf(pluginId: string): string {
    return join(this.options.userData, 'logs', 'plugins', `${pluginId}.log`)
  }

  /**
   * 开发目录文件变化后原地重载（manifest 与 `main.js` 都可能改过）。
   * id 变了就按旧 id 摘除、新 id 重新登记；权限 / 贡献变化由调用方的 onChanged 同步。
   */
  async reloadDevDir(dir: string): Promise<void> {
    const entry = [...this.entries.values()].find((item) => item.isDev && item.root === dir)
    if (entry === undefined) return
    await this.stopEntry(entry, { status: 'stopped' })
    const loaded = await readPluginManifest(dir, {
      hostVersion: this.options.hostVersion,
      isDev: true,
    })
    if (!loaded.ok || loaded.plugin === undefined) {
      entry.status = 'error'
      entry.lastError = loaded.errors.join('；')
      this.options.logger.warn('开发目录插件重载失败', { dir, errors: loaded.errors })
      this.emitChanged('dev-reload-failed')
      return
    }
    const nextId = loaded.plugin.manifest.id
    if (nextId !== entry.manifest.id) {
      this.entries.delete(entry.manifest.id)
      const data = await this.readDataFiles(nextId, loaded.plugin.manifest)
      this.entries.set(nextId, {
        manifest: loaded.plugin.manifest,
        root: dir,
        isDev: true,
        status: this.settings.plugins.enabled ? 'stopped' : 'disabled',
        config: data.config,
        storage: data.storage,
        loadedAt: new Date().toISOString(),
        heartbeatMisses: 0,
        crashTimes: [],
      })
    } else {
      entry.manifest = loaded.plugin.manifest
      entry.lastError = undefined
    }
    const target = this.entries.get(nextId)!
    if (this.started && this.isEnabled(target)) {
      void this.ensureStarted(target).catch((error: unknown) => {
        this.options.logger.warn('开发目录插件重启失败', { dir, error: errorMessage(error) })
      })
    }
    this.emitChanged('dev-reload')
  }

  /** 待注册的工具清单（只含启用且声明 tools 权限的插件）。 */
  toolContributions(): PluginToolContribution[] {
    const result: PluginToolContribution[] = []
    for (const entry of this.entries.values()) {
      if (!this.isEnabled(entry)) continue
      if (!hasPermission(entry.manifest.permissions, 'tools')) continue
      const trusted = entry.record?.trusted === true
      for (const tool of entry.manifest.contributes.tools) {
        result.push({
          pluginId: entry.manifest.id,
          pluginName: entry.manifest.name,
          name: tool.name,
          fullName: pluginToolName(entry.manifest.id, tool.name),
          description: tool.description,
          parameters: tool.parameters,
          sensitivity: trusted && tool.sensitivity === 'safe' ? 'safe' : 'confirm',
          readonly: tool.readonly,
          ...(tool.timeoutMs === undefined ? {} : { timeoutMs: tool.timeoutMs }),
        })
      }
    }
    return result
  }

  commands(): PluginCommandInfo[] {
    const result: PluginCommandInfo[] = []
    for (const entry of this.entries.values()) {
      if (!this.isEnabled(entry)) continue
      if (!hasPermission(entry.manifest.permissions, 'commands')) continue
      for (const command of entry.manifest.contributes.commands) {
        result.push({
          pluginId: entry.manifest.id,
          pluginName: entry.manifest.name,
          name: command.name,
          title: command.title,
          description: command.description,
          mode: command.mode,
        })
      }
    }
    return result
  }

  panels(): PluginPanelInfo[] {
    const result: PluginPanelInfo[] = []
    for (const entry of this.entries.values()) {
      if (!this.isEnabled(entry)) continue
      for (const panel of entry.manifest.contributes.panels) {
        result.push({
          pluginId: entry.manifest.id,
          pluginName: entry.manifest.name,
          id: panel.id,
          title: panel.title,
          icon: normalizePluginPanelIcon(panel.icon),
          kind: panel.schema === undefined ? 'page' : 'schema',
          ...(panel.entry === undefined ? {} : { entry: panel.entry }),
        })
      }
    }
    return result
  }

  /** 待创建的桌面 / 提示条小组件（按启用 + `ui.widgets` 权限过滤）。 */
  widgetContributions(): PluginWidgetInfo[] {
    const result: PluginWidgetInfo[] = []
    for (const entry of this.entries.values()) {
      if (!this.isEnabled(entry)) continue
      if (!hasPermission(entry.manifest.permissions, 'ui.widgets')) continue
      for (const widget of entry.manifest.contributes.widgets) {
        result.push({
          pluginId: entry.manifest.id,
          pluginName: entry.manifest.name,
          id: widget.id,
          title: widget.title,
          ...(widget.icon === undefined ? {} : { icon: normalizePluginPanelIcon(widget.icon) }),
          slot: widget.slot,
          kind: widget.schema === undefined ? 'page' : 'schema',
          ...(widget.entry === undefined ? {} : { entry: widget.entry }),
          ...(widget.defaultSize === undefined ? {} : { defaultSize: { ...widget.defaultSize } }),
        })
      }
    }
    return result
  }

  themes(): PluginThemeInfo[] {
    const result: PluginThemeInfo[] = []
    for (const entry of this.entries.values()) {
      if (!this.isEnabled(entry)) continue
      for (const theme of entry.manifest.contributes.themes) {
        result.push({
          pluginId: entry.manifest.id,
          pluginName: entry.manifest.name,
          id: theme.id,
          name: theme.name,
          tokens: { ...theme.tokens },
        })
      }
    }
    return result
  }

  automationActions(): PluginAutomationActionInfo[] {
    const result: PluginAutomationActionInfo[] = []
    for (const entry of this.entries.values()) {
      if (!this.isEnabled(entry)) continue
      for (const action of entry.manifest.contributes.automation.actions) {
        result.push({
          pluginId: entry.manifest.id,
          pluginName: entry.manifest.name,
          name: action.name,
          title: action.title,
          description: action.description,
        })
      }
    }
    return result
  }

  automationEvents(): PluginAutomationEventInfo[] {
    const result: PluginAutomationEventInfo[] = []
    for (const entry of this.entries.values()) {
      if (!this.isEnabled(entry)) continue
      for (const event of entry.manifest.contributes.automation.events) {
        result.push({
          pluginId: entry.manifest.id,
          pluginName: entry.manifest.name,
          name: event.name,
          title: event.title,
          ...(event.description === undefined ? {} : { description: event.description }),
        })
      }
    }
    return result
  }

  /** 插件 Skill 目录（启用 + 有 skills 权限）；`SkillsRegistry` 按 builtin → plugin → user 扫描。 */ skillDirs(): Array<{
    dir: string
    pluginId: string
  }> {
    const result: Array<{ dir: string; pluginId: string }> = []
    for (const entry of this.entries.values()) {
      if (!this.isEnabled(entry)) continue
      if (!hasPermission(entry.manifest.permissions, 'skills')) continue
      for (const relativePath of entry.manifest.contributes.skills) {
        result.push({
          dir: join(entry.root, relativePath),
          pluginId: entry.manifest.id,
        })
      }
    }
    return result
  }

  /** 面板文件（声明式 schema 的 JSON 文本）；页面型返回 undefined。 */
  async panelSchemaFile(pluginId: string, panelId: string): Promise<string | undefined> {
    const entry = this.entries.get(pluginId)
    if (entry === undefined || !this.isEnabled(entry)) return undefined
    const panel = entry.manifest.contributes.panels.find((item) => item.id === panelId)
    if (panel?.schema === undefined) return undefined
    const file = join(entry.root, panel.schema)
    const stat = await fs.stat(file)
    if (stat.size > 256 * 1024) {
      throw new PluginRpcFailure('E_PLUGIN_INVALID_ARGS', '面板 schema 超过 256 KB')
    }
    return await fs.readFile(file, 'utf8')
  }

  /** 小组件文件（声明式 schema 的 JSON 文本）；页面型返回 undefined。 */
  async widgetSchemaFile(pluginId: string, widgetId: string): Promise<string | undefined> {
    const entry = this.entries.get(pluginId)
    if (entry === undefined || !this.isEnabled(entry)) return undefined
    if (!hasPermission(entry.manifest.permissions, 'ui.widgets')) return undefined
    const widget = entry.manifest.contributes.widgets.find((item) => item.id === widgetId)
    if (widget?.schema === undefined) return undefined
    const file = join(entry.root, widget.schema)
    const stat = await fs.stat(file)
    if (stat.size > 256 * 1024) {
      throw new PluginRpcFailure('E_PLUGIN_INVALID_ARGS', '小组件 schema 超过 256 KB')
    }
    return await fs.readFile(file, 'utf8')
  }

  // ───────────────────────── 安装 / 卸载 / 回滚 ─────────────────────────

  async inspect(ref: PluginPackageRef): Promise<PluginInstallPreview> {
    return await previewPackage(ref, this.paths, {
      hostVersion: this.options.hostVersion,
      logger: this.options.logger,
      installed: this.installedRecords(),
      otherManifests: this.enabledManifests(),
    })
  }

  async install(ref: PluginPackageRef): Promise<PluginSummary> {
    const staged = await stageLocalPackage(ref, this.paths, {
      hostVersion: this.options.hostVersion,
      logger: this.options.logger,
      installed: this.installedRecords(),
      otherManifests: this.enabledManifests(),
    })

    try {
      const preview = buildPreview(staged, {
        hostVersion: this.options.hostVersion,
        logger: this.options.logger,
        installed: this.installedRecords(),
        otherManifests: this.enabledManifests(),
      })
      if (preview.conflicts.length > 0) {
        throw new PluginInstallError('插件与已安装内容冲突', preview.conflicts)
      }

      const id = staged.plugin.manifest.id
      const existing = this.entries.get(id)
      if (existing !== undefined && !existing.isDev) {
        await this.stopEntry(existing, { status: 'stopped' })
      }
      const committed = await commitStagedPackage(staged, this.paths, existing?.record, {
        source: ref.kind === 'marketplace' ? 'marketplace' : 'local',
        logger: this.options.logger,
      })
      const state = await this.readDataFiles(id, committed.plugin.manifest)
      const records = await this.registry.load()
      records[id] = committed.record
      await this.registry.save(records)
      this.entries.set(id, {
        manifest: committed.plugin.manifest,
        root: committed.plugin.root,
        isDev: false,
        record: committed.record,
        status: 'stopped',
        config: state.config,
        storage: state.storage,
        loadedAt: new Date().toISOString(),
        heartbeatMisses: 0,
        crashTimes: [],
      })
      this.options.logger.info('插件已安装', {
        pluginId: id,
        version: committed.record.activeVersion,
        checksum: committed.record.checksum,
      })
      if (this.started && this.settings.plugins.enabled && committed.record.enabled) {
        void this.ensureStarted(this.entries.get(id)!).catch((error: unknown) => {
          this.options.logger.warn('插件安装后启动失败', {
            pluginId: id,
            error: errorMessage(error),
          })
        })
      }
      this.emitChanged('install')
      return this.toSummary(this.entries.get(id)!)
    } catch (error) {
      await fs.rm(staged.stagingDir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  async uninstall(pluginId: string, deleteData = false): Promise<boolean> {
    const entry = this.entries.get(pluginId)
    if (entry === undefined) return false
    if (entry.isDev) {
      throw new PluginRpcFailure('E_PLUGIN_INVALID_ARGS', '开发目录插件请从 plugins.devDirs 移除')
    }
    await this.stopEntry(entry, { status: 'disabled' })
    this.entries.delete(pluginId)
    const records = await this.registry.load()
    delete records[pluginId]
    await this.registry.save(records)
    await fs.rm(join(this.paths.plugins, pluginId), { recursive: true, force: true })
    if (deleteData) {
      await fs.rm(join(this.paths.data, pluginId), { recursive: true, force: true })
    }
    this.options.logger.info('插件已卸载', { pluginId, deleteData })
    this.emitChanged('uninstall')
    return true
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<PluginSummary> {
    const entry = this.requireEntry(pluginId)
    if (entry.isDev) {
      throw new PluginRpcFailure(
        'E_PLUGIN_INVALID_ARGS',
        '开发目录插件由 plugins.devDirs 控制，移除目录即停用',
      )
    }
    const record = entry.record
    if (record === undefined) throw new PluginRpcFailure('E_PLUGIN_NOT_READY', '插件记录缺失')
    record.enabled = enabled
    record.updatedAt = new Date().toISOString()
    await this.saveRecord(record)
    if (!enabled) {
      await this.stopEntry(entry, { status: 'disabled' })
    } else if (this.started && this.settings.plugins.enabled) {
      if (entry.manifest.activation === 'startup') {
        void this.ensureStarted(entry).catch((error: unknown) =>
          this.options.logger.warn('插件启用后启动失败', {
            pluginId,
            error: errorMessage(error),
          }),
        )
      } else {
        entry.status = 'stopped'
      }
    }
    this.emitChanged('enable')
    return this.toSummary(entry)
  }

  async setTrusted(pluginId: string, trusted: boolean): Promise<PluginSummary> {
    const entry = this.requireEntry(pluginId)
    if (entry.record !== undefined) {
      entry.record.trusted = trusted
      entry.record.updatedAt = new Date().toISOString()
      await this.saveRecord(entry.record)
    }
    this.emitChanged('trust')
    return this.toSummary(entry)
  }

  async restart(pluginId: string): Promise<PluginSummary> {
    const entry = this.requireEntry(pluginId)
    await this.stopEntry(entry, { status: 'stopped' })
    entry.crashTimes = []
    entry.lastError = undefined
    if (this.isEnabled(entry)) await this.ensureStarted(entry)
    this.emitChanged('restart')
    return this.toSummary(entry)
  }

  async rollback(pluginId: string): Promise<PluginSummary> {
    const entry = this.requireEntry(pluginId)
    const record = entry.record
    if (record?.previousVersion === undefined) {
      throw new PluginRpcFailure('E_PLUGIN_INVALID_ARGS', '没有可回滚的上一版本')
    }
    const versionDir = join(this.paths.plugins, pluginId, 'versions', record.previousVersion)
    const loaded = await readPluginManifest(versionDir, {
      hostVersion: this.options.hostVersion,
      isDev: false,
    })
    if (!loaded.ok || loaded.plugin === undefined) {
      throw new PluginInstallError('上一版本无法加载', loaded.errors)
    }
    await this.stopEntry(entry, { status: 'stopped' })
    const previousActive = record.activeVersion
    record.activeVersion = record.previousVersion
    record.previousVersion = previousActive
    record.installPath = versionDir
    record.updatedAt = new Date().toISOString()
    await this.saveRecord(record)
    entry.manifest = loaded.plugin.manifest
    entry.root = versionDir
    entry.lastError = undefined
    if (this.isEnabled(entry)) await this.ensureStarted(entry)
    this.emitChanged('rollback')
    return this.toSummary(entry)
  }

  // ───────────────────────── 调用 ─────────────────────────

  async invokeTool(
    pluginId: string,
    toolName: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<{ content: string; isError?: boolean; summary?: string }> {
    const entry = this.requireEnabled(pluginId, 'tools')
    const tool = entry.manifest.contributes.tools.find((item) => item.name === toolName)
    if (tool === undefined) {
      throw new PluginRpcFailure('E_PLUGIN_INVALID_ARGS', `插件未声明工具：${toolName}`)
    }
    await this.ensureStarted(entry)
    const timeoutMs = Math.min(
      tool.timeoutMs ?? PLUGIN_RPC_TIMEOUTS.toolDefault,
      PLUGIN_RPC_TIMEOUTS.toolMax,
    )
    const result = (await entry.process!.peer.request(
      PLUGIN_HOST_CALLS.tool,
      { name: toolName, input },
      { timeoutMs, ...(signal === undefined ? {} : { signal }) },
    )) as { content?: unknown; isError?: unknown; summary?: unknown }
    const content =
      typeof result?.content === 'string' ? result.content.slice(0, PLUGIN_TOOL_CONTENT_MAX) : ''
    if (content === '') {
      throw new PluginRpcFailure('E_PLUGIN_TOOL_FAILED', '插件工具没有返回文本内容')
    }
    return {
      content,
      ...(result?.isError === true ? { isError: true } : {}),
      ...(typeof result?.summary === 'string' ? { summary: result.summary } : {}),
    }
  }

  async invokeCommand(pluginId: string, name: string, args = ''): Promise<PluginRunCommandResult> {
    const entry = this.requireEnabled(pluginId, 'commands')
    const command = entry.manifest.contributes.commands.find((item) => item.name === name)
    if (command === undefined) {
      throw new PluginRpcFailure('E_PLUGIN_INVALID_ARGS', `插件未声明命令：${name}`)
    }
    await this.ensureStarted(entry)
    const result = (await entry.process!.peer.request(
      PLUGIN_HOST_CALLS.command,
      { name, args },
      { timeoutMs: PLUGIN_RPC_TIMEOUTS.command },
    )) as { prompt?: unknown; summary?: unknown }
    return {
      ...(typeof result?.prompt === 'string' ? { prompt: result.prompt } : {}),
      ...(typeof result?.summary === 'string' ? { summary: result.summary } : {}),
    }
  }

  async invokeAutomationAction(
    pluginId: string,
    name: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ summary?: string }> {
    const entry = this.requireEnabled(pluginId, 'automation')
    const action = entry.manifest.contributes.automation.actions.find((item) => item.name === name)
    if (action === undefined) {
      throw new PluginRpcFailure('E_PLUGIN_INVALID_ARGS', `插件未声明自动化动作：${name}`)
    }
    await this.ensureStarted(entry)
    const result = (await entry.process!.peer.request(
      PLUGIN_HOST_CALLS.automationAction,
      { name, params },
      {
        timeoutMs: PLUGIN_RPC_TIMEOUTS.automation,
        ...(signal === undefined ? {} : { signal }),
      },
    )) as { summary?: unknown }
    return typeof result?.summary === 'string' ? { summary: result.summary } : {}
  }

  async invokePanel(
    pluginId: string,
    panelId: string,
    method = 'refresh',
    params: unknown = {},
    signal?: AbortSignal,
  ): Promise<{ schema?: unknown; toast?: string; data?: unknown }> {
    const entry = this.requireEnabled(pluginId, 'ui.panels')
    const panel = entry.manifest.contributes.panels.find((item) => item.id === panelId)
    if (panel === undefined) {
      throw new PluginRpcFailure('E_PLUGIN_INVALID_ARGS', `插件未声明面板：${panelId}`)
    }
    await this.ensureStarted(entry)
    const result = (await entry.process!.peer.request(
      PLUGIN_HOST_CALLS.panel,
      { panelId, method, params },
      {
        timeoutMs: PLUGIN_RPC_TIMEOUTS.panel,
        ...(signal === undefined ? {} : { signal }),
      },
    )) as { schema?: unknown; toast?: unknown; data?: unknown }
    return {
      ...(result?.schema === undefined ? {} : { schema: result.schema }),
      ...(typeof result?.toast === 'string' ? { toast: result.toast } : {}),
      ...(result?.data === undefined ? {} : { data: result.data }),
    }
  }

  async invokeWidget(
    pluginId: string,
    widgetId: string,
    method = 'refresh',
    params: unknown = {},
    signal?: AbortSignal,
  ): Promise<{ schema?: unknown; toast?: string; data?: unknown }> {
    const entry = this.requireEnabled(pluginId, 'ui.widgets')
    const widget = entry.manifest.contributes.widgets.find((item) => item.id === widgetId)
    if (widget === undefined) {
      throw new PluginRpcFailure('E_PLUGIN_INVALID_ARGS', `插件未声明小组件：${widgetId}`)
    }
    if (widget.schema === undefined) {
      throw new PluginRpcFailure('E_PLUGIN_INVALID_ARGS', '页面型小组件请通过小组件页面打开')
    }
    await this.ensureStarted(entry)
    const result = (await entry.process!.peer.request(
      PLUGIN_HOST_CALLS.widget,
      { widgetId, method, params },
      {
        timeoutMs: PLUGIN_RPC_TIMEOUTS.widget,
        ...(signal === undefined ? {} : { signal }),
      },
    )) as { schema?: unknown; toast?: unknown; data?: unknown }
    return {
      ...(result?.schema === undefined ? {} : { schema: result.schema }),
      ...(typeof result?.toast === 'string' ? { toast: result.toast } : {}),
      ...(result?.data === undefined ? {} : { data: result.data }),
    }
  }

  /** 宿主事件投递（只投给声明了该事件、且正在运行的插件）。 */
  async deliverEvent(event: string, payload: unknown): Promise<void> {
    for (const entry of this.entries.values()) {
      if (!this.isEnabled(entry)) continue
      if (!entry.manifest.events.includes(event as never)) continue
      if (entry.process === undefined) continue
      void entry.process.peer
        .request(
          PLUGIN_HOST_CALLS.event,
          { event, payload },
          { timeoutMs: PLUGIN_RPC_TIMEOUTS.event },
        )
        .catch((error: unknown) => {
          this.options.logger.debug('插件事件投递失败', {
            pluginId: entry.manifest.id,
            event,
            error: errorMessage(error),
          })
        })
    }
  }

  async getConfig(pluginId: string): Promise<Record<string, unknown>> {
    const entry = this.requireEntry(pluginId)
    return { ...entry.config }
  }

  async setConfig(
    pluginId: string,
    values: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const entry = this.requireEntry(pluginId)
    const sanitized = sanitizeConfig(entry.manifest.config.fields, values)
    entry.config = { ...entry.config, ...sanitized }
    await this.writeData(pluginId, 'config.json', entry.config)
    if (entry.process !== undefined) {
      void entry.process.peer
        .request(
          PLUGIN_HOST_CALLS.configChanged,
          { config: entry.config },
          { timeoutMs: PLUGIN_RPC_TIMEOUTS.configChanged },
        )
        .catch(() => undefined)
    }
    this.emitChanged('config')
    return { ...entry.config }
  }

  /** 检查市场更新（P4 由 marketplace 客户端调用前先取本机版本）。 */
  updateCandidates(): Array<{ pluginId: string; name: string; currentVersion: string }> {
    const result: Array<{ pluginId: string; name: string; currentVersion: string }> = []
    for (const entry of this.entries.values()) {
      if (entry.isDev) continue
      result.push({
        pluginId: entry.manifest.id,
        name: entry.manifest.name,
        currentVersion: entry.manifest.version,
      })
    }
    return result
  }

  // ───────────────────────── 内部：进程 ─────────────────────────

  private async ensureStarted(entry: PluginEntry): Promise<void> {
    if (entry.process !== undefined) {
      if (entry.status === 'ready') return
      if (entry.startPromise !== undefined) return await entry.startPromise
      return
    }
    if (entry.startPromise !== undefined) return await entry.startPromise
    if (!this.isEnabled(entry)) {
      throw new PluginRpcFailure('E_PLUGIN_DISABLED', '插件已停用')
    }
    if (!this.settings.plugins.enabled) {
      throw new PluginRpcFailure('E_PLUGIN_DISABLED', '插件总开关已关闭')
    }
    if (this.runningCount() >= PLUGIN_MAX_RUNNING) {
      throw new PluginRpcFailure(
        'E_PLUGIN_NOT_READY',
        `同时运行的插件已达上限 ${PLUGIN_MAX_RUNNING}`,
      )
    }

    entry.startPromise = (async () => {
      entry.status = 'starting'
      entry.lastError = undefined
      // eslint-disable-next-line prefer-const -- 回调闭包要先于赋值引用它
      let spawned: PluginProcessHandle | undefined
      const handle = this.options.processFactory.create(
        {
          pluginId: entry.manifest.id,
          root: entry.root,
          dataDir: join(this.paths.data, entry.manifest.id),
          isDev: entry.isDev,
          manifest: entry.manifest,
          config: entry.config,
          hostVersion: this.options.hostVersion,
        },
        {
          onExit: (code) => this.handleExit(entry, spawned, code),
          onOutput: (stream, line) => {
            const text = line.trim()
            if (text === '') return
            const log = this.options.logger.child(`plugin:${entry.manifest.id}`)
            if (stream === 'stderr') log.warn(text)
            else log.debug(text)
          },
        },
      )
      spawned = handle
      entry.process = handle
      // 插件 → 宿主的白名单调用（存储 / 网络 / 通知 / 配置 / 事件 / UI）
      handle.peer.setRequestHandler((method, params) =>
        this.handleClientCall(entry, method, params),
      )
      handle.peer.setEventHandler((event, payload) => {
        if (event !== 'plugin.fatal') return
        entry.lastError = typeof payload === 'string' ? payload : errorMessage(payload)
        this.options.logger.error('插件进程报告未捕获异常', {
          pluginId: entry.manifest.id,
          error: entry.lastError,
        })
      })
      handle.start()
      try {
        await handle.peer.request(
          PLUGIN_HOST_CALLS.init,
          {
            id: entry.manifest.id,
            version: entry.manifest.version,
            root: entry.root,
            main: join(entry.root, entry.manifest.main),
            dataDir: join(this.paths.data, entry.manifest.id),
            isDev: entry.isDev,
            config: entry.config,
            hostVersion: this.options.hostVersion,
          },
          { timeoutMs: PLUGIN_RPC_TIMEOUTS.init },
        )
        await handle.peer.request(
          PLUGIN_HOST_CALLS.activate,
          {},
          {
            timeoutMs: PLUGIN_RPC_TIMEOUTS.activate,
          },
        )
        entry.status = 'ready'
        this.startHeartbeat(entry)
        this.options.logger.info('插件已就绪', { pluginId: entry.manifest.id })
        this.emitChanged('ready')
      } catch (error) {
        entry.lastError = errorMessage(error)
        entry.status = 'error'
        entry.process = undefined
        handle.kill()
        throw error
      } finally {
        entry.startPromise = undefined
      }
    })()
    return await entry.startPromise
  }

  private handleExit(
    entry: PluginEntry,
    handle: PluginProcessHandle | undefined,
    code: number | null,
  ): void {
    // 主动停用 / 启动失败 / 已被新进程替换：只清引用，不按崩溃重启
    if (handle === undefined || entry.process !== handle) {
      this.clearHeartbeat(entry)
      return
    }
    this.clearHeartbeat(entry)
    entry.process = undefined
    if (entry.restartTimer !== undefined) {
      clearTimeout(entry.restartTimer)
      entry.restartTimer = undefined
    }
    if (this.stopping || !this.isEnabled(entry)) {
      entry.status = this.isEnabled(entry) ? 'stopped' : 'disabled'
      return
    }
    entry.status = 'crashed'
    entry.lastError = `插件进程退出（code ${code ?? 'unknown'}）`
    this.options.logger.warn('插件进程退出', {
      pluginId: entry.manifest.id,
      code,
      isDev: entry.isDev,
    })

    const now = Date.now()
    entry.crashTimes = entry.crashTimes.filter((at) => now - at < PLUGIN_RESTART_WINDOW_MS)
    entry.crashTimes.push(now)
    if (entry.crashTimes.length > PLUGIN_RESTART_BACKOFF.length) {
      entry.status = 'crashed'
      entry.lastError = '插件在 10 分钟内反复崩溃，已自动停用'
      if (entry.record !== undefined) {
        entry.record.enabled = false
        entry.record.updatedAt = new Date().toISOString()
        void this.saveRecord(entry.record).catch((error: unknown) => {
          this.options.logger.warn('插件自动停用状态写入失败', {
            pluginId: entry.manifest.id,
            error: errorMessage(error),
          })
        })
      }
      this.options.logger.error('插件反复崩溃，已自动停用', { pluginId: entry.manifest.id })
      this.emitChanged('crashed-disabled')
      return
    }

    const delay =
      PLUGIN_RESTART_BACKOFF[
        Math.min(entry.crashTimes.length - 1, PLUGIN_RESTART_BACKOFF.length - 1)
      ] ?? 15_000
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = undefined
      if (!this.isEnabled(entry) || this.stopping) return
      void this.ensureStarted(entry).catch((error: unknown) => {
        this.options.logger.warn('插件自动重启失败', {
          pluginId: entry.manifest.id,
          error: errorMessage(error),
        })
      })
    }, delay)
    entry.restartTimer.unref?.()
    this.emitChanged('crashed')
  }

  private async stopEntry(
    entry: PluginEntry,
    options: { status: PluginRuntimeStatus },
  ): Promise<void> {
    this.clearHeartbeat(entry)
    if (entry.restartTimer !== undefined) {
      clearTimeout(entry.restartTimer)
      entry.restartTimer = undefined
    }
    const handle = entry.process
    entry.process = undefined
    if (handle !== undefined) {
      try {
        await handle.peer.request(PLUGIN_HOST_CALLS.deactivate, {}, { timeoutMs: 3_000 })
      } catch {
        /* 超时 / 已崩溃：直接杀 */
      }
      handle.kill()
    }
    entry.status = options.status
  }

  private startHeartbeat(entry: PluginEntry): void {
    this.clearHeartbeat(entry)
    entry.heartbeatMisses = 0
    entry.heartbeat = setInterval(() => {
      const handle = entry.process
      if (handle === undefined) return
      void handle.peer
        .request(PLUGIN_HOST_CALLS.ping, {}, { timeoutMs: PLUGIN_RPC_TIMEOUTS.ping })
        .then(() => {
          entry.heartbeatMisses = 0
        })
        .catch(() => {
          entry.heartbeatMisses += 1
          if (entry.heartbeatMisses >= PLUGIN_HEARTBEAT.maxMisses) {
            this.options.logger.warn('插件心跳超时，重启进程', {
              pluginId: entry.manifest.id,
            })
            handle.kill()
          }
        })
    }, PLUGIN_HEARTBEAT.intervalMs)
    entry.heartbeat.unref?.()
  }

  private clearHeartbeat(entry: PluginEntry): void {
    if (entry.heartbeat !== undefined) {
      clearInterval(entry.heartbeat)
      entry.heartbeat = undefined
    }
  }

  private runningCount(): number {
    let count = 0
    for (const entry of this.entries.values()) {
      if (entry.process !== undefined) count += 1
    }
    return count
  }

  // ───────────────────────── 内部：宿主 API ─────────────────────────

  private requireEntry(pluginId: string): PluginEntry {
    const entry = this.entries.get(pluginId)
    if (entry === undefined) {
      throw new PluginRpcFailure('E_PLUGIN_NOT_READY', `插件不存在：${pluginId}`)
    }
    return entry
  }

  private requireEnabled(pluginId: string, permission: PluginPermission): PluginEntry {
    const entry = this.requireEntry(pluginId)
    if (!this.isEnabled(entry)) {
      throw new PluginRpcFailure('E_PLUGIN_DISABLED', '插件已停用')
    }
    if (!hasPermission(entry.manifest.permissions, permission)) {
      throw new PluginRpcFailure('E_PLUGIN_PERMISSION', `插件未声明权限「${permission}」`)
    }
    return entry
  }

  private isEnabled(entry: PluginEntry): boolean {
    if (this.stopping) return false
    if (!this.settings.plugins.enabled) return false
    if (entry.isDev) return true
    return entry.record?.enabled !== false
  }

  /** 插件 → 宿主的白名单调用。未知方法 / 缺权限一律拒绝。 */
  private async handleClientCall(
    entry: PluginEntry,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    const raw =
      typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {}

    if (method === PLUGIN_CLIENT_CALLS.log) {
      const level = raw['level']
      const message = typeof raw['message'] === 'string' ? raw['message'] : ''
      const detail = raw['detail']
      const log = this.options.logger.child(`plugin:${entry.manifest.id}`)
      const text = message.slice(0, LOG_MESSAGE_MAX)
      if (level === 'error') log.error(text, { detail })
      else if (level === 'warn') log.warn(text, { detail })
      else if (level === 'info') log.info(text, { detail })
      else log.debug(text, { detail })
      return { ok: true }
    }

    if (method === PLUGIN_CLIENT_CALLS.storageGet) {
      this.requirePermission(entry, 'storage')
      const key = this.requireStorageKey(raw['key'])
      return entry.storage[key] ?? null
    }
    if (method === PLUGIN_CLIENT_CALLS.storageSet) {
      this.requirePermission(entry, 'storage')
      const key = this.requireStorageKey(raw['key'])
      const value = raw['value']
      const bytes = Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
      if (bytes > PLUGIN_STORAGE_VALUE_MAX_BYTES) {
        throw new PluginRpcFailure('E_PLUGIN_INVALID_ARGS', '单个存储值超过 256 KB')
      }
      const previousBytes =
        entry.storage[key] === undefined
          ? 0
          : Buffer.byteLength(JSON.stringify(entry.storage[key]) ?? '', 'utf8')
      if (this.storageBytes(entry) - previousBytes + bytes > PLUGIN_STORAGE_MAX_BYTES) {
        throw new PluginRpcFailure('E_PLUGIN_INVALID_ARGS', '插件存储超过 5 MB 配额')
      }
      entry.storage[key] = value
      await this.writeStorage(entry)
      return { ok: true }
    }
    if (method === PLUGIN_CLIENT_CALLS.storageDelete) {
      this.requirePermission(entry, 'storage')
      const key = this.requireStorageKey(raw['key'])
      delete entry.storage[key]
      await this.writeStorage(entry)
      return { ok: true }
    }
    if (method === PLUGIN_CLIENT_CALLS.storageList) {
      this.requirePermission(entry, 'storage')
      return Object.keys(entry.storage)
    }

    if (method === PLUGIN_CLIENT_CALLS.getConfig) {
      this.requirePermission(entry, 'config')
      return { ...entry.config }
    }
    if (method === PLUGIN_CLIENT_CALLS.setConfig) {
      this.requirePermission(entry, 'config')
      const sanitized = sanitizeConfig(
        entry.manifest.config.fields,
        raw['values'] as Record<string, unknown>,
      )
      entry.config = { ...entry.config, ...sanitized }
      await this.writeData(entry.manifest.id, 'config.json', entry.config)
      return { ...entry.config }
    }

    if (method === PLUGIN_CLIENT_CALLS.notify) {
      this.requirePermission(entry, 'notifications')
      const title = typeof raw['title'] === 'string' ? raw['title'].slice(0, 120) : ''
      const body = typeof raw['body'] === 'string' ? raw['body'].slice(0, 800) : ''
      const shown = this.options.notify?.({ title: title || entry.manifest.name, body }) ?? false
      return shown
    }

    if (method === PLUGIN_CLIENT_CALLS.openPanel) {
      this.requirePermission(entry, 'ui.panels')
      const panelId = typeof raw['panelId'] === 'string' ? raw['panelId'] : ''
      const panel = entry.manifest.contributes.panels.find((item) => item.id === panelId)
      if (panel === undefined) {
        throw new PluginRpcFailure('E_PLUGIN_INVALID_ARGS', `插件未声明面板：${panelId}`)
      }
      this.options.onOpenPanel?.(entry.manifest.id, panelId)
      return { ok: true }
    }
    if (method === PLUGIN_CLIENT_CALLS.toast) {
      this.requirePermission(entry, 'ui.panels')
      const message = typeof raw['message'] === 'string' ? raw['message'].slice(0, 500) : ''
      const kind = raw['kind'] === 'error' ? 'error' : 'info'
      this.options.onToast?.(entry.manifest.id, message, kind)
      return { ok: true }
    }

    if (method === PLUGIN_CLIENT_CALLS.panelEvent) {
      const panelId = typeof raw['panelId'] === 'string' ? raw['panelId'].trim() : ''
      const widgetId = typeof raw['widgetId'] === 'string' ? raw['widgetId'].trim() : ''
      if ((panelId === '') === (widgetId === '')) {
        throw new PluginRpcFailure(
          'E_PLUGIN_INVALID_ARGS',
          'panelId 与 widgetId 必须且只能提供一个',
        )
      }
      const event = typeof raw['event'] === 'string' ? raw['event'] : ''
      if (!PLUGIN_PANEL_EVENT.namePattern.test(event)) {
        throw new PluginRpcFailure('E_PLUGIN_INVALID_ARGS', `事件名非法：${event}`)
      }
      if (panelId !== '') {
        this.requirePermission(entry, 'ui.panels')
        const declared = entry.manifest.contributes.panels.some((item) => item.id === panelId)
        if (!declared) {
          throw new PluginRpcFailure('E_PLUGIN_INVALID_ARGS', `插件未声明面板：${panelId}`)
        }
      } else {
        this.requirePermission(entry, 'ui.widgets')
        const declared = entry.manifest.contributes.widgets.some((item) => item.id === widgetId)
        if (!declared) {
          throw new PluginRpcFailure('E_PLUGIN_INVALID_ARGS', `插件未声明小组件：${widgetId}`)
        }
      }
      const payload = raw['payload']
      if (Buffer.byteLength(JSON.stringify(payload) ?? '', 'utf8') > PLUGIN_PANEL_EVENT.payloadMaxBytes) {
        throw new PluginRpcFailure('E_PLUGIN_INVALID_ARGS', '事件载荷超过 64 KB')
      }
      if (!this.consumePanelEventBudget(entry.manifest.id)) {
        this.options.logger.warn('插件事件推送超过限速，已丢弃', {
          pluginId: entry.manifest.id,
          event,
          limit: PLUGIN_PANEL_EVENT.ratePerSecond,
        })
        return { ok: true, dropped: true }
      }
      this.options.onPanelEvent?.({
        pluginId: entry.manifest.id,
        ...(panelId === '' ? {} : { panelId }),
        ...(widgetId === '' ? {} : { widgetId }),
        event,
        payload,
      })
      return { ok: true }
    }

    if (method === PLUGIN_CLIENT_CALLS.emitEvent) {
      this.requirePermission(entry, 'automation.events')
      const name = typeof raw['name'] === 'string' ? raw['name'] : ''
      const declared = entry.manifest.contributes.automation.events.some(
        (event) => event.name === name,
      )
      if (!declared) {
        throw new PluginRpcFailure('E_PLUGIN_INVALID_ARGS', `插件未声明自动化事件：${name}`)
      }
      this.options.onAutomationEvent?.({
        pluginId: entry.manifest.id,
        pluginName: entry.manifest.name,
        event: name,
        data: raw['payload'],
      })
      return { ok: true }
    }

    if (method === PLUGIN_CLIENT_CALLS.netFetch) {
      this.requirePermission(entry, 'net')
      return await this.handleNetFetch(entry, raw)
    }

    throw new PluginRpcFailure('E_PLUGIN_PERMISSION', `不允许的宿主调用：${method}`)
  }

  private requirePermission(entry: PluginEntry, permission: PluginPermission): void {
    if (!hasPermission(entry.manifest.permissions, permission)) {
      throw new PluginRpcFailure('E_PLUGIN_PERMISSION', `插件未声明权限「${permission}」`)
    }
  }

  /** 滑动 1s 窗口：返回 false 表示本轮应丢弃（不抛错，避免打断插件）。 */
  private consumePanelEventBudget(pluginId: string): boolean {
    const now = Date.now()
    const recent = (this.panelEventTimes.get(pluginId) ?? []).filter((at) => now - at < 1000)
    if (recent.length >= PLUGIN_PANEL_EVENT.ratePerSecond) {
      this.panelEventTimes.set(pluginId, recent)
      return false
    }
    recent.push(now)
    this.panelEventTimes.set(pluginId, recent)
    return true
  }

  private requireStorageKey(value: unknown): string {
    if (
      typeof value !== 'string' ||
      !STORAGE_KEY_PATTERN.test(value) ||
      value.length > STORAGE_KEY_MAX
    ) {
      throw new PluginRpcFailure(
        'E_PLUGIN_INVALID_ARGS',
        '存储键必须是 1–128 位字母 / 数字 / _ . : -',
      )
    }
    return value
  }

  private storageBytes(entry: PluginEntry): number {
    return Buffer.byteLength(JSON.stringify(entry.storage) ?? '', 'utf8')
  }

  private async handleNetFetch(
    entry: PluginEntry,
    raw: Record<string, unknown>,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const url = typeof raw['url'] === 'string' ? raw['url'].trim() : ''
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new PluginRpcFailure('E_PLUGIN_INVALID_ARGS', 'URL 非法')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new PluginRpcFailure('E_PLUGIN_INVALID_ARGS', '只允许 http / https')
    }
    if (
      isPrivateHost(parsed.hostname) &&
      !hasPermission(entry.manifest.permissions, 'net.private')
    ) {
      throw new PluginRpcFailure(
        'E_PLUGIN_PERMISSION',
        '访问本机 / 私网地址需要「net.private」权限',
      )
    }
    const fetchImpl = this.options.resolveFetch?.() ?? globalThis.fetch
    const timeoutMs = Math.min(
      Math.max(typeof raw['timeoutMs'] === 'number' ? raw['timeoutMs'] : 30_000, 1_000),
      120_000,
    )
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const method = typeof raw['method'] === 'string' ? raw['method'].toUpperCase() : 'GET'
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
        throw new PluginRpcFailure('E_PLUGIN_INVALID_ARGS', `不支持的 HTTP 方法：${method}`)
      }
      const headers: Record<string, string> = {}
      if (typeof raw['headers'] === 'object' && raw['headers'] !== null) {
        for (const [key, value] of Object.entries(raw['headers'] as Record<string, unknown>)) {
          if (typeof value === 'string') headers[key] = value
        }
      }
      const response = await fetchImpl(parsed.toString(), {
        method,
        headers,
        ...(typeof raw['body'] === 'string' ? { body: raw['body'] } : {}),
        signal: controller.signal,
        redirect: 'follow',
      })
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.byteLength > PLUGIN_NET_MAX_RESPONSE_BYTES) {
        throw new PluginRpcFailure('E_PLUGIN_INVALID_ARGS', '响应超过 5 MB 上限')
      }
      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value
      })
      return {
        status: response.status,
        headers: responseHeaders,
        body: buffer.toString('utf8'),
      }
    } finally {
      clearTimeout(timer)
    }
  }

  // ───────────────────────── 内部：条目与数据 ─────────────────────────

  private async loadInstalledEntry(id: string, record: InstalledPluginRecord): Promise<void> {
    const loaded = await readPluginManifest(record.installPath, {
      hostVersion: this.options.hostVersion,
      isDev: false,
    })
    if (!loaded.ok || loaded.plugin === undefined) {
      this.options.logger.warn('已安装插件无法加载，保留记录等待修复 / 卸载', {
        pluginId: id,
        errors: loaded.errors,
      })
      return
    }
    if (loaded.plugin.manifest.id !== id) {
      this.options.logger.warn('插件目录与 registry id 不一致，已跳过', {
        pluginId: id,
        manifestId: loaded.plugin.manifest.id,
      })
      return
    }
    const data = await this.readDataFiles(id, loaded.plugin.manifest)
    this.entries.set(id, {
      manifest: loaded.plugin.manifest,
      root: record.installPath,
      isDev: false,
      record,
      status: record.enabled ? 'stopped' : 'disabled',
      ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
      config: data.config,
      storage: data.storage,
      loadedAt: new Date().toISOString(),
      heartbeatMisses: 0,
      crashTimes: [],
    })
  }

  private async reloadDevEntries(dirs: string[], options: { notify: boolean }): Promise<void> {
    const next = new Set(dirs.filter((dir) => dir.trim() !== ''))
    for (const dir of [...this.devDirs]) {
      if (next.has(dir)) continue
      const entry = [...this.entries.values()].find((item) => item.isDev && item.root === dir)
      if (entry !== undefined) {
        await this.stopEntry(entry, { status: 'disabled' })
        this.entries.delete(entry.manifest.id)
      }
      this.devDirs.delete(dir)
    }

    for (const dir of next) {
      if (this.devDirs.has(dir)) continue
      const loaded = await readPluginManifest(dir, {
        hostVersion: this.options.hostVersion,
        isDev: true,
      })
      if (!loaded.ok || loaded.plugin === undefined) {
        this.options.logger.warn('开发目录插件加载失败', { dir, errors: loaded.errors })
        this.devDirs.add(dir)
        continue
      }
      const id = loaded.plugin.manifest.id
      const installed = this.entries.get(id)
      if (installed !== undefined && !installed.isDev) {
        this.options.logger.warn('开发目录插件与已安装插件 id 相同，开发版优先', {
          pluginId: id,
          dir,
        })
        await this.stopEntry(installed, { status: 'stopped' })
      }
      const data = await this.readDataFiles(id, loaded.plugin.manifest)
      this.entries.set(id, {
        manifest: loaded.plugin.manifest,
        root: dir,
        isDev: true,
        status: this.settings.plugins.enabled ? 'stopped' : 'disabled',
        config: data.config,
        storage: data.storage,
        loadedAt: new Date().toISOString(),
        heartbeatMisses: 0,
        crashTimes: [],
      })
      this.devDirs.add(dir)
    }

    if (options.notify) this.emitChanged('dev-dirs')
  }

  private enabledManifests(): Array<{ id: string; manifest: PluginManifest }> {
    return [...this.entries.values()].map((entry) => ({
      id: entry.manifest.id,
      manifest: entry.manifest,
    }))
  }

  private installedRecords(): Record<string, InstalledPluginRecord> {
    const records: Record<string, InstalledPluginRecord> = {}
    for (const entry of this.entries.values()) {
      if (entry.record !== undefined) records[entry.manifest.id] = entry.record
    }
    return records
  }

  private async saveRecord(record: InstalledPluginRecord): Promise<void> {
    const records = await this.registry.load()
    records[record.id] = record
    await this.registry.save(records)
  }

  private configFile(pluginId: string): string {
    return join(this.paths.data, pluginId, 'config.json')
  }

  private storageFile(pluginId: string): string {
    return join(this.paths.data, pluginId, 'storage.json')
  }

  private async readDataFiles(
    pluginId: string,
    manifest: PluginManifest,
  ): Promise<{
    config: Record<string, unknown>
    storage: Record<string, unknown>
  }> {
    const stored = await readJsonFile<Record<string, unknown>>(this.configFile(pluginId), {})
    const config = { ...defaultsFor(manifest.config.fields), ...stored }
    const storage = await readJsonFile<Record<string, unknown>>(this.storageFile(pluginId), {})
    return { config, storage }
  }

  private async writeData(pluginId: string, name: string, value: unknown): Promise<void> {
    await writeJsonAtomic(join(this.paths.data, pluginId, name), value)
  }

  private async writeStorage(entry: PluginEntry): Promise<void> {
    // 配额检查以实际序列化后的字节数为准（键 + 值 + JSON 结构）
    if (this.storageBytes(entry) > PLUGIN_STORAGE_MAX_BYTES) {
      throw new PluginRpcFailure('E_PLUGIN_INVALID_ARGS', '插件存储超过 5 MB 配额')
    }
    await this.writeData(entry.manifest.id, 'storage.json', entry.storage)
  }

  private toSummary(entry: PluginEntry): PluginSummary {
    const manifest = entry.manifest
    const record = entry.record
    const trusted = record?.trusted === true
    const tools: PluginToolInfo[] = manifest.contributes.tools.map((tool) => ({
      name: tool.name,
      fullName: pluginToolName(manifest.id, tool.name),
      description: tool.description,
      sensitivity: trusted && tool.sensitivity === 'safe' ? 'safe' : 'confirm',
      readonly: tool.readonly,
    }))
    const commands: PluginCommandInfo[] = manifest.contributes.commands.map((command) => ({
      pluginId: manifest.id,
      pluginName: manifest.name,
      name: command.name,
      title: command.title,
      description: command.description,
      mode: command.mode,
    }))
    const panels: PluginPanelInfo[] = manifest.contributes.panels.map((panel) => ({
      pluginId: manifest.id,
      pluginName: manifest.name,
      id: panel.id,
      title: panel.title,
      icon: normalizePluginPanelIcon(panel.icon),
      kind: panel.schema === undefined ? 'page' : 'schema',
      ...(panel.entry === undefined ? {} : { entry: panel.entry }),
    }))
    const themes: PluginThemeInfo[] = manifest.contributes.themes.map((theme) => ({
      pluginId: manifest.id,
      pluginName: manifest.name,
      id: theme.id,
      name: theme.name,
      tokens: { ...theme.tokens },
    }))
    const widgets: PluginWidgetInfo[] = manifest.contributes.widgets.map((widget) => ({
      pluginId: manifest.id,
      pluginName: manifest.name,
      id: widget.id,
      title: widget.title,
      ...(widget.icon === undefined ? {} : { icon: normalizePluginPanelIcon(widget.icon) }),
      slot: widget.slot,
      kind: widget.schema === undefined ? 'page' : 'schema',
      ...(widget.entry === undefined ? {} : { entry: widget.entry }),
      ...(widget.defaultSize === undefined ? {} : { defaultSize: { ...widget.defaultSize } }),
    }))
    const automationActions: PluginAutomationActionInfo[] =
      manifest.contributes.automation.actions.map((action) => ({
        pluginId: manifest.id,
        pluginName: manifest.name,
        name: action.name,
        title: action.title,
        description: action.description,
      }))
    const automationEvents: PluginAutomationEventInfo[] =
      manifest.contributes.automation.events.map((event) => ({
        pluginId: manifest.id,
        pluginName: manifest.name,
        name: event.name,
        title: event.title,
        ...(event.description === undefined ? {} : { description: event.description }),
      }))

    const status: PluginRuntimeStatus = this.isEnabled(entry)
      ? entry.status
      : this.settings.plugins.enabled
        ? 'disabled'
        : 'disabled'

    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author.name,
      ...(manifest.license === undefined ? {} : { license: manifest.license }),
      ...(manifest.homepage === undefined ? {} : { homepage: manifest.homepage }),
      enabled: entry.isDev ? true : record?.enabled !== false,
      trusted,
      source: entry.isDev ? 'dev' : (record?.source ?? 'local'),
      status,
      activeVersion: manifest.version,
      ...(record?.previousVersion === undefined ? {} : { previousVersion: record.previousVersion }),
      installPath: entry.root,
      ...(record?.checksum === undefined ? {} : { checksum: record.checksum }),
      installedAt: record?.installedAt ?? entry.loadedAt,
      updatedAt: record?.updatedAt ?? entry.loadedAt,
      ...(entry.lastError === undefined ? {} : { lastError: entry.lastError }),
      isDev: entry.isDev,
      permissions: [...manifest.permissions] as PluginPermission[],
      tools,
      commands,
      panels,
      widgets,
      themes,
      automationActions,
      automationEvents,
      configFields: manifest.config.fields.map((field) => ({ ...field })),
      events: [...manifest.events],
      skills: [...manifest.contributes.skills],
    }
  }

  private emitChanged(reason: string): void {
    if (this.changedTimer !== undefined) return
    this.changedTimer = setTimeout(() => {
      this.changedTimer = undefined
      this.options.onChanged?.(reason)
    }, 50)
    this.changedTimer.unref?.()
  }
}

export type { PluginInstallPaths }
