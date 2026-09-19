/**
 * Skill 服务单测（docs/06 §6、docs/08 §6 `skills.userDir`）。
 *
 * 覆盖重点是那个曾经的「假开关」：`skills.userDir` 存了但运行时永远读
 * `userData/skills`。这里断言空串回落、自定义目录生效、目录变更后**重扫**，
 * 以及解析失败（坏 SKILL.md）被如实上报而不是静默吞掉。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryLogger, createDefaultSettings, type Settings } from '@aurora/shared'
import { SkillsService, resolveSkillsUserDir } from './skills.js'

let root = ''
let builtinDir = ''
let userData = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aurora-skills-'))
  builtinDir = join(root, 'builtin')
  userData = join(root, 'userData')
  await mkdir(builtinDir, { recursive: true })
  await mkdir(userData, { recursive: true })
  await writeSkill(join(builtinDir, 'file-classify'), 'file-classify', '按科目分类文件')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeSkill(dir: string, name: string, description: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n执行指令正文\n`,
    'utf8',
  )
}

function settingsWith(userDir: string, disabled: string[] = []): Settings {
  const settings = createDefaultSettings()
  settings.skills = { userDir, disabled }
  return settings
}

function createService(): SkillsService {
  return new SkillsService({ builtinDir, userData, logger: createMemoryLogger() }, settingsWith(''))
}

describe('resolveSkillsUserDir', () => {
  it('空串回落到 userData/skills', () => {
    expect(resolveSkillsUserDir(settingsWith(''), userData)).toBe(join(userData, 'skills'))
    expect(resolveSkillsUserDir(settingsWith('   '), userData)).toBe(join(userData, 'skills'))
  })

  it('自定义目录原样生效（并去掉两端空白）', () => {
    const custom = join(root, 'D:\\cloud\\skills')
    expect(resolveSkillsUserDir(settingsWith(custom), userData)).toBe(custom)
    expect(resolveSkillsUserDir(settingsWith(`  ${custom}  `), userData)).toBe(custom)
  })
})

describe('SkillsService', () => {
  it('init 扫描内置目录并上报状态', async () => {
    const service = createService()
    const status = await service.init(settingsWith(''))
    expect(status.total).toBe(1)
    expect(status.failed).toBe(0)
    expect(status.scannedAt).not.toBeNull()
    expect(status.userDir).toBe(join(userData, 'skills'))
    expect(service.list().map((skill) => skill.name)).toEqual(['file-classify'])
  })

  it('skills.userDir 指向的目录里的技能会被扫到（原死字段，现生效）', async () => {
    const custom = join(root, 'custom-skills')
    await writeSkill(join(custom, 'my-helper'), 'my-helper', '自定义能力')

    const service = createService()
    await service.init(settingsWith(custom))

    const names = service.list().map((skill) => skill.name)
    expect(names).toContain('my-helper')
    expect(service.status().userDir).toBe(custom)
    expect(service.list().find((skill) => skill.name === 'my-helper')?.source).toBe('user')
  })

  it('reconfigure 改目录后重扫，新目录的技能出现、旧目录的消失', async () => {
    const first = join(root, 'first')
    const second = join(root, 'second')
    await writeSkill(join(first, 'skill-a'), 'skill-a', '第一批')
    await writeSkill(join(second, 'skill-b'), 'skill-b', '第二批')

    const service = createService()
    await service.init(settingsWith(first))
    expect(service.list().map((skill) => skill.name)).toContain('skill-a')

    const status = await service.reconfigure(settingsWith(second))
    const names = service.list().map((skill) => skill.name)
    expect(names).toContain('skill-b')
    expect(names).not.toContain('skill-a')
    expect(status.userDir).toBe(second)
  })

  it('用户技能同名时覆盖内置技能', async () => {
    const custom = join(root, 'custom')
    await writeSkill(join(custom, 'file-classify'), 'file-classify', '用户自定义版本')

    const service = createService()
    await service.init(settingsWith(custom))

    const target = service.list().find((skill) => skill.name === 'file-classify')
    expect(target?.source).toBe('user')
    expect(target?.description).toBe('用户自定义版本')
  })

  it('disabled 列表让技能停用，重启扫描后依然停用', async () => {
    const service = createService()
    await service.init(settingsWith('', ['file-classify']))
    expect(service.list()[0]?.enabled).toBe(false)

    await service.reconfigure(settingsWith('', ['file-classify']))
    expect(service.list()[0]?.enabled).toBe(false)
  })

  it('坏 SKILL.md 被跳过并计入 failed / warnings，不抛错', async () => {
    const custom = join(root, 'broken-root')
    await writeSkill(join(custom, 'good'), 'good', '正常技能')
    await mkdir(join(custom, 'broken'), { recursive: true })
    await writeFile(join(custom, 'broken', 'SKILL.md'), '没有 frontmatter', 'utf8')

    const service = createService()
    const status = await service.init(settingsWith(custom))

    expect(status.total).toBe(2) // 内置 + good
    expect(status.failed).toBe(1)
    expect(status.warnings[0]).toContain('broken')
  })

  it('reconfigure 传无关设置变更时也能安全重扫（幂等）', async () => {
    const service = createService()
    await service.init(settingsWith(''))

    const next = settingsWith('')
    next.advanced.logLevel = 'debug' // 无关字段
    const status = await service.reconfigure(next)
    expect(status.total).toBe(1)
  })

  it('用户目录不存在时不报错，只是少若干技能', async () => {
    const service = createService()
    const status = await service.init(settingsWith(join(root, 'not-created')))
    expect(status.failed).toBe(0)
    expect(status.total).toBe(1)
  })
})
