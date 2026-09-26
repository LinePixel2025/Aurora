/**
 * `resolveWorkspaceOpenTarget`（「打开工作目录」按钮，docs/06 §5.1）。
 *
 * 本文件不 import electron（被测函数是纯计算）→ vitest 可收。
 * 钉两条口径：
 * 1. **与执行链同目录**：配了当前项目时返回项目根（与缺省 `cwd` 一致）；
 * 2. **无项目等价护栏**：未配项目时与旧的「字面 `workspaceDir`（空串 = 主目录）」两级逻辑逐字一致。
 */
import { describe, expect, it } from 'vitest'
import { resolveWorkspaceOpenTarget } from './workspace-target.js'
import { createDefaultSettings } from '@aurora/shared'

/** 主目录桩（值不重要，只验「回落的是注入的那个值」） */
const home = 'C:\\Users\\smoke-home'

describe('resolveWorkspaceOpenTarget（openPath kind:workspace）', () => {
  it('无项目 + 工作目录留空：回落用户主目录（与旧两级逻辑逐字一致）', () => {
    const settings = createDefaultSettings()
    expect(settings.agent.tools.workspaceDir).toBe('')
    const target = resolveWorkspaceOpenTarget(settings, {
      projectRoot: () => undefined,
      homeDir: () => home,
    })
    expect(target).toBe(home)
  })

  it('无项目 + 工作目录非空：返回配置的工作目录（与旧两级逻辑逐字一致）', () => {
    const settings = createDefaultSettings()
    settings.agent.tools.workspaceDir = 'D:\\ws'
    const target = resolveWorkspaceOpenTarget(settings, {
      projectRoot: () => undefined,
      homeDir: () => home,
    })
    expect(target).toBe('D:\\ws')
  })

  it('有项目时返回项目根（与命令缺省 cwd 一致，工作目录留空或非空都不参与）', () => {
    const settings = createDefaultSettings()
    settings.agent.tools.workspaceDir = 'D:\\ws'
    const target = resolveWorkspaceOpenTarget(settings, {
      projectRoot: () => 'D:\\proj',
      homeDir: () => home,
    })
    expect(target).toBe('D:\\proj')
  })

  it('项目根为纯空白：视为未配置项目，回落到工作目录（与 effectiveWorkspace 同一护栏）', () => {
    const settings = createDefaultSettings()
    settings.agent.tools.workspaceDir = 'D:\\ws'
    const target = resolveWorkspaceOpenTarget(settings, {
      projectRoot: () => '   ',
      homeDir: () => home,
    })
    expect(target).toBe('D:\\ws')
  })
})
