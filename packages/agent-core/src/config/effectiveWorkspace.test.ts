/**
 * effectiveWorkspaceDir 单测（docs/06 §5.1）。
 *
 * 覆盖回落链：会话绑定项目根 > 模式工作目录 > agent.tools.workspaceDir > homeDir。
 * 全局 `projects.current` 一级已于 v25 退役（会话的实际工作目录由会话绑定决定）。
 * 用真实 `Settings` 对象做桩（`createDefaultSettings()`），纯 Node 可跑。
 */
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDefaultSettings } from '@aurora/shared'
import type { ProjectConfig, Settings } from '@aurora/shared'
import { effectiveWorkspaceDir } from './effectiveWorkspace.js'

const SESSION_ROOT = resolve('top', 'session-root')
const WORKSPACE_DIR = resolve('top', 'workspace-dir')
const HOME_DIR = resolve('top', 'home-dir')

/** 真实 Settings 桩：只改 projects 与 agent.tools.workspaceDir。 */
function settingsWith(options: { list?: ProjectConfig[]; workspaceDir?: string }): Settings {
  const settings = createDefaultSettings()
  settings.projects = {
    ...settings.projects,
    list: options.list ?? [],
  }
  settings.agent.tools.workspaceDir = options.workspaceDir ?? ''
  return settings
}

describe('effectiveWorkspaceDir', () => {
  it('会话绑定的项目根优先级最高（压过模式目录与 workspaceDir）', () => {
    const settings = settingsWith({ workspaceDir: WORKSPACE_DIR })

    expect(effectiveWorkspaceDir(settings, HOME_DIR, SESSION_ROOT, WORKSPACE_DIR)).toBe(
      SESSION_ROOT,
    )
  })

  it('会话根为空白串视为未绑定，继续回落', () => {
    const settings = settingsWith({ workspaceDir: WORKSPACE_DIR })

    expect(effectiveWorkspaceDir(settings, HOME_DIR, '  ', undefined)).toBe(WORKSPACE_DIR)
    expect(effectiveWorkspaceDir(settings, HOME_DIR, '', undefined)).toBe(WORKSPACE_DIR)
  })

  it('未绑定时模式工作目录（Work）赢过 workspaceDir', () => {
    const settings = settingsWith({ workspaceDir: WORKSPACE_DIR })

    expect(effectiveWorkspaceDir(settings, HOME_DIR, undefined, WORKSPACE_DIR)).toBe(WORKSPACE_DIR)
  })

  it('未绑定且模式目录缺席时 workspaceDir 赢过 homeDir', () => {
    const settings = settingsWith({ workspaceDir: WORKSPACE_DIR })

    expect(effectiveWorkspaceDir(settings, HOME_DIR, undefined, undefined)).toBe(WORKSPACE_DIR)
  })

  it('workspaceDir 带空白时归一采用；全链缺席回落 homeDir', () => {
    const settings = settingsWith({ workspaceDir: `  ${WORKSPACE_DIR}  ` })

    expect(effectiveWorkspaceDir(settings, HOME_DIR, undefined, undefined)).toBe(WORKSPACE_DIR)

    const bare = settingsWith({ workspaceDir: '  ' })
    expect(effectiveWorkspaceDir(bare, HOME_DIR, undefined, undefined)).toBe(HOME_DIR)
  })
})
