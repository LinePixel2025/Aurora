/**
 * 提权探针的**真实环境**回归护栏（2026-09-29 加入）。
 *
 * 与 `elevation.test.ts` 的分工：那边用假 exec 钉住决策路径（确定性、跨平台可跑），
 * 这边**不注入任何假件**，把两条判据（`fltmc.exe` 与 PowerShell 的
 * `WindowsPrincipal.IsInRole(Administrator)`）放到真实的 Windows 上跑一遍，
 * 断言它们互相一致、且与当前进程的实际提权态相符。
 *
 * 为什么值得单独一条：探测链是「拿不到结论就按已提权处理」的降级设计 —— 降级本身正确，
 * 但它会让"整条链失效"表现为"永远不重启"，没有任何报错。这条用例把「判据真的能给出结论」
 * 变成可执行的断言（实测：非提权终端下 fltmc 退出码 1「拒绝访问」、PowerShell 输出 False）。
 *
 * 非 Windows（`process.platform !== 'win32'`）时跳过：探针在那些平台恒返回 true（不拦）。
 */
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { probeElevated } from './elevation.js'

const onWindows = process.platform === 'win32'

describe.runIf(onWindows)('probeElevated（真实 Windows 环境）', () => {
  it('fltmc 判据可用：退出码 0（已提权）/ 1（拒绝访问），probeElevated 与之一致', () => {
    const fltmc = spawnSync('fltmc.exe', [], { windowsHide: true, encoding: 'utf8' })
    expect([0, 1]).toContain(fltmc.status)
    const viaFlmtc = fltmc.status === 0
    expect(probeElevated({ platform: 'win32' })).toBe(viaFlmtc)
  })

  it('PowerShell 兜底判据与 fltmc 结论一致（两条判据不打架）', () => {
    const fltmc = spawnSync('fltmc.exe', [], { windowsHide: true, encoding: 'utf8' })
    const ps = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
      ],
      { windowsHide: true, encoding: 'utf8' },
    )
    const viaPs = (ps.stdout ?? '').trim().toLowerCase() === 'true'
    expect(viaPs).toBe(fltmc.status === 0)
  })
})
