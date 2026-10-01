/**
 * 项目根解析（docs/06 §5.1）。
 *
 * 项目机制决定两件事：① 绑定项目的会话每轮注入哪份项目级 `AGENTS.md`（项目根 → 当前工作目录
 * 逐层收集）；② 权限层判定「项目根之内 / 之外」的边界（路径前缀校验）。
 *
 * 唯一的解析入口是**按项目 id**（会话绑定 `SessionMeta.projectId` → `projects.list` 里的条目）：
 * 全局 `projects.current` 已于 v25 退役（v17 起它就不再决定会话的实际工作目录 / 边界）。
 *
 * 本文件只做**纯函数**归一：把 root 归一成绝对路径 —— 不读文件、不碰 Electron / DOM，
 * 纯 Node 可单测。
 *
 * **永不抛错**：绑定指向的项目已被删除 / root 空白是预期回落路径（会话级绑定是可选的），
 * 静默降级为 `undefined`，与 `agentHost` 的 provider 自愈路径同一口径 —— 配置坏掉不该让
 * Agent 彻底失能。
 */
import { isAbsolute, resolve } from 'node:path'
import type { Settings } from '@aurora/shared'

/**
 * 按**项目 id** 解析项目根（会话级项目，docs/06 §5.1 的唯一解析入口）。
 *
 * 会话绑定（`sessions/<id>.json` 的 `meta.projectId`）指向的项目可能**已被删除**——
 * 这是预期回落路径（会话级项目是可选的），因此这里**静默**返回 undefined、不记 warn：
 * 解析发生在每次工具执行 / 确认判定上，逐次 warn 只会刷屏；需要排查时看装配层日志。
 *
 * - id 空白 → undefined（未绑定）
 * - id 在 list 里找不到 → undefined（绑定已失效）
 * - root 归一后为空白 → undefined（条目没有根）
 */
export function resolveProjectRootById(
  settings: Pick<Settings, 'projects'>,
  id: string | undefined,
  options: { cwd: string },
): string | undefined {
  const trimmed = (id ?? '').trim()
  if (trimmed === '') return undefined
  const matched = settings.projects.list.find((entry) => entry.id === trimmed)
  if (matched === undefined) return undefined
  return normalizeRoot(matched.root, options.cwd)
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
