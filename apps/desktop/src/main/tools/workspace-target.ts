/**
 * 「打开工作目录」按钮的目标解析（docs/06 §5.1）。
 *
 * 与工具执行链走**同一个**三级回落 `effectiveWorkspaceDir`
 * （当前项目根 > `agent.tools.workspaceDir` > 用户主目录）：配了当前项目时打开项目根，
 * 与不显式传 `cwd` 的 `run_command` / 不传根的 `grep` / `glob` 落地目录一致，
 * 消除早前「按钮按字面 `workspaceDir` 解析」的用户可见分叉。
 *
 * 本文件是**纯计算**：不 import electron —— `homeDir` 与 `projectRoot` 由调用方注入
 * （`ipc.ts` 用 `app.getPath('home')` / `resolveProject()` 提供），
 * 这样解析逻辑可以直接进 vitest（vitest 只收不 import 'electron' 的主进程测试）。
 */
import { effectiveWorkspaceDir } from '@aurora/agent-core'
import type { Settings } from '@aurora/shared'

/** 「打开工作目录」按钮的目标：与执行链缺省目录同口径（docs/06 §5.1 三级回落）。 */
export function resolveWorkspaceOpenTarget(
  settings: Pick<Settings, 'projects' | 'agent'>,
  deps: { projectRoot: () => string | undefined; homeDir: () => string },
): string {
  return effectiveWorkspaceDir(settings, deps.projectRoot(), deps.homeDir())
}
