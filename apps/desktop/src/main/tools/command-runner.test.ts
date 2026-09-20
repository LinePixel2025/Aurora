/**
 * 真实 PowerShell 执行器单测（docs/06 §11、step 3）。
 *
 * 这里**真启动 powershell.exe**（离线可跑）：编码、退出码、cwd、超时杀进程树、abort
 * 这些行为只有真跑进程才验证得了，假 runner 覆盖不到。非 Windows 平台整体跳过
 * （执行器本身只面向 Windows）。
 */
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCommandRunner, terminateProcessTree } from './command-runner.js'

const WORK_DIR = process.cwd()
const runner = createCommandRunner({ defaultCwd: WORK_DIR })
const TIMEOUT = 20_000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe.skipIf(process.platform !== 'win32')('createCommandRunner（真实 PowerShell）', () => {
  it(
    '执行 echo：拿到 stdout、退出码 0、未超时',
    async () => {
      const result = await runner({ command: 'echo AURORA_TERMINAL_OK', timeoutMs: TIMEOUT })

      expect(result.stdout).toContain('AURORA_TERMINAL_OK')
      expect(result.exitCode).toBe(0)
      expect(result.timedOut).toBe(false)
      expect(result.aborted).toBe(false)
      // 回带原始命令（内核渲染头部要用）
      expect(result.command).toBe('echo AURORA_TERMINAL_OK')
    },
    TIMEOUT,
  )

  it(
    '中文输出不乱码（编码回归：不设 OutputEncoding 时 PowerShell 5.1 会按 GBK 输出）',
    async () => {
      const result = await runner({
        command: "Write-Output '中文输出测试'",
        timeoutMs: TIMEOUT,
      })

      expect(result.stdout).toContain('中文输出测试')
      // 乱码的典型症状：字节流被按错误编码解码，出现替换字符
      expect(result.stdout).not.toContain('\uFFFD')
      expect(result.exitCode).toBe(0)
    },
    TIMEOUT,
  )

  it(
    'stderr 单独采集',
    async () => {
      const result = await runner({
        command: "[Console]::Error.WriteLine('BOOM')",
        timeoutMs: TIMEOUT,
      })

      expect(result.stderr).toContain('BOOM')
      // WriteLine 到 stderr 不影响退出码
      expect(result.exitCode).toBe(0)
    },
    TIMEOUT,
  )

  it(
    '退出码原样回带（exit 3）',
    async () => {
      const result = await runner({ command: 'exit 3', timeoutMs: TIMEOUT })

      expect(result.exitCode).toBe(3)
      expect(result.timedOut).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'cwd 生效（Get-Location 返回传入的目录）',
    async () => {
      const cwd = tmpdir()
      const expected = cwd.replace(/[\\/]+$/, '').toLowerCase()
      const result = await runner({ command: '(Get-Location).Path', cwd, timeoutMs: TIMEOUT })

      expect(result.cwd.replace(/[\\/]+$/, '').toLowerCase()).toBe(expected)
      expect(result.stdout.trim().toLowerCase()).toContain(expected)
      expect(result.exitCode).toBe(0)
    },
    TIMEOUT,
  )

  it(
    '超时按进程树终止：Start-Sleep 10s 在 800ms 超时后被真的杀掉',
    async () => {
      const result = await runner({ command: 'Start-Sleep -Seconds 10', timeoutMs: 800 })

      expect(result.timedOut).toBe(true)
      expect(result.aborted).toBe(false)
      // 关键证据：远小于命令自身的 10s，说明进程被杀了而不是等它睡完
      expect(result.durationMs).toBeLessThan(4_000)
    },
    TIMEOUT,
  )

  it(
    '超时杀的是整棵进程树：孙进程也活不到干完活（marker 文件不出现）',
    async () => {
      const marker = join(tmpdir(), `aurora-tree-kill-${process.pid}-${Date.now()}.txt`)
      // 孙进程 4 秒后写 marker；外层只负责睡（20s）——如果只杀直接子进程，
      // 孙进程会活下来并在 4 秒后把 marker 写出来（child.kill() 在 Windows 上就是这个结果）。
      const grandchild = `Start-Sleep -Seconds 4; Set-Content -LiteralPath '${marker}' -Value alive`
      const command =
        "Start-Process -FilePath 'powershell.exe' -NoNewWindow -ArgumentList " +
        `'-NoProfile','-NonInteractive','-Command','${grandchild.replace(/'/g, "''")}'; ` +
        'Start-Sleep -Seconds 20'

      const result = await runner({ command, timeoutMs: 1_200 })
      expect(result.timedOut).toBe(true)
      expect(result.durationMs).toBeLessThan(4_000)

      // 等过孙进程自己的 4 秒期限
      await delay(4_500)
      const survived = existsSync(marker)
      if (survived) rmSync(marker, { force: true })
      expect(survived).toBe(false)
    },
    TIMEOUT,
  )

  it(
    '已 abort 的 signal：返回 aborted，且 2s 内收尾',
    async () => {
      const controller = new AbortController()
      controller.abort()
      const started = Date.now()

      const result = await runner({
        command: 'Start-Sleep -Seconds 10',
        timeoutMs: TIMEOUT,
        signal: controller.signal,
      })

      expect(result.aborted).toBe(true)
      expect(result.timedOut).toBe(false)
      expect(Date.now() - started).toBeLessThan(2_000)
    },
    TIMEOUT,
  )

  it(
    '不存在的 cwd 回落到 defaultCwd（不让 spawn 直接挂掉）',
    async () => {
      const result = await runner({
        command: '(Get-Location).Path',
        cwd: 'D:\\aurora-not-exists-测试目录',
        timeoutMs: TIMEOUT,
      })

      expect(result.cwd).toBe(WORK_DIR)
      expect(result.exitCode).toBe(0)
    },
    TIMEOUT,
  )

  it(
    'terminateProcessTree 对不存在的 PID 也是安全的 no-op',
    async () => {
      await expect(terminateProcessTree(undefined)).resolves.toBeUndefined()
      // 一个几乎不可能存在的 PID：taskkill 报错被吞掉，不允许抛
      await expect(terminateProcessTree(2_147_483_647)).resolves.toBeUndefined()
    },
    TIMEOUT,
  )
})
