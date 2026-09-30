/**
 * 会话级项目解析器单测（docs/06 §5.1，v17；2026-09-30 会话空间三分）。
 *
 * 覆盖解析链的五级：会话绑定项目 > 会话空间目录（Agent → `桌面\Aurora`；Work →
 * `modes.work.workspaceDir`）> 全局当前项目 > `agent.tools.workspaceDir` > 主目录，
 * 以及「绑定项已被删除」「未传会话 id（全局链）」两条回落路径。
 * 关键口径（docs/06 §4）：**Agent 空间恒可解析**（`agentDir` 不依赖配置），因此
 * 未标记 / 未绑定的会话一律落 Agent 目录 —— 全局项目只剩「Work 空间且未配目录」
 * 这类空间目录缺席时的回落位。
 * 纯 Node（本文件不 import electron）：配置用 `createDefaultSettings()` 桩。
 */
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentDesktopDir } from '@aurora/agent-core'
import { createDefaultSettings } from '@aurora/shared'
import type { SessionSpace } from '@aurora/agent-core'
import type { ProjectConfig, Settings } from '@aurora/shared'
import { createSessionProjectResolver, type SessionProjectDeps } from './session-project.js'

const HOME = resolve('top', 'home-dir')
const GLOBAL_ROOT = resolve('top', 'global-root')
const SESSION_ROOT = resolve('top', 'session-root')
const WORKSPACE_DIR = resolve('top', 'workspace-dir')
/** Agent 空间的固定工作目录（与 agentDesktopDir 纯函数同口径，这里用真实函数算出） */
const AGENT_DIR = agentDesktopDir(HOME)

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
/** 会话空间桩：缺省一律 Agent 空间（与 `SessionStore.spaceOf` 的归一口径一致） */
const spaces: Record<string, SessionSpace> = { sw: 'work' }

function depsOf(settings: Settings): SessionProjectDeps {
  return {
    getSettings: () => settings,
    getProjectId: (sessionId) =>
      sessionId === undefined || sessionId === '' ? undefined : bindings[sessionId],
    sessionSpaceOf: (sessionId) =>
      sessionId === undefined || sessionId === '' ? 'agent' : (spaces[sessionId] ?? 'agent'),
    agentDir: () => AGENT_DIR,
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

  it('boundaryRoot：会话绑定项目 > 会话空间目录（Agent 空间恒有根，盖过全局当前项目）', () => {
    const settings = settingsWith({
      current: 'proj-global',
      list: [project('proj-global', GLOBAL_ROOT), project('proj-session', SESSION_ROOT)],
    })
    const resolver = createSessionProjectResolver(depsOf(settings))

    expect(resolver.boundaryRoot('s1')).toBe(SESSION_ROOT)
    // 未绑定 / 绑定已删除 / 未传会话 id：Agent 空间 → 桌面 Aurora（2026-09-30 起的有意收紧）
    expect(resolver.boundaryRoot('unbound')).toBe(AGENT_DIR)
    expect(resolver.boundaryRoot('deleted')).toBe(AGENT_DIR)
    expect(resolver.boundaryRoot(undefined)).toBe(AGENT_DIR)
  })

  it('boundaryRoot：Work 空间 → 模式工作目录；目录未配置时回落全局项目（唯一能摸到全局链的路径）', () => {
    const workDir = resolve('top', 'work-dir')
    // Work 空间**不看** modes.current：空间戳在创建时刻已确定归属
    const withWorkDir = settingsWith({
      current: 'proj-global',
      list: [project('proj-global', GLOBAL_ROOT)],
    })
    withWorkDir.modes.work.workspaceDir = workDir
    withWorkDir.modes.current = 'classroom'
    const resolver = createSessionProjectResolver(depsOf(withWorkDir))

    expect(resolver.boundaryRoot('sw')).toBe(workDir)

    // Work 空间但目录空白：跳过空间级，回落全局当前项目
    const emptyWork = settingsWith({
      current: 'proj-global',
      list: [project('proj-global', GLOBAL_ROOT)],
    })
    emptyWork.modes.work.workspaceDir = '   '
    const resolver2 = createSessionProjectResolver(depsOf(emptyWork))
    expect(resolver2.boundaryRoot('sw')).toBe(GLOBAL_ROOT)

    // 全局也没有：undefined（= 无边界的旧语义只对「Work 空间 + 未配目录 + 无项目」成立）
    const bare = createSessionProjectResolver(depsOf(settingsWith({ current: '' })))
    expect(bare.boundaryRoot('sw')).toBeUndefined()
  })

  it('workspaceDir：会话绑定项目 > 空间目录 > workspaceDir > 主目录', () => {
    const settings = settingsWith(
      {
        current: 'proj-global',
        list: [project('proj-global', GLOBAL_ROOT), project('proj-session', SESSION_ROOT)],
      },
      WORKSPACE_DIR,
    )
    const resolver = createSessionProjectResolver(depsOf(settings))

    expect(resolver.workspaceDir('s1')).toBe(SESSION_ROOT)
    expect(resolver.workspaceDir('unbound')).toBe(AGENT_DIR)
    expect(resolver.workspaceDir(undefined)).toBe(AGENT_DIR)

    // 全局项目根缺席：会话绑定仍生效；未绑定落 Agent 目录（不再回落 workspaceDir）
    const noGlobal = createSessionProjectResolver(
      depsOf(
        settingsWith({ current: '', list: [project('proj-session', SESSION_ROOT)] }, WORKSPACE_DIR),
      ),
    )
    expect(noGlobal.workspaceDir('s1')).toBe(SESSION_ROOT)
    expect(noGlobal.workspaceDir('unbound')).toBe(AGENT_DIR)
    expect(noGlobal.workspaceDir('deleted')).toBe(AGENT_DIR)

    // Work 空间：模式工作目录盖过 workspaceDir 配置；目录空白时才轮到 workspaceDir / 主目录
    const work = settingsWith({ current: '', list: [] }, WORKSPACE_DIR)
    work.modes.work.workspaceDir = resolve('top', 'work-dir')
    const workResolver = createSessionProjectResolver(depsOf(work))
    expect(workResolver.workspaceDir('sw')).toBe(resolve('top', 'work-dir'))

    const emptyWork = settingsWith({ current: '', list: [] }, WORKSPACE_DIR)
    const emptyWorkResolver = createSessionProjectResolver(depsOf(emptyWork))
    expect(emptyWorkResolver.workspaceDir('sw')).toBe(WORKSPACE_DIR)

    // 全链缺席：主目录兜底
    const bare = createSessionProjectResolver(depsOf(settingsWith({ current: '' })))
    expect(bare.workspaceDir('unbound')).toBe(AGENT_DIR)
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

    expect(resolver.workspaceDir('s1')).toBe(AGENT_DIR)
    mutableBindings['s1'] = 'proj-b'
    expect(resolver.workspaceDir('s1')).toBe(SESSION_ROOT)
  })
})
