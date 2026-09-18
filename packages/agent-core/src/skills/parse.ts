/**
 * SKILL.md 解析（ADR-005）：YAML frontmatter + 说明正文 + 可选 scripts/。
 *
 * 只支持 frontmatter 中的扁平键值（本项目的使用范围），
 * 因此不引入 YAML 依赖，解析结果可完全单测。
 */
export interface SkillFrontmatter {
  name: string
  description: string
  when_to_use?: string
  [key: string]: string | undefined
}

export interface ParsedSkill {
  frontmatter: SkillFrontmatter
  body: string
}

export interface SkillParseError {
  error: string
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export function parseSkillMarkdown(source: string): ParsedSkill | SkillParseError {
  const text = source.replace(/^\uFEFF/, '')
  const matched = FRONTMATTER_PATTERN.exec(text)
  if (!matched) return { error: '缺少 YAML frontmatter（文件需以 --- 开头）' }

  const frontmatter = parseFrontmatter(matched[1] ?? '')
  const name = frontmatter['name']
  const description = frontmatter['description']
  if (typeof name !== 'string' || name.trim() === '') {
    return { error: 'frontmatter 缺少必填字段 name' }
  }
  if (typeof description !== 'string' || description.trim() === '') {
    return { error: 'frontmatter 缺少必填字段 description' }
  }

  return {
    frontmatter: frontmatter as SkillFrontmatter,
    body: text.slice(matched[0].length).trim(),
  }
}

function parseFrontmatter(block: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    out[key] = stripQuotes(value)
  }
  return out
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

export function isParseError(result: ParsedSkill | SkillParseError): result is SkillParseError {
  return 'error' in result
}
