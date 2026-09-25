/**
 * SettingsStore —— 配置读写、Schema 校验、版本迁移、凭据加密（docs/08 §2）。
 *
 * 行为要点：
 * - 读取：读盘 → JSON 解析 → 迁移 → 字段级 sanitize（非法字段回退默认并记日志）。
 * - 整份文件解析失败：备份为 `config.corrupt-<ts>.json` 后重建默认（不静默丢数据）。
 * - 写入：原子写 + 300ms 防抖；`flush()` 可强制立刻落盘（退出前调用）。
 * - 凭据：`llm.providers.<id>.apiKey`、`tts.providers.<id>.apiKey`、`stt.providers.<id>.apiKey`、
 *   `imagegen.providers.<id>.apiKey`、`mcp.servers.<name>.env.<KEY>` 为敏感路径，
 *   写盘时加密为 `apiKeyEnc` / `envEnc`；加密不可用时凭据只驻留内存，绝不落盘明文。
 */
import { join } from 'node:path'
import {
  SettingsSchema,
  WINDOW_NAMES,
  fieldAccepts,
  isDynamicPath,
  type Settings,
} from './schema.js'
import { createDefaultSettings } from './defaults.js'
import { migrate, readVersion, type MigrationOutcome } from './migrations.js'
import {
  cleanupTempFiles,
  identityCrypto,
  nodeFileSystem,
  type CryptoPort,
  type FileSystemPort,
} from './ports.js'
import { createNoopLogger, type Logger } from '../utils/logger.js'
import {
  deepClone,
  isPlainObject,
  sanitizeWithDefaults,
  type SanitizeIssue,
} from '../utils/object.js'

export const CONFIG_FILE_NAME = 'config.json'
export const WRITE_DEBOUNCE_MS = 300
const MAX_BACKUPS = 5

export class SettingsSecretError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SettingsSecretError'
  }
}

export interface SettingsStoreOptions {
  /** 用户数据目录（主进程传 app.getPath('userData')） */
  dir: string
  crypto?: CryptoPort
  fs?: FileSystemPort
  logger?: Logger
  /** 防抖写盘间隔，测试可传 0 立即写 */
  writeDebounceMs?: number
  onWriteError?: (error: Error) => void
}

export interface InitReport {
  path: string
  created: boolean
  corrupted: boolean
  backupPath?: string
  fromVersion: number
  appliedMigrations: string[]
  warnings: string[]
  sanitizeIssues: SanitizeIssue[]
  cryptoAvailable: boolean
  /** 首次运行 / 需要引导：没有可用的默认模型配置 */
  needsOnboarding: boolean
}

export type SettingsListener = (settings: Settings) => void

export class SettingsStore {
  readonly path: string
  private readonly dir: string
  private readonly crypto: CryptoPort
  private readonly fs: FileSystemPort
  private readonly logger: Logger
  private readonly writeDebounceMs: number
  private readonly onWriteError: ((error: Error) => void) | undefined

  private current: Settings = createDefaultSettings()
  private readonly listeners = new Set<SettingsListener>()
  private writeTimer: NodeJS.Timeout | undefined
  private writing: Promise<void> | undefined
  /** 内存配置领先于磁盘时为 true（防抖写的合并依据） */
  private dirty = false
  private readonly memorySecrets = new Map<string, string>()
  private lastSanitizeIssues: SanitizeIssue[] = []
  private lastReport: InitReport | undefined

  constructor(options: SettingsStoreOptions) {
    this.dir = options.dir
    this.path = join(options.dir, CONFIG_FILE_NAME)
    this.crypto = options.crypto ?? identityCrypto
    this.fs = options.fs ?? nodeFileSystem
    this.logger = options.logger ?? createNoopLogger()
    this.writeDebounceMs = options.writeDebounceMs ?? WRITE_DEBOUNCE_MS
    this.onWriteError = options.onWriteError
  }

  /** 初始化：读盘 / 迁移 / 校验。可重复调用（幂等）。 */
  async init(): Promise<InitReport> {
    await this.fs.mkdirp(this.dir)
    const removed = await cleanupTempFiles(this.fs, this.dir)
    if (removed.length > 0) this.logger.info('已清理临时配置文件', { removed })

    let created = false
    let corrupted = false
    /** 读盘时做过字段级修复（如摘掉已下线窗口几何）：需要立刻落盘，否则每次启动都要再修一遍 */
    let repaired = false
    let backupPath: string | undefined
    let raw: Record<string, unknown> | undefined

    if (!(await this.fs.exists(this.path))) {
      created = true
      this.logger.info('未发现配置文件，使用默认配置', { path: this.path })
    } else {
      try {
        const parsed: unknown = JSON.parse(await this.fs.readFile(this.path))
        if (!isPlainObject(parsed)) throw new Error('配置文件根节点不是对象')
        raw = parsed
      } catch (error) {
        corrupted = true
        this.logger.error('配置文件解析失败，已备份并重建默认配置', { error: String(error) })
        backupPath = await this.backupCorruptFile()
        raw = undefined
      }
    }

    const warnings: string[] = []
    let fromVersion = 0
    let appliedMigrations: string[] = []
    const defaults = deepClone(createDefaultSettings()) as unknown as Record<string, unknown>
    let candidate: Record<string, unknown> = deepClone(defaults)

    if (raw) {
      fromVersion = readVersion(raw)
      const outcome: MigrationOutcome = migrate(raw, this.logger)
      warnings.push(...outcome.warnings)
      appliedMigrations = outcome.applied
      // 已下线窗口的几何残留：`general.windowState` 是 `z.record(WindowNameSchema, …)`，
      // 而动态键路径在 sanitize 里**不校验键**，于是这类键会一路活到 `SettingsSchema.parse` 并硬抛
      // —— 表现为「应用起不来」，而不是文档写的「备份后重建」。迁移只在 `version < 当前` 时才跑，
      // 所以「声明已是 v4、却还留着 service-dock」这种文件不会被迁移链覆盖。
      // 这里按 `WINDOW_NAMES` 精确摘掉未知键：只丢一个窗口几何，用户的其它配置一个不动。
      const prunedWarnings = pruneUnknownWindowState(outcome.data, this.logger)
      warnings.push(...prunedWarnings)
      repaired = prunedWarnings.length > 0
      const issues: SanitizeIssue[] = []
      candidate = sanitizeWithDefaults(
        outcome.data,
        defaults,
        fieldAccepts,
        issues,
        '',
        isDynamicPath,
      )
      if (issues.length > 0) {
        this.logger.warn('部分配置字段非法，已回退默认值', { issues })
      }
      this.lastSanitizeIssues = issues
    }

    let settings: Settings
    try {
      settings = SettingsSchema.parse(candidate)
    } catch (error) {
      // 兜底：任何 Schema 漂移都不该让应用**启动失败**。走与「文件损坏」同一条路——
      // 备份原文件 + 重建默认配置，用户能在设置页看到 `corrupted` 与备份路径。
      corrupted = true
      this.logger.error('配置校验失败，已备份并重建默认配置', { error: String(error) })
      backupPath = await this.backupCorruptFile()
      settings = SettingsSchema.parse(deepClone(defaults))
    }
    if (settings.llm.active !== '' && !settings.llm.providers[settings.llm.active]) {
      warnings.push(`默认模型配置 "${settings.llm.active}" 不存在，已重置为未配置`)
      settings.llm.active = ''
    }
    this.current = settings

    // 历史明文凭据（v0 迁移而来）在此补加密，之后才允许首次落盘
    const encrypted = this.encryptStoredSecrets()

    // 首次运行 / 迁移 / 字段回退 / 字段修复都值得立刻落盘一次
    if (created || corrupted || repaired || appliedMigrations.length > 0 || encrypted > 0) {
      this.scheduleWrite(0)
    }

    const report: InitReport = {
      path: this.path,
      created,
      corrupted,
      ...(backupPath === undefined ? {} : { backupPath }),
      fromVersion,
      appliedMigrations,
      warnings,
      sanitizeIssues: this.lastSanitizeIssues,
      cryptoAvailable: this.crypto.isAvailable(),
      needsOnboarding: this.needsOnboarding(),
    }
    this.lastReport = report
    if (!report.cryptoAvailable) {
      this.logger.warn('safeStorage 不可用：API Key 只驻留内存，不会写入磁盘')
    }
    this.logger.info('配置初始化完成', {
      path: report.path,
      created,
      corrupted,
      appliedMigrations: appliedMigrations.length,
      needsOnboarding: report.needsOnboarding,
    })
    return report
  }

  get lastInitReport(): InitReport | undefined {
    return this.lastReport
  }

  /** 返回配置深拷贝，避免调用方直接改内部状态。 */
  get(): Settings {
    return deepClone(this.current)
  }

  /** 主功能是否可用：必须存在可用的默认模型配置。 */
  needsOnboarding(): boolean {
    const { active, providers } = this.current.llm
    if (active === '') return true
    const provider = providers[active]
    return provider === undefined || provider.apiKeyEnc === ''
  }

  isCryptoAvailable(): boolean {
    return this.crypto.isAvailable()
  }

  get dataDir(): string {
    return this.dir
  }

  onChange(listener: SettingsListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 变更配置：默认浅合并到顶层字段；传 `replace: true` 时整份替换。 */
  update(
    patch: Partial<Settings> | Settings,
    options: { replace?: boolean } = {},
  ): Settings | undefined {
    const next = options.replace
      ? (deepClone(patch) as Settings)
      : ({ ...deepClone(this.current), ...deepClone(patch) } as Settings)

    const sanitized = this.sanitize(next)
    if (!sanitized) {
      this.logger.warn('配置更新被拒绝：校验失败')
      return undefined
    }
    this.current = sanitized
    this.scheduleWrite()
    this.emit()
    return this.get()
  }

  /** 高级用法：在可变副本上做任意修改，再统一校验落盘。 */
  mutate(mutator: (draft: Settings) => void): Settings | undefined {
    const draft = this.get()
    mutator(draft)
    return this.update(draft, { replace: true })
  }

  // ───────────────────────── 凭据 ─────────────────────────

  /** 读取解密后的凭据；不存在或解密失败返回 ''。 */
  getSecret(path: string): string {
    const key = canonicalSecretPath(path)
    const cached = this.memorySecrets.get(key)
    if (cached !== undefined) return cached
    const stored = this.readSecretField(key)
    if (stored === undefined || stored === '') return ''
    if (!this.crypto.isAvailable()) return ''
    try {
      return this.crypto.decrypt(stored)
    } catch (error) {
      this.logger.error('凭据解密失败', { path: key, error: String(error) })
      return ''
    }
  }

  /**
   * 写入凭据：加密后落盘。
   *
   * 内存明文的写入**必须晚于**路径存在性校验：`writeSecretField` 失败时抛错不回滚，
   * 提前 `set` 会把明文永久留在 `memorySecrets` 里 —— 表现为「抛了错但 `getSecret` 还读得出」，
   * 且该路径之后若真的建出同名条目，会凭空继承这份明文（磁盘却是空的 → `apiKeySet` 误报）。
   *
   * @returns true = 已加密落盘；false = 加密不可用，仅缓存在内存（绝不落盘明文）。
   */
  setSecret(path: string, plain: string): boolean {
    const key = canonicalSecretPath(path)
    if (!this.crypto.isAvailable()) {
      this.logger.warn('safeStorage 不可用，凭据仅保存在内存中', { path: key })
      this.memorySecrets.set(key, plain)
      return false
    }
    const cipher = this.crypto.encrypt(plain)
    if (cipher === '') {
      this.logger.error('凭据加密返回空值，已拒绝写入磁盘', { path: key })
      this.memorySecrets.set(key, plain)
      return false
    }
    // 先落盘（内部做路径存在性校验）再写内存：失败时抛错，内存里不会留下这份明文。
    if (!this.writeSecretField(key, cipher)) {
      throw new SettingsSecretError(`无法识别的凭据路径：${key}`)
    }
    this.memorySecrets.set(key, plain)
    return true
  }

  clearSecret(path: string): void {
    const key = canonicalSecretPath(path)
    this.memorySecrets.delete(key)
    if (!this.writeSecretField(key, '')) {
      this.logger.warn('清除凭据时路径无法识别', { path: key })
    }
  }

  /** 导出脱敏配置（日志 / 用户导出场景，docs/06 §10）。 */
  exportRedacted(): Settings {
    const clone = this.get()
    for (const provider of Object.values(clone.llm.providers)) {
      provider.apiKeyEnc = provider.apiKeyEnc === '' ? '' : '***'
    }
    for (const provider of Object.values(clone.tts.providers)) {
      provider.apiKeyEnc = provider.apiKeyEnc === '' ? '' : '***'
    }
    for (const provider of Object.values(clone.stt.providers)) {
      provider.apiKeyEnc = provider.apiKeyEnc === '' ? '' : '***'
    }
    for (const provider of Object.values(clone.imagegen.providers)) {
      provider.apiKeyEnc = provider.apiKeyEnc === '' ? '' : '***'
    }
    for (const server of clone.mcp.servers) {
      for (const envKey of Object.keys(server.envEnc)) {
        server.envEnc[envKey] = '***'
      }
    }
    return clone
  }

  /** 立即落盘（退出前 / 单测使用）：反复排空写入队列，直到没有待写变更。 */
  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = undefined
    }
    for (let guard = 0; guard < 8; guard++) {
      await this.writeNow()
      if (!this.dirty) return
    }
  }

  dispose(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = undefined
    }
    this.listeners.clear()
  }

  // ───────────────────────── 内部 ─────────────────────────

  private sanitize(input: Settings): Settings | undefined {
    const parsed = SettingsSchema.safeParse(input)
    if (!parsed.success) {
      this.logger.warn('配置不符合 Schema，更新被拒绝', {
        issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
      })
      return undefined
    }
    const settings = parsed.data
    if (settings.llm.active !== '' && settings.llm.providers[settings.llm.active] === undefined) {
      this.logger.warn('默认模型配置不存在，已重置为未配置', { active: settings.llm.active })
      settings.llm.active = ''
    }
    return settings
  }

  private emit(): void {
    const snapshot = this.get()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        this.logger.warn('配置监听器抛错', { error: String(error) })
      }
    }
  }

  private scheduleWrite(delayMs = this.writeDebounceMs): void {
    this.dirty = true
    if (this.writeTimer) clearTimeout(this.writeTimer)
    if (delayMs <= 0) {
      this.writeTimer = undefined
      void this.writeNow()
      return
    }
    const timer = setTimeout(() => {
      this.writeTimer = undefined
      void this.writeNow()
    }, delayMs)
    timer.unref?.()
    this.writeTimer = timer
  }

  /**
   * 落盘当前配置。多个来源（防抖定时器 / flush / 退出）可能同时触发：
   * 全部串行排队执行，**排到队时才读取最新内存配置并序列化**，
   * 因此永远不会写旧快照；队首无变更时直接跳过（自然合并）。
   */
  private writeNow(): Promise<void> {
    const run = (this.writing ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        if (!this.dirty) return
        this.dirty = false
        const payload = JSON.stringify(this.toPersisted(this.current), null, 2)
        try {
          await this.fs.writeFileAtomic(this.path, `${payload}\n`)
        } catch (error) {
          const wrapped = error instanceof Error ? error : new Error(String(error))
          this.dirty = true // 写失败保持脏标记，下次重试
          this.logger.error('配置文件写入失败', { error: wrapped.message })
          this.onWriteError?.(wrapped)
        }
      })

    // 写盘期间又发生变更 → 在队尾补一次（单层，不递归，避免失败时打转）
    this.writing = run.then(async () => {
      if (!this.dirty) return
      this.dirty = false
      const payload = JSON.stringify(this.toPersisted(this.current), null, 2)
      try {
        await this.fs.writeFileAtomic(this.path, `${payload}\n`)
      } catch (error) {
        const wrapped = error instanceof Error ? error : new Error(String(error))
        this.dirty = true
        this.logger.error('配置文件写入失败（补写）', { error: wrapped.message })
        this.onWriteError?.(wrapped)
      }
    })

    return this.writing
  }

  private async backupCorruptFile(): Promise<string | undefined> {
    const backupPath = join(this.dir, `config.corrupt-${Date.now()}.json`)
    try {
      await this.fs.rename(this.path, backupPath)
      await this.pruneBackups()
      return backupPath
    } catch (error) {
      this.logger.error('备份损坏配置失败', { error: String(error) })
      return undefined
    }
  }

  private async pruneBackups(): Promise<void> {
    try {
      const entries = (await this.fs.readdir(this.dir))
        .filter((name) => name.startsWith('config.corrupt-'))
        .sort()
      while (entries.length > MAX_BACKUPS) {
        const oldest = entries.shift()
        if (oldest !== undefined) await this.fs.remove(join(this.dir, oldest))
      }
    } catch {
      /* 备份清理失败不影响主流程 */
    }
  }

  /**
   * 把存量明文凭据补加密（v0 迁移 / 手改配置文件的情形）。
   * 通过"能否解密成功"判断是否已是密文；加密不可用时直接返回 0。
   * @returns 本次加密的字段数量
   */
  private encryptStoredSecrets(): number {
    if (!this.crypto.isAvailable()) return 0
    let count = 0

    const encryptIfPlain = (value: string): string => {
      if (value === '') return value
      if (this.isDecryptable(value)) return value
      const cipher = this.crypto.encrypt(value)
      if (cipher === '') {
        this.logger.error('存量凭据加密失败，已跳过（不会落盘明文）')
        return ''
      }
      count += 1
      return cipher
    }

    for (const [id, provider] of Object.entries(this.current.llm.providers)) {
      const next = encryptIfPlain(provider.apiKeyEnc)
      if (next !== provider.apiKeyEnc) {
        this.logger.info('已为存量 API Key 补加密', { provider: id })
        provider.apiKeyEnc = next
      }
    }

    for (const [id, provider] of Object.entries(this.current.tts.providers)) {
      const next = encryptIfPlain(provider.apiKeyEnc)
      if (next !== provider.apiKeyEnc) {
        this.logger.info('已为存量 TTS API Key 补加密', { provider: id })
        provider.apiKeyEnc = next
      }
    }

    for (const [id, provider] of Object.entries(this.current.stt.providers)) {
      const next = encryptIfPlain(provider.apiKeyEnc)
      if (next !== provider.apiKeyEnc) {
        this.logger.info('已为存量 STT API Key 补加密', { provider: id })
        provider.apiKeyEnc = next
      }
    }

    for (const [id, provider] of Object.entries(this.current.imagegen.providers)) {
      const next = encryptIfPlain(provider.apiKeyEnc)
      if (next !== provider.apiKeyEnc) {
        this.logger.info('已为存量生图 API Key 补加密', { provider: id })
        provider.apiKeyEnc = next
      }
    }

    for (const server of this.current.mcp.servers) {
      for (const [envKey, value] of Object.entries(server.envEnc)) {
        const next = encryptIfPlain(value)
        if (next !== value) {
          this.logger.info('已为存量 MCP 凭据补加密', { server: server.name, envKey })
          server.envEnc[envKey] = next
        }
      }
    }

    return count
  }
  private isDecryptable(value: string): boolean {
    try {
      this.crypto.decrypt(value)
      return true
    } catch {
      return false
    }
  }

  private readSecretField(key: string): string | undefined {
    const providerId = matchProviderKey(key)
    if (providerId !== undefined) return this.current.llm.providers[providerId]?.apiKeyEnc
    const ttsId = matchTtsProviderKey(key)
    if (ttsId !== undefined) return this.current.tts.providers[ttsId]?.apiKeyEnc
    const sttId = matchSttProviderKey(key)
    if (sttId !== undefined) return this.current.stt.providers[sttId]?.apiKeyEnc
    const imageGenId = matchImageGenProviderKey(key)
    if (imageGenId !== undefined) return this.current.imagegen.providers[imageGenId]?.apiKeyEnc
    const envMatch = matchMcpEnvKey(key)
    if (envMatch) {
      const server = this.current.mcp.servers.find((s) => s.name === envMatch.server)
      return server?.envEnc[envMatch.envKey]
    }
    return undefined
  }

  private writeSecretField(key: string, cipher: string): boolean {
    const providerId = matchProviderKey(key)
    if (providerId !== undefined) {
      // 条目不存在时必须返回 false：mutate 本身会成功返回（守卫是空操作），
      // 只看返回值会把「凭据没落盘」误报成写入成功。
      if (this.current.llm.providers[providerId] === undefined) return false
      return (
        this.mutate((draft) => {
          const provider = draft.llm.providers[providerId]
          if (provider === undefined) return
          provider.apiKeyEnc = cipher
        }) !== undefined
      )
    }
    const ttsId = matchTtsProviderKey(key)
    if (ttsId !== undefined) {
      if (this.current.tts.providers[ttsId] === undefined) return false
      return (
        this.mutate((draft) => {
          const provider = draft.tts.providers[ttsId]
          if (provider === undefined) return
          provider.apiKeyEnc = cipher
        }) !== undefined
      )
    }
    const sttId = matchSttProviderKey(key)
    if (sttId !== undefined) {
      if (this.current.stt.providers[sttId] === undefined) return false
      return (
        this.mutate((draft) => {
          const provider = draft.stt.providers[sttId]
          if (provider === undefined) return
          provider.apiKeyEnc = cipher
        }) !== undefined
      )
    }
    const imageGenId = matchImageGenProviderKey(key)
    if (imageGenId !== undefined) {
      if (this.current.imagegen.providers[imageGenId] === undefined) return false
      return (
        this.mutate((draft) => {
          const provider = draft.imagegen.providers[imageGenId]
          if (provider === undefined) return
          provider.apiKeyEnc = cipher
        }) !== undefined
      )
    }
    const envMatch = matchMcpEnvKey(key)
    if (envMatch) {
      if (!this.current.mcp.servers.some((s) => s.name === envMatch.server)) return false
      return (
        this.mutate((draft) => {
          const server = draft.mcp.servers.find((s) => s.name === envMatch.server)
          if (server === undefined) return
          if (cipher === '') delete server.envEnc[envMatch.envKey]
          else server.envEnc[envMatch.envKey] = cipher
        }) !== undefined
      )
    }
    return false
  }

  /**
   * 序列化前收敛：加密不可用时清空所有密文字段，
   * 保证"宁可不存，也不落盘不可加密的凭据"。
   */
  private toPersisted(settings: Settings): Settings {
    if (this.crypto.isAvailable()) return settings
    const clone = deepClone(settings)
    for (const provider of Object.values(clone.llm.providers)) provider.apiKeyEnc = ''
    for (const provider of Object.values(clone.tts.providers)) provider.apiKeyEnc = ''
    for (const provider of Object.values(clone.stt.providers)) provider.apiKeyEnc = ''
    for (const provider of Object.values(clone.imagegen.providers)) provider.apiKeyEnc = ''
    for (const server of clone.mcp.servers) server.envEnc = {}
    return clone
  }
}

// ───────────────────────── 工具 ─────────────────────────

function matchProviderKey(key: string): string | undefined {
  const matched = /^llm\.providers\.([^.]+)\.apiKey$/.exec(key)
  return matched?.[1]
}

function matchTtsProviderKey(key: string): string | undefined {
  const matched = /^tts\.providers\.([^.]+)\.apiKey$/.exec(key)
  return matched?.[1]
}

function matchSttProviderKey(key: string): string | undefined {
  const matched = /^stt\.providers\.([^.]+)\.apiKey$/.exec(key)
  return matched?.[1]
}

function matchImageGenProviderKey(key: string): string | undefined {
  const matched = /^imagegen\.providers\.([^.]+)\.apiKey$/.exec(key)
  return matched?.[1]
}

function matchMcpEnvKey(key: string): { server: string; envKey: string } | undefined {
  const matched = /^mcp\.servers\.([^.]+)\.env\.(.+)$/.exec(key)
  if (!matched) return undefined
  return { server: matched[1] as string, envKey: matched[2] as string }
}

/**
 * `llm.providers.<id>.apiKey` / `tts.providers.<id>.apiKey` / `stt.providers.<id>.apiKey` /
 * `imagegen.providers.<id>.apiKey` / `mcp.servers.<name>.env.<KEY>` → 内部规范路径
 */
export function canonicalSecretPath(path: string): string {
  const trimmed = path.trim().replace(/\.$/, '')
  const provider = /^llm\.providers\.([^.]+)\.apiKey(Enc)?$/.exec(trimmed)
  if (provider) return `llm.providers.${provider[1]}.apiKey`
  const tts = /^tts\.providers\.([^.]+)\.apiKey(Enc)?$/.exec(trimmed)
  if (tts) return `tts.providers.${tts[1]}.apiKey`
  const stt = /^stt\.providers\.([^.]+)\.apiKey(Enc)?$/.exec(trimmed)
  if (stt) return `stt.providers.${stt[1]}.apiKey`
  const imagegen = /^imagegen\.providers\.([^.]+)\.apiKey(Enc)?$/.exec(trimmed)
  if (imagegen) return `imagegen.providers.${imagegen[1]}.apiKey`
  const env = /^mcp\.servers\.([^.]+)\.env(Enc)?\.(.+)$/.exec(trimmed)
  if (env) return `mcp.servers.${env[1]}.env.${env[3]}`
  return trimmed
}

/**
 * 递归脱敏：apiKey / 各类 token / secret / password / authorization / envEnc 替换为 ***。
 * 注意不要用宽泛的 `key` 匹配——`keywords`（科目关键词）属正常业务字段。
 *
 * `.*api[-_]?key.*` 分支专门覆盖 `apiKeyEnc`（密文，绝不能随日志落盘）与 `apiKeySet`
 * （布尔标记，被判敏感后置 `***` 无害）；原分支是整体锚定的，两者都不命中。
 */
const SENSITIVE_KEY_PATTERN =
  /^(.*api[-_]?key.*|api[-_]?key|apikey|token|access[-_]?token|refresh[-_]?token|authorization|secret|client[-_]?secret|password|passwd|credential|envEnc|.*secret.*|.*password.*|.*credential.*)$/i

export function redactKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactKeys(item))
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      out[key] = '***'
      continue
    }
    out[key] = redactKeys(raw)
  }
  return out
}

/**
 * 摘掉 `general.windowState` 里**已下线窗口**的几何记录（就地修改 `raw`），返回警告文案。
 *
 * 背景：`windowState` 的 Schema 是 `z.record(WindowNameSchema, …)`，而 `sanitizeWithDefaults`
 * 把动态键路径（`llm.providers` / `general.windowState`）视为"键名任意"，不校验键合法性。
 * 于是 `service-dock` 这类已删除窗口的键会活到 `SettingsSchema.parse` 并**硬抛**，
 * 应用直接起不来；而迁移链只在 `version < CONFIG_VERSION` 时运行，兜不住
 * 「声明是 v4、却仍带旧键」的文件（正常升级路径是 v3 → 迁移删键，不受影响）。
 *
 * 只动这一个 record 的键，用户其它配置与其它窗口几何保持不变。
 */
export function pruneUnknownWindowState(raw: Record<string, unknown>, logger?: Logger): string[] {
  const general = raw['general']
  if (!isPlainObject(general)) return []
  const windowState = general['windowState']
  if (!isPlainObject(windowState)) return []
  const known = new Set<string>(WINDOW_NAMES)
  const retired = Object.keys(windowState).filter((key) => !known.has(key))
  if (retired.length === 0) return []
  for (const key of retired) delete windowState[key]
  logger?.warn('清理已下线窗口的几何记录', { retired })
  return [`已移除不再存在的窗口几何记录：${retired.join('、')}`]
}
