import { describe, expect, it } from 'vitest'
import { SkillsBridge, USE_SKILL_TOOL_NAME } from './bridge.js'
import { SkillsRegistry } from './registry.js'
import { ToolRegistry } from '../tools/registry.js'

function skillFile(name: string, body: string): string {
  return `---
name: ${name}
description: ${name} 的说明
when_to_use: 用户需要 ${name} 时
---

# ${name}

${body}
`
}

async function setup() {
  const registry = await createRegistry()
  return { registry, bridge: new SkillsBridge(registry) }
}

/** 用真实临时目录构造 SkillsRegistry（生命周期内自动清理） */
async function createRegistry(): Promise<SkillsRegistry> {
  const { promises: nodeFs } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const base = await nodeFs.mkdtemp(join(tmpdir(), 'aurora-skills-'))
  for (const [name, body] of [
    ['system-status', '读取系统状态'],
    ['file-classify', '分类文件'],
  ] as const) {
    await nodeFs.mkdir(join(base, name), { recursive: true })
    await nodeFs.writeFile(join(base, name, 'SKILL.md'), skillFile(name, body), 'utf8')
  }
  // system-status 附带脚本（验证正文渲染脚本清单）；file-classify 无脚本
  await nodeFs.mkdir(join(base, 'system-status', 'scripts'), { recursive: true })
  await nodeFs.writeFile(join(base, 'system-status', 'scripts', 'b.sh'), 'echo 1', 'utf8')
  await nodeFs.writeFile(join(base, 'system-status', 'scripts', 'a.py'), 'print(1)', 'utf8')
  const registry = new SkillsRegistry({ builtinDir: base })
  await registry.scan()
  return registry
}

describe('SkillsBridge', () => {
  it('注册 use_skill，描述里带技能名枚举', async () => {
    const { bridge } = await setup()
    const tools = new ToolRegistry()
    bridge.registerInto(tools)

    const tool = tools.get(USE_SKILL_TOOL_NAME)
    expect(tool).toBeDefined()
    expect(tool?.sensitivity).toBe('safe')
    const name = tool?.parameters.properties?.['name'] as { enum?: string[] } | undefined
    expect(name?.enum).toEqual(['file-classify', 'system-status'])
  })

  it('use_skill 返回技能正文与目录，附脚本清单与确认提醒', async () => {
    const { bridge } = await setup()
    const tools = new ToolRegistry()
    bridge.registerInto(tools)
    const result = await tools
      .get(USE_SKILL_TOOL_NAME)
      ?.execute({ name: 'system-status' }, { sessionId: 's' })
    expect(result?.content).toContain('读取系统状态')
    expect(result?.content).toContain('技能：system-status')
    expect(result?.content).toContain(
      '本技能附带脚本：scripts/a.py、scripts/b.sh' +
        '（当前版本不会自动执行脚本；确需运行请向用户说明用途并征得同意。）',
    )
    expect(result?.summary).toBe('已加载 Skill：system-status')
    expect(result?.isError).toBeUndefined()
  })

  it('无脚本的技能正文不出现脚本清单提示', async () => {
    const { bridge } = await setup()
    expect(bridge.render('file-classify')).not.toContain('附带脚本')
    expect(bridge.render('file-classify')).toContain('分类文件')
  })

  it('render 路径同样列出脚本清单', async () => {
    const { bridge } = await setup()
    expect(bridge.render('system-status')).toContain('本技能附带脚本：scripts/a.py、scripts/b.sh')
  })

  it('未知技能返回错误结果而不是抛错', async () => {
    const { bridge } = await setup()
    const tools = new ToolRegistry()
    bridge.registerInto(tools)
    const result = await tools
      .get(USE_SKILL_TOOL_NAME)
      ?.execute({ name: 'nope' }, { sessionId: 's' })
    expect(result?.isError).toBe(true)
    expect(result?.content).toContain('没有名为 "nope"')
  })

  it('缺少 name 参数被拒绝', async () => {
    const { bridge } = await setup()
    const tools = new ToolRegistry()
    bridge.registerInto(tools)
    const result = await tools.get(USE_SKILL_TOOL_NAME)?.execute({}, { sessionId: 's' })
    expect(result?.isError).toBe(true)
  })

  it('parseExplicitInvocation 识别 / 与 @ 前缀，未知技能返回 undefined', async () => {
    const { bridge } = await setup()
    expect(bridge.parseExplicitInvocation('/system-status 现在几点')).toEqual({
      skillName: 'system-status',
      rest: '现在几点',
    })
    expect(bridge.parseExplicitInvocation('@system-status')?.skillName).toBe('system-status')
    expect(bridge.parseExplicitInvocation('/unknown 你好')).toBeUndefined()
    expect(bridge.parseExplicitInvocation('普通消息')).toBeUndefined()
  })

  it('render 返回正文；禁用技能不可用', async () => {
    const { registry, bridge } = await setup()
    expect(bridge.render('file-classify')).toContain('分类文件')
    registry.setDisabled(['file-classify'])
    const tools = new ToolRegistry()
    new SkillsBridge(registry).registerInto(tools)
    const result = await tools
      .get(USE_SKILL_TOOL_NAME)
      ?.execute({ name: 'file-classify' }, { sessionId: 's' })
    expect(result?.isError).toBe(true)
  })

  it('catalogPrompt 暴露已启用技能', async () => {
    const { bridge } = await setup()
    expect(bridge.catalogPrompt).toContain('system-status')
  })
})
