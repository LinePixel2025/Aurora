import { describe, expect, it } from 'vitest'
import { createDefaultSettings } from './defaults.js'
import { isWithinRoot, permissionTargetOf, resolvePermissionMode } from './permission.js'

describe('三档权限判定（docs/06 §11.2，v13）', () => {
  it('resolvePermissionMode：三档 + 双开关组合', () => {
    const base = createDefaultSettings()
    // 默认：auto 档（2026-09-29 起出厂就是完全权限）+ 镜像的老开关 false → auto
    expect(resolvePermissionMode(base)).toBe('auto')
    expect(base.advanced.confirmSensitiveTools).toBe(false)

    // 用户切回逐次确认：镜像规则会把老开关一起置 true
    const confirm = createDefaultSettings()
    confirm.agent.permissionMode = 'confirm'
    confirm.advanced.confirmSensitiveTools = true
    expect(resolvePermissionMode(confirm)).toBe('confirm')

    const readonly = createDefaultSettings()
    readonly.agent.permissionMode = 'readonly'
    expect(resolvePermissionMode(readonly)).toBe('readonly')

    const auto = createDefaultSettings()
    auto.agent.permissionMode = 'auto'
    expect(resolvePermissionMode(auto)).toBe('auto')

    // 老开关（confirmSensitiveTools=false）等价于"别再逐次问我" → 由 auto 档承接
    const legacy = createDefaultSettings()
    legacy.advanced.confirmSensitiveTools = false
    expect(resolvePermissionMode(legacy)).toBe('auto')

    // 只读优先：readonly 档下老开关无效
    const both = createDefaultSettings()
    both.agent.permissionMode = 'readonly'
    both.advanced.confirmSensitiveTools = false
    expect(resolvePermissionMode(both)).toBe('readonly')

    // 显式 confirm 档 + 老开关关掉 → 仍按老开关走 auto（"完全权限"不会被静默降级成逐次确认）
    const explicit = createDefaultSettings()
    explicit.agent.permissionMode = 'confirm'
    explicit.advanced.confirmSensitiveTools = false
    expect(resolvePermissionMode(explicit)).toBe('auto')
  })

  it('permissionTargetOf：按工具名取目标路径，解析不出一律 undefined', () => {
    expect(permissionTargetOf('write_file', { path: 'D:\\p\\a.txt' })).toBe('D:\\p\\a.txt')
    expect(permissionTargetOf('open_path', { target: 'D:\\p' })).toBe('D:\\p')
    expect(permissionTargetOf('run_command', { command: 'ls', cwd: 'D:\\p' })).toBe('D:\\p')
    // 缺字段 / 非字符串 / 空白 / 入参不是对象 → undefined（调用方按"越界"处理）
    expect(permissionTargetOf('run_command', { command: 'ls' })).toBeUndefined()
    expect(permissionTargetOf('write_file', { path: 42 })).toBeUndefined()
    expect(permissionTargetOf('write_file', { path: '   ' })).toBeUndefined()
    expect(permissionTargetOf('write_file', null)).toBeUndefined()
    expect(permissionTargetOf('write_file', 'D:\\p\\a.txt')).toBeUndefined()
  })

  it('isWithinRoot：分隔符与大小写归一，根为空/无根一律 false', () => {
    expect(isWithinRoot('D:\\proj\\a.txt', 'D:\\proj')).toBe(true)
    expect(isWithinRoot('d:/proj/sub/a.txt', 'D:\\proj')).toBe(true)
    expect(isWithinRoot('D:\\proj', 'D:\\proj')).toBe(true)
    // 前缀相同的兄弟目录不算根内（`D:\proj2` 不在 `D:\proj` 里）
    expect(isWithinRoot('D:\\proj2\\a.txt', 'D:\\proj')).toBe(false)
    // 穿越不在这里判（port 层的 realpath 负责），但字符串形态明显越界的必须 false
    expect(isWithinRoot('D:\\other\\a.txt', 'D:\\proj')).toBe(false)
    expect(isWithinRoot('D:\\proj\\..\\other\\a.txt', 'D:\\proj')).toBe(false)
    expect(isWithinRoot('D:\\proj\\a.txt', undefined)).toBe(false)
    expect(isWithinRoot(undefined, 'D:\\proj')).toBe(false)
    expect(isWithinRoot('D:\\proj\\a.txt', '')).toBe(false)
  })
})
