import { describe, expect, it } from 'vitest'
import {
  isAppAllowed,
  isLaunchableCommand,
  isProtectedWindow,
  isWindowOperable,
  normalizeExeName,
} from './policy.js'

const selfPid = 100

describe('Computer Use 应用策略', () => {
  it('basename 归一：路径 / 引号 / 大小写', () => {
    expect(normalizeExeName('C:\\Windows\\Notepad.EXE')).toBe('notepad.exe')
    expect(normalizeExeName('"chrome.exe"')).toBe('chrome.exe')
    expect(normalizeExeName('')).toBe('')
  })

  it('受保护目标：Aurora 自身 / 终端 / 系统界面', () => {
    expect(isProtectedWindow({ exe: 'C:\\Aurora.exe', pid: selfPid, selfPid })).toBe(true)
    expect(isProtectedWindow({ exe: 'pwsh.exe', pid: 1, selfPid })).toBe(true)
    expect(isProtectedWindow({ exe: 'notepad.exe', pid: 2, selfPid })).toBe(false)
    expect(
      isProtectedWindow({ exe: 'foo.exe', className: 'ConsoleWindowClass', pid: 3, selfPid }),
    ).toBe(true)
  })

  it('deny 优先；allow 为空 = 除 deny 外全部允许', () => {
    expect(isAppAllowed('notepad.exe', { allowedApps: [], deniedApps: [] })).toBe(true)
    expect(isAppAllowed('notepad.exe', { allowedApps: [], deniedApps: ['notepad.exe'] })).toBe(
      false,
    )
    expect(isAppAllowed('notepad.exe', { allowedApps: ['notepad.exe'], deniedApps: [] })).toBe(true)
    expect(isAppAllowed('chrome.exe', { allowedApps: ['notepad.exe'], deniedApps: [] })).toBe(false)
    expect(
      isAppAllowed('chrome.exe', {
        allowedApps: ['chrome.exe'],
        deniedApps: ['chrome.exe'],
      }),
    ).toBe(false)
  })

  it('组合判定与 launch 文件类型', () => {
    expect(
      isWindowOperable({
        exe: 'cmd.exe',
        pid: 1,
        selfPid,
        policy: { allowedApps: [], deniedApps: [] },
      }),
    ).toBe(false)
    expect(
      isWindowOperable({
        exe: 'notepad.exe',
        pid: 2,
        selfPid,
        policy: { allowedApps: [], deniedApps: [] },
      }),
    ).toBe(true)
    expect(isLaunchableCommand('notepad.exe')).toBe(true)
    expect(isLaunchableCommand('C:\\Tools\\a.COM')).toBe(true)
    expect(isLaunchableCommand('evil.bat')).toBe(false)
    expect(isLaunchableCommand('evil.ps1')).toBe(false)
  })
})
