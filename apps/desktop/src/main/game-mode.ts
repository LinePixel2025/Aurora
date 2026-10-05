/**
 * Windows 游戏模式联动（docs/06 §8.3）。
 *
 * Windows 没有公开的「Game Mode 正在运行」查询 API。这里用 Game Bar 的
 * `GameBarPresenceWriter.exe` 进程与 `SHQueryUserNotificationState()` 的
 * `QUNS_RUNNING_D3D_FULL_SCREEN` 状态做交叉识别，并放在单条常驻 PowerShell
 * 子进程里轮询，避免主进程周期性地新建 PowerShell / 重复 Add-Type。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { Logger } from '@aurora/shared'

export const GAME_MODE_PROBE_MARKER = 'AURORA_GAME|'
const DEFAULT_POLL_MS = 2_000

export type GameModeReason = 'gamebar' | 'fullscreen' | 'none'

export interface GameModeSnapshot {
  active: boolean
  reason: GameModeReason
}

export interface GameModeWatcherLike {
  start(listener: (snapshot: GameModeSnapshot) => void): void
  stop(): void
}

export interface GameModeControllerOptions {
  enabled: () => boolean
  watcher: GameModeWatcherLike
  enter: () => void | Promise<void>
  exit: () => void | Promise<void>
  logger: Logger
  /** 平台门控；单测可显式开启。 */
  supported?: boolean
}

export interface WindowsGameModeWatcherOptions {
  logger: Logger
  pollMs?: number
}

/**
 * 生成常驻探针脚本。
 *
 * 进程先输出当前状态，之后只在 active 翻转时输出；主进程只解析标记行。
 * `$last` 用整数而不是布尔值，避免 PowerShell 中 `$false -eq $null` 的坑。
 */
export function windowsGameModeProbeScript(
  pollMs = DEFAULT_POLL_MS,
  parentPid = process.pid,
): string {
  const interval = Math.max(500, Math.round(pollMs))
  return `$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$parentPid = ${Math.max(1, Math.round(parentPid))}
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AuroraGameModeProbe {
  [DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);
  [DllImport("psapi.dll")] public static extern bool EmptyWorkingSet(IntPtr process);
}
"@
try { [Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal' } catch { }
[void][AuroraGameModeProbe]::EmptyWorkingSet([Diagnostics.Process]::GetCurrentProcess().Handle)
$last = -1
while ($true) {
  if (-not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) { break }
  $presence = @(Get-Process -Name 'GameBarPresenceWriter' -ErrorAction SilentlyContinue).Count -gt 0
  $state = 0
  [void][AuroraGameModeProbe]::SHQueryUserNotificationState([ref]$state)
  $active = if ($presence -or ($state -eq 3)) { 1 } else { 0 }
  $reason = if ($state -eq 3) { 'fullscreen' } elseif ($presence) { 'gamebar' } else { 'none' }
  if ($active -ne $last) {
    [Console]::Out.WriteLine('${GAME_MODE_PROBE_MARKER}' + $active + '|' + $reason)
    [Console]::Out.Flush()
    $last = $active
  }
  Start-Sleep -Milliseconds ${interval}
}
`
}

/** 解析探针 stdout 的机器可读行；非标记行与非法值一律忽略。 */
export function parseGameModeProbeLine(line: string): GameModeSnapshot | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith(GAME_MODE_PROBE_MARKER)) return undefined
  const [activePart, reasonPart] = trimmed.slice(GAME_MODE_PROBE_MARKER.length).split('|')
  if (activePart !== '0' && activePart !== '1') return undefined
  if (reasonPart !== 'gamebar' && reasonPart !== 'fullscreen' && reasonPart !== 'none') {
    return undefined
  }
  const active = activePart === '1'
  if (!active && reasonPart !== 'none') return undefined
  return { active, reason: active ? reasonPart : 'none' }
}

/**
 * 常驻 Windows 探针。
 *
 * 探针失败或意外退出时按「不在游戏中」降级，避免把提示条和文件自感知永久锁死；
 * 下一次设置变更 / 应用重启会重新启动探针。
 */
export class WindowsGameModeWatcher implements GameModeWatcherLike {
  private readonly options: WindowsGameModeWatcherOptions
  private child: ChildProcess | undefined
  private listener: ((snapshot: GameModeSnapshot) => void) | undefined
  private stopped = true
  private stdoutBuffer = ''

  constructor(options: WindowsGameModeWatcherOptions) {
    this.options = options
  }

  start(listener: (snapshot: GameModeSnapshot) => void): void {
    if (!this.stopped) return
    this.stopped = false
    this.listener = listener
    this.stdoutBuffer = ''
    const encoded = Buffer.from(
      windowsGameModeProbeScript(this.options.pollMs),
      'utf16le',
    ).toString('base64')
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    this.child = child
    if (child.stdout === null || child.stderr === null) {
      this.options.logger.warn('游戏模式探针管道不可用，按不在游戏中处理')
      this.listener?.({ active: false, reason: 'none' })
      child.kill()
      return
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      const message = chunk.trim()
      if (message !== '') this.options.logger.debug('游戏模式探针输出', { message })
    })
    child.on('error', (error) => {
      if (this.stopped) return
      this.options.logger.warn('游戏模式探针启动失败，按不在游戏中处理', {
        error: String(error),
      })
      this.listener?.({ active: false, reason: 'none' })
    })
    child.on('exit', (code, signal) => {
      if (this.stopped) return
      this.options.logger.warn('游戏模式探针已退出，按不在游戏中处理', { code, signal })
      this.listener?.({ active: false, reason: 'none' })
      this.child = undefined
    })
  }

  stop(): void {
    this.stopped = true
    this.listener = undefined
    this.stdoutBuffer = ''
    const child = this.child
    this.child = undefined
    if (child !== undefined && !child.killed) child.kill()
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    const lines = this.stdoutBuffer.split(/\r?\n/)
    this.stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      const snapshot = parseGameModeProbeLine(line)
      if (snapshot !== undefined) this.listener?.(snapshot)
    }
  }
}

/**
 * 游戏状态到副作用的编排器。
 *
 * `enter` / `exit` 串行执行，避免快速切换时「先恢复后挂起」的竞态。
 * `stop()` 只停止探针，不做恢复；应用退出由各服务自己的收尾链负责。
 */
export class GameModeController {
  private readonly options: GameModeControllerOptions
  private readonly supported: boolean
  private started = false
  private watching = false
  private active = false
  private transition: Promise<void> = Promise.resolve()

  constructor(options: GameModeControllerOptions) {
    this.options = options
    this.supported = options.supported ?? process.platform === 'win32'
  }

  start(): void {
    this.started = true
    this.reconfigure()
  }

  reconfigure(): void {
    if (!this.started || !this.supported) return
    if (this.options.enabled()) {
      if (!this.watching) {
        this.watching = true
        this.options.watcher.start((snapshot) => this.apply(snapshot))
      }
      return
    }
    if (this.watching) {
      this.watching = false
      this.options.watcher.stop()
    }
    if (this.active) this.apply({ active: false, reason: 'none' })
  }

  /** 应用退出用：只停探针，不触发恢复动作。 */
  stop(): void {
    this.started = false
    if (this.watching) {
      this.watching = false
      this.options.watcher.stop()
    }
  }

  getStatus(): GameModeSnapshot {
    return { active: this.active, reason: this.active ? this.lastReason : 'none' }
  }

  private lastReason: GameModeReason = 'none'

  private apply(snapshot: GameModeSnapshot): void {
    if (snapshot.active === this.active) return
    this.active = snapshot.active
    this.lastReason = snapshot.active ? snapshot.reason : 'none'
    const action = snapshot.active ? this.options.enter : this.options.exit
    this.transition = this.transition
      .then(() => action())
      .then(() => undefined)
      .catch((error: unknown) => {
        this.options.logger.warn('切换游戏模式失败', { error: String(error) })
      })
  }
}
