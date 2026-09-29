/**
 * 管理员提权（v0.2.8，docs/08 §1、docs/09 §9）。
 *
 * **要解决的问题**：`run_command` 与文件类工具跑在**当前用户权限**下。未提权时，
 * 写 `C:\Program Files`、改系统设置、`net session` 这类操作会直接失败 ——
 * 用户看到的是「AI 说做了，其实没做成」。以管理员身份启动把这条缝焊上。
 *
 * 两步：
 * 1. `probeElevated()` 探测当前进程是否已提权；
 * 2. 未提权且配置要求（`general.requireAdmin`）时，`relaunchElevated()` 用
 *    `Start-Process -Verb RunAs` 拉起一个管理员实例，然后本进程退出。
 *
 * **四条边界（每一条都对应一个真实会踩的坑）**：
 * - **反循环**：子进程带 `--aurora-elevated` 标记，看到它就不再尝试提权 ——
 *   用户点了「否」、或 UAC 因策略无法提权时，不会无限重拉自己；
 * - **失败不卡死**：提权失败（用户拒绝 / 无管理员权限 / 非 Windows）时**继续以普通权限启动**
 *   并记一条 warn。「要求管理员」不能变成"配置错了就打不开"；
 * - **只在安装版强制**：开发态（`pnpm dev` / smoke / capture）默认跳过 ——
 *   那些进程常常跑在非提权终端里，强制提权会让自测每次弹 UAC 甚至卡住；
 *   需要验证时用 `AURORA_REQUIRE_ADMIN=1` 显式打开；
 * - **探测失败按"已提权"处理**：拿不到结论时宁可不重启（同上，能跑优先）。
 *
 * 本模块**不 import electron**（走参数注入），因此可以直接进 vitest（docs/09 §2 的
 * 「主进程测试只收不依赖 Electron 的模块」约定）。
 */
import { spawn, spawnSync } from 'node:child_process'
import type { Logger } from '@aurora/shared'

/** 提权实例的标记参数：子进程看到它就不再尝试提权（反循环的唯一判据） */
export const ELEVATION_FLAG = '--aurora-elevated'

/** 探测 / 提权是否被显式允许（开发态默认关闭，见文件头第 3 条） */
export const REQUIRE_ADMIN_ENV = 'AURORA_REQUIRE_ADMIN'

export interface ExecResult {
  status: number | null
  stdout: string
}

/** 命令执行器（可注入：单测不真的起进程） */
export type ExecFn = (file: string, args: readonly string[]) => ExecResult

export interface ElevationProbeOptions {
  /** 当前平台（默认 `process.platform`）；非 win32 一律按"已提权"处理（不拦） */
  platform?: string
  /** 命令执行器（默认 `spawnSync`，`windowsHide` + 不继承 stdio） */
  exec?: ExecFn
}

const defaultExec: ExecFn = (file, args) => {
  const result = spawnSync(file, [...args], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 10_000,
  })
  return { status: result.status, stdout: result.stdout ?? '' }
}

/**
 * 当前进程是否以管理员身份运行。
 *
 * 判定顺序（先快后慢，任一给出结论即返回）：
 * 1. `fltmc.exe` —— 非提权时因访问被拒而失败（退出码非 0），提权时列出筛选器驱动（0）；
 *    它在 System32 里、不依赖 PowerShell 策略，是最快的一条；
 * 2. PowerShell 的 `WindowsPrincipal.IsInRole(Administrator)` —— 若 `fltmc` 不存在
 *    （极精简的系统）就靠它。
 *
 * **任何一个命令都没能给出结论**（两个都启动失败 / 非 Windows）时返回 `true`（按已提权）：
 * 探测失败绝不能变成"启动不了"。
 */
export function probeElevated(options: ElevationProbeOptions = {}): boolean {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return true
  const exec = options.exec ?? defaultExec
  try {
    const fltmc = exec('fltmc.exe', [])
    if (fltmc.status === 0) return true
    // 退出码 1（访问被拒）= 确定未提权；其余（找不到文件等）继续往下试
    if (fltmc.status === 1) return false
  } catch {
    // 继续用下一条判据
  }
  try {
    const ps = exec('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    ])
    const text = ps.stdout.trim().toLowerCase()
    if (text.includes('true')) return true
    if (text.includes('false')) return false
  } catch {
    // 拿不到结论 → 按已提权处理（见上方注释）
  }
  return true
}

/** 命令行里是否带提权标记（被提权拉起的实例用它避免再次提权） */
export function hasElevationFlag(argv: readonly string[]): boolean {
  return argv.includes(ELEVATION_FLAG)
}

/**
 * 是否应该尝试提权重启（纯函数，单测直接覆盖决策表）。
 *
 * 五条理由任一成立就**不提权**：配置没要求 / 已经提权 / 本次已是提权重启的实例 /
 * 非安装版且没显式打开（开发态）/ 非 Windows。
 */
export function shouldRelaunchElevated(input: {
  requireAdmin: boolean
  elevated: boolean
  alreadyRelaunched: boolean
  /** 是否安装版（`app.isPackaged`） */
  packaged: boolean
  /** 开发态是否显式要求提权（`AURORA_REQUIRE_ADMIN=1`） */
  forceInDev: boolean
  platform?: string
}): boolean {
  if (!input.requireAdmin) return false
  if (input.elevated) return false
  if (input.alreadyRelaunched) return false
  if ((input.platform ?? process.platform) !== 'win32') return false
  if (!input.packaged && !input.forceInDev) return false
  return true
}

/** PowerShell 单引号字符串转义（内部单引号翻倍） */
function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * 组装提权重启用的 PowerShell 脚本（导出以便单测断言转义）。
 *
 * `-Verb RunAs` 触发 UAC；`-PassThru` 让 `Start-Process` 在拿到进程对象后立即返回，
 * 因此这条 powershell 的**存活时间只覆盖 UAC 询问**，不是子进程的生命周期
 * （父进程据此判断"用户点了否"）。
 */
export function buildRelaunchScript(exePath: string, args: readonly string[]): string {
  const list = args.map(quotePowerShell).join(',')
  return [
    '$ErrorActionPreference = "Stop"',
    'try {',
    `  Start-Process -FilePath ${quotePowerShell(exePath)} -ArgumentList @(${list}) -Verb RunAs -PassThru | Out-Null`,
    '  exit 0',
    '} catch {',
    '  exit 3',
    '}',
  ].join('\n')
}

export interface RelaunchResult {
  ok: boolean
  /** 失败原因（用户拒绝 UAC / PowerShell 不可用 / 超时），用于日志与界面提示 */
  error?: string
}

/** 提权重启的可注入执行器（单测用假实现） */
export type RelaunchFn = (exePath: string, args: readonly string[]) => Promise<RelaunchResult>

/**
 * 用 UAC 重新拉起自己（默认实现）。
 *
 * **等待 powershell 退出**（而不是 detached 后立刻返回）：它是"用户有没有点否"的唯一信号，
 * 拿到结论才能决定是继续以普通权限启动、还是安心退出。超时（默认 2 分钟，
 * 足够用户看清 UAC 再点）按失败处理 —— 卡在启动阶段比不启动更糟。
 */
export const defaultRelaunch: RelaunchFn = (exePath, args) =>
  new Promise<RelaunchResult>((resolve) => {
    const script = buildRelaunchScript(exePath, args)
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { windowsHide: true, stdio: 'ignore' },
    )
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, error: '提权请求超时（未在 UAC 弹窗里确认）' })
    }, 120_000)
    timer.unref?.()
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, error: `无法启动提权进程：${error.message}` })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ ok: true })
      else resolve({ ok: false, error: '提权被拒绝或失败（UAC 未确认）' })
    })
  })

export type ElevationOutcome = 'elevated' | 'skipped' | 'relaunched' | 'failed'

export interface EnsureElevationOptions {
  /** 配置要求（`general.requireAdmin`） */
  requireAdmin: boolean
  /** `app.isPackaged` */
  packaged: boolean
  /** 当前进程命令行（`process.argv`） */
  argv: readonly string[]
  /** 可执行文件（`process.execPath`） */
  execPath: string
  logger: Logger
  platform?: string
  env?: NodeJS.ProcessEnv
  probe?: (options: ElevationProbeOptions) => boolean
  relaunch?: RelaunchFn
}

/**
 * 启动期的提权总入口：返回 `'relaunched'` 时**调用方应立刻退出**（提权实例会接管）。
 *
 * 其余三种结果都表示"继续以当前权限启动"：`elevated` 本来就够权限、`skipped` 不需要
 * 提权（配置关闭 / 开发态）、`failed` 提权没能完成（已在日志与界面上说明）。
 */
export async function ensureElevation(options: EnsureElevationOptions): Promise<ElevationOutcome> {
  const { logger } = options
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return 'skipped'
  const elevated = (options.probe ?? probeElevated)({ platform })
  if (elevated) return 'elevated'
  const forceInDev = (options.env ?? process.env)[REQUIRE_ADMIN_ENV] === '1'
  const should = shouldRelaunchElevated({
    requireAdmin: options.requireAdmin,
    elevated,
    alreadyRelaunched: hasElevationFlag(options.argv),
    packaged: options.packaged,
    forceInDev,
    platform,
  })
  if (!should) {
    logger.info('未以管理员身份运行，按配置跳过自动提权', {
      requireAdmin: options.requireAdmin,
      packaged: options.packaged,
    })
    return 'skipped'
  }
  const args = [...options.argv.slice(1).filter((arg) => arg !== ELEVATION_FLAG), ELEVATION_FLAG]
  const result = await (options.relaunch ?? defaultRelaunch)(options.execPath, args)
  if (!result.ok) {
    logger.warn('提权失败，将以普通权限继续运行', { error: result.error ?? '未知原因' })
    return 'failed'
  }
  logger.info('已请求以管理员身份重新启动，本进程退出', { execPath: options.execPath })
  return 'relaunched'
}
