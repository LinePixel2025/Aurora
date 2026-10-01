/**
 * `resolveWorkspaceOpenTarget`（「打开工作目录」按钮，docs/06 §5.1）。
 *
 * 本文件不 import electron（被测函数是纯计算）→ vitest 可收。
 * 钉两条口径：
 * 1. **与执行链同目录**：Work 模式配了模式工作目录时返回它（与缺省 `cwd` 一致）；
 * 2. **回落护栏**：没配模式目录时按 workspaceDir > 主目录回落 —— 全局 `projects.current`
 *    一级已于 v25 退役（该按钮无会话上下文，也不经过会话绑定 / 空间那两级）。
 */
import { describe, expect, it } from 'vitest'
import { resolveWorkspaceOpenTarget } from './workspace-target.js'
import { createDefaultSettings } from '@aurora/shared'

/** 主目录桩（值不重要，只验「回落的是注入的那个值」） */
const home = 'C:\\Users\\smoke-home'

describe('resolveWorkspaceOpenTarget（openPath kind:workspace）', () => {
  it('非 Work 模式 + 工作目录留空：回落用户主目录', () => {
    const settings = createDefaultSettings()
    expect(settings.agent.tools.workspaceDir).toBe('')
    const target = resolveWorkspaceOpenTarget(settings, { homeDir: () => home })
    expect(target).toBe(home)
  })

  it('非 Work 模式 + 工作目录非空：返回配置的工作目录', () => {
    const settings = createDefaultSettings()
    settings.agent.tools.workspaceDir = 'D:\\ws'
    const target = resolveWorkspaceOpenTarget(settings, { homeDir: () => home })
    expect(target).toBe('D:\\ws')
  })

  it('Work 模式 + 配了模式工作目录：返回模式目录（与命令缺省 cwd 一致）', () => {
    const settings = createDefaultSettings()
    settings.agent.tools.workspaceDir = 'D:\\ws'
    settings.modes.current = 'work'
    settings.modes.work.workspaceDir = 'D:\\work-dir'
    const target = resolveWorkspaceOpenTarget(settings, { homeDir: () => home })
    expect(target).toBe('D:\\work-dir')
  })

  it('Work 模式但模式目录空白：跳过模式级，回落到工作目录（与 effectiveWorkspace 同一护栏）', () => {
    const settings = createDefaultSettings()
    settings.agent.tools.workspaceDir = 'D:\\ws'
    settings.modes.current = 'work'
    settings.modes.work.workspaceDir = '   '
    const target = resolveWorkspaceOpenTarget(settings, { homeDir: () => home })
    expect(target).toBe('D:\\ws')
  })
})
