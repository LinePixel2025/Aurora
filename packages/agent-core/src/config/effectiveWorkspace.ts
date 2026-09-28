/**
 * 生效的工作目录（docs/06 §5.1，v13；会话级项目 v17；模式工作目录 v18）。
 *
 * 回落链：**会话绑定的项目根 > 当前项目根 > 激活模式的工作目录 > `agent.tools.workspaceDir` > 用户主目录**。
 * 项目根排最前是因为「切项目」在用户心智里就等于「切工作区」——登记了项目却还把命令
 * 跑在旧目录，是最难排查的一类错位。会话绑定的项目（`meta.projectId`）又排在全局
 * `projects.current` 之前：它是「这个会话在哪个项目里干活」的显式表达，粒度更细。
 * 模式工作目录（当前只有 Work 模式提供）插在全局项目之后：它是「没绑项目时的场景化
 * 缺省」，比全局工具目录更具体，又不能盖掉用户显式指定的当前项目 —— 这条链是
 * Codex 式「一个会话一个工作目录」的唯一口径（docs/05 §4），提示词与工具链同源。
 *
 * 纯函数：不读配置存储、不解析文件系统，`homeDir` 与两级项目根都由调用方注入
 * （主进程从 `os.homedir()` / `resolveProject()` / 会话绑定解析取），因此不碰 Electron / DOM，
 * 可直接单测。
 */
import type { Settings } from '@aurora/shared'

/**
 * 生效的工作目录（docs/06 §5.1）：会话项目根 > 当前项目根 > 模式工作目录 >
 * agent.tools.workspaceDir > homeDir。前四级都为空串时返回 homeDir（可能也是空串，调用方自行兜底）。
 *
 * 注意：本函数**不做绝对化**——`projects.list[*].root` 可能还是相对路径，
 * 归一由 `resolveProject()` / `resolveProjectRootById()`（或调用方）负责。
 *
 * @param projectRoot   调用方已解析好的**全局**当前项目根（`resolveProject().root`）；无项目传 undefined
 * @param homeDir       末级回落（用户主目录）
 * @param sessionProjectRoot 会话绑定的项目根（**调用方已按会话解析**，docs/06 §5.1）；
 *   undefined / 空串 = 未绑定或绑定已失效，整条链按既有回落
 * @param modeWorkspaceDir 激活模式的工作目录（v18；当前只有 Work 模式传
 *   `modes.work.workspaceDir`，其余模式传 undefined）—— 空串 / undefined 视为未配置
 */
export function effectiveWorkspaceDir(
  settings: Pick<Settings, 'projects' | 'agent'>,
  projectRoot: string | undefined,
  homeDir: string,
  sessionProjectRoot?: string | undefined,
  modeWorkspaceDir?: string | undefined,
): string {
  // ⓪ 会话绑定的项目根（最高优先级；空串同样视为未绑定）
  const fromSession = normalize(sessionProjectRoot)
  if (fromSession !== undefined) return fromSession

  // ① 调用方已解析好的全局当前项目根
  const fromProject = normalize(projectRoot)
  if (fromProject !== undefined) return fromProject

  // ② 未传 projectRoot 时，按 current 现查一次 list（不做绝对化，调用方负责）
  const current = normalize(settings.projects.current)
  if (current !== undefined) {
    const matched = settings.projects.list.find((entry) => entry.id === current)
    const projectRootFromList = normalize(matched?.root)
    if (projectRootFromList !== undefined) return projectRootFromList
  }

  // ③ 激活模式的工作目录（v18，Work 模式；空串 = 未配置）
  const fromMode = normalize(modeWorkspaceDir)
  if (fromMode !== undefined) return fromMode

  // ④ 用户显式配置的电脑操控工具工作目录（空串 = 未配置）
  const configured = normalize(settings.agent.tools.workspaceDir)
  if (configured !== undefined) return configured

  // ⑤ 都为空 → 回落用户主目录（由调用方保证它可用；可能也是空串）
  return homeDir
}

/** 去掉首尾空白；空白串 / undefined 一律视为「未配置」（noUncheckedIndexedAccess 下 entry 可能为 undefined）。 */
function normalize(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}
