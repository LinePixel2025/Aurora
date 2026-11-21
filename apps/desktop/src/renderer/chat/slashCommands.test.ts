import { describe, expect, it } from 'vitest'
import {
  BUILTIN_COMMANDS,
  filterSlashItems,
  planTaskOf,
  slashQueryOf,
  type SlashItem,
} from './slashCommands.js'

const skill = {
  name: 'plan-helper',
  description: '整理文件',
  enabled: true,
  path: '',
  dir: '',
  builtin: false,
} as never

describe('斜杠命令（docs/07 §2.3）', () => {
  it('/plan 在内置命令组里，且前缀匹配能命中', () => {
    expect(BUILTIN_COMMANDS.some((item) => item.name === 'plan')).toBe(true)
    const items = filterSlashItems('pl', [], false)
    expect(items.map((item) => item.name)).toContain('plan')
  })

  it('slashQueryOf 只认整串 /xxx：/plan 后带空格退出浮层', () => {
    expect(slashQueryOf('/plan')).toBe('plan')
    expect(slashQueryOf('/plan ')).toBeNull()
    expect(slashQueryOf('/plan 做点事')).toBeNull()
  })

  it('planTaskOf：命令 / 任务 / off / 相似词 / 多行', () => {
    expect(planTaskOf('/plan')).toBe('')
    expect(planTaskOf('  /plan  ')).toBe('')
    expect(planTaskOf('/plan 整理笔记')).toBe('整理笔记')
    expect(planTaskOf('/plan\n多行任务')).toBe('多行任务')
    expect(planTaskOf('/plan off')).toBe('off')
    expect(planTaskOf('/plan OFF')).toBe('off')
    expect(planTaskOf('/planning')).toBeNull()
    expect(planTaskOf('/plan-x')).toBeNull()
    expect(planTaskOf('请用 /plan')).toBeNull()
  })

  it('过滤顺序：内置命令在前、技能在后（/p 同时命中 plan 与技能时命令优先）', () => {
    const items: SlashItem[] = filterSlashItems('pl', [skill], false)
    const planIndex = items.findIndex((item) => item.name === 'plan')
    const skillIndex = items.findIndex((item) => item.kind === 'skill')
    if (skillIndex !== -1) expect(planIndex).toBeLessThan(skillIndex)
  })
})
