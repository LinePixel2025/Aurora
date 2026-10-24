/**
 * 插件标识、命名与版本比较（docs/14 §2、docs/15 §3）。
 *
 * 纯字符串函数：安装器、Center 市场、校验脚本与渲染层共用同一份口径，
 * 不允许任何 Node 依赖（`@aurora/shared/browser` 会转出本文件）。
 */

/** 宿主支持的插件 API 版本。清单 `apiVersion` 必须严格等于它。 */
export const PLUGIN_API_VERSION = 1 as const

/** 反向域名 id：小写字母 / 数字 / 连字符，至少两段，每段 ≤ 24，总长 ≤ 40。 */
export const PLUGIN_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?)+$/

/** 保留段：避免插件 id 看起来像内置命名空间。 */
export const PLUGIN_RESERVED_SEGMENTS = [
  'aurora',
  'builtin',
  'plugin',
  'mcp',
  'skill',
  'system',
  'core',
] as const

export const PLUGIN_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,24}$/
export const PLUGIN_COMMAND_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/
export const PLUGIN_PANEL_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
export const PLUGIN_THEME_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
export const PLUGIN_ACTION_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/

/** 最终工具名的长度上限（OpenAI function name 上限 64）。 */
export const PLUGIN_TOOL_FULL_NAME_MAX = 64

/** 与内置斜杠命令重名即拒绝（内置命令只有这 7 个，见 chat/slashCommands.ts）。 */
export const RESERVED_COMMAND_NAMES = [
  'new',
  'clear',
  'init',
  'compact',
  'subagents',
  'settings',
  'stop',
] as const

/**
 * 插件工具的最终注册名：`plugin.<id>.<name>`。
 *
 * 与 MCP 工具的 `mcp.<server>.<tool>` 同构（`agent-core/src/mcp/hub.ts`），
 * 点号前缀让 `unregisterByPrefix` 能一次性摘掉某个插件的全部工具。
 */
export function pluginToolName(pluginId: string, toolName: string): string {
  return `plugin.${pluginId}.${toolName}`
}

/** 插件工具的注销前缀（含末尾点号，避免 `com.example.a` 命中 `com.example.ab`）。 */
export function pluginToolPrefix(pluginId: string): string {
  return `plugin.${pluginId}.`
}

/**
 * 宽松语义化版本比较：`1.2.3` / `1.2.3-beta.1`。
 *
 * 只用于 `minAuroraVersion` 与更新判断，不追求 SemVer 全量语义：
 * 主版本段按数字比较，预发布段（`-` 之后）一律视为**低于**同版本正式版。
 * 无法解析的段按 0 处理（清单侧已由 zod 校验格式，这里只兜底）。
 */
export function compareVersions(a: string, b: string): number {
  const split = (value: string): { main: number[]; pre: string } => {
    const [core = '', pre = ''] = value.split('-', 2)
    const main = core.split('.').map((part) => {
      const parsed = Number.parseInt(part, 10)
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
    })
    return { main, pre }
  }
  const left = split(a)
  const right = split(b)
  const length = Math.max(left.main.length, right.main.length)
  for (let index = 0; index < length; index += 1) {
    const l = left.main[index] ?? 0
    const r = right.main[index] ?? 0
    if (l !== r) return l > r ? 1 : -1
  }
  if (left.pre === right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  return left.pre > right.pre ? 1 : -1
}

/** 当前宿主版本是否满足插件要求的最低版本。 */
export function satisfiesMinVersion(current: string, minimum: string): boolean {
  if (!minimum) return true
  return compareVersions(current, minimum) >= 0
}

/**
 * 校验插件 id 的构成与保留段；返回中文原因（通过时返回 null）。
 * 正则之外单独拆出来，是为了让安装预览能给出「哪一段被保留」的可读提示。
 */
export function validatePluginId(id: string): string | null {
  if (!id) return '插件 id 不能为空'
  if (id.length > 40) return '插件 id 不能超过 40 个字符'
  if (!PLUGIN_ID_PATTERN.test(id)) {
    return '插件 id 必须是反向域名（小写字母 / 数字 / 连字符，至少两段，如 com.example.todo）'
  }
  const reserved = id.split('.').find((segment) => PLUGIN_RESERVED_SEGMENTS.includes(segment as never))
  if (reserved) return `插件 id 不能使用保留段「${reserved}」`
  return null
}

/**
 * 规范化插件包内的相对路径：反斜杠转 `/`、去掉开头的 `./`。
 * 拒绝绝对路径 / 盘符 / UNC / 空段 / `..` / NUL，返回 null 表示非法。
 *
 * 只做字符串层判定：真正的落盘前还要在安装器里 `realpath` 复核一次。
 */
export function normalizePluginPath(input: string): string | null {
  if (!input || input.includes('\0')) return null
  const raw = input.replace(/\\/g, '/')
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw) || raw.startsWith('//')) return null
  const segments = raw.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0) return null
  if (segments.some((segment) => segment === '..')) return null
  return segments.join('/')
}
