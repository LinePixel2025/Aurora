/**
 * 「打开工作目录」按钮的目标解析（docs/06 §5.1）。
 *
 * 与工具执行链走**同一个**回落 `effectiveWorkspaceDir`
 * （激活模式工作目录（Work）> `agent.tools.workspaceDir` > 用户主目录；无会话上下文，
 * 不经过会话绑定 / 会话空间那两级）：
 * Work 模式下打开模式工作目录，与不显式传 `cwd` 的 `run_command` / 不传根的 `grep` /
 * `glob` 落地目录一致，消除早前「按钮按字面 `workspaceDir` 解析」的用户可见分叉。
 *
 * 本文件是**纯计算**：不 import electron —— `homeDir` 由调用方注入
 * （`ipc.ts` 用 `app.getPath('home')` 提供），
 * 这样解析逻辑可以直接进 vitest（vitest 只收不 import 'electron' 的主进程测试）。
 */
import { effectiveWorkspaceDir } from '@aurora/agent-core'
import type { Settings } from '@aurora/shared'

/** 「打开工作目录」按钮的目标：与执行链缺省目录同口径（docs/06 §5.1 回落链）。 */
export function resolveWorkspaceOpenTarget(
  settings: Pick<Settings, 'agent' | 'modes'>,
  deps: { homeDir: () => string },
): string {
  // 激活模式的工作目录（v18）：当前只有 Work 模式提供，与 session-project 同口径
  const modeDir =
    settings.modes.current === 'work' && settings.modes.work.workspaceDir.trim() !== ''
      ? settings.modes.work.workspaceDir
      : undefined
  return effectiveWorkspaceDir(settings, deps.homeDir(), undefined, modeDir)
}
