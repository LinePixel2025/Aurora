/**
 * 项目添加的共享逻辑（docs/06 §5.1 项目机制，2026-09-30；2026-10-01 两处入口对齐）。
 *
 * 两个入口共用：设置页「会话管理」（项目管理区组）与主界面左栏「项目对话」标题行的
 * 「添加项目」钮。id 规则 / 「目录末段作默认名」/「添加后即设为当前项目」只在这里有一份 ——
 * 两处各抄一遍必然漂移（`.nav-row` 与探针契约那类漂移已经发生过一次）。
 *
 * 2026-10-01 用户报「左栏加完项目并没有真正添加」：两处入口此前**语义不一致** ——
 * 设置页加完会把新项目设为 `projects.current`（界面上的「已启用」），左栏只往 `list` 里追加、
 * 不动 `current`，于是「加上了」与「生效了」在左栏这条路径上分了家。现在统一为
 * `appendProject()` 一份口径：**加入 list + 设为当前项目**。
 *
 * 渲染层没有文件系统能力：目录一律由主进程弹系统选择框（`project:pickDirectory`）。
 */
import type { ProjectConfig, ProjectsSettings, Result } from '@aurora/shared'

/** 项目 id 只是本机标识（`projects.current` 引用它），不必全局唯一，但要够随机以免撞车 */
export function newProjectId(): string {
  return `proj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 目录末段作为默认项目名（同时兼容 `\` 与 `/`；全是分隔符时回落成路径原文） */
export function folderNameOf(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part !== '')
  return parts[parts.length - 1] ?? path
}

/**
 * 「添加项目」的配置补丁构造口径（**唯一一份**）：把新条目追加进 `list`，并把它设为
 * `projects.current`（与设置页同款，见文件头注释）。返回完整 `projects` 子树 ——
 * `settings:update` 是顶层浅合并，少带一个键（如 `maxAgentsBytes`）就会丢配置。
 */
export function appendProject(current: ProjectsSettings, entry: ProjectConfig): ProjectsSettings {
  return { ...current, list: [...current.list, entry], current: entry.id }
}

/**
 * 选择目录的结果：三态而不是 `ProjectConfig | null`（2026-10-01）。
 *
 * 旧签名把「用户取消」与「选择框失败」压成同一个 `null`，调用方一律静默返回 ——
 * 于是 `project:pickDirectory` 出错时用户点了「添加项目」**什么都不会发生、也没有任何提示**，
 * 正是用户报的那类「加了但没真加」。现在错误必须带出来给界面（chatError / 设置页 error）。
 */
export type ProjectPickOutcome =
  | { kind: 'picked'; entry: ProjectConfig }
  | { kind: 'canceled' }
  | { kind: 'error'; message: string }

/**
 * 弹目录选择框并返回一条**待写入的新项目**。
 *
 * 只负责取值与构造条目，不碰配置 —— 落盘由调用方经 `settingsStore.update` 带**完整 projects
 * 子树**写入（顶层浅合并，`list` 是数组整体权威），补丁一律由 `appendProject` 构造。
 *
 * `pick` 可注入（缺省就是那条 IPC）：选择框是原生模态框、探针驱动不了，三态语义只能靠
 * 单测钉住（`projects.test.ts`）——与内核的 `fetchImpl` / `confirmTool` 同款注入套路。
 */
export async function pickProjectEntry(
  pick: ProjectPicker = () => window.aurora.project.pickDirectory(),
): Promise<ProjectPickOutcome> {
  let picked: Result<string | null>
  try {
    picked = await pick()
  } catch (cause) {
    // IPC 本身抛错（主进程未装配 / 通道异常）：按错误上报，不装作"用户取消"
    return { kind: 'error', message: cause instanceof Error ? cause.message : String(cause) }
  }
  if (!picked.ok) return { kind: 'error', message: picked.message }
  if (picked.value === null) return { kind: 'canceled' }
  return {
    kind: 'picked',
    entry: { id: newProjectId(), name: folderNameOf(picked.value), root: picked.value },
  }
}

/** 取目录的注入点：缺省是主进程的系统选择框（`project:pickDirectory`） */
export type ProjectPicker = () => Promise<Result<string | null>>
