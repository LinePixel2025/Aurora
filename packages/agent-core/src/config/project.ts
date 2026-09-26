/**
 * 「当前项目」解析（docs/06 §5.1、docs/08 §1，v13）。
 *
 * 项目机制决定两件事：① 每轮注入哪份项目级 `AGENTS.md`（项目根 → 当前工作目录逐层收集）；
 * ② 权限层判定「项目根之内 / 之外」的边界（路径前缀校验）。
 *
 * 本文件只做**纯函数**归一：把 `settings.projects.current` 指到 `list` 里的哪一条解析出来，
 * 并把 `root` 归一成绝对路径 —— 不读文件、不碰 Electron / DOM，纯 Node 可单测。
 *
 * **永不抛错**：配置被写坏（`current` 指向不存在的 id）只降级为「无项目」+ 一条 warn，
 * 与 `agentHost` 的 provider 自愈路径同一口径 —— 配置坏掉不该让 Agent 彻底失能。
 */
import { isAbsolute, resolve } from 'node:path'
import type { Logger, ProjectConfig, Settings } from '@aurora/shared'
import { createNoopLogger } from '@aurora/shared'

export interface ResolvedProject {
  /** 命中的当前项目条目；无项目 / id 无效时为 undefined */
  current: ProjectConfig | undefined
  /** 归一后的绝对项目根；无项目时为 undefined */
  root: string | undefined
}

/**
 * 解析「当前项目」：settings.projects.current 指向 list 里的哪一条、根目录归一成绝对路径。
 * - current 为空串（或全空白）→ 无项目（不 warn）
 * - current 有值但 list 里没有该 id → 记 warn（logger 可选）并降级为无项目，**永不抛错**
 * - root 为绝对路径直接采用；相对路径按传入的 cwd 解析（node:path 的 resolve/isAbsolute）
 * - root 归一后为空串时视为无项目（条目本身不返回，调用方只需看 `root`）
 */
export function resolveProject(
  settings: Pick<Settings, 'projects'>,
  options: { cwd: string; logger?: Logger },
): ResolvedProject {
  const logger = options.logger ?? createNoopLogger()
  const id = settings.projects.current.trim()
  // 空串 = 未登记项目（默认态）：不告警，行为与 v13 之前完全一致
  if (id === '') return { current: undefined, root: undefined }

  const matched = settings.projects.list.find((entry) => entry.id === id)
  if (matched === undefined) {
    logger.warn('projects.current 指向不存在的项目，降级为无项目', { current: id })
    return { current: undefined, root: undefined }
  }

  const root = normalizeRoot(matched.root, options.cwd)
  // root 为空白的条目等于「登记了但没有根」——当无项目处理，条目也不返回（调用方只看 root）
  if (root === undefined) return { current: undefined, root: undefined }

  return { current: matched, root }
}

/**
 * 把配置里的 root 归一成绝对路径；空白串返回 undefined（= 无项目）。
 *
 * 绝对 root 直接采用（`resolve` 对绝对路径只做 `.` / `..` / 分隔符归一，不拼接 cwd）；
 * 相对 root 按传入的 cwd 展开 —— 因此「归一后为空串」只可能来自全空白输入。
 */
function normalizeRoot(root: string, cwd: string): string | undefined {
  const trimmed = root.trim()
  if (trimmed === '') return undefined
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed)
}
