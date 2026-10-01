/**
 * 会话级项目解析器单测（docs/06 §5.1，v17；2026-09-30 会话空间三分）。
 *
 * 覆盖解析链：会话绑定项目 > 会话空间目录（Agent → `桌面\Aurora`；Work →
 * `modes.work.workspaceDir`）> 激活模式目录 > `agent.tools.workspaceDir` > 主目录，
 * 以及「绑定项已被删除」「未传会话 id」两条回落路径。
 * 关键口径（docs/06 §4）：**Agent 空间恒可解析**（`agentDir` 不依赖配置），因此
 * 未标记 / 未绑定的会话一律落 Agent 目录 —— 全局 `projects.current` 一级已于 v25 退役。
 * 纯 Node（本文件不 import electron）：配置用 `createDefaultSettings()` 桩。
 */
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentDesktopDir } from '@aurora/agent-core'
import { createDefaultSettings } from '@aurora/shared'
import type { SessionSpace } from '@aurora/agent-core'
import type { ProjectConfig, Settings } from '@aurora/shared'
import {
  adaptForSubagent,
  createSessionProjectResolver,
  type SessionProjectDeps,
} from './session-project.js'

const HOME = resolve('top', 'home-dir')
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
    homeDir: () => HOME,
    cwd: process.cwd(),
  }
}

describe('createSessionProjectResolver', () => {
  it('projectRootOf 只读会话自身绑定：未绑定 / 绑定已删除返回 undefined（不回落）', () => {
    const settings = settingsWith({ list: [project('proj-session', SESSION_ROOT)] })
    const resolver = createSessionProjectResolver(depsOf(settings))

    expect(resolver.projectRootOf('s1')).toBe(SESSION_ROOT)
    expect(resolver.projectRootOf('deleted')).toBeUndefined()
    expect(resolver.projectRootOf('unbound')).toBeUndefined()
    expect(resolver.projectRootOf(undefined)).toBeUndefined()
  })

  it('boundaryRoot：会话绑定项目 > 会话空间目录（Agent 空间恒有根）', () => {
    const settings = settingsWith({ list: [project('proj-session', SESSION_ROOT)] })
    const resolver = createSessionProjectResolver(depsOf(settings))

    expect(resolver.boundaryRoot('s1')).toBe(SESSION_ROOT)
    // 未绑定 / 绑定已删除 / 未传会话 id：Agent 空间 → 桌面 Aurora（2026-09-30 起的有意收紧）
    expect(resolver.boundaryRoot('unbound')).toBe(AGENT_DIR)
    expect(resolver.boundaryRoot('deleted')).toBe(AGENT_DIR)
    expect(resolver.boundaryRoot(undefined)).toBe(AGENT_DIR)
  })

  it('boundaryRoot：Work 空间 → 模式工作目录；目录未配置时无根（undefined）', () => {
    const workDir = resolve('top', 'work-dir')
    // Work 空间**不看** modes.current：空间戳在创建时刻已确定归属
    const withWorkDir = settingsWith({})
    withWorkDir.modes.work.workspaceDir = workDir
    withWorkDir.modes.current = 'classroom'
    const resolver = createSessionProjectResolver(depsOf(withWorkDir))

    expect(resolver.boundaryRoot('sw')).toBe(workDir)

    // Work 空间但目录空白：无别的绑定 → 无边界根
    const emptyWork = settingsWith({})
    emptyWork.modes.work.workspaceDir = '   '
    const resolver2 = createSessionProjectResolver(depsOf(emptyWork))
    expect(resolver2.boundaryRoot('sw')).toBeUndefined()
  })

  it('workspaceDir：会话绑定项目 > 空间目录 > workspaceDir > 主目录', () => {
    const settings = settingsWith({ list: [project('proj-session', SESSION_ROOT)] }, WORKSPACE_DIR)
    const resolver = createSessionProjectResolver(depsOf(settings))

    expect(resolver.workspaceDir('s1')).toBe(SESSION_ROOT)
    expect(resolver.workspaceDir('unbound')).toBe(AGENT_DIR)
    expect(resolver.workspaceDir(undefined)).toBe(AGENT_DIR)

    // Agent 空间恒可解析：workspaceDir 配置不参与（空间目录盖过它）
    expect(resolver.workspaceDir('deleted')).toBe(AGENT_DIR)

    // Work 空间：模式工作目录盖过 workspaceDir 配置；目录空白时才轮到 workspaceDir / 主目录
    const work = settingsWith({}, WORKSPACE_DIR)
    work.modes.work.workspaceDir = resolve('top', 'work-dir')
    const workResolver = createSessionProjectResolver(depsOf(work))
    expect(workResolver.workspaceDir('sw')).toBe(resolve('top', 'work-dir'))

    const emptyWorkResolver = createSessionProjectResolver(depsOf(settingsWith({}, WORKSPACE_DIR)))
    expect(emptyWorkResolver.workspaceDir('sw')).toBe(WORKSPACE_DIR)
  })

  it('配置是 live getter：改绑定 / 改设置下一次解析立即生效（无缓存死值）', () => {
    const settings = settingsWith({ list: [project('proj-b', SESSION_ROOT)] })
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

describe('adaptForSubagent（A2：子代理缺省 cwd / 搜索根 / 边界根跟随父会话）', () => {
  it('`-sub` 会话 id 剥回父会话再解析：绑定项目的父会话，子代理拿到同一个项目根', () => {
    const settings = settingsWith({ list: [project('proj-session', SESSION_ROOT)] })
    const view = adaptForSubagent(createSessionProjectResolver(depsOf(settings)))

    expect(view.workspaceDir('s1-sub')).toBe(SESSION_ROOT)
    expect(view.boundaryRoot('s1-sub')).toBe(SESSION_ROOT)
    // 父会话本身与未带后缀的 id 原样
    expect(view.workspaceDir('s1')).toBe(SESSION_ROOT)
    expect(view.workspaceDir('a-sub-sub')).toBe(AGENT_DIR) // 只剥一层：a-sub 未绑定 → Agent 空间
  })

  it('父会话未绑定项目：回落链逐字不变（Agent 空间 > Work 模式目录 > workspaceDir > 主目录）', () => {
    const settings = settingsWith({}, WORKSPACE_DIR)
    const view = adaptForSubagent(createSessionProjectResolver(depsOf(settings)))

    expect(view.workspaceDir('unbound-sub')).toBe(AGENT_DIR)
    expect(view.boundaryRoot('unbound-sub')).toBe(AGENT_DIR)

    const work = settingsWith({}, WORKSPACE_DIR)
    work.modes.work.workspaceDir = resolve('top', 'work-dir')
    work.modes.current = 'work'
    const workView = adaptForSubagent(createSessionProjectResolver(depsOf(work)))
    expect(workView.workspaceDir('sw-sub')).toBe(resolve('top', 'work-dir'))
  })

  it('undefined / 空串原样透传（不剥、不抛）', () => {
    const settings = settingsWith({ list: [project('proj-session', SESSION_ROOT)] })
    const view = adaptForSubagent(createSessionProjectResolver(depsOf(settings)))

    expect(view.workspaceDir(undefined)).toBe(AGENT_DIR)
    expect(view.workspaceDir('')).toBe(AGENT_DIR)
    expect(view.boundaryRoot(undefined)).toBe(AGENT_DIR)
  })
})
