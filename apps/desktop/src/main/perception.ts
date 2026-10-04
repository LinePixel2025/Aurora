/**
 * 系统感知采集（docs/06 §8、ADR-007）。
 *
 * P1 范围：时间 / 星期（进程内定时器）、电源、网络连通性。
 * P5 范围：前台窗口（PowerShell 探针）、显示器（主进程注入 Electron `screen`）、
 * 课程表（主进程注入 `IScheduleProvider`）。
 *
 * 缺失的采集项一律降级为 `unknown`，**绝不抛错**（ADR-007）：
 * 任何探测失败都只记 debug 日志并保留该项在 `unknown` 里。
 */
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promises as dns } from 'node:dns'
import type systeminformation from 'systeminformation'
import type { ClassIslandBridgeSnapshot, Logger, PerceptionSummary } from '@aurora/shared'
import { parseClock, type Lesson } from './schedule.js'

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'] as const

/**
 * `systeminformation` 按需加载（2026-10-04 性能轮）。
 *
 * 实测静态 require 约 8MB RSS / 89ms；它只在电源 / 网卡采集时用得到，
 * 而感知摘要本身已经是按需消费（提示条展开、聊天上下文、系统提示词）。
 * 首帧启动不再为它付费，纯空闲时也不会加载。
 */
type SysteminformationModule = typeof systeminformation
let systeminformationPromise: Promise<SysteminformationModule> | null = null

function loadSysteminformation(): Promise<SysteminformationModule> {
  systeminformationPromise ??= import('systeminformation').then(
    (mod) => (mod.default ?? mod) as SysteminformationModule,
  )
  return systeminformationPromise
}

/** 前台窗口探针输出标记（stdout 里唯一的机器可读行）。 */
const FOREGROUND_MARKER = 'AURORA_FG|'

/**
 * 前台窗口探针（docs/06 §8.1）。
 *
 * Windows 无内置命令行工具能同时拿到「前台窗口标题 + 进程名」，因此用 P/Invoke
 * 调 `GetForegroundWindow` / `GetWindowTextW` / `GetWindowThreadProcessId`；
 * `active-win`（文档原定首选）是原生模块、杀软误报风险高，v1 直接走 PowerShell。
 */
export const FOREGROUND_PROBE_SCRIPT = `$ErrorActionPreference = 'SilentlyContinue'
try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class AuroraForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int processId);
}
"@
$handle = [AuroraForeground]::GetForegroundWindow()
$buffer = New-Object System.Text.StringBuilder 1024
[void][AuroraForeground]::GetWindowTextW($handle, $buffer, 1024)
$processId = 0
[void][AuroraForeground]::GetWindowThreadProcessId($handle, [ref]$processId)
$name = ''
$proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
if ($proc) { $name = $proc.ProcessName }
Write-Output ('${FOREGROUND_MARKER}' + $name + '|' + $buffer.ToString())`

export interface PerceptionOptions {
  logger: Logger
  /** 网络探测间隔，默认 30s */
  networkIntervalMs?: number
  /** 电源采集间隔，默认 5min（docs/06 §8.1） */
  powerIntervalMs?: number
  /**
   * 前台窗口采集的 TTL，默认 60s（docs/06 §8.1，2026-10-04 性能轮）。
   *
   * 探针要新建 `powershell.exe` 并现场 `Add-Type` 编译 C#，单次成本 1s 级 CPU；
   * 因此**不挂后台定时器**，只在 `summary()` 消费时按 TTL 非阻塞刷新。
   */
  foregroundTtlMs?: number
  /** 探测使用的 DNS 服务器 */
  dnsTarget?: string
  /**
   * 前台窗口探针（返回 stdout）。默认走 PowerShell；
   * 单测可注入假实现，避免真的起进程（本文件因此不依赖 Electron）。
   */
  foregroundProbe?: () => Promise<string>
  /** 显示器状态（主进程注入 Electron `screen`）；未注入时该项保持 `unknown` */
  displayProvider?: () => PerceptionSummary['display']
  /** 今日课程（主进程注入 `IScheduleProvider`）；未注入时 `课程表` 保持 `unknown` */
  scheduleProvider?: () => Promise<Lesson[] | undefined>
  /**
   * ClassIsland 桥接的课堂状态快照（v2/v3，docs/05 §3.4）；未注入 / 桥接未提供时该行省略。
   *
   * **刷新时机**：`summary()` 先读课程表（`readLessons`，走同一个桥接 provider，
   * 会顺带刷新它缓存的最近一次快照），再取本回调 —— 因此这里拿到的快照与
   * `lessons` 是**同一批数据**，最大滞后一个感知刷新周期（默认 30s，
   * 也随每次系统提示词组装即时触发）。桥接侧本身 30s 写一次，粒度一致。
   */
  classStatusProvider?: () => ClassIslandBridgeSnapshot | undefined
}

export class PerceptionHub {
  private readonly options: PerceptionOptions
  private readonly logger: Logger
  private readonly networkIntervalMs: number
  private readonly powerIntervalMs: number
  private readonly foregroundTtlMs: number
  private readonly dnsTarget: string
  private timers: NodeJS.Timeout[] = []
  private started = false
  private timersStarted = false
  private power: PerceptionSummary['battery'] | undefined
  private network: PerceptionSummary['network'] | undefined
  private foreground: PerceptionSummary['foreground'] | undefined
  private foregroundBusy = false
  /** 上次前台探针的**尝试**时刻（成功 / 失败都算，失败也按 TTL 重试，避免持续失败时刷探针） */
  private foregroundCheckedAt = 0

  constructor(options: PerceptionOptions) {
    this.options = options
    this.logger = options.logger
    this.networkIntervalMs = options.networkIntervalMs ?? 30_000
    this.powerIntervalMs = options.powerIntervalMs ?? 300_000
    this.foregroundTtlMs = Math.max(0, options.foregroundTtlMs ?? 60_000)
    this.dnsTarget = options.dnsTarget ?? '223.5.5.5'
  }

  start(): void {
    // 不在这里做首次采集、也不起定时器：让**第一次真正消费**（`summary()`）才激活。
    // 这样纯空闲的进程不会加载 systeminformation / 起 DNS 探测（ADR-007 的降级语义不变）。
    this.started = true
    this.logger.debug('系统感知已就绪（消费时按需激活）', {
      networkIntervalMs: this.networkIntervalMs,
      powerIntervalMs: this.powerIntervalMs,
      foregroundTtlMs: this.foregroundTtlMs,
    })
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
    this.timersStarted = false
  }

  /**
   * 第一次 `summary()` 时启动电源 / 网络周期采集。
   *
   * 只有被消费过的事实数据才值得维护周期任务；纯空闲进程（提示条收起、没聊天、没设置页）
   * 永远不激活，省掉 `systeminformation` 的常驻与每 30s 的 DNS 探测。
   */
  private ensureTimersStarted(): void {
    if (!this.started || this.timersStarted) return
    this.timersStarted = true
    this.timers.push(setInterval(() => void this.refreshPower(), this.powerIntervalMs))
    this.timers.push(setInterval(() => void this.refreshNetwork(), this.networkIntervalMs))
    for (const timer of this.timers) timer.unref?.()
  }

  /** 当前感知摘要（用于上下文注入与 `system-status` Skill）。 */
  async summary(): Promise<PerceptionSummary> {
    const now = new Date()
    this.ensureTimersStarted()
    await this.ensureBaseCollections()
    // 前台窗口没有后台定时器：按 TTL 懒刷新。**不等待**，避免 1s 级探针拖慢系统提示词组装；
    // 首次探测完成前该项保持 unknown（ADR-007），下一轮 summary 自然拿到值。
    if (!this.foregroundBusy && Date.now() - this.foregroundCheckedAt >= this.foregroundTtlMs) {
      void this.refreshForeground()
    }

    const display = this.readDisplay()
    const lessons = await this.readLessons(now)
    // 教室状态：**必须在 readLessons 之后取**（那一步会刷新桥接 provider 缓存的快照，
    // 保证 classStatus 与 lessons 同源同批，见 classStatusProvider 的注释）
    const classStatus = this.readClassStatus()

    const unknown: string[] = []
    if (this.power === undefined) unknown.push('电源状态')
    if (this.network === undefined) unknown.push('网络状态')
    if (this.foreground === undefined) unknown.push('前台窗口')
    if (display === undefined) unknown.push('显示器状态')
    if (lessons === undefined) unknown.push('课程表')

    return {
      timestamp: now.toISOString(),
      localTime: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
      weekday: WEEKDAYS[now.getDay()] ?? '未知',
      ...(this.power === undefined ? {} : { battery: this.power }),
      ...(this.network === undefined ? {} : { network: this.network }),
      ...(this.foreground === undefined ? {} : { foreground: this.foreground }),
      ...(display === undefined ? {} : { display }),
      ...(lessons === undefined ? {} : { lessons }),
      ...(classStatus === undefined ? {} : { classStatus }),
      unknown,
    }
  }

  /** 供系统提示词使用的紧凑摘要（不返回 unknown 细节）。 */
  async contextSummary(): Promise<string> {
    const summary = await this.summary()
    const parts = [`当前时间：${summary.localTime} ${summary.weekday}`]
    if (summary.battery) {
      parts.push(
        summary.battery.hasBattery
          ? `电源：电池 ${summary.battery.percent}%${summary.battery.isCharging ? '（充电中）' : ''}`
          : '电源：已接通交流电',
      )
    }
    if (summary.network)
      parts.push(`网络：${summary.network.online ? '在线' : '离线'}（${summary.network.type}）`)
    if (summary.foreground) {
      const { app, title } = summary.foreground
      parts.push(title === '' ? `当前前台：${app}` : `当前前台：${app} — ${title}`)
    }
    if (summary.display) {
      parts.push(
        `显示器：${summary.display.width}×${summary.display.height} @${summary.display.scaleFactor}x（共 ${summary.display.count} 块）`,
      )
    }
    if (summary.lessons && summary.lessons.length > 0) {
      const shown = summary.lessons
        .slice(0, 5)
        .map((lesson) => `${lesson.subject} ${lesson.startTime}-${lesson.endTime}`)
      const suffix = summary.lessons.length > shown.length ? ' 等' : ''
      parts.push(`今日课程：${shown.join('、')}${suffix}`)
    }
    // 课堂状态行（v3）：不在上课且没有下节课时整行省略（不制造"无信息噪音"）
    const classLine = describeClassStatus(summary.classStatus)
    if (classLine !== '') parts.push(classLine)
    parts.push(`主机：${os.hostname()} / ${os.platform()} ${os.release()}`)
    return parts.join('；')
  }

  // ───────────────────────── 采集 ─────────────────────────

  private async ensureBaseCollections(): Promise<void> {
    // 首次激活时并行采集：两次都要等 systeminformation 的模块加载，串行只会白等一轮
    await Promise.all([
      this.power === undefined ? this.refreshPower() : Promise.resolve(),
      this.network === undefined ? this.refreshNetwork() : Promise.resolve(),
    ])
  }

  private async refreshPower(): Promise<void> {
    try {
      const si = await loadSysteminformation()
      const battery = await si.battery()
      this.power = {
        hasBattery: battery.hasBattery,
        percent: Math.round(battery.percent),
        isCharging: battery.isCharging,
      }
    } catch (error) {
      this.power = undefined
      this.logger.debug('电源感知不可用，已降级为未知', { error: String(error) })
    }
  }

  private async refreshNetwork(): Promise<void> {
    try {
      const [online, interfaces] = await Promise.all([this.probeDns(), this.readInterfaceType()])
      this.network = { online, type: interfaces }
    } catch (error) {
      this.network = undefined
      this.logger.debug('网络感知不可用，已降级为未知', { error: String(error) })
    }
  }

  private async refreshForeground(): Promise<void> {
    if (this.foregroundBusy) return
    this.foregroundBusy = true
    this.foregroundCheckedAt = Date.now()
    try {
      const stdout = await this.runForegroundProbe()
      const parsed = parseForegroundProbe(stdout)
      if (parsed === undefined) {
        this.foreground = undefined
        this.logger.debug('前台窗口探针未返回可用结果，已降级为未知')
        return
      }
      this.foreground = parsed
    } catch (error) {
      this.foreground = undefined
      this.logger.debug('前台窗口感知不可用，已降级为未知', { error: String(error) })
    } finally {
      this.foregroundBusy = false
    }
  }

  private readDisplay(): PerceptionSummary['display'] {
    const provider = this.options.displayProvider
    if (provider === undefined) return undefined
    try {
      return provider()
    } catch (error) {
      this.logger.debug('显示器感知不可用，已降级为未知', { error: String(error) })
      return undefined
    }
  }

  /** 今日尚未结束的课程（进行中的课也算）；provider 未注入或失败时为 `undefined`。 */
  private async readLessons(now: Date): Promise<Lesson[] | undefined> {
    const provider = this.options.scheduleProvider
    if (provider === undefined) return undefined
    try {
      const lessons = await provider()
      if (lessons === undefined) return undefined
      const nowMinutes = now.getHours() * 60 + now.getMinutes()
      return lessons.filter((lesson) => {
        const end = parseClock(lesson.endTime)
        return end === undefined || end >= nowMinutes
      })
    } catch (error) {
      this.logger.debug('课程表感知不可用，已降级为未知', { error: String(error) })
      return undefined
    }
  }

  /** 课堂状态快照（v2/v3）：未注入 / 桥接未提供 / 抛错时一律 undefined（不写进 unknown）。 */
  private readClassStatus(): ClassIslandBridgeSnapshot | undefined {
    const provider = this.options.classStatusProvider
    if (provider === undefined) return undefined
    try {
      return provider()
    } catch (error) {
      this.logger.debug('课堂状态快照不可用，已降级为未知', { error: String(error) })
      return undefined
    }
  }

  private async runForegroundProbe(): Promise<string> {
    if (this.options.foregroundProbe !== undefined) return this.options.foregroundProbe()
    if (process.platform !== 'win32') throw new Error('前台窗口采集仅支持 Windows')
    return runPowerShell(FOREGROUND_PROBE_SCRIPT)
  }

  private async probeDns(): Promise<boolean> {
    // 800ms 足够识别本机连通性；首次 summary 会同步等待这一步，别让离线场景拖 2s
    const resolver = new dns.Resolver({ timeout: 800, tries: 1 })
    try {
      resolver.setServers([this.dnsTarget])
      await resolver.resolve4('www.baidu.com')
      return true
    } catch {
      return false
    }
  }

  private async readInterfaceType(): Promise<string> {
    try {
      const si = await loadSysteminformation()
      const stats = await si.networkInterfaceDefault()
      return stats === '' ? '未知' : stats
    } catch {
      return '未知'
    }
  }
}

/**
 * 纯函数：解析前台窗口探针的 stdout。
 *
 * 期望一行 `AURORA_FG|<进程名>|<窗口标题>`；标题里的 `|` 原样保留。
 * 没有标记行、或进程名与标题都为空时返回 `undefined`（调用方降级为 `unknown`）。
 */
export function parseForegroundProbe(stdout: string): PerceptionSummary['foreground'] {
  if (typeof stdout !== 'string') return undefined
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith(FOREGROUND_MARKER)) continue
    const rest = line.slice(FOREGROUND_MARKER.length)
    const separator = rest.indexOf('|')
    const app = (separator === -1 ? rest : rest.slice(0, separator)).trim()
    const title = (separator === -1 ? '' : rest.slice(separator + 1)).trim()
    if (app === '' && title === '') return undefined
    return { app: app === '' ? '未知应用' : app, title }
  }
  return undefined
}

/**
 * 纯函数：把桥接的课堂状态快照描述成**一行人类可读文本**（进系统提示词，
 * 由 `contextSummary()` 消费；`PerceptionSummary.classStatus` 保留原始字段）。
 *
 * 输出示例（docs/05 §3.4 v3）：
 * - 上课中且有下节课：`课堂状态：上课中（数学 08:00-08:45）；下节课 语文 09:20-10:05`
 * - 仅上课中：`课堂状态：上课中（数学 08:00-08:45）`
 * - 课间且有下节课：`课堂状态：不在上课；下节课 语文 09:20-10:05`
 * - 两者都无（快照只有版本号 / 时间戳）：`''` —— 调用方据此**省略整行**
 *
 * 所有字段都是可选的（桥接取不到就不写），因此这里逐段拼接、缺哪段少哪段，
 * 绝不补默认值（编造"下一节是数学"比不说更糟）。
 */
export function describeClassStatus(status: ClassIslandBridgeSnapshot | undefined): string {
  if (status === undefined) return ''

  const segments: string[] = []
  if (status.onClass === true) {
    const range = timeRange(status.currentStartTime, status.currentEndTime)
    const subject = status.currentSubject ?? ''
    segments.push(`上课中（${subject}${subject === '' || range === '' ? '' : ' '}${range}）`)
  }

  const nextRange = timeRange(status.nextStartTime, status.nextEndTime)
  if (status.nextSubject !== undefined || nextRange !== '') {
    const subject = status.nextSubject ?? ''
    const gap = subject !== '' && nextRange !== '' ? ' ' : ''
    segments.push(`下节课 ${subject}${gap}${nextRange}`)
  }

  if (segments.length === 0) {
    // 不在上课、也没有下节课：整行省略（课间 / 放学后不制造噪音）
    return ''
  }
  if (status.onClass !== true) segments.unshift('不在上课')
  return `课堂状态：${segments.join('；')}`
}

/** `08:00-08:45` / 只有一端时只给一端 / 两端都缺时为空串 */
function timeRange(start: string | undefined, end: string | undefined): string {
  if (start === undefined) return end ?? ''
  if (end === undefined) return start
  return `${start}-${end}`
}

/** 执行 PowerShell 脚本并返回 stdout（超时/失败一律抛错，由调用方降级）。 */
function runPowerShell(script: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 4000, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(stdout)
      },
    )
  })
}

function pad(value: number): string {
  return `${value}`.padStart(2, '0')
}
