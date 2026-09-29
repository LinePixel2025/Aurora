/**
 * 管理员提权（v0.2.8，docs/08 §1）的决策表与转义护栏。
 *
 * 这里覆盖的是**判断**，不是真的起进程：探测 / 重启都是可注入端口，
 * 因此单测能钉住四条边界 —— 反循环、失败不卡死、只在安装版强制、探测失败按已提权。
 */
import { describe, expect, it } from 'vitest'
import type { Logger } from '@aurora/shared'
import {
  ELEVATION_FLAG,
  buildRelaunchScript,
  ensureElevation,
  hasElevationFlag,
  probeElevated,
  shouldRelaunchElevated,
  type ElevationProbeOptions,
  type ExecFn,
} from './elevation.js'

function silentLogger(): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  }
  return logger
}

/** 命令执行器替身：按文件名给预设结果；未预设的按"找不到命令"抛错 */
function fakeExec(table: Record<string, { status: number | null; stdout?: string }>): ExecFn {
  return (file) => {
    const entry = table[file]
    if (entry === undefined) throw new Error(`ENOENT: ${file}`)
    return { status: entry.status, stdout: entry.stdout ?? '' }
  }
}

describe('probeElevated', () => {
  it('fltmc 退出码 0 → 已提权（不再问 PowerShell）', () => {
    let powershellCalled = false
    const exec: ExecFn = (file) => {
      if (file === 'powershell.exe') {
        powershellCalled = true
        return { status: 0, stdout: 'True' }
      }
      return { status: 0, stdout: '' }
    }
    expect(probeElevated({ platform: 'win32', exec })).toBe(true)
    expect(powershellCalled).toBe(false)
  })

  it('fltmc 退出码 1（访问被拒）→ 未提权', () => {
    const exec = fakeExec({
      'fltmc.exe': { status: 1 },
      'powershell.exe': { status: 0, stdout: 'True' },
    })
    expect(probeElevated({ platform: 'win32', exec })).toBe(false)
  })

  it('fltmc 不可用时回落 PowerShell 判定（True / False 文本）', () => {
    const only = (stdout: string): ElevationProbeOptions => ({
      platform: 'win32',
      exec: fakeExec({ 'powershell.exe': { status: 0, stdout } }),
    })
    expect(probeElevated(only('True\r\n'))).toBe(true)
    expect(probeElevated(only('false'))).toBe(false)
  })

  it('两条判据都拿不到结论 → 按已提权处理（探测失败不能变成启动不了）', () => {
    expect(probeElevated({ platform: 'win32', exec: fakeExec({}) })).toBe(true)
  })

  it('非 Windows 不拦（平台未支持提权概念）', () => {
    expect(probeElevated({ platform: 'darwin', exec: fakeExec({}) })).toBe(true)
  })
})

describe('shouldRelaunchElevated 决策表', () => {
  const base = {
    requireAdmin: true,
    elevated: false,
    alreadyRelaunched: false,
    packaged: true,
    forceInDev: false,
    platform: 'win32',
  }

  it('安装版 + 未提权 + 配置要求 → 提权', () => {
    expect(shouldRelaunchElevated(base)).toBe(true)
  })

  it('五条"不提权"理由各自成立即否决', () => {
    expect(shouldRelaunchElevated({ ...base, requireAdmin: false })).toBe(false)
    expect(shouldRelaunchElevated({ ...base, elevated: true })).toBe(false)
    // 反循环：被提权拉起的实例带着标记参数，不再提权
    expect(shouldRelaunchElevated({ ...base, alreadyRelaunched: true })).toBe(false)
    // 开发态默认不提权（smoke / capture 跑在非提权终端里，强制提权会每次弹 UAC）
    expect(shouldRelaunchElevated({ ...base, packaged: false })).toBe(false)
    expect(shouldRelaunchElevated({ ...base, platform: 'linux' })).toBe(false)
  })

  it('开发态显式打开（AURORA_REQUIRE_ADMIN=1）后仍然提权', () => {
    expect(shouldRelaunchElevated({ ...base, packaged: false, forceInDev: true })).toBe(true)
  })
})

describe('hasElevationFlag / buildRelaunchScript', () => {
  it('标记参数按整串比对（不会被别的参数顺带命中）', () => {
    expect(hasElevationFlag([ELEVATION_FLAG])).toBe(true)
    expect(hasElevationFlag(['--other', ELEVATION_FLAG])).toBe(true)
    expect(hasElevationFlag(['--aurora-elevated-2'])).toBe(false)
  })

  it('脚本转义：单引号翻倍、参数按数组传递（路径含空格 / 单引号都安全）', () => {
    const script = buildRelaunchScript("C:\\Program Files\\Aurora's App\\Aurora.exe", [
      '--flag',
      "it's fine",
    ])
    expect(script).toContain("'C:\\Program Files\\Aurora''s App\\Aurora.exe'")
    expect(script).toContain("'--flag','it''s fine'")
    expect(script).toContain('-Verb RunAs')
    // 用户点「否」时 Start-Process 抛错 → exit 3（父进程据此知道没提成）
    expect(script).toContain('exit 3')
  })
})

describe('ensureElevation', () => {
  const args = {
    requireAdmin: true,
    packaged: true,
    argv: ['Aurora.exe'],
    execPath: 'C:\\Aurora\\Aurora.exe',
    logger: silentLogger(),
    platform: 'win32',
  }

  it('已提权 → elevated，不重启', async () => {
    let relaunched = false
    const outcome = await ensureElevation({
      ...args,
      probe: () => true,
      relaunch: async () => {
        relaunched = true
        return { ok: true }
      },
    })
    expect(outcome).toBe('elevated')
    expect(relaunched).toBe(false)
  })

  it('未提权 + 安装版 → 带标记参数重启并返回 relaunched', async () => {
    const calls: Array<{ exePath: string; args: readonly string[] }> = []
    const outcome = await ensureElevation({
      ...args,
      probe: () => false,
      relaunch: async (exePath, relaunchArgs) => {
        calls.push({ exePath, args: relaunchArgs })
        return { ok: true }
      },
    })
    expect(outcome).toBe('relaunched')
    expect(calls[0]?.exePath).toBe(args.execPath)
    expect(calls[0]?.args).toContain(ELEVATION_FLAG)
  })

  it('已在提权实例里（带标记参数）→ skipped，不再套娃提权', async () => {
    let relaunched = false
    const outcome = await ensureElevation({
      ...args,
      argv: ['Aurora.exe', ELEVATION_FLAG],
      probe: () => false,
      relaunch: async () => {
        relaunched = true
        return { ok: true }
      },
    })
    expect(outcome).toBe('skipped')
    expect(relaunched).toBe(false)
  })

  it('用户拒绝 UAC（重启失败）→ failed，调用方据此继续以普通权限启动', async () => {
    const outcome = await ensureElevation({
      ...args,
      probe: () => false,
      relaunch: async () => ({ ok: false, error: '提权被拒绝' }),
    })
    expect(outcome).toBe('failed')
  })

  it('配置关闭 → skipped（不再探测后重启）', async () => {
    let relaunched = false
    const outcome = await ensureElevation({
      ...args,
      requireAdmin: false,
      probe: () => false,
      relaunch: async () => {
        relaunched = true
        return { ok: true }
      },
    })
    expect(outcome).toBe('skipped')
    expect(relaunched).toBe(false)
  })
})
