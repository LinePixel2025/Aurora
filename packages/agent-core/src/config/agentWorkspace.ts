/**
 * Agent 空间的固定工作目录（docs/06 §4 会话三分 / §5.1 回落链，2026-09-30）。
 *
 * 主界面左栏「Agent对话」区的会话（`space: 'agent'` 或未标记，含 `quick`）统一落在
 * 桌面下的 Aurora 目录：`%USERPROFILE%\Desktop\Aurora`。它是**固定常量不是配置项**
 * —— 不进 Schema、不进 `CONFIG_VERSION` 迁移链；用户要换工作区请用项目绑定
 * （项目对话）或 Work 模式的工作目录（工作目录对话）。
 *
 * 目录的**创建**由主进程负责（装配层在 Agent 会话首次使用前懒 `mkdir recursive`，
 * 失败只告警不阻断 —— 目录不存在时 `file-port` 的 realpath 校验会退到最近存在的
 * 父目录，链路本身能工作）。纯 Node：不碰 Electron / DOM，可直接单测。
 */
import { join } from 'node:path'

/** Agent 空间的目录名（桌面下的 Aurora 文件夹） */
export const AGENT_WORKSPACE_DIR_NAME = 'Aurora'

/**
 * Agent 空间的固定工作目录：`<homeDir>\Desktop\Aurora`。
 *
 * `homeDir` 由调用方注入（主进程传 `os.homedir()`）；`homeDir` 为空白时返回空串
 * （与 `effectiveWorkspaceDir` 的末级回落同款约定，调用方自行兜底）。
 */
export function agentDesktopDir(homeDir: string): string {
  const home = homeDir.trim()
  if (home === '') return ''
  return join(home, 'Desktop', AGENT_WORKSPACE_DIR_NAME)
}
