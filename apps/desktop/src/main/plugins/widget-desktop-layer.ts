/**
 * 桌面小组件「桌面层」owner 亲和（docs/14 §5.3，v37）—— **纯 Node**，不 import electron。
 *
 * `windowLevel = "desktop"` 想让小组件在 Win+D / Win+M（显示桌面）后仍尽量可见：
 * 把窗口的 Win32 **owner**（`GWLP_HWNDPARENT = -8`）指向桌面 shell 的 `SHELLDLL_DefView`，
 * 系统就会把它当桌面的一部分，而不是被「显示桌面」最小化。
 *
 * 口径（务必保持）：
 * - 只改 owner，**不改父窗口、不改窗口样式** —— 拖动 / 缩放 / 透明表面都不受影响；
 * - 这是**尽力而为**：拿不到 shell view、SetWindowLongPtr 失败、脚本超时都返回 `false`，
 *   调用方回落 `normal`（`widgets.ts` 还有 minimize 恢复守护兜底，不在本模块）；
 * - 脚本模板是**静态常量**（唯一变化是 HWND / action 两个插值），走 `-EncodedCommand`
 *   （UTF-16LE + base64）避免命令行引号 / 编码问题；**绝不经过 shell**（`execFile` + argv 数组）。
 */
import { execFile } from 'node:child_process'
import type { Logger } from '@aurora/shared'

/** PowerShell 脚本输出行的机器可读前缀；非标记行一律忽略。 */
export const DESKTOP_LAYER_MARKER = 'AURORA_DESKTOP_LAYER|'

/** 单次 PowerShell 调用的超时（桌面层是建窗 / 切层级时的旁路操作，不能拖住主进程）。 */
export const DESKTOP_LAYER_TIMEOUT_MS = 3_000

/** `SetWindowLongPtr` 的 owner 槽位：`GWL_HWNDPARENT`（负偏移表示「索引」而非用户数据）。 */
const GWL_HWNDPARENT = -8

export type DesktopLayerAction = 'attach' | 'detach'

/**
 * 静态 PowerShell 脚本模板。
 *
 * 为什么用 Add-Type P/Invoke 而不是现成工具：Windows 没有公开 API 能「把窗口挂成桌面 owner」，
 * 只能自己调 `FindWindow` / `FindWindowEx` / `SetWindowLongPtr`；`-EncodedCommand` 传中文注释
 * 也不会有编码问题（本脚本刻意保持纯 ASCII，减少老 PowerShell 的惊喜）。
 *
 * 解析顺序与 Explorer 的两种桌面形态对应：
 * 1. `Progman` → 子窗口 `SHELLDLL_DefView`（常规桌面）；
 * 2. 回落：枚举顶层 `WorkerW`，找挂了 `SHELLDLL_DefView` 子窗口的那个（壁纸切换 / 幻灯片场景）。
 * attach 用 `SetWindowLongPtr(hwnd, -8, shellView)` 后 `GetWindowLongPtr` **读回校验**；
 * detach 写 0 并读回 0。成功 / 失败都输出一行 marker，失败带短原因（仅用于日志）。
 *
 * 坑（2026-10-24 实测）：PowerShell 调 .NET 方法时会把 `$null` 转成**空字符串**再交给 `string` 参数，
 * `FindWindow('Progman', $null)` 因此变成「标题必须为空」而匹配不到 Progman（返回 0）。
 * 传真正的 NULL 必须用 `[NullString]::Value`（Windows PowerShell 5.1 也支持）。
 */
const DESKTOP_LAYER_SCRIPT = `$ErrorActionPreference = 'Stop'
$hwnd = [IntPtr]([Int64]__AURORA_HWND__)
$action = '__AURORA_ACTION__'
function Write-AuroraDesktopLayer([bool]$ok, [string]$reason) {
  $flag = if ($ok) { '1' } else { '0' }
  [Console]::Out.WriteLine('AURORA_DESKTOP_LAYER|' + $flag + '|' + $reason)
  [Console]::Out.Flush()
}
try {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AuroraDesktopLayer {
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);
}
"@
  if ($hwnd -eq [IntPtr]::Zero -or -not [AuroraDesktopLayer]::IsWindow($hwnd)) {
    Write-AuroraDesktopLayer $false 'not-a-window'
    exit 0
  }
  if ($action -eq 'detach') {
    [void][AuroraDesktopLayer]::SetWindowLongPtr($hwnd, __AURORA_INDEX__, [IntPtr]::Zero)
    $current = [AuroraDesktopLayer]::GetWindowLongPtr($hwnd, __AURORA_INDEX__)
    if ($current -eq [IntPtr]::Zero) { Write-AuroraDesktopLayer $true 'detached' }
    else { Write-AuroraDesktopLayer $false 'detach-readback-mismatch' }
    exit 0
  }
  # $null 会被 PowerShell 转成 ''，标题参数必须传 [NullString]::Value 才是真 NULL
  $shellView = [AuroraDesktopLayer]::FindWindowEx([AuroraDesktopLayer]::FindWindow('Progman', [NullString]::Value), [IntPtr]::Zero, 'SHELLDLL_DefView', [NullString]::Value)
  if ($shellView -eq [IntPtr]::Zero) {
    $worker = [AuroraDesktopLayer]::FindWindow('WorkerW', [NullString]::Value)
    while ($worker -ne [IntPtr]::Zero) {
      $child = [AuroraDesktopLayer]::FindWindowEx($worker, [IntPtr]::Zero, 'SHELLDLL_DefView', [NullString]::Value)
      if ($child -ne [IntPtr]::Zero) { $shellView = $child; break }
      $worker = [AuroraDesktopLayer]::FindWindowEx([IntPtr]::Zero, $worker, 'WorkerW', [NullString]::Value)
    }
  }
  if ($shellView -eq [IntPtr]::Zero) {
    Write-AuroraDesktopLayer $false 'no-shell-view'
    exit 0
  }
  [void][AuroraDesktopLayer]::SetWindowLongPtr($hwnd, __AURORA_INDEX__, $shellView)
  $current = [AuroraDesktopLayer]::GetWindowLongPtr($hwnd, __AURORA_INDEX__)
  if ($current -eq $shellView) { Write-AuroraDesktopLayer $true 'attached' }
  else { Write-AuroraDesktopLayer $false 'readback-mismatch' }
} catch {
  [Console]::Out.WriteLine('AURORA_DESKTOP_LAYER|0|exception')
}
`

/**
 * 生成一次 owner 操作（attach / detach）的完整脚本。
 *
 * 静态模板 + 三处插值（HWND、action、owner 索引）；非法 HWND 一律写成 0，
 * 由脚本输出 `not-a-window`，不会拿脏值去调 Win32。
 */
export function buildDesktopLayerScript(hwnd: number, action: DesktopLayerAction): string {
  const safeHwnd = Number.isSafeInteger(hwnd) && hwnd > 0 ? Math.trunc(hwnd) : 0
  return DESKTOP_LAYER_SCRIPT.replace('__AURORA_HWND__', String(safeHwnd))
    .replace('__AURORA_ACTION__', action)
    .replaceAll('__AURORA_INDEX__', String(GWL_HWNDPARENT))
}

/** 解析脚本输出的一行；不是 marker 行 / 首段不是 0|1 时返回 `undefined`。 */
export interface DesktopLayerResult {
  /** marker 首段：`1` = 操作成功，`0` = 失败 */
  ok: boolean
  /** 脚本给的短原因（`attached` / `no-shell-view` / `exception` …），只用于日志 */
  reason: string
}

export function parseDesktopLayerResult(line: string): DesktopLayerResult | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith(DESKTOP_LAYER_MARKER)) return undefined
  const rest = trimmed.slice(DESKTOP_LAYER_MARKER.length)
  const separator = rest.indexOf('|')
  const flag = separator === -1 ? rest : rest.slice(0, separator)
  if (flag !== '0' && flag !== '1') return undefined
  return { ok: flag === '1', reason: separator === -1 ? '' : rest.slice(separator + 1) }
}

/**
 * 执行器：`(可执行文件, argv) => stdout`。
 *
 * 主进程默认实现是 `execFile`（不经 shell）；单测必须注入假执行器，**不得真的启动 PowerShell**。
 */
export type DesktopLayerRunner = (file: string, args: readonly string[]) => Promise<string>

export interface DesktopLayerOptions {
  /** 失败降级日志（可选；不传则静默） */
  logger?: Logger
  /** 平台门控（缺省 `process.platform`；单测注入） */
  platform?: NodeJS.Platform
  /** 注入执行器（单测用） */
  runner?: DesktopLayerRunner
  /** 单次超时（缺省 `DESKTOP_LAYER_TIMEOUT_MS`） */
  timeoutMs?: number
}

/** PowerShell 启动参数（顺序固定；最后一项是 base64 编码的脚本）。 */
const POWERSHELL_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-EncodedCommand',
]

/** 把脚本编码成 `-EncodedCommand` 要求的形式（UTF-16LE + base64）。 */
export function encodeDesktopLayerCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

function execFileRunner(timeoutMs: number): DesktopLayerRunner {
  return (file, args) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        file,
        [...args],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024, encoding: 'utf8' },
        (error, stdout) => {
          if (error !== null) {
            reject(error)
            return
          }
          resolve(stdout)
        },
      )
    })
}

/**
 * attach / detach 的共用流程：平台与句柄校验 → 编码脚本 → 注入执行器 → 解析 marker。
 *
 * 任何一步失败都 resolve `false`（不抛错），保证 widgets 的调用链只需要处理布尔；
 * attach 失败记 warn（功能降级），detach 失败只记 debug（最佳努力收尾，不影响用户）。
 */
async function runDesktopLayer(
  action: DesktopLayerAction,
  hwnd: number,
  options: DesktopLayerOptions,
): Promise<boolean> {
  const { logger } = options
  const level = action === 'attach' ? 'warn' : 'debug'
  const log = (message: string, meta: unknown): void => {
    if (level === 'warn') logger?.warn(message, meta)
    else logger?.debug(message, meta)
  }

  if ((options.platform ?? process.platform) !== 'win32') {
    logger?.debug('非 Windows 平台，跳过桌面层 owner 操作', { action })
    return false
  }
  if (!Number.isSafeInteger(hwnd) || hwnd <= 0) {
    logger?.debug('小组件 HWND 非法，跳过桌面层 owner 操作', { action, hwnd })
    return false
  }

  const encoded = encodeDesktopLayerCommand(buildDesktopLayerScript(hwnd, action))
  const args = [...POWERSHELL_ARGS, encoded]
  const runner = options.runner ?? execFileRunner(options.timeoutMs ?? DESKTOP_LAYER_TIMEOUT_MS)

  let stdout: string
  try {
    stdout = await runner('powershell.exe', args)
  } catch (error) {
    log('桌面层 owner 脚本执行失败，按普通窗口处理', { action, hwnd, error: String(error) })
    return false
  }

  for (const line of stdout.split(/\r?\n/)) {
    const parsed = parseDesktopLayerResult(line)
    if (parsed === undefined) continue
    if (!parsed.ok) log('桌面层 owner 操作未成功', { action, hwnd, reason: parsed.reason })
    return parsed.ok
  }
  log('桌面层 owner 脚本没有返回结果标记', { action, hwnd })
  return false
}

/**
 * 把窗口挂到桌面 shell owner（`SHELLDLL_DefView`）。
 *
 * 返回 `true` 仅当脚本明确回报 `AURORA_DESKTOP_LAYER|1|...`；`desktop` 是尽力而为，
 * 失败时调用方回落 `normal`（`widgets.ts` 的 minimize 恢复守护继续兜底）。
 */
export async function attachDesktopOwner(
  hwnd: number,
  options: DesktopLayerOptions = {},
): Promise<boolean> {
  return runDesktopLayer('attach', hwnd, options)
}

/** 解除桌面 shell owner（写 0 并读回校验）；用于切回 floating / normal 与销毁窗口。 */
export async function detachDesktopOwner(
  hwnd: number,
  options: DesktopLayerOptions = {},
): Promise<boolean> {
  return runDesktopLayer('detach', hwnd, options)
}
