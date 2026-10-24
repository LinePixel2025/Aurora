/**
 * Skill 注册表（docs/06 §6）。
 *
 * P1 范围：扫描内置 `skills/` 与用户技能目录、解析 SKILL.md、向设置页与
 * 上下文组装暴露清单。真正的"按 description 自动匹配 + 执行脚本"在 P3 落地。
 */
import { promises as fs, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Dirent } from 'node:fs'
import { createNoopLogger, type Logger } from '@aurora/shared'
import { isParseError, parseSkillMarkdown } from './parse.js'

export const SKILL_FILE_NAME = 'SKILL.md'

export type SkillSource = 'builtin' | 'user' | 'plugin'

export interface Skill {
  name: string
  description: string
  whenToUse?: string
  /** SKILL.md 正文指令 */
  body: string
  /** SKILL.md 所在目录 */
  dir: string
  source: SkillSource
  /** source = 'plugin' 时：提供该 Skill 的插件 id */
  pluginId?: string
  /** 目录下是否存在 scripts/ */
  hasScripts: boolean
  enabled: boolean
}

export interface SkillsRegistryOptions {
  /** 内置技能根目录（随安装包，仓库 `skills/`） */
  builtinDir: string
  /** 用户技能根目录（userData/skills） */
  userDir?: string
  /**
   * 插件贡献的技能目录（见 docs/14 §3.3）。两种形态都支持：
   * 目录本身含 `SKILL.md`（清单 `contributes.skills` 指向技能目录），
   * 或目录下是一层技能子目录（与内置 `skills/` 同构）。
   */
  pluginDirs?: Array<{ dir: string; pluginId: string }>
  logger?: Logger
}

export interface SkillScanIssue {
  path: string
  error: string
}

export interface SkillScanReport {
  skills: Skill[]
  issues: SkillScanIssue[]
}

export class SkillsRegistry {
  private skills = new Map<string, Skill>()
  private readonly logger: Logger
  private readonly builtinDir: string
  private userDir: string | undefined
  private pluginDirs: Array<{ dir: string; pluginId: string }> = []
  private disabled = new Set<string>()
  private issues: SkillScanIssue[] = []

  constructor(options: SkillsRegistryOptions) {
    this.builtinDir = options.builtinDir
    this.userDir = options.userDir
    this.pluginDirs = options.pluginDirs ?? []
    this.logger = options.logger ?? createNoopLogger()
  }

  /** 当前生效的用户技能目录（`undefined` 表示不扫描用户目录）。 */
  get directory(): string | undefined {
    return this.userDir
  }

  /**
   * 替换插件技能目录（插件启用 / 停用 / 卸载后调用）。
   * 与 `setUserDir` 同理：只改数据，**必须**由调用方再 `scan()` 一次。
   */
  setPluginDirs(dirs: Array<{ dir: string; pluginId: string }>): void {
    this.pluginDirs = [...dirs]
  }

  get pluginSkillDirs(): ReadonlyArray<{ dir: string; pluginId: string }> {
    return this.pluginDirs
  }

  /**
   * 切换用户技能目录（docs/08 §6 `skills.userDir`）。
   *
   * 为什么是可变而非重建：注册表实例被 `use_skill` 工具的闭包与提示词组装持有，
   * 换目录时若新建实例，这些引用会指向旧表 —— 表现为"改了目录但模型仍看到旧技能"。
   * 改完目录**必须**再调一次 `scan()`。
   */
  setUserDir(dir: string | undefined): void {
    this.userDir = dir === undefined || dir.trim() === '' ? undefined : dir
  }

  /** 扫描并重建注册表；用户目录中的同名技能覆盖内置与插件技能。 */
  async scan(): Promise<SkillScanReport> {
    const skills = new Map<string, Skill>()
    const issues: SkillScanIssue[] = []

    for (const [dir, source, pluginId] of this.directories()) {
      const found = await this.loadDirectory(dir, source, issues, pluginId)
      for (const skill of found) {
        const existing = skills.get(skill.name)
        if (existing !== undefined) {
          // 口径（docs/14 §3.3）：用户覆盖一切；插件不能遮蔽内置，插件之间先到先得。
          // 判定看**新来的**这个技能：只有 user 来源允许覆盖已加载的同名技能。
          if (skill.source !== 'user') {
            issues.push({
              path: skill.dir,
              error: `技能名「${skill.name}」与已加载的 ${existing.source} 技能重名，已跳过`,
            })
            this.logger.warn('技能重名，已跳过', {
              name: skill.name,
              kept: existing.source,
              skipped: skill.source,
            })
            continue
          }
          this.logger.info('用户技能覆盖同名技能', { name: skill.name })
        }
        skills.set(skill.name, skill)
      }
    }

    for (const skill of skills.values()) {
      skill.enabled = !this.disabled.has(skill.name)
    }

    this.skills = skills
    this.issues = issues
    this.logger.info('技能扫描完成', { count: skills.size, issues: issues.length })
    return { skills: this.list(), issues: [...issues] }
  }

  /** 应用设置中的 `skills.disabled`（docs/08 §6）。 */
  setDisabled(names: readonly string[]): void {
    this.disabled = new Set(names)
    for (const skill of this.skills.values()) {
      skill.enabled = !this.disabled.has(skill.name)
    }
  }

  list(): Skill[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  enabled(): Skill[] {
    return this.list().filter((skill) => skill.enabled)
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name)
  }

  /**
   * 列出技能目录下 `scripts/` 一层内的文件名（排序）。
   * 技能不存在或没有 scripts 目录（含不可读）时返回空数组。
   *
   * 为什么是同步：调用方是 `SkillsBridge` 的正文渲染路径（同步拼装注入文本），
   * 与 `scan()` 的 readdir 同一套目录读取，只是换成同步形态。
   */
  listScripts(name: string): string[] {
    const skill = this.skills.get(name)
    if (skill === undefined) return []
    let entries: Dirent[]
    try {
      entries = readdirSync(join(skill.dir, 'scripts'), { withFileTypes: true })
    } catch {
      return [] // 没有 scripts/ 目录（或不可读）视为没有附带脚本
    }
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()
  }

  get lastIssues(): readonly SkillScanIssue[] {
    return this.issues
  }

  /**
   * 组装给 LLM 的"技能清单"片段（docs/06 §6：以 `use_skill` 工具暴露，
   * 由模型按 description 选择）。P3 会在 loop 中作为工具注册。
   */
  toCatalogPrompt(): string {
    const skills = this.enabled()
    if (skills.length === 0) return '（当前没有可用 Skill）'
    return skills
      .map((skill) => {
        const hint = skill.whenToUse ? `（适用场景：${skill.whenToUse}）` : ''
        return `- ${skill.name}：${skill.description}${hint}`
      })
      .join('\n')
  }

  private directories(): Array<[string, SkillSource, string?]> {
    const entries: Array<[string, SkillSource, string?]> = [[this.builtinDir, 'builtin']]
    for (const plugin of this.pluginDirs) entries.push([plugin.dir, 'plugin', plugin.pluginId])
    if (this.userDir) entries.push([this.userDir, 'user'])
    return entries
  }

  private async loadDirectory(
    dir: string,
    source: SkillSource,
    issues: SkillScanIssue[],
    pluginId?: string,
  ): Promise<Skill[]> {
    // 目录本身就是技能（插件清单把 `contributes.skills` 指向技能目录，如 `skills/hello`）
    const direct = await this.loadSkill(dir, source, issues, pluginId)
    if (direct !== null) return direct === undefined ? [] : [direct]

    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      this.logger.debug('技能目录不存在，跳过', { dir, source })
      return []
    }

    const skills: Skill[] = []
    for (const entry of entries) {
      const skill = await this.loadSkill(join(dir, entry), source, issues, pluginId)
      if (skill !== undefined && skill !== null) skills.push(skill)
    }
    return skills
  }

  /**
   * 读 `skillDir/SKILL.md`。返回 `null` 表示文件不存在（调用方继续按父目录扫描），
   * `undefined` 表示存在但解析失败（已记 issue，不再向下扫）。
   */
  private async loadSkill(
    skillDir: string,
    source: SkillSource,
    issues: SkillScanIssue[],
    pluginId?: string,
  ): Promise<Skill | undefined | null> {
    const file = join(skillDir, SKILL_FILE_NAME)
    let content: string
    try {
      content = await fs.readFile(file, 'utf8')
    } catch {
      return null
    }

    const parsed = parseSkillMarkdown(content)
    if (isParseError(parsed)) {
      issues.push({ path: file, error: parsed.error })
      this.logger.warn('技能解析失败，已跳过', { path: file, error: parsed.error })
      return undefined
    }

    return {
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      ...(parsed.frontmatter['when_to_use'] === undefined
        ? {}
        : { whenToUse: parsed.frontmatter['when_to_use'] }),
      body: parsed.body,
      dir: skillDir,
      source,
      ...(pluginId === undefined ? {} : { pluginId }),
      hasScripts: await directoryExists(join(skillDir, 'scripts')),
      enabled: true,
    }
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path)
    return stat.isDirectory()
  } catch {
    return false
  }
}
