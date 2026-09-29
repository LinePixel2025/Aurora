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
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { Logger } from '@aurora/shared'

/** 提权实例的标记参数：子进程看到它就不再尝试提权（反循环的唯一判据） */
export const ELEVATION_FLAG = '--aurora-elevated'

/** 启动方（原用户）的配置目录：子进程据此识别"提权换了账户"（见 `inspectElevatedUserData`） */
export const USER_DATA_FLAG = '--aurora-user-data='

/**
 * 识别「UAC 让程序换了个账户跑」的情况（v0.2.8 审查修复）。
 *
 * 场景：当前用户在**不在管理员组**的机器上（企业 / 受管机器常见）时，UAC 弹的不是
 * "同意"框而是**凭据**框；用户填了管理员账户密码后，子进程以那个管理员账户运行 ——
 * 于是 `app.getPath('userData')` 指向管理员自己的 `%APPDATA%`，界面看起来像
 * "配置、会话、自动化全丢了"（原数据其实好好躺在用户自己的 profile 里）。
 * 同组用户的常规 UAC（同意框）不会有这个问题：提权后仍是同一个 profile。
 *
 * 返回 `undefined` 表示一致 / 无从判断（没带标记参数）；否则返回两边的路径供上层提示。
 * 纯函数（只比较字符串），单测直接覆盖。
 */
export function inspectElevatedUserData(
  argv: readonly string[],
  actualUserData: string,
): { expected: string; actual: string } | undefined {
  const flag = argv.find((arg) => arg.startsWith(USER_DATA_FLAG))
  if (flag === undefined) return undefined
  const expected = flag.slice(USER_DATA_FLAG.length).trim()
  if (expected === '') return undefined
  const normalize = (value: string): string =>
    value
      .replace(/[\\/]+$/, '')
      .replace(/\//g, '\\')
      .toLowerCase()
  if (normalize(expected) === normalize(actualUserData)) return undefined
  return { expected, actual: actualUserData }
}

/**
 * 把原用户配置里的 `general.requireAdmin` 关掉（"换账户提权"的自愈路径，见上条）。
 *
 * 只做一件最小的事：读 JSON → 置 `general.requireAdmin = false` → 原子写。
 * 其余字段逐字不动（用 JSON.stringify 保留数据，缩进与 SettingsStore 一致为 2）；
 * 任何一步失败都返回 `false`（调用方据此只提示、不改），绝不抛错。
 */
export function disableRequireAdmin(configPath: string): boolean {
  try {
    const raw = readFileSync(configPath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return false
    const config = parsed as Record<string, unknown>
    const general = config['general']
    if (typeof general !== 'object' || general === null) return false
    if ((general as Record<string, unknown>)['requireAdmin'] === false) return true
    ;(general as Record<string, unknown>)['requireAdmin'] = false
    const temp = `${configPath}.elevation-fix.tmp`
    writeFileSync(temp, JSON.stringify(config, null, 2), 'utf8')
    renameSync(temp, configPath)
    return true
  } catch {
    return false
  }
}

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
 * 按 **CommandLineToArgvW 规则**给一个参数加引号（v0.2.8 审查修复）。
 *
 * 为什么需要它：`Start-Process -ArgumentList @('a','b')` 内部是 `join(' ')`，
 * **不会**替我们加引号 —— 含空格的参数会被子进程拆成多个参数。受影响的是
 * 开发态验证路径（`AURORA_REQUIRE_ADMIN=1 pnpm dev` 里 `argv[1]` 是 app 目录路径，
 * 仓库路径含空格时子进程收到被拆开的路径 → Electron 找不到 app 而直接退出，
 * 用户看到的是"提权把它搞崩了"）。打包版参数通常为空，属于稳健性修复。
 *
 * 规则（Windows 解析命令行的那一套）：不含空白与双引号就原样返回；否则整体包双引号，
 * 内部 `"` 用反斜杠转义（前面的反斜杠按 2n+1 加倍），结尾的反斜杠按 2n 加倍。
 */
export function quoteArgument(value: string): string {
  if (value === '') return '""'
  if (!/[\s"]/.test(value)) return value
  let out = '"'
  let backslashes = 0
  for (const char of value) {
    if (char === '\\') {
      backslashes += 1
      continue
    }
    if (char === '"') {
      out += `${'\\'.repeat(backslashes * 2 + 1)}"`
      backslashes = 0
      continue
    }
    out += `${'\\'.repeat(backslashes)}${char}`
    backslashes = 0
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`
}

/**
 * 组装提权重启用的 PowerShell 脚本（导出以便单测断言转义）。
 *
 * `-Verb RunAs` 触发 UAC；`-PassThru` 让 `Start-Process` 在拿到进程对象后立即返回，
 * 因此这条 powershell 的**存活时间只覆盖 UAC 询问**，不是子进程的生命周期
 * （父进程据此判断"用户点了否"）。
 *
 * 两层转义缺一不可：先按 Windows 命令行规则给参数加引号（`quoteArgument`），
 * 再按 PowerShell 单引号字面量转义（`quotePowerShell`）—— 前者管子进程怎么拆参数，
 * 后者管 PowerShell 怎么读这个字符串，顺序反了等于没做。
 */
export function buildRelaunchScript(exePath: string, args: readonly string[]): string {
  const list = args.map((arg) => quotePowerShell(quoteArgument(arg))).join(',')
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
  /**
   * 当前用户的配置目录（`app.getPath('userData')`）：作为标记参数传给提权实例，
   * 用于识别"UAC 换了账户"（见 `inspectElevatedUserData`）。缺省则不传该标记。
   */
  userDataPath?: string
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
  // 配置没要求时**连探测都不做**（v0.2.8 审查修复）：`probeElevated` 是 `spawnSync`，
  // 在 fltmc 不可用的机器上要等 PowerShell 起完（实测约 0.5s）—— 关掉开关的用户不该
  // 白付这段启动延迟。
  if (!options.requireAdmin) {
    logger.info('配置未要求管理员身份，跳过提权流程')
    return 'skipped'
  }
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
  const args = [
    ...options.argv
      .slice(1)
      .filter((arg) => arg !== ELEVATION_FLAG && !arg.startsWith(USER_DATA_FLAG)),
    // 带上**原用户**的配置目录（同时用于两件事，见 `inspectElevatedUserData`）：
    // ① 识别"提权换了账户"（UAC 要求输入管理员账户时，子进程的 %APPDATA% 是那个账户的）；
    // ② 那种情况下把 `requireAdmin` 关回原用户的配置，让下次启动能正常跑。
    ...(options.userDataPath === undefined ? [] : [`${USER_DATA_FLAG}${options.userDataPath}`]),
    ELEVATION_FLAG,
  ]
  const result = await (options.relaunch ?? defaultRelaunch)(options.execPath, args)
  if (!result.ok) {
    logger.warn('提权失败，将以普通权限继续运行', { error: result.error ?? '未知原因' })
    return 'failed'
  }
  logger.info('已请求以管理员身份重新启动，本进程退出', { execPath: options.execPath })
  return 'relaunched'
}
