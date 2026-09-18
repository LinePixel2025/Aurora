import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SkillsRegistry } from './registry.js'
import { ToolRegistry } from '../tools/registry.js'
import type { LlmToolParameterSchema } from '../llm/types.js'

let root = ''
let builtinDir = ''
let userDir = ''

const CLASSIFY_SKILL = `---
name: file-classify
description: 根据文件内容证据判定科目
when_to_use: 感知文件夹出现新文件
---
分类步骤说明
`

const STATUS_SKILL = `---
name: system-status
description: 读取当前系统状态
---
状态读取说明
`

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'aurora-skills-'))
  builtinDir = join(root, 'builtin')
  userDir = join(root, 'user')

  await fs.mkdir(join(builtinDir, 'file-classify'), { recursive: true })
  await fs.writeFile(join(builtinDir, 'file-classify', 'SKILL.md'), CLASSIFY_SKILL, 'utf8')

  await fs.mkdir(join(builtinDir, 'system-status', 'scripts'), { recursive: true })
  await fs.writeFile(join(builtinDir, 'system-status', 'SKILL.md'), STATUS_SKILL, 'utf8')
  await fs.writeFile(join(builtinDir, 'system-status', 'scripts', 'read.ps1'), 'echo 1', 'utf8')

  // 用户目录：覆盖同名技能 + 一个非法技能
  await fs.mkdir(join(userDir, 'file-classify'), { recursive: true })
  await fs.writeFile(
    join(userDir, 'file-classify', 'SKILL.md'),
    '---\nname: file-classify\ndescription: 用户自定义分类策略\n---\n用户版本\n',
    'utf8',
  )
  await fs.mkdir(join(userDir, 'broken'), { recursive: true })
  await fs.writeFile(join(userDir, 'broken', 'SKILL.md'), '没有 frontmatter', 'utf8')

  // 没有 SKILL.md 的普通目录应被忽略
  await fs.mkdir(join(builtinDir, 'not-a-skill'), { recursive: true })
})

afterAll(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true })
})

describe('SkillsRegistry', () => {
  it('扫描内置与用户目录，用户同名技能覆盖内置', async () => {
    const registry = new SkillsRegistry({ builtinDir, userDir })
    const report = await registry.scan()
    const names = report.skills.map((s) => s.name)
    expect(names).toEqual(['file-classify', 'system-status'])
    const overridden = registry.get('file-classify')
    expect(overridden?.description).toBe('用户自定义分类策略')
    expect(overridden?.source).toBe('user')
    expect(overridden?.whenToUse).toBeUndefined()
  })

  it('识别 scripts/ 目录', async () => {
    const registry = new SkillsRegistry({ builtinDir })
    await registry.scan()
    expect(registry.get('system-status')?.hasScripts).toBe(true)
    expect(registry.get('file-classify')?.hasScripts).toBe(false)
  })

  it('非法 SKILL.md 记入 issues 且不影响其它技能', async () => {
    const registry = new SkillsRegistry({ builtinDir, userDir })
    const report = await registry.scan()
    expect(report.issues).toHaveLength(1)
    expect(report.issues[0]?.error).toContain('frontmatter')
    expect(report.skills).toHaveLength(2)
  })

  it('目录不存在时静默返回空列表', async () => {
    const registry = new SkillsRegistry({ builtinDir: join(root, 'missing') })
    const report = await registry.scan()
    expect(report.skills).toEqual([])
    expect(report.issues).toEqual([])
  })

  it('setDisabled 影响 enabled 与目录提示词', async () => {
    const registry = new SkillsRegistry({ builtinDir, userDir })
    await registry.scan()
    registry.setDisabled(['system-status'])
    expect(registry.enabled().map((s) => s.name)).toEqual(['file-classify'])
    const catalog = registry.toCatalogPrompt()
    expect(catalog).toContain('file-classify')
    expect(catalog).not.toContain('system-status')
    // 用户覆盖版没有 when_to_use，因此不出现"适用场景"提示
    expect(catalog).not.toContain('适用场景')

    // 只挂内置目录时，system-status 的 when_to_use 会进入提示词
    const builtinOnly = new SkillsRegistry({ builtinDir })
    await builtinOnly.scan()
    expect(builtinOnly.toCatalogPrompt()).toContain('system-status')
  })

  it('空技能集返回占位提示', async () => {
    const registry = new SkillsRegistry({ builtinDir: join(root, 'missing') })
    await registry.scan()
    expect(registry.toCatalogPrompt()).toBe('（当前没有可用 Skill）')
  })
})

describe('ToolRegistry', () => {
  const params: LlmToolParameterSchema = { type: 'object', properties: {} }
  const makeTool = (name: string) => ({
    name,
    description: `tool ${name}`,
    parameters: params,
    execute: () => Promise.resolve({ content: 'ok' }),
  })

  it('注册 / 查询 / 列出 / 转 LLM 工具表', () => {
    const registry = new ToolRegistry()
    registry.register(makeTool('system_status'))
    registry.register(makeTool('read_file'))
    expect(registry.list()).toHaveLength(2)
    expect(registry.get('system_status')?.description).toBe('tool system_status')
    expect(registry.toLlmTools().map((t) => t.name)).toEqual(['system_status', 'read_file'])
  })

  it('同名冲突：先到先得（Skill 不覆盖已有实现）', () => {
    const registry = new ToolRegistry()
    registry.register(makeTool('dup'))
    registry.register(makeTool('dup'), 'skill')
    expect(registry.conflicts).toHaveLength(1)
    expect(registry.conflicts[0]?.detail).toBe('dup')
  })

  it('MCP 工具同名时覆盖并留痕', () => {
    const registry = new ToolRegistry()
    registry.register(makeTool('search'))
    registry.register(makeTool('mcp.demo.search'), 'mcp')
    registry.register({ ...makeTool('search'), description: '来自 MCP' }, 'mcp')
    expect(registry.get('search')?.description).toBe('来自 MCP')
    expect(registry.conflicts.some((c) => c.message.includes('MCP'))).toBe(true)
  })

  it('按前缀批量注销（MCP 断开）', () => {
    const registry = new ToolRegistry()
    registry.register(makeTool('mcp.demo.a'), 'mcp')
    registry.register(makeTool('mcp.demo.b'), 'mcp')
    registry.register(makeTool('system_status'))
    expect(registry.unregisterByPrefix('mcp.demo.')).toBe(2)
    expect(registry.list().map((t) => t.name)).toEqual(['system_status'])
  })
})
