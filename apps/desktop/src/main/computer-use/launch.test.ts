import { describe, expect, it } from 'vitest'
import {
  LAUNCH_COOLDOWN_MS,
  describeActivateFailure,
  describeLaunchResult,
  findReusableWindow,
  launchKey,
  planLaunch,
  type LaunchWindow,
} from './launch.js'

function window(overrides: Partial<LaunchWindow> = {}): LaunchWindow {
  return {
    windowId: '100',
    title: '微信',
    exe: 'C:\\Program Files\\Weixin\\Weixin.exe',
    pid: 1234,
    bounds: { x: 100, y: 100, width: 800, height: 600 },
    visible: true,
    minimized: false,
    foreground: false,
    ...overrides,
  }
}

describe('Computer Use 启动策略', () => {
  it('无 args 且同 exe 已运行：复用窗口（优先前台，其次非最小化）', () => {
    const background = window({ windowId: '1' })
    const foreground = window({ windowId: '2', foreground: true })
    expect(findReusableWindow([background, foreground], 'E:\\Weixin\\Weixin.exe')?.windowId).toBe(
      '2',
    )
    const minimized = window({ windowId: '3', minimized: true })
    expect(findReusableWindow([minimized, background], 'weixin.exe')?.windowId).toBe('1')
  })

  it('不同 exe / 不可见 / 无标题的窗口不参与复用', () => {
    expect(findReusableWindow([window({ exe: 'msedge.exe' })], 'weixin.exe')).toBeUndefined()
    expect(findReusableWindow([window({ visible: false })], 'weixin.exe')).toBeUndefined()
    expect(findReusableWindow([window({ title: '  ' })], 'weixin.exe')).toBeUndefined()
  })

  it('无 args + 已运行 → reuse；带 args → 即使已运行也 launch', () => {
    const windows = [window({ foreground: true })]
    expect(planLaunch({ command: 'weixin.exe', windows, now: 1000 }).kind).toBe('reuse')
    expect(
      planLaunch({
        command: 'msedge.exe',
        args: ['--new-window', 'https://example.com'],
        windows: [window({ exe: 'msedge.exe' })],
        now: 1000,
      }).kind,
    ).toBe('launch')
  })

  it('同 command+args 在冷却期内重试 → cooldown；过期 / 换参数 → launch', () => {
    const key = launchKey('weixin.exe', [])
    const now = 10_000
    const plan = planLaunch({
      command: 'weixin.exe',
      windows: [],
      lastAttempt: { key, at: now - 2000 },
      now,
    })
    expect(plan).toEqual({ kind: 'cooldown', seconds: 6 })
    expect(
      planLaunch({
        command: 'weixin.exe',
        windows: [],
        lastAttempt: { key, at: now - LAUNCH_COOLDOWN_MS - 1 },
        now,
      }).kind,
    ).toBe('launch')
    expect(
      planLaunch({
        command: 'weixin.exe',
        args: ['--new-window'],
        windows: [],
        lastAttempt: { key, at: now - 1000 },
        now,
      }).kind,
    ).toBe('launch')
  })

  it('宿主返回 window=null 时不抛错，给出「不要重复 launch」的成功文案', () => {
    const result = describeLaunchResult({
      name: 'weixin.exe',
      result: { pid: 1, process: 'weixin.exe', window: null },
    })
    expect(result.content).toContain('没有检测到新窗口')
    expect(result.content).toContain('不要重复 launch')
    expect(result.content).not.toContain('失败')
    expect(result.summary).toContain('等待窗口')
  })

  it('有窗口 / 复用 / 激活失败三种文案', () => {
    const launched = describeLaunchResult({
      name: 'msedge.exe',
      result: {
        pid: 2,
        process: 'msedge.exe',
        window: window({ title: 'B 站', windowId: '9' }),
      },
    })
    expect(launched.content).toContain('已启动 msedge.exe')
    expect(launched.content).toContain('窗口「B 站」')

    const reused = describeLaunchResult({
      name: 'weixin.exe',
      reused: window({ windowId: '7', title: '微信' }),
      restored: true,
    })
    expect(reused.content).toContain('已在运行')
    expect(reused.content).toContain('已还原并切换')
    expect(reused.content).toContain('不要重复 launch')

    const failed = describeLaunchResult({
      name: 'weixin.exe',
      reused: window({ windowId: '7' }),
      activationFailed: true,
    })
    expect(failed.content).toContain('系统拒绝把窗口切到前台')
    expect(failed.content).toContain('不要重复 launch')
  })

  it('前台激活失败的错误文案包含宿主原因', () => {
    expect(describeActivateFailure()).toContain('系统拒绝把窗口切到前台')
    expect(describeActivateFailure('前台锁')).toContain('前台锁')
  })
})
