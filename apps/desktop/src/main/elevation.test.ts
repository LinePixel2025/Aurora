/**
 * 管理员提权（v0.2.8，docs/08 §1）的决策表与转义护栏。
 *
 * 这里覆盖的是**判断**，不是真的起进程：探测 / 重启都是可注入端口，
 * 因此单测能钉住四条边界 —— 反循环、失败不卡死、只在安装版强制、探测失败按已提权。
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { Logger } from '@aurora/shared'
import {
  ELEVATION_FLAG,
  USER_DATA_FLAG,
  buildRelaunchScript,
  disableRequireAdmin,
  ensureElevation,
  hasElevationFlag,
  inspectElevatedUserData,
  probeElevated,
  quoteArgument,
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

  it('脚本转义：单引号翻倍 + 含空格的参数按 Windows 规则加引号', () => {
    const script = buildRelaunchScript("C:\\Program Files\\Aurora's App\\Aurora.exe", [
      '--flag',
      "it's fine",
    ])
    // -FilePath 是独立参数：路径原样单引号转义即可（Start-Process 自己会引用它）
    expect(script).toContain("'C:\\Program Files\\Aurora''s App\\Aurora.exe'")
    // -ArgumentList 内部是 join(' ')：含空格的参数必须自己加双引号，否则会被拆成两个参数
    // （v0.2.8 审查修复：开发态验证路径里 argv[1] 是 app 目录路径）
    expect(script).toContain(`'--flag','"it''s fine"'`)
    expect(script).toContain('-Verb RunAs')
    // 用户点「否」时 Start-Process 抛错 → exit 3（父进程据此知道没提成）
    expect(script).toContain('exit 3')
  })

  it('quoteArgument：按 CommandLineToArgvW 规则处理空白、双引号与反斜杠', () => {
    expect(quoteArgument('plain')).toBe('plain')
    expect(quoteArgument('')).toBe('""')
    expect(quoteArgument('C:\\My Projects\\Aurora')).toBe('"C:\\My Projects\\Aurora"')
    // 内部双引号 → \"，其前面的反斜杠加倍（2n+1）
    expect(quoteArgument('a""b')).toBe('"a\\"\\"b"')
    expect(quoteArgument('a\\"b')).toBe('"a\\\\\\"b"')
    // 结尾反斜杠 → 2n（否则会把收尾的引号转义掉）
    expect(quoteArgument('a b\\')).toBe('"a b\\\\"')
  })
})

/** 提权换账户的自愈路径（v0.2.8 审查修复）：识别"UAC 换了账户" + 关掉原用户的 requireAdmin */
describe('inspectElevatedUserData / disableRequireAdmin', () => {
  it('没带标记 / 两边一致 → undefined；不一致 → 给出两边路径（大小写与尾分隔符归一）', () => {
    expect(
      inspectElevatedUserData(['Aurora.exe'], 'C:\\Users\\A\\AppData\\Roaming\\Aurora'),
    ).toBeUndefined()
    expect(
      inspectElevatedUserData(
        ['Aurora.exe', `${USER_DATA_FLAG}C:\\Users\\A\\AppData\\Roaming\\Aurora`],
        'c:\\users\\a\\appdata\\roaming\\aurora\\',
      ),
    ).toBeUndefined()
    const mismatch = inspectElevatedUserData(
      ['Aurora.exe', `${USER_DATA_FLAG}C:\\Users\\A\\AppData\\Roaming\\Aurora`],
      'C:\\Users\\Administrator\\AppData\\Roaming\\Aurora',
    )
    expect(mismatch).toEqual({
      expected: 'C:\\Users\\A\\AppData\\Roaming\\Aurora',
      actual: 'C:\\Users\\Administrator\\AppData\\Roaming\\Aurora',
    })
  })

  it('disableRequireAdmin：只改那一个字段、其余逐字保留；文件缺失/损坏时返回 false 不抛', async () => {
    const { mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'aurora-elevation-'))
    const configPath = join(dir, 'config.json')
    try {
      await writeFile(
        configPath,
        JSON.stringify(
          { version: 20, general: { language: 'zh-CN', requireAdmin: true }, llm: { active: 'x' } },
          null,
          2,
        ),
        'utf8',
      )
      expect(disableRequireAdmin(configPath)).toBe(true)
      const parsed = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
      const general = parsed['general'] as Record<string, unknown>
      expect(general['requireAdmin']).toBe(false)
      // 其余字段一字未动
      expect(general['language']).toBe('zh-CN')
      expect(parsed['llm']).toEqual({ active: 'x' })
      expect(parsed['version']).toBe(20)
      // 幂等：已是 false 时直接返回 true（不重写）
      expect(disableRequireAdmin(configPath)).toBe(true)

      // 损坏 JSON / 缺文件 → false（调用方只提示、不改）
      await writeFile(configPath, '{ not json', 'utf8')
      expect(disableRequireAdmin(configPath)).toBe(false)
      expect(disableRequireAdmin(join(dir, 'missing.json'))).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
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

/**
 * v0.2.8 审查修复的三条（提权链）：
 * ① 配置关闭时连探测都不做（省掉最多约 0.5s 的 `spawnSync` 启动延迟）；
 * ② 提权实例的命令行带上原用户的配置目录（子进程据此识别"UAC 换了账户"）；
 * ③ 参数按 Windows 命令行规则加引号（含空格也不会被拆成多个参数）。
 */
describe('ensureElevation · 审查修复', () => {
  const userData = join('C:', 'Users', 'A', 'AppData', 'Roaming', 'Aurora')
  const base = {
    requireAdmin: true,
    packaged: true,
    argv: ['Aurora.exe'],
    execPath: join('C:', 'Aurora', 'Aurora.exe'),
    logger: silentLogger(),
    platform: 'win32',
    userDataPath: userData,
  }

  it('配置未要求提权 → 连探测都不做', async () => {
    let probed = false
    const outcome = await ensureElevation({
      ...base,
      requireAdmin: false,
      probe: () => {
        probed = true
        return false
      },
      relaunch: async () => ({ ok: true }),
    })
    expect(outcome).toBe('skipped')
    expect(probed).toBe(false)
  })

  it('提权实例的命令行带上原用户配置目录标记 + 提权标记', async () => {
    let captured: readonly string[] = []
    const outcome = await ensureElevation({
      ...base,
      probe: () => false,
      relaunch: async (_exe, args) => {
        captured = args
        return { ok: true }
      },
    })
    expect(outcome).toBe('relaunched')
    expect(captured).toContain(ELEVATION_FLAG)
    expect(captured).toContain(`${USER_DATA_FLAG}${userData}`)
  })

  it('原命令行里的陈旧配置目录标记会被替换掉（不会带着上一轮的目录）', async () => {
    let captured: readonly string[] = []
    await ensureElevation({
      ...base,
      argv: ['Aurora.exe', `${USER_DATA_FLAG}${join('C:', '旧', '目录')}`, '--other'],
      probe: () => false,
      relaunch: async (_exe, args) => {
        captured = args
        return { ok: true }
      },
    })
    expect(captured.filter((arg) => arg.startsWith(USER_DATA_FLAG))).toEqual([
      `${USER_DATA_FLAG}${userData}`,
    ])
    expect(captured).toContain('--other')
  })

  it('参数含空格：脚本里该参数带双引号（子进程不会把它拆成两个参数）', async () => {
    // 开发态验证路径的典型形态：argv[1] 是 app 目录，仓库路径可能含空格
    const appDir = join('D:', 'My Projects', 'Aurora', 'apps', 'desktop')
    let capturedArgs: readonly string[] = []
    await ensureElevation({
      ...base,
      argv: ['electron.exe', appDir],
      packaged: false,
      env: { AURORA_REQUIRE_ADMIN: '1' },
      probe: () => false,
      relaunch: async (_exe, args) => {
        capturedArgs = args
        // 脚本里的形式：PowerShell 单引号字面量里包着 Windows 命令行双引号
        const script = buildRelaunchScript(base.execPath, args)
        expect(script).toContain(`'"${appDir}"'`)
        return { ok: true }
      },
    })
    expect(capturedArgs).toContain(appDir)
  })
})
