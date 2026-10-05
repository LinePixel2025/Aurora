/**
 * 三档权限的纯函数判定（docs/06 §11.2、docs/08 §1，v13）。
 *
 * 放在 `shared` 而不是主进程的理由：**主进程与渲染层必须看到同一个"生效档位"** ——
 * 主进程用它决定注册哪些工具、要不要弹确认卡；渲染层用它决定下拉框显示哪一档、
 * 设置页摘要写哪些工具。两边各写一份判断迟早会漂移（"界面说只读、实际还能写"是最坏的一类）。
 *
 * 本文件是纯函数，不碰 fs / Electron / DOM，因此也能进 `@aurora/shared/browser`。
 */
import type { Settings } from './schema.js'

/** 三档权限（`agent.permissionMode` 的值域） */
export type PermissionMode = 'readonly' | 'confirm' | 'auto'

/**
 * 双开关优先级（`00-index.md` 假设 1 定稿）：
 * 1. `agent.permissionMode === 'readonly'` → `'readonly'`（**只读优先**：`confirmSensitiveTools` 在这档无效）；
 * 2. `agent.permissionMode === 'auto'` → `'auto'`（**出厂默认档**，2026-09-29 起）；
 * 3. 否则 `advanced.confirmSensitiveTools === false` → `'auto'`（老开关的语义是"别再逐次问我"，
 *    现在由 auto 档承接：完全权限，所有敏感工具不再弹确认卡）；
 * 4. 否则 → `'confirm'`（用户手动收紧后的档位：逐次弹卡）。
 */
export function resolvePermissionMode(
  settings: Pick<Settings, 'agent' | 'advanced'>,
): PermissionMode {
  const mode = settings.agent.permissionMode
  if (mode === 'readonly') return 'readonly'
  if (mode === 'auto') return 'auto'
  if (settings.advanced.confirmSensitiveTools === false) return 'auto'
  return 'confirm'
}

/**
 * 判"这次调用是否可直接放行"时用的目标路径（docs/06 §11.2）。
 *
 * 取值口径（与 `docs/06` 的表一致）：
 * - `read_file` / `write_file` / `edit_file` / `list_dir` / `grep` / `glob` → `input.path`；
 * - `open_path` → `input.target`；
 * - `run_command` → `input.cwd`（缺省由调用方回落到项目根）。
 *
 * **解析不出来就返回 `undefined`，调用方必须按"越界"处理（走确认）**：
 * 把"解析不出目标"当成"在根内"等于给了一条换参数写法就绕过边界的路。
 */
export function permissionTargetOf(name: string, input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const record = input as Record<string, unknown>
  const key = name === 'open_path' ? 'target' : name === 'run_command' ? 'cwd' : 'path'
  const value = record[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 目标路径是否落在根内（`auto` 档的免确认判据）。
 *
 * 这里**只做字符串级的包含判断**，真正的边界（realpath、符号链接、`..` 穿越）由
 * `apps/desktop/src/main/tools/file-port.ts` 的 `resolveWithin` 兜底 —— 两道判定的分工是：
 * 这里决定"要不要问用户"，那里决定"能不能碰"。
 *
 * `root` 为 `undefined`（无项目）时返回 `false`：没有项目就没有"根内"，
 * 调用方据此走"无项目"分支（见 `resolvePermissionMode` 的注释）。
 */
export function isWithinRoot(target: string | undefined, root: string | undefined): boolean {
  if (target === undefined || root === undefined || root === '') return false
  // 只用 node:path 的语义做粗判：UNC / 盘符 / 大小写由 port 层的 realpath 判定负责。
  // ⚠️ 含 `..` 段的一律按**越界**处理（不做归一后再比）：这里的结论是"要不要问用户"，
  // 保守方向永远是"问"，而不是"猜它其实在根内"。
  const segments = target.split(/[\\/]+/)
  if (segments.includes('..')) return false
  const normalize = (value: string): string =>
    value
      .replace(/[\\/]+/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase()
  const normalizedTarget = normalize(target)
  const normalizedRoot = normalize(root)
  if (normalizedTarget === normalizedRoot) return true
  return normalizedTarget.startsWith(`${normalizedRoot}/`)
}
