/**
 * resolveProjectRootById 单测（docs/06 §5.1，v17；v25 起是项目根解析的唯一入口）。
 *
 * 用真实的 `Settings` 对象做桩（`createDefaultSettings()`），只覆盖 `projects` 分组 ——
 * 不 import zod、不碰文件系统，纯 Node 可跑。
 */
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDefaultSettings } from '@aurora/shared'
import type { ProjectConfig, Settings } from '@aurora/shared'
import { resolveProjectRootById } from './project.js'

const CWD = join(process.cwd(), 'work', 'cwd')

function project(id: string, root: string, name = id): ProjectConfig {
  return { id, name, root }
}

/** 真实 Settings 桩：只改 projects 分组，其余字段保持默认。 */
function settingsWith(projects: Partial<Settings['projects']>): Settings {
  const settings = createDefaultSettings()
  settings.projects = { ...settings.projects, ...projects }
  return settings
}

describe('resolveProjectRootById（会话级项目，docs/06 §5.1）', () => {
  it('按传入 id 命中条目并归一 root（相对 root 按 cwd 展开）', () => {
    const root = resolveProjectRootById(
      settingsWith({ list: [project('p1', 'sub/dir'), project('p2', 'other')] }),
      'p1',
      { cwd: CWD },
    )

    expect(root).toBe(join(CWD, 'sub', 'dir'))
  })

  it('绝对 root 原样采用（不受 cwd 影响）', () => {
    // `resolve('D:\\proj')` 在 Windows 上就是 `D:\proj`，在其它平台是等价绝对路径；
    // 期望值与实现同源，避免写死反斜杠字面量。
    const absoluteRoot = resolve('D:\\proj')
    const root = resolveProjectRootById(
      settingsWith({ list: [project('p1', absoluteRoot)] }),
      'p1',
      {
        cwd: CWD,
      },
    )

    expect(root).toBe(absoluteRoot)
  })

  it('id 空白 / undefined → 未绑定，返回 undefined', () => {
    const settings = settingsWith({ list: [project('p1', 'root')] })

    expect(resolveProjectRootById(settings, '', { cwd: CWD })).toBeUndefined()
    expect(resolveProjectRootById(settings, '   ', { cwd: CWD })).toBeUndefined()
    expect(resolveProjectRootById(settings, undefined, { cwd: CWD })).toBeUndefined()
  })

  it('绑定指向已删除的项目 → 静默回落 undefined（不 warn：解析逐次执行，刷屏无益）', () => {
    const settings = settingsWith({ list: [project('p1', 'root')] })

    expect(resolveProjectRootById(settings, 'ghost', { cwd: CWD })).toBeUndefined()
  })

  it('命中条目的 root 为空白串 → 返回 undefined（条目等于「登记了但没有根」）', () => {
    const settings = settingsWith({ list: [project('p1', '   ')] })

    expect(resolveProjectRootById(settings, 'p1', { cwd: CWD })).toBeUndefined()
  })
})
