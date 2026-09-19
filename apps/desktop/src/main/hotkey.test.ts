/**
 * 全局快捷键注册逻辑单测（docs/07 §5）。
 *
 * Electron 的 `globalShortcut` 由 `HotkeyPort` 注入，因此这里能覆盖
 * 「改绑 / 冲突 / 格式非法 / 注销」全部路径，并保证**不会因为注册失败就静默**。
 */
import { describe, expect, it, vi } from 'vitest'
import { HotkeyManager, conflictMessage, invalidReason } from './hotkey.js'
import { createMemoryLogger } from '@aurora/shared'

function createPort(registerImpl?: (accelerator: string) => boolean) {
  const registered = new Set<string>()
  return {
    registered,
    unregisterAllCalls: { count: 0 },
    port: {
      register: (accelerator: string, _handler: () => void): boolean => {
        if (registerImpl) {
          const ok = registerImpl(accelerator)
          if (ok) registered.add(accelerator)
          return ok
        }
        // 默认模拟系统行为：同一个组合不能重复注册
        if (registered.has(accelerator)) return false
        registered.add(accelerator)
        return true
      },
      unregister: (accelerator: string): void => {
        registered.delete(accelerator)
      },
      unregisterAll: (): void => {
        registered.clear()
      },
    },
  }
}

describe('HotkeyManager', () => {
  it('注册成功并把状态标为已生效', () => {
    const { port, registered } = createPort()
    const manager = new HotkeyManager({
      port,
      onTrigger: () => undefined,
      logger: createMemoryLogger(),
    })
    const status = manager.apply('Ctrl+Alt+A')
    expect(status.registered).toBe(true)
    expect(status.hotkey).toBe('Ctrl+Alt+A')
    expect(registered.has('Ctrl+Alt+A')).toBe(true)
  })

  it('注册失败（被占用）时保留期望值并给出可操作文案', () => {
    const { port } = createPort(() => false)
    const manager = new HotkeyManager({
      port,
      onTrigger: () => undefined,
      logger: createMemoryLogger(),
    })
    const status = manager.apply('Alt+Space')
    expect(status.registered).toBe(false)
    expect(status.hotkey).toBe('Alt+Space')
    // Alt+Space 是 Windows 系统窗口菜单键，文案必须解释清楚，否则用户只会以为坏了
    expect(status.message).toBe(conflictMessage('Alt+Space'))
    expect(status.message).toContain('Windows')
  })

  it('格式非法（无修饰键）时拒绝注册，避免吞掉全局按键', () => {
    const { port, registered } = createPort()
    const manager = new HotkeyManager({
      port,
      onTrigger: () => undefined,
      logger: createMemoryLogger(),
    })
    const status = manager.apply('F5')
    expect(status.registered).toBe(false)
    expect(status.message).toContain('修饰键')
    expect(registered.size).toBe(0)
  })

  it('改绑时先注销旧组合，再注册新组合', () => {
    const { port, registered } = createPort()
    const manager = new HotkeyManager({
      port,
      onTrigger: () => undefined,
      logger: createMemoryLogger(),
    })
    manager.apply('Ctrl+Alt+A')
    manager.apply('Ctrl+Alt+B')
    expect([...registered]).toEqual(['Ctrl+Alt+B'])
    expect(manager.getStatus().hotkey).toBe('Ctrl+Alt+B')
  })

  it('apply 同一个值不重复注册（避免闪断窗口）', () => {
    const register = vi.fn(() => true)
    const { port } = createPort(register)
    const manager = new HotkeyManager({
      port,
      onTrigger: () => undefined,
      logger: createMemoryLogger(),
    })
    manager.apply('Ctrl+Alt+A')
    manager.apply('Ctrl+Alt+A')
    expect(register).toHaveBeenCalledTimes(1)
  })

  it('首次注册失败后，再次 apply 同一值仍如实回报失败状态', () => {
    const { port } = createPort(() => false)
    const manager = new HotkeyManager({
      port,
      onTrigger: () => undefined,
      logger: createMemoryLogger(),
    })
    manager.apply('Alt+Space')
    const again = manager.apply('Alt+Space')
    expect(again.registered).toBe(false)
    expect(again.hotkey).toBe('Alt+Space')
  })

  it('空值表示不注册，并给出说明', () => {
    const { port } = createPort()
    const manager = new HotkeyManager({
      port,
      onTrigger: () => undefined,
      logger: createMemoryLogger(),
    })
    const status = manager.apply('   ')
    expect(status.registered).toBe(false)
    expect(status.message).toContain('未设置')
  })

  it('注册抛错时降级为失败状态，不向外抛', () => {
    const manager = new HotkeyManager({
      port: {
        register: () => {
          throw new Error('boom')
        },
        unregister: () => undefined,
        unregisterAll: () => undefined,
      },
      onTrigger: () => undefined,
      logger: createMemoryLogger(),
    })
    const status = manager.apply('Ctrl+Alt+A')
    expect(status.registered).toBe(false)
  })

  it('触发时调用注入的动作', () => {
    const { port } = createPort()
    const onTrigger = vi.fn()
    const manager = new HotkeyManager({
      port: {
        register: (accelerator: string, handler: () => void): boolean => {
          port.register(accelerator, handler)
          handler() // 模拟用户按下
          return true
        },
        unregister: port.unregister,
        unregisterAll: port.unregisterAll,
      },
      onTrigger,
      logger: createMemoryLogger(),
    })
    manager.apply('Ctrl+Alt+A')
    expect(onTrigger).toHaveBeenCalledTimes(1)
  })

  it('状态变化会推送，dispose 会注销并清空全局注册表', () => {
    const { port, registered } = createPort()
    const manager = new HotkeyManager({
      port,
      onTrigger: () => undefined,
      logger: createMemoryLogger(),
    })
    const seen: boolean[] = []
    const off = manager.onChange((status) => seen.push(status.registered))
    manager.apply('Ctrl+Alt+A')
    manager.dispose()
    off()
    expect(seen).toEqual([true, false])
    expect(registered.size).toBe(0)
  })
})

describe('invalidReason', () => {
  it('接受常见修饰键写法', () => {
    expect(invalidReason('Alt+Space')).toBeUndefined()
    expect(invalidReason('Ctrl+Shift+A')).toBeUndefined()
    expect(invalidReason('CommandOrControl+Alt+K')).toBeUndefined()
    expect(invalidReason('Super+L')).toBeUndefined()
  })

  it('拒绝空段与纯键位', () => {
    expect(invalidReason('Ctrl++A')).toContain('空')
    expect(invalidReason('A')).toContain('修饰键')
  })
})
