import { describe, expect, it, vi } from 'vitest'
import { createMemoryLogger } from '@aurora/shared'
import {
  attachDesktopOwner,
  buildDesktopLayerScript,
  DESKTOP_LAYER_MARKER,
  DESKTOP_LAYER_TIMEOUT_MS,
  detachDesktopOwner,
  encodeDesktopLayerCommand,
  parseDesktopLayerResult,
  type DesktopLayerRunner,
} from './widget-desktop-layer.js'

interface Invocation {
  file: string
  args: readonly string[]
}

/** 假执行器：记录调用并回固定 stdout，**绝不启动真实 PowerShell**。 */
function fakeRunner(stdout: string): {
  runner: DesktopLayerRunner
  calls: Invocation[]
} {
  const calls: Invocation[] = []
  return {
    calls,
    runner: (file, args) => {
      calls.push({ file, args })
      return Promise.resolve(stdout)
    },
  }
}

const POWERSHELL_FLAGS = [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-EncodedCommand',
]

function decodeCommand(args: readonly string[]): string {
  return Buffer.from(args[args.length - 1] ?? '', 'base64').toString('utf16le')
}

describe('桌面层 PowerShell 脚本', () => {
  it('包含 Progman / WorkerW / SHELLDLL_DefView 与 P/Invoke 入口', () => {
    const script = buildDesktopLayerScript(0x1234, 'attach')
    expect(script).toContain('Add-Type')
    expect(script).toContain('FindWindow')
    expect(script).toContain('FindWindowEx')
    expect(script).toContain('SetWindowLongPtr')
    expect(script).toContain('GetWindowLongPtr')
    expect(script).toContain('SetWindowLongPtr($hwnd, -8, $shellView)')
    expect(script).toContain('Progman')
    expect(script).toContain('SHELLDLL_DefView')
    expect(script).toContain('WorkerW')
    // HWND 与 action 是仅有的两处业务插值
    expect(script).toContain('[IntPtr]([Int64]4660)')
    expect(script).toContain("$action = 'attach'")
    // PowerShell 会把 $null 转成 '' 交给 string 参数，标题参数必须用 [NullString]::Value
    expect(script).toContain('[NullString]::Value')
    expect(script).not.toContain(', $null)')
  })

  it('attach / detach 用同一份静态模板，只换 action', () => {
    const attach = buildDesktopLayerScript(1, 'attach')
    const detach = buildDesktopLayerScript(1, 'detach')
    expect(detach).toContain("$action = 'detach'")
    expect(attach).not.toBe(detach)
    expect(attach.replace("'attach'", "'detach'")).toBe(detach)
  })

  it('非法 HWND 写成 0（不拿脏值去调 Win32）', () => {
    expect(buildDesktopLayerScript(Number.NaN, 'attach')).toContain('[IntPtr]([Int64]0)')
    expect(buildDesktopLayerScript(-5, 'detach')).toContain('[IntPtr]([Int64]0)')
    expect(buildDesktopLayerScript(1.5, 'attach')).toContain('[IntPtr]([Int64]0)')
  })

  it('-EncodedCommand 用 UTF-16LE + base64', () => {
    const encoded = encodeDesktopLayerCommand('AURORA 桌面层')
    expect(encoded).toBe(Buffer.from('AURORA 桌面层', 'utf16le').toString('base64'))
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe('AURORA 桌面层')
  })
})

describe('parseDesktopLayerResult', () => {
  it('marker 首段 1 = 成功，原因原样保留', () => {
    expect(parseDesktopLayerResult('AURORA_DESKTOP_LAYER|1|attached')).toEqual({
      ok: true,
      reason: 'attached',
    })
    expect(parseDesktopLayerResult(`  ${DESKTOP_LAYER_MARKER}1|detached  `)).toEqual({
      ok: true,
      reason: 'detached',
    })
  })

  it('marker 首段 0 = 失败，带原因', () => {
    expect(parseDesktopLayerResult(`${DESKTOP_LAYER_MARKER}0|no-shell-view`)).toEqual({
      ok: false,
      reason: 'no-shell-view',
    })
    expect(parseDesktopLayerResult(`${DESKTOP_LAYER_MARKER}0|readback-mismatch`)).toEqual({
      ok: false,
      reason: 'readback-mismatch',
    })
  })

  it('非 marker 行 / 非法首段一律 undefined', () => {
    expect(parseDesktopLayerResult('')).toBeUndefined()
    expect(parseDesktopLayerResult('some noise')).toBeUndefined()
    expect(parseDesktopLayerResult(`${DESKTOP_LAYER_MARKER}2|bad`)).toBeUndefined()
    expect(parseDesktopLayerResult(`${DESKTOP_LAYER_MARKER}`)).toBeUndefined()
    expect(parseDesktopLayerResult(`${DESKTOP_LAYER_MARKER}|1|attached`)).toBeUndefined()
  })
})

describe('attachDesktopOwner', () => {
  it('execFile 形态的 argv：powershell.exe + 固定 flags + 编码脚本；不启动真实进程', async () => {
    const { runner, calls } = fakeRunner(`${DESKTOP_LAYER_MARKER}1|attached\r\n`)
    await expect(attachDesktopOwner(0x1234, { runner, platform: 'win32' })).resolves.toBe(true)
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.file).toBe('powershell.exe')
    expect(call.args.slice(0, POWERSHELL_FLAGS.length)).toEqual(POWERSHELL_FLAGS)
    expect(call.args).toHaveLength(POWERSHELL_FLAGS.length + 1)
    expect(decodeCommand(call.args)).toBe(buildDesktopLayerScript(0x1234, 'attach'))
  })

  it('marker 0 解析为 false 并记 warn（失败原因进日志）', async () => {
    const logger = createMemoryLogger()
    const { runner } = fakeRunner(`${DESKTOP_LAYER_MARKER}0|no-shell-view\n`)
    await expect(attachDesktopOwner(77, { runner, platform: 'win32', logger })).resolves.toBe(false)
    expect(
      logger.entries.some((line) => line.includes('[warn]') && line.includes('no-shell-view')),
    ).toBe(true)
  })

  it('执行失败 / 超时降级为 false 并记 warn（不抛错）', async () => {
    const logger = createMemoryLogger()
    const runner = vi.fn(async () => {
      throw new Error('ETIMEDOUT: powershell.exe')
    })
    await expect(attachDesktopOwner(88, { runner, platform: 'win32', logger })).resolves.toBe(false)
    expect(
      logger.entries.some((line) => line.includes('[warn]') && line.includes('ETIMEDOUT')),
    ).toBe(true)
  })

  it('没有 marker 行按失败处理', async () => {
    const logger = createMemoryLogger()
    const { runner } = fakeRunner('powershell 输出了一些噪声\n')
    await expect(attachDesktopOwner(99, { runner, platform: 'win32', logger })).resolves.toBe(false)
    expect(logger.entries.some((line) => line.includes('[warn]'))).toBe(true)
  })

  it('非 win32 / 非法 HWND 直接 false，不执行脚本', async () => {
    const runner = vi.fn(async () => `${DESKTOP_LAYER_MARKER}1|attached`)
    await expect(attachDesktopOwner(1, { runner, platform: 'linux' })).resolves.toBe(false)
    await expect(attachDesktopOwner(1, { runner, platform: 'darwin' })).resolves.toBe(false)
    await expect(attachDesktopOwner(0, { runner, platform: 'win32' })).resolves.toBe(false)
    await expect(attachDesktopOwner(-1, { runner, platform: 'win32' })).resolves.toBe(false)
    await expect(attachDesktopOwner(Number.NaN, { runner, platform: 'win32' })).resolves.toBe(false)
    expect(runner).not.toHaveBeenCalled()
  })

  it('超时常量为 3000ms（脚本是建窗旁路，不能拖住主进程）', () => {
    expect(DESKTOP_LAYER_TIMEOUT_MS).toBe(3000)
  })
})

describe('detachDesktopOwner', () => {
  it('用 detach 脚本并解析成功 marker', async () => {
    const { runner, calls } = fakeRunner(`${DESKTOP_LAYER_MARKER}1|detached\n`)
    await expect(detachDesktopOwner(0x55, { runner, platform: 'win32' })).resolves.toBe(true)
    expect(decodeCommand(calls[0]!.args)).toBe(buildDesktopLayerScript(0x55, 'detach'))
  })

  it('失败只记 debug（最佳努力收尾，不打扰用户）', async () => {
    const logger = createMemoryLogger()
    const runner = vi.fn(async () => {
      throw new Error('timeout')
    })
    await expect(detachDesktopOwner(0x55, { runner, platform: 'win32', logger })).resolves.toBe(
      false,
    )
    expect(logger.entries.some((line) => line.includes('[debug]'))).toBe(true)
    expect(logger.entries.some((line) => line.includes('[warn]'))).toBe(false)
  })
})
