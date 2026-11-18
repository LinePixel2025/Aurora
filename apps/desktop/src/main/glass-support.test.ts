/**
 * 原生 Acrylic 平台判据（2026-11-18）。
 *
 * 回归护栏：Windows 10（含最后的 19045）与 Win11 21H2（22000）都没有
 * DWM_SYSTEMBACKDROP_TYPE，必须返回 false；只有 22H2（22621）起才允许挂材质。
 * 之前的实现只靠 try/catch，Win10 上 Electron 静默 no-op 会让窗口被记成
 * 「已挂材质」，提示条直接裸漏桌面。
 */
import { describe, expect, it } from 'vitest'
import { supportsNativeWindowMaterial } from './glass-support.js'

describe('supportsNativeWindowMaterial', () => {
  it('Windows 11 22H2（22621）及以上支持', () => {
    expect(supportsNativeWindowMaterial('win32', '10.0.22621')).toBe(true)
    expect(supportsNativeWindowMaterial('win32', '10.0.22631')).toBe(true)
    expect(supportsNativeWindowMaterial('win32', '10.0.26100')).toBe(true)
  })

  it('Windows 10 与 Win11 21H2 一律不支持', () => {
    expect(supportsNativeWindowMaterial('win32', '10.0.19045')).toBe(false)
    expect(supportsNativeWindowMaterial('win32', '10.0.22000')).toBe(false)
    expect(supportsNativeWindowMaterial('win32', '6.3.9600')).toBe(false)
  })

  it('非 Windows 与异常版本串不支持', () => {
    expect(supportsNativeWindowMaterial('darwin', '23.0.0')).toBe(false)
    expect(supportsNativeWindowMaterial('linux', '6.8.0')).toBe(false)
    expect(supportsNativeWindowMaterial('win32', '10.0')).toBe(false)
    expect(supportsNativeWindowMaterial('win32', '')).toBe(false)
  })
})
