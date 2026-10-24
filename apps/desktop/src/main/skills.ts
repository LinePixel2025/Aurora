/**
 * Skill 服务（docs/06 §6、docs/08 §6）。
 *
 * 存在理由：`SkillsRegistry` 的 `userDir` 是**构造期固定**的，而设置项
 * `skills.userDir` 允许用户把它指到自定义目录（如云盘同步的技能包）。
 * 之前的实现硬编码 `userData/skills`，配置项存了也永远不生效 ——
 * 这正是「假开关」之一。这里把「按当前设置解析目录 + 目录变了就重建注册表」
 * 收在一处，避免调用方各自记着重建。
 *
 * 纯函数 `resolveSkillsUserDir` 单独导出，便于单测与「设置页展示实际生效路径」。
 */
import { mkdirSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { SkillsRegistry } from '@aurora/agent-core'
import type { Logger, Settings, SkillSummary, SkillsStatus } from '@aurora/shared'

/**
 * 解析生效的用户技能目录。
 * `skills.userDir` 为空串（默认）时回落到 `userData/skills`（docs/08 §1）。
 */
export function resolveSkillsUserDir(settings: Pick<Settings, 'skills'>, userData: string): string {
  const configured = settings.skills.userDir.trim()
  return configured === '' ? join(userData, 'skills') : configured
}

export interface SkillsServiceOptions {
  builtinDir: string
  /** 当前用户数据目录（`skills.userDir` 为空时的回落基准） */
  userData: string
  logger: Logger
  /**
   * 监听实现，仅供单测注入（默认 `node:fs` 的 `watch`）。
   * 真实 watch 的 error 行为随运行时漂移：Electron 33 / Node 20 对「监听根被删」报
   * EPERM，Electron 44 / Node 24 同场景只刷 change 风暴、根本不报错 —— error 分支
   * 只能靠假 watcher 钉住。
   */
  watchImpl?: typeof watch
}

/**
 * 包装 `SkillsRegistry`：负责目录重解析与状态上报。
 *
 * 目录变化时**复用同一个注册表实例**（`setUserDir` + 重扫），因为
 * `use_skill` 工具的闭包与提示词组装都持有该实例；换目录时新建实例会让
 * 它们继续指向旧表，表现为「改了目录但模型仍看到旧技能」。
 */
export class SkillsService {
  private readonly options: SkillsServiceOptions
  private readonly registry: SkillsRegistry
  private currentUserDir: string
  private scannedAt: string | null = null
  private lastWarnings: string[] = []

  constructor(options: SkillsServiceOptions, initialSettings: Settings) {
    this.options = options
    this.currentUserDir = resolveSkillsUserDir(initialSettings, options.userData)
    this.registry = new SkillsRegistry({
      builtinDir: options.builtinDir,
      userDir: this.currentUserDir,
      logger: options.logger.child('skills'),
    })
  }

  /**
   * 首次扫描（启动时调用）。
   *
   * 走 `reconfigure` 而不是"设 disabled + rescan"：构造器拿到的
   * `initialSettings` 只是为了先建出注册表，真正生效的目录必须以**这里的设置**为准
   * ——否则启动时 `skills.userDir` 会被忽略，用户的自定义技能目录要等改一次设置才生效。
   */
  async init(settings: Settings): Promise<SkillsStatus> {
    return this.reconfigure(settings)
  }

  get directory(): string {
    return this.currentUserDir
  }

  list(): SkillSummary[] {
    return this.registry.list().map((skill) => ({
      name: skill.name,
      description: skill.description,
      ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
      source: skill.source,
      ...(skill.pluginId === undefined ? {} : { pluginId: skill.pluginId }),
      hasScripts: skill.hasScripts,
      enabled: skill.enabled,
      dir: skill.dir,
    }))
  }

  /**
   * 注入插件贡献的 Skill 目录并重扫（docs/14）。
   * 冲突口径由 `SkillsRegistry` 决定：内置同名优先、用户同名覆盖插件、插件之间先到先得。
   */
  async setPluginDirs(dirs: Array<{ dir: string; pluginId: string }>): Promise<SkillsStatus> {
    this.registry.setPluginDirs(dirs)
    return this.rescan()
  }

  /** 供内核组装提示词 / 工具表使用 */
  get kernel(): SkillsRegistry {
    return this.registry
  }

  /** 应用设置里的 `skills.disabled`（`SkillsInfoLike` 的方法名）。 */
  setDisabled(names: readonly string[]): void {
    this.registry.setDisabled(names)
  }

  /**
   * 按当前设置重新解析目录并扫描。
   * 目录变化时切换注册表的用户目录（保留 disabled 集合），随后统一重扫。
   */
  async reconfigure(settings: Settings): Promise<SkillsStatus> {
    const nextDir = resolveSkillsUserDir(settings, this.options.userData)
    if (nextDir !== this.currentUserDir) {
      this.options.logger.info('用户技能目录已变更', {
        from: this.currentUserDir,
        to: nextDir,
      })
      this.currentUserDir = nextDir
      this.registry.setUserDir(nextDir)
      // 目录变了：旧目录的监听作废，改挂新目录（未 startWatching 时 no-op）
      this.rearmWatcher()
    }
    this.registry.setDisabled(settings.skills.disabled)
    return this.rescan()
  }

  async rescan(): Promise<SkillsStatus> {
    try {
      const report = await this.registry.scan()
      this.scannedAt = new Date().toISOString()
      this.lastWarnings = report.issues.map((issue) => `${issue.path}：${issue.error}`)
      return this.status()
    } catch (error) {
      this.options.logger.warn('技能扫描失败', { error: String(error) })
      this.lastWarnings = [`扫描失败：${String(error)}`]
      return this.status()
    }
  }

  status(): SkillsStatus {
    return {
      userDir: this.currentUserDir,
      builtinDir: this.options.builtinDir,
      total: this.registry.list().length,
      failed: this.lastWarnings.length,
      scannedAt: this.scannedAt,
      warnings: [...this.lastWarnings],
    }
  }

  /**
   * 监听用户技能目录（docs/06 §22.3）：create-skill 写完 SKILL.md、或用户手动
   * 拖入技能包后**自动重扫**，新技能下一次请求就进 `use_skill` 清单，无需重启。
   * 监听失败（目录被删 / 平台不支持）降级为日志告警，不影响既有技能表。
   */
  startWatching(onChanged?: () => void): void {
    this.onSkillsChanged = onChanged
    this.rearmWatcher()
  }

  stopWatching(): void {
    this.watcher?.close()
    this.watcher = undefined
    if (this.watchDebounce !== undefined) {
      clearTimeout(this.watchDebounce)
      this.watchDebounce = undefined
    }
    this.onSkillsChanged = undefined
  }

  private rearmWatcher(): void {
    this.watcher?.close()
    this.watcher = undefined
    try {
      // fs.watch 对不存在的目录直接抛 ENOENT；用户技能目录在首次创建技能前并不存在
      //（create-skill / 设置页都会往里写）——先建出来，顺带让"目录在哪"肉眼可查。
      mkdirSync(this.currentUserDir, { recursive: true })
      const watchFn = this.options.watchImpl ?? watch
      const watcher = watchFn(this.currentUserDir, { recursive: true }, () => this.scheduleRescan())
      // 建立**之后**的 error 不走上面的 try/catch，而是以事件到达（Electron 内置的 Node 20
      // 对「监听根被整树删除」报 EPERM —— capture/smoke 每轮收尾删临时 userData 就是这个
      // 现场）。不挂 error 监听它会变成未捕获异常，直通 Electron 的「A JavaScript error
      // occurred in the main process」弹窗并把进程挂住等点击。降级为告警并放弃监听（重挂走
      // startWatching / reconfigure），与 file-watcher 的 error 处理同款口径。
      watcher.on('error', (error) => {
        watcher.close()
        // 旧 watcher 的迟到 error：新监听已挂上，安静丢弃，不误清也不刷告警
        if (this.watcher !== watcher) return
        this.watcher = undefined
        this.options.logger.warn('技能目录监听出错，已停止自动重扫（改设置或重启可恢复）', {
          dir: this.currentUserDir,
          error: String(error),
        })
      })
      this.watcher = watcher
    } catch (error) {
      this.options.logger.warn('技能目录监听失败，新技能需手动重扫或改设置触发', {
        dir: this.currentUserDir,
        error: String(error),
      })
    }
  }

  private scheduleRescan(): void {
    // 防抖：编辑器保存常触发多轮事件，500ms 静默期后扫一次即可
    if (this.watchDebounce !== undefined) return
    this.watchDebounce = setTimeout(() => {
      this.watchDebounce = undefined
      void this.rescan().then(() => this.onSkillsChanged?.())
    }, 500)
    this.watchDebounce.unref?.()
  }

  private watcher: FSWatcher | undefined
  private watchDebounce: NodeJS.Timeout | undefined
  private onSkillsChanged: (() => void) | undefined
}
