/**
 * resolveProject 单测（docs/06 §5.1，v13）。
 *
 * 用真实的 `Settings` 对象做桩（`createDefaultSettings()`），只覆盖 `projects` 分组 ——
 * 不 import zod、不碰文件系统，纯 Node 可跑。
 */
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDefaultSettings, createMemoryLogger } from '@aurora/shared'
import type { ProjectConfig, Settings } from '@aurora/shared'
import { resolveProject } from './project.js'

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

describe('resolveProject', () => {
  it('current 为空串 → 无项目，且不告警', () => {
    const logger = createMemoryLogger()
    const result = resolveProject(
      settingsWith({ current: '', list: [project('p1', resolve('proj-1'))] }),
      { cwd: CWD, logger },
    )

    expect(result.current).toBeUndefined()
    expect(result.root).toBeUndefined()
    expect(logger.entries).toEqual([])
  })

  it('current 指向不存在的 id → 降级为无项目、不抛错，并记一条 warn', () => {
    const logger = createMemoryLogger()
    const settings = settingsWith({ current: 'ghost', list: [project('p1', resolve('proj-1'))] })

    // 未注入 logger 的调用路径同样不得抛错
    expect(() => resolveProject(settings, { cwd: CWD })).not.toThrow()

    const result = resolveProject(settings, { cwd: CWD, logger })
    expect(result.current).toBeUndefined()
    expect(result.root).toBeUndefined()
    expect(logger.entries).toHaveLength(1)
    expect(logger.entries[0]).toContain('[warn]')
    expect(logger.entries[0]).toContain('ghost')
  })

  it('命中项目 + 绝对 root → 原样采用（不受 cwd 影响）', () => {
    // `resolve('D:\\proj')` 在 Windows 上就是 `D:\proj`，在其它平台是等价绝对路径；
    // 期望值与实现同源，避免写死反斜杠字面量。
    const absoluteRoot = resolve('D:\\proj')
    const entry = project('p1', absoluteRoot)
    const logger = createMemoryLogger()

    const result = resolveProject(settingsWith({ current: 'p1', list: [entry] }), {
      cwd: CWD,
      logger,
    })

    expect(result.current).toStrictEqual(entry)
    expect(result.root).toBe(absoluteRoot)
    expect(logger.entries).toEqual([])
  })

  it('命中项目 + 相对 root → 按传入 cwd 解析成绝对路径', () => {
    const entry = project('p2', 'sub/dir')
    const result = resolveProject(settingsWith({ current: 'p2', list: [entry] }), { cwd: CWD })

    expect(result.current).toStrictEqual(entry)
    expect(result.root).toBe(join(CWD, 'sub', 'dir'))
  })

  it('root 为空白串 → 视为无项目', () => {
    const logger = createMemoryLogger()
    const result = resolveProject(settingsWith({ current: 'p3', list: [project('p3', '   ')] }), {
      cwd: CWD,
      logger,
    })

    expect(result.current).toBeUndefined()
    expect(result.root).toBeUndefined()
  })

  it('多项目时只取 current 那一条', () => {
    const first = project('a', 'a-root')
    const second = project('b', 'b-root')
    const third = project('c', 'c-root')

    const result = resolveProject(settingsWith({ current: 'b', list: [first, second, third] }), {
      cwd: CWD,
    })

    expect(result.current).toStrictEqual(second)
    expect(result.root).toBe(join(CWD, 'b-root'))
  })
})
