/**
 * 会话级项目解析器单测（docs/06 §5.1，v17）。
 *
 * 覆盖解析链的三层：会话绑定项目 > 全局当前项目 > `agent.tools.workspaceDir` > 主目录，
 * 以及「绑定项已被删除」「未传会话 id（全局链）」两条回落路径。
 * 纯 Node（本文件不 import electron）：配置用 `createDefaultSettings()` 桩。
 */
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDefaultSettings } from '@aurora/shared'
import type { ProjectConfig, Settings } from '@aurora/shared'
import { createSessionProjectResolver, type SessionProjectDeps } from './session-project.js'

const HOME = resolve('top', 'home-dir')
const GLOBAL_ROOT = resolve('top', 'global-root')
const SESSION_ROOT = resolve('top', 'session-root')
const WORKSPACE_DIR = resolve('top', 'workspace-dir')

function project(id: string, root: string): ProjectConfig {
  return { id, name: id, root }
}

function settingsWith(projects: Partial<Settings['projects']>, workspaceDir = ''): Settings {
  const settings = createDefaultSettings()
  settings.projects = { ...settings.projects, ...projects }
  settings.agent.tools.workspaceDir = workspaceDir
  return settings
}

/** 会话绑定桩：`s1 → proj-session`，其余未绑定 */
const bindings: Record<string, string> = { s1: 'proj-session', deleted: 'proj-gone' }

function depsOf(settings: Settings): SessionProjectDeps {
  return {
    getSettings: () => settings,
    getProjectId: (sessionId) =>
      sessionId === undefined || sessionId === '' ? undefined : bindings[sessionId],
    // 与生产装配同口径：全局根按 settings.projects.current 现查（settings 改了立即生效）
    globalProjectRoot: () => {
      const id = settings.projects.current.trim()
      if (id === '') return undefined
      const root = settings.projects.list.find((entry) => entry.id === id)?.root.trim()
      return root === undefined || root === '' ? undefined : resolve(root)
    },
    homeDir: () => HOME,
    cwd: process.cwd(),
  }
}

describe('createSessionProjectResolver', () => {
  it('projectRootOf 只读会话自身绑定：未绑定 / 绑定已删除返回 undefined（不回落全局）', () => {
    const settings = settingsWith({
      current: 'proj-global',
      list: [project('proj-global', GLOBAL_ROOT), project('proj-session', SESSION_ROOT)],
    })
    const resolver = createSessionProjectResolver(depsOf(settings))

    expect(resolver.projectRootOf('s1')).toBe(SESSION_ROOT)
    expect(resolver.projectRootOf('deleted')).toBeUndefined()
    expect(resolver.projectRootOf('unbound')).toBeUndefined()
    expect(resolver.projectRootOf(undefined)).toBeUndefined()
  })

  it('boundaryRoot：会话绑定项目 > 全局当前项目；两者都无 → undefined', () => {
    const settings = settingsWith({
      current: 'proj-global',
      list: [project('proj-global', GLOBAL_ROOT), project('proj-session', SESSION_ROOT)],
    })
    const resolver = createSessionProjectResolver(depsOf(settings))

    expect(resolver.boundaryRoot('s1')).toBe(SESSION_ROOT)
    expect(resolver.boundaryRoot('unbound')).toBe(GLOBAL_ROOT)
    expect(resolver.boundaryRoot('deleted')).toBe(GLOBAL_ROOT)
    expect(resolver.boundaryRoot(undefined)).toBe(GLOBAL_ROOT)

    const noGlobal = createSessionProjectResolver(
      depsOf(settingsWith({ current: '', list: [project('proj-session', SESSION_ROOT)] })),
    )
    expect(noGlobal.boundaryRoot('unbound')).toBeUndefined()
  })

  it('boundaryRoot / workspaceDir 的 Work 模式回落（v18）：会话绑定 > 全局项目 > 模式工作目录', () => {
    const workDir = resolve('top', 'work-dir')
    const bare = settingsWith({ current: '', list: [] })
    bare.modes.current = 'work'
    bare.modes.work.workspaceDir = workDir
    const resolver = createSessionProjectResolver(depsOf(bare))

    expect(resolver.boundaryRoot('unbound')).toBe(workDir)
    expect(resolver.workspaceDir('unbound')).toBe(workDir)

    // 项目优先于模式工作目录（显式指定的当前项目盖过场景化缺省）
    const withProject = settingsWith({
      current: 'proj-global',
      list: [project('proj-global', GLOBAL_ROOT)],
    })
    withProject.modes.current = 'work'
    withProject.modes.work.workspaceDir = workDir
    const resolver2 = createSessionProjectResolver(depsOf(withProject))
    expect(resolver2.boundaryRoot('unbound')).toBe(GLOBAL_ROOT)

    // 非 Work 模式不参与链；Work 模式但目录空白同样不参与
    const classroom = settingsWith({ current: '', list: [] })
    classroom.modes.work.workspaceDir = workDir
    expect(createSessionProjectResolver(depsOf(classroom)).workspaceDir('unbound')).toBe(HOME)

    const emptyWork = settingsWith({ current: '', list: [] })
    emptyWork.modes.current = 'work'
    emptyWork.modes.work.workspaceDir = '   '
    expect(createSessionProjectResolver(depsOf(emptyWork)).workspaceDir('unbound')).toBe(HOME)
  })

  it('workspaceDir：会话绑定项目 > 全局项目根 > workspaceDir > 主目录', () => {
    const settings = settingsWith(
      {
        current: 'proj-global',
        list: [project('proj-global', GLOBAL_ROOT), project('proj-session', SESSION_ROOT)],
      },
      WORKSPACE_DIR,
    )
    const resolver = createSessionProjectResolver(depsOf(settings))

    expect(resolver.workspaceDir('s1')).toBe(SESSION_ROOT)
    expect(resolver.workspaceDir('unbound')).toBe(GLOBAL_ROOT)
    expect(resolver.workspaceDir(undefined)).toBe(GLOBAL_ROOT)

    // 全局项目根缺席：会话绑定仍生效，未绑定回落 workspaceDir
    const noGlobal = createSessionProjectResolver(
      depsOf(
        settingsWith({ current: '', list: [project('proj-session', SESSION_ROOT)] }, WORKSPACE_DIR),
      ),
    )
    expect(noGlobal.workspaceDir('s1')).toBe(SESSION_ROOT)
    expect(noGlobal.workspaceDir('unbound')).toBe(WORKSPACE_DIR)
    expect(noGlobal.workspaceDir('deleted')).toBe(WORKSPACE_DIR)

    // 全链缺席：主目录兜底
    const bare = createSessionProjectResolver(depsOf(settingsWith({ current: '' })))
    expect(bare.workspaceDir('unbound')).toBe(HOME)
  })

  it('配置是 live getter：改绑定 / 改设置下一次解析立即生效（无缓存死值）', () => {
    const settings = settingsWith({
      current: 'proj-a',
      list: [project('proj-a', GLOBAL_ROOT), project('proj-b', SESSION_ROOT)],
    })
    const mutableBindings: Record<string, string> = { s1: '' }
    const resolver = createSessionProjectResolver({
      ...depsOf(settings),
      getProjectId: (sessionId) =>
        sessionId === undefined || sessionId === '' ? undefined : mutableBindings[sessionId],
    })

    expect(resolver.workspaceDir('s1')).toBe(GLOBAL_ROOT)
    mutableBindings['s1'] = 'proj-b'
    expect(resolver.workspaceDir('s1')).toBe(SESSION_ROOT)
  })
})
