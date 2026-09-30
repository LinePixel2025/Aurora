/**
 * 项目添加的共享逻辑（docs/06 §5.1 项目机制，2026-09-30）。
 *
 * 两个入口共用：设置页「会话管理」（项目管理区组）与主界面左栏「项目对话」标题行的
 * 「添加项目」钮。id 规则与「目录末段作默认名」只在这里有一份 ——
 * 两处各抄一遍必然漂移（`.nav-row` 与探针契约那类漂移已经发生过一次）。
 *
 * 渲染层没有文件系统能力：目录一律由主进程弹系统选择框（`project:pickDirectory`）。
 */
import type { ProjectConfig } from '@aurora/shared'

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
 * 弹目录选择框并返回一条**待写入的新项目**（用户取消返回 `null`，不是错误）。
 *
 * 只负责取值与构造条目，不碰配置 —— 落盘由调用方经 `settingsStore.update`
 * 带**完整 projects 子树**写入（顶层浅合并，`list` 是数组整体权威）。
 */
export async function pickProjectEntry(): Promise<ProjectConfig | null> {
  const picked = await window.aurora.project.pickDirectory()
  if (!picked.ok || picked.value === null) return null
  return { id: newProjectId(), name: folderNameOf(picked.value), root: picked.value }
}
