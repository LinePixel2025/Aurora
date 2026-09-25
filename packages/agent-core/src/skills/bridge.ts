/**
 * Skill 与 Agent 内核的桥接（docs/06 §6）。
 *
 * v1（P3）范围：**只注入指令，不执行脚本**。
 * `use_skill` 把目标技能的正文指令与目录返回给模型，由模型按指令行事；
 * 目录下若有 `scripts/`，在文本里列出脚本清单并提示模型向用户说明用途、
 * 征得同意——本模块没有任何命令执行路径，也不需要用户确认。
 */
import type { SkillsRegistry } from './registry.js'
import type { ToolDefinition, ToolRegistry } from '../tools/registry.js'

export const USE_SKILL_TOOL_NAME = 'use_skill'

/** 显式调用前缀：`/skill名` 与 `@skill名` */
const EXPLICIT_PATTERN = /^([/@])([A-Za-z0-9_-]+)\s*([\s\S]*)$/

export interface ExplicitSkillInvocation {
  skillName: string
  /** 去掉前缀后的剩余文本（保持原样，含换行） */
  rest: string
}

export class SkillsBridge {
  private readonly registry: SkillsRegistry

  constructor(registry: SkillsRegistry) {
    this.registry = registry
  }

  get catalogPrompt(): string {
    return this.registry.toCatalogPrompt()
  }

  /** 注册 `use_skill` 到工具表（由 AgentHost 装配时调用一次）。 */
  registerInto(tools: ToolRegistry): void {
    tools.register(this.tool(), 'skill')
  }

  /**
   * 解析显式调用（`/system-status 现在几点`）。
   * 未匹配前缀或技能不存在时返回 `undefined`，调用方按普通文本处理。
   */
  parseExplicitInvocation(text: string): ExplicitSkillInvocation | undefined {
    const matched = EXPLICIT_PATTERN.exec(text.trimStart())
    if (!matched) return undefined
    const name = matched[2] ?? ''
    if (this.registry.get(name) === undefined) return undefined
    return { skillName: name, rest: (matched[3] ?? '').trim() }
  }

  /** 取技能正文（供显式调用注入）。 */
  render(skillName: string): string | undefined {
    const skill = this.registry.get(skillName)
    if (skill === undefined) return undefined
    return renderSkill(
      skill.name,
      skill.description,
      skill.body,
      skill.dir,
      this.registry.listScripts(skill.name),
    )
  }

  private tool(): ToolDefinition {
    const names = this.registry.enabled().map((skill) => skill.name)
    return {
      name: USE_SKILL_TOOL_NAME,
      description:
        '读取一个 Skill 的完整指令并注入当前上下文。需要某个技能时先调用本工具，再按返回的指令行事。',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '技能名称',
            ...(names.length === 0 ? {} : { enum: names }),
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
      sensitivity: 'safe',
      execute: async (input) => {
        const name = readName(input)
        if (name === '') {
          return {
            content: '缺少技能名称（参数 name）。',
            isError: true,
            summary: '缺少 name 参数',
          }
        }
        const skill = this.registry.get(name)
        if (skill === undefined || !skill.enabled) {
          return {
            content: `没有名为 "${name}" 的可用 Skill。可用：${names.join('、') || '（无）'}`,
            isError: true,
            summary: `未知 Skill：${name}`,
          }
        }
        return {
          content: renderSkill(
            skill.name,
            skill.description,
            skill.body,
            skill.dir,
            this.registry.listScripts(skill.name),
          ),
          summary: `已加载 Skill：${skill.name}`,
        }
      },
    }
  }
}

function readName(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const value = (input as Record<string, unknown>)['name']
  return typeof value === 'string' ? value.trim() : ''
}

function renderSkill(
  name: string,
  description: string,
  body: string,
  dir: string,
  scripts: string[],
): string {
  const lines = [`技能：${name}`, `说明：${description}`, `目录：${dir}`, body.trim()]
  if (scripts.length > 0) {
    lines.push(
      `本技能附带脚本：${scripts.map((file) => `scripts/${file}`).join('、')}` +
        '（当前版本不会自动执行脚本；确需运行请向用户说明用途并征得同意。）',
    )
  }
  return lines.filter((line) => line !== '').join('\n\n')
}
