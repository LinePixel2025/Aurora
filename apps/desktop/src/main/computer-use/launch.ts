/**
 * Computer Use 应用启动策略（纯函数，docs/06 §28）。
 *
 * 2026-11-07 实测根因：`app_launch` 在 2s 内没找到窗口时返回 `window: null`，端口用
 * `=== undefined` 判断后访问 `null.title`，模型看到的是 `Cannot read properties of null
 * (reading 'title')`；它随后换 `open_path` / `run_command` 再来一次，于是重复打开同一应用。
 *
 * 这里把「要不要启动、复用哪个窗口、是否冷却」收成可单测的纯逻辑：
 * - **无 args + 同 exe 已运行** → 复用现有窗口（不再起新进程）；
 * - **有 args**（新窗口 / URL）→ 一律走启动，不误复用；
 * - 同 `command + args` 在冷却窗口内重复提交 → 返回冷却提示，不再启动。
 *
 * 不 import electron，窗口结构用最小的 `LaunchWindow`，端口那边的 `WindowInfo` 结构兼容。
 */
import { isListableWindow, normalizeExeName } from './policy.js'

/** 宿主 `app_launch` 等新窗口的上限（毫秒）。2s 会把单实例应用误判成「没启动」。 */
export const LAUNCH_WINDOW_WAIT_MS = 5000
/** 同一个 command+args 在没检测到窗口后的重试冷却（毫秒）。 */
export const LAUNCH_COOLDOWN_MS = 8000

export interface LaunchWindow {
  windowId: string
  title: string
  exe: string
  pid: number
  bounds: { x: number; y: number; width: number; height: number }
  visible: boolean
  minimized: boolean
  foreground: boolean
}

export type LaunchPlan =
  | { kind: 'reuse'; window: LaunchWindow }
  | { kind: 'launch' }
  | { kind: 'cooldown'; seconds: number }

/** 冷却键：exe 归一化 + args 原样（同 exe 不同参数是两次不同意图）。 */
export function launchKey(command: string, args: readonly string[] = []): string {
  return `${normalizeExeName(command)}\u0000${args.join('\u0000')}`
}

/**
 * 找同 exe 的可复用窗口：优先前台，其次非最小化，最后最小化。
 * 不可见 / 无标题 / 尺寸为 0 的工具窗不参与（与 `window_list` 同一口径）。
 */
export function findReusableWindow(
  windows: readonly LaunchWindow[],
  command: string,
): LaunchWindow | undefined {
  const name = normalizeExeName(command)
  if (name === '') return undefined
  const candidates = windows.filter(
    (window) =>
      normalizeExeName(window.exe) === name &&
      isListableWindow({
        title: window.title,
        visible: window.visible,
        width: window.bounds.width,
        height: window.bounds.height,
      }),
  )
  if (candidates.length === 0) return undefined
  return (
    candidates.find((window) => window.foreground) ??
    candidates.find((window) => !window.minimized) ??
    candidates[0]
  )
}

export function planLaunch(input: {
  command: string
  args?: readonly string[]
  windows: readonly LaunchWindow[]
  lastAttempt?: { key: string; at: number }
  now: number
}): LaunchPlan {
  const args = input.args ?? []
  if (args.length === 0) {
    const reusable = findReusableWindow(input.windows, input.command)
    if (reusable !== undefined) return { kind: 'reuse', window: reusable }
  }
  const key = launchKey(input.command, args)
  if (input.lastAttempt !== undefined && input.lastAttempt.key === key) {
    const elapsed = Math.max(0, input.now - input.lastAttempt.at)
    if (elapsed < LAUNCH_COOLDOWN_MS) {
      const remaining = Math.ceil((LAUNCH_COOLDOWN_MS - elapsed) / 1000)
      return { kind: 'cooldown', seconds: Math.max(1, remaining) }
    }
  }
  return { kind: 'launch' }
}

export interface LaunchHostResult {
  pid?: number
  process?: string
  /** 宿主没检测到窗口时是 `null`（PowerShell JSON），**绝不能**按 undefined 判断 */
  window?: LaunchWindow | null
}

/**
 * 把宿主结果翻成给模型看的内容。
 *
 * 关键口径：
 * - `window == null` 不是错误，而是一条「已发出启动 / 请截图确认 / 不要重复 launch」的成功结果；
 * - 复用现有窗口时明确写「已在运行」；
 * - 前台激活失败不抛错（桌面状态仍可继续），只说明原因与下一步。
 */
export function describeLaunchResult(input: {
  name: string
  result?: LaunchHostResult
  reused?: LaunchWindow
  restored?: boolean
  activationFailed?: boolean
}): { content: string; summary: string } {
  const name = input.name
  const reused = input.reused
  if (reused !== undefined) {
    const title = truncate(reused.title)
    if (input.activationFailed === true) {
      return {
        content:
          `「${name}」已在运行（窗口 ${reused.windowId}「${title}」），但系统拒绝把窗口切到前台` +
          '（前台锁）。请先 computer_screenshot 确认，或请用户手动切换；**不要重复 launch**。',
        summary: `已运行 ${name}（激活失败）`,
      }
    }
    return {
      content:
        `「${name}」已在运行（窗口 ${reused.windowId}「${title}」），` +
        (input.restored === true ? '已还原并切换到该窗口' : '已切换到该窗口') +
        '；**不要重复 launch**。需要新窗口时请带 args（如 --new-window）。',
      summary: `已切换到 ${name}`,
    }
  }

  const window = input.result?.window ?? undefined
  if (window !== undefined) {
    const title = truncate(window.title)
    const pid = input.result?.pid
    return {
      content:
        `已启动 ${input.result?.process ?? name}` +
        (pid === undefined ? '' : `（pid ${pid}）`) +
        `；窗口「${title}」（id ${window.windowId}）。`,
      summary: `已启动 ${name}`,
    }
  }

  return {
    content:
      `启动命令已发出（${name}），但 ${LAUNCH_WINDOW_WAIT_MS / 1000} 秒内没有检测到新窗口：` +
      '可能仍在加载，或已交给正在运行的实例。先 computer_screenshot 确认；**不要重复 launch**。',
    summary: `已启动 ${name}（等待窗口）`,
  }
}

/** 前台激活失败的可读文案（宿主 `FOCUS_REFUSED` 的 message 可能为空）。 */
export function describeActivateFailure(hostMessage?: string): string {
  const detail = hostMessage?.trim() ?? ''
  return (
    '系统拒绝把窗口切到前台（前台锁）' +
    (detail === '' ? '' : `：${detail}`) +
    '；请先 computer_screenshot 确认，或请用户手动切换。'
  )
}

function truncate(title: string): string {
  const trimmed = title.trim()
  if (trimmed === '') return '（无标题）'
  return trimmed.length <= 40 ? trimmed : `${trimmed.slice(0, 39)}…`
}
