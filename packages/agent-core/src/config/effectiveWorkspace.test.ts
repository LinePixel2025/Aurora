/**
 * effectiveWorkspaceDir 单测（docs/06 §5.1，v13）。
 *
 * 覆盖三级优先级：项目根 > agent.tools.workspaceDir > homeDir（+ 全空白时回落 homeDir）。
 * 用真实 `Settings` 对象做桩（`createDefaultSettings()`），纯 Node 可跑。
 */
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDefaultSettings } from '@aurora/shared'
import type { ProjectConfig, Settings } from '@aurora/shared'
import { effectiveWorkspaceDir } from './effectiveWorkspace.js'

const PROJECT_ROOT = resolve('top', 'project-root')
const LIST_ROOT = resolve('top', 'list-root')
const WORKSPACE_DIR = resolve('top', 'workspace-dir')
const HOME_DIR = resolve('top', 'home-dir')

function project(id: string, root: string): ProjectConfig {
  return { id, name: id, root }
}

/** 真实 Settings 桩：只改 projects 与 agent.tools.workspaceDir。 */
function settingsWith(options: {
  current?: string
  list?: ProjectConfig[]
  workspaceDir?: string
}): Settings {
  const settings = createDefaultSettings()
  settings.projects = {
    ...settings.projects,
    current: options.current ?? '',
    list: options.list ?? [],
  }
  settings.agent.tools.workspaceDir = options.workspaceDir ?? ''
  return settings
}

describe('effectiveWorkspaceDir', () => {
  it('项目根赢过 workspaceDir', () => {
    const settings = settingsWith({
      current: 'p1',
      list: [project('p1', LIST_ROOT)],
      workspaceDir: WORKSPACE_DIR,
    })

    expect(effectiveWorkspaceDir(settings, PROJECT_ROOT, HOME_DIR)).toBe(PROJECT_ROOT)
  })

  it('projectRoot 未传时用 current 命中条目的 root（不做绝对化）', () => {
    const settings = settingsWith({
      current: 'p1',
      list: [project('p1', 'relative/list-root')],
      workspaceDir: WORKSPACE_DIR,
    })

    expect(effectiveWorkspaceDir(settings, undefined, HOME_DIR)).toBe('relative/list-root')
  })

  it('无项目时 workspaceDir 赢过 homeDir', () => {
    const settings = settingsWith({
      current: '',
      list: [project('p1', LIST_ROOT)],
      workspaceDir: WORKSPACE_DIR,
    })

    expect(effectiveWorkspaceDir(settings, undefined, HOME_DIR)).toBe(WORKSPACE_DIR)
  })

  it('项目与 workspaceDir 都为空时回落 homeDir', () => {
    const settings = settingsWith({ workspaceDir: '' })

    expect(effectiveWorkspaceDir(settings, undefined, HOME_DIR)).toBe(HOME_DIR)
  })

  it('projectRoot 传值时优先级最高（压过 list 命中的 root 与 workspaceDir）', () => {
    const settings = settingsWith({
      current: 'p1',
      list: [project('p1', LIST_ROOT)],
      workspaceDir: WORKSPACE_DIR,
    })

    expect(effectiveWorkspaceDir(settings, PROJECT_ROOT, HOME_DIR)).toBe(PROJECT_ROOT)
  })

  it('三级全为空白串时返回传入的 homeDir', () => {
    const settings = settingsWith({
      current: '   ',
      list: [],
      workspaceDir: '  ',
    })

    expect(effectiveWorkspaceDir(settings, '  ', HOME_DIR)).toBe(HOME_DIR)
  })

  it('命中条目的 root 为空白串时继续回落到 workspaceDir', () => {
    const settings = settingsWith({
      current: 'p1',
      list: [project('p1', '   ')],
      workspaceDir: `  ${WORKSPACE_DIR}  `,
    })

    expect(effectiveWorkspaceDir(settings, undefined, HOME_DIR)).toBe(WORKSPACE_DIR)
  })

  // ───────── 会话级项目（docs/06 §5.1，第 4 参） ─────────

  it('会话绑定的项目根优先级最高（压过全局项目根与 workspaceDir）', () => {
    const settings = settingsWith({
      current: 'p1',
      list: [project('p1', LIST_ROOT), project('p2', resolve('top', 'session-root'))],
      workspaceDir: WORKSPACE_DIR,
    })
    const sessionRoot = resolve('top', 'session-root')

    expect(effectiveWorkspaceDir(settings, PROJECT_ROOT, HOME_DIR, sessionRoot)).toBe(sessionRoot)
  })

  it('未绑定会话（undefined）按原三级回落：全局项目根 > workspaceDir > homeDir', () => {
    const settings = settingsWith({
      current: 'p1',
      list: [project('p1', LIST_ROOT)],
      workspaceDir: WORKSPACE_DIR,
    })

    expect(effectiveWorkspaceDir(settings, undefined, HOME_DIR, undefined)).toBe(LIST_ROOT)
    expect(effectiveWorkspaceDir(settings, undefined, HOME_DIR, '')).toBe(LIST_ROOT)
  })

  it('会话绑定的项目已被删除（第 4 参为空串）时回落全局链，不抛错', () => {
    const settings = settingsWith({
      current: 'p1',
      list: [project('p1', LIST_ROOT)],
      workspaceDir: WORKSPACE_DIR,
    })

    expect(effectiveWorkspaceDir(settings, undefined, HOME_DIR, '   ')).toBe(LIST_ROOT)
  })

  it('会话根与全局根都缺席时按 workspaceDir > homeDir 回落', () => {
    const settings = settingsWith({ current: '', workspaceDir: WORKSPACE_DIR })

    expect(effectiveWorkspaceDir(settings, undefined, HOME_DIR, undefined)).toBe(WORKSPACE_DIR)

    const bare = settingsWith({ current: '' })
    expect(effectiveWorkspaceDir(bare, undefined, HOME_DIR, undefined)).toBe(HOME_DIR)
  })
})
