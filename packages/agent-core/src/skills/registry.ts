/**
 * Skill 注册表（docs/06 §6）。
 *
 * P1 范围：扫描内置 `skills/` 与用户技能目录、解析 SKILL.md、向设置页与
 * 上下文组装暴露清单。真正的"按 description 自动匹配 + 执行脚本"在 P3 落地。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { createNoopLogger, type Logger } from '@aurora/shared'
import { isParseError, parseSkillMarkdown } from './parse.js'

export const SKILL_FILE_NAME = 'SKILL.md'

export type SkillSource = 'builtin' | 'user'

export interface Skill {
  name: string
  description: string
  whenToUse?: string
  /** SKILL.md 正文指令 */
  body: string
  /** SKILL.md 所在目录 */
  dir: string
  source: SkillSource
  /** 目录下是否存在 scripts/ */
  hasScripts: boolean
  enabled: boolean
}

export interface SkillsRegistryOptions {
  /** 内置技能根目录（随安装包，仓库 `skills/`） */
  builtinDir: string
  /** 用户技能根目录（userData/skills） */
  userDir?: string
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
  private disabled = new Set<string>()
  private issues: SkillScanIssue[] = []

  constructor(options: SkillsRegistryOptions) {
    this.builtinDir = options.builtinDir
    this.userDir = options.userDir
    this.logger = options.logger ?? createNoopLogger()
  }

  /** 当前生效的用户技能目录（`undefined` 表示不扫描用户目录）。 */
  get directory(): string | undefined {
    return this.userDir
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

  /** 扫描并重建注册表；用户目录中的同名技能覆盖内置技能。 */
  async scan(): Promise<SkillScanReport> {
    const skills = new Map<string, Skill>()
    const issues: SkillScanIssue[] = []

    for (const [dir, source] of this.directories()) {
      const found = await this.loadDirectory(dir, source, issues)
      for (const skill of found) {
        if (skills.has(skill.name)) {
          this.logger.info('用户技能覆盖同名内置技能', { name: skill.name })
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

  private directories(): Array<[string, SkillSource]> {
    const entries: Array<[string, SkillSource]> = [[this.builtinDir, 'builtin']]
    if (this.userDir) entries.push([this.userDir, 'user'])
    return entries
  }

  private async loadDirectory(
    dir: string,
    source: SkillSource,
    issues: SkillScanIssue[],
  ): Promise<Skill[]> {
    const skills: Skill[] = []
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      this.logger.debug('技能目录不存在，跳过', { dir, source })
      return skills
    }

    for (const entry of entries) {
      const skillDir = join(dir, entry)
      const file = join(skillDir, SKILL_FILE_NAME)
      let content: string
      try {
        content = await fs.readFile(file, 'utf8')
      } catch {
        continue // 目录内没有 SKILL.md 视为普通目录，不算错误
      }

      const parsed = parseSkillMarkdown(content)
      if (isParseError(parsed)) {
        issues.push({ path: file, error: parsed.error })
        this.logger.warn('技能解析失败，已跳过', { path: file, error: parsed.error })
        continue
      }

      skills.push({
        name: parsed.frontmatter.name,
        description: parsed.frontmatter.description,
        ...(parsed.frontmatter['when_to_use'] === undefined
          ? {}
          : { whenToUse: parsed.frontmatter['when_to_use'] }),
        body: parsed.body,
        dir: skillDir,
        source,
        hasScripts: await directoryExists(join(skillDir, 'scripts')),
        enabled: true,
      })
    }

    return skills
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
