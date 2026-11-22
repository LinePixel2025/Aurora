/**
 * 插件工具面（P0 全局上限 / P1 注册状态，docs/14 §3.1.1）。
 *
 * 上限是**插件工具的全局**约束（单插件 32 由清单校验），注册表只认名字、不认来源；
 * 截断必须发生在注册前，且顺序只由名字决定 —— 否则插件安装顺序 / `Map` 插入序会让
 * 「哪些工具被留下」漂移，同一配置下用户看到的行为就不可复现。
 */
import {
  PLUGIN_TOOL_FACE_LIMIT,
  type PluginInstallPreview,
  type PluginSummary,
} from '@aurora/shared'
import type { PluginToolContribution } from './manager.js'

/** 一次 `sync()` 的注册结果：只记名字，足够 UI 逐工具标记与统计。 */
export interface PluginToolFaceSnapshot {
  /** 实际注册的 `plugin.<id>.<name>`（字典序） */
  readonly registered: readonly string[]
  /** 因全局上限未注册的 `plugin.<id>.<name>`（字典序） */
  readonly skipped: readonly string[]
}

export function emptyPluginToolFaceSnapshot(): PluginToolFaceSnapshot {
  return { registered: [], skipped: [] }
}

/** 名字比较不走 `localeCompare`（跨机器 / 区域可能不同），与 `ToolRegistry` 的排序同口径。 */
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export interface SelectPluginToolsOptions {
  /** 只读档：先过滤掉非 `readonly` 工具再计数（被过滤的不算「被上限截断」） */
  readonlyMode?: boolean
  /** 仅单测覆盖；缺省用 `PLUGIN_TOOL_FACE_LIMIT` */
  limit?: number
}

/**
 * 从候选里选出本次要注册的插件工具。
 *
 * 顺序固定为：只读档过滤 → 名字字典序 → 取前 `limit` 个；其余进 `skipped`。
 */
export function selectPluginTools(
  contributions: readonly PluginToolContribution[],
  options: SelectPluginToolsOptions = {},
): { kept: PluginToolContribution[]; skipped: PluginToolContribution[] } {
  const limit = Math.max(0, options.limit ?? PLUGIN_TOOL_FACE_LIMIT)
  const candidates =
    options.readonlyMode === true
      ? contributions.filter((item) => item.readonly)
      : [...contributions]
  candidates.sort((a, b) => compareNames(a.fullName, b.fullName))
  return { kept: candidates.slice(0, limit), skipped: candidates.slice(limit) }
}

/**
 * 把注册快照装饰成 IPC 可传的摘要（纯函数，不改入参）。
 *
 * 逐工具写 `registered`；插件级计数与全局 `used` 供设置页 / 配置窗口直接渲染。
 * 停用或未装配时同样返回布尔值（全 false），由 UI 按插件状态决定要不要标「未注册」。
 */
export function applyToolFace(
  summary: PluginSummary,
  snapshot: PluginToolFaceSnapshot,
): PluginSummary {
  const registered = new Set(snapshot.registered)
  const skipped = new Set(snapshot.skipped)
  return {
    ...summary,
    toolFace: {
      used: snapshot.registered.length,
      registered: summary.tools.filter((tool) => registered.has(tool.fullName)).length,
      skipped: summary.tools.filter((tool) => skipped.has(tool.fullName)).length,
    },
    tools: summary.tools.map((tool) => ({ ...tool, registered: registered.has(tool.fullName) })),
  }
}

/** 安装预览的工具面影响：只算「装完会变」的部分（docs/14 §3.1.1）。 */
export interface PluginInstallToolFaceImpact {
  /** 本插件装完不会注册的工具（fullName） */
  readonly dropped: readonly string[]
  /** 会被挤掉的已有插件工具（fullName） */
  readonly displaced: readonly string[]
}

/**
 * 预览安装后的工具面：把「现有候选 ∪ 本插件候选」按同一套规则重新排一遍。
 *
 * 现有候选取最近一次快照的 `registered ∪ skipped`（`skipped` 是上次被上限截掉、
 * 停用别的插件后还能回来的那批）。同 id 重装 / 升级时旧版本的工具会被新清单替换，
 * 因此先把 `plugin.<id>.` 前缀从现有集合里剔除，否则会误报「挤掉自己」。
 */
export function previewPluginToolFace(
  preview: Pick<PluginInstallPreview, 'id' | 'tools'>,
  snapshot: PluginToolFaceSnapshot,
  options: { readonlyMode?: boolean } = {},
): PluginInstallToolFaceImpact {
  const selfPrefix = `plugin.${preview.id}.`
  const existing = [...new Set([...snapshot.registered, ...snapshot.skipped])].filter(
    (name) => !name.startsWith(selfPrefix),
  )
  const fresh = preview.tools
    .filter((tool) => options.readonlyMode !== true || tool.readonly)
    .map((tool) => tool.fullName)
  const ordered = [...new Set([...existing, ...fresh])].sort(compareNames)
  const kept = new Set(ordered.slice(0, PLUGIN_TOOL_FACE_LIMIT))
  return {
    dropped: fresh.filter((name) => !kept.has(name)),
    displaced: existing.filter((name) => !kept.has(name)),
  }
}

function previewNames(names: readonly string[]): string {
  const head = names.slice(0, 3).join('、')
  return names.length > 3 ? `${head} 等` : head
}

/**
 * 安装确认弹窗的预警文案（`PluginInstallPreview.warnings`）。
 *
 * 空数组 = 装完不会丢工具、也不会挤掉任何人，弹窗保持原样（不制造无谓警告）。
 */
export function pluginInstallToolFaceWarnings(
  preview: Pick<PluginInstallPreview, 'id' | 'tools'>,
  snapshot: PluginToolFaceSnapshot,
  options: { readonlyMode?: boolean } = {},
): string[] {
  const impact = previewPluginToolFace(preview, snapshot, options)
  if (impact.dropped.length === 0 && impact.displaced.length === 0) return []
  const eligible = preview.tools.filter(
    (tool) => options.readonlyMode !== true || tool.readonly,
  ).length
  const warnings: string[] = []
  if (impact.dropped.length > 0) {
    warnings.push(
      `本插件 ${eligible} 个可注册工具中有 ${impact.dropped.length} 个不会注册（全局上限 ${PLUGIN_TOOL_FACE_LIMIT}）。`,
    )
  }
  if (impact.displaced.length > 0) {
    warnings.push(
      `安装后会挤掉已有插件工具 ${impact.displaced.length} 个：${previewNames(impact.displaced)}。`,
    )
  }
  return warnings
}
