/**
 * 全局快捷键（docs/07 §5、docs/08 §1 `general.hotkey`）。
 *
 * 唯一职责：把设置里的快捷键字符串注册成系统级热键，并在改绑 / 冲突时如实上报状态。
 * Electron 能力通过注入的 `HotkeyPort` 提供，`HotkeyManager` 本身不 import electron，
 * 因此可以在 Node 里单测「格式化 / 冲突 / 改绑」的全部逻辑。
 *
 * ⚠️ 默认值 `Alt+Space` 在 Windows 上是**系统窗口菜单键**，被系统占用的概率很高。
 * 这不是 bug，而是预期路径：注册失败必须让用户在设置页看得到，并给出可操作的替代说法，
 * 因此 `register()` 的返回值被翻译成 `HotkeyStatus.message` 而不是静默忽略。
 */
import type { HotkeyStatus, Logger } from '@aurora/shared'

/**
 * Electron `globalShortcut` 的最小面（结构化契约，便于单测注入假实现）。
 * 返回值与 Electron 一致：`false` 表示被系统或其他程序占用。
 */
export interface HotkeyPort {
  register(accelerator: string, handler: () => void): boolean
  unregister(accelerator: string): void
  /** 退出时清空所有已注册热键（`globalShortcut.unregisterAll`） */
  unregisterAll(): void
}

export interface HotkeyManagerOptions {
  port: HotkeyPort
  /** 热键按下时的动作（主进程注入：切换服务窗显隐） */
  onTrigger: () => void
  logger: Logger
}

export class HotkeyManager {
  private readonly options: HotkeyManagerOptions
  /** 当前已成功注册的 accelerator；`undefined` 表示未注册 */
  private current: string | undefined
  private status: HotkeyStatus = { hotkey: '', registered: false }
  private readonly listeners = new Set<(status: HotkeyStatus) => void>()

  constructor(options: HotkeyManagerOptions) {
    this.options = options
  }

  getStatus(): HotkeyStatus {
    return { ...this.status }
  }

  onChange(listener: (status: HotkeyStatus) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 应用期望的快捷键（幂等）。
   *
   * 与当前已注册值相同时直接返回，避免每次设置变更都触发一次
   * unregister + register —— 那会在极短窗口内让热键失效，也会放大冲突概率。
   */
  apply(hotkey: string): HotkeyStatus {
    const desired = hotkey.trim()
    if (desired === this.current) {
      // 值没变，但仍要保证 status.hotkey 与设置一致（首次注册失败后再次 apply 同一值）
      if (this.status.hotkey !== desired) {
        this.status = { ...this.status, hotkey: desired }
        this.emit()
      }
      return this.getStatus()
    }

    this.unregisterCurrent()

    if (desired === '') {
      this.status = { hotkey: '', registered: false, message: '未设置快捷键' }
      this.emit()
      return this.getStatus()
    }

    if (invalidReason(desired) !== undefined) {
      this.status = { hotkey: desired, registered: false, message: invalidReason(desired) }
      this.options.logger.warn('快捷键格式非法，未注册', { hotkey: desired })
      this.emit()
      return this.getStatus()
    }

    let registered = false
    try {
      registered = this.options.port.register(desired, this.options.onTrigger)
    } catch (error) {
      this.options.logger.warn('快捷键注册抛错', { hotkey: desired, error: String(error) })
      registered = false
    }

    if (registered) {
      this.current = desired
      this.status = { hotkey: desired, registered: true }
      this.options.logger.info('全局快捷键已注册', { hotkey: desired })
    } else {
      this.status = {
        hotkey: desired,
        registered: false,
        message: conflictMessage(desired),
      }
      this.options.logger.warn('全局快捷键注册失败（可能被系统或其他程序占用）', {
        hotkey: desired,
      })
    }
    this.emit()
    return this.getStatus()
  }

  /** 注销当前热键（退出、或临时停用时调用）。 */
  release(): void {
    this.unregisterCurrent()
    this.status = { ...this.status, registered: false }
    this.emit()
  }

  /** 退出前调用：注销本管理器注册的热键并清空全局注册表。 */
  dispose(): void {
    this.unregisterCurrent()
    try {
      this.options.port.unregisterAll()
    } catch (error) {
      this.options.logger.debug('清空全局快捷键失败', { error: String(error) })
    }
    this.status = { ...this.status, registered: false }
    // 与 release() 一致地推送：设置页可能仍开着，状态应与实际注册情况相符
    this.emit()
  }

  private unregisterCurrent(): void {
    if (this.current === undefined) return
    try {
      this.options.port.unregister(this.current)
    } catch (error) {
      this.options.logger.debug('注销快捷键失败', { hotkey: this.current, error: String(error) })
    }
    this.current = undefined
  }

  private emit(): void {
    const snapshot = this.getStatus()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        this.options.logger.warn('快捷键状态监听器抛错', { error: String(error) })
      }
    }
  }
}

/**
 * Electron accelerator 的宽松校验。
 *
 * 不做完整语法解析（Electron 自会拒绝非法值），只挡两类明显笔误：
 * 空串（已在调用方处理）与不含修饰键的裸字母 —— 后者会**吞掉全局按键**，
 * 属于用户误操作，必须当场拒绝而不是注册成功再让全系统失能。
 */
export function invalidReason(accelerator: string): string | undefined {
  if (accelerator.trim() === '') return '快捷键为空'
  const parts = accelerator.split('+').map((part) => part.trim())
  if (parts.some((part) => part === '')) return '快捷键格式非法（存在空的键位段）'

  const modifiers = new Set([
    'Command',
    'Cmd',
    'Control',
    'Ctrl',
    'CommandOrControl',
    'CmdOrCtrl',
    'Alt',
    'Option',
    'AltGr',
    'Shift',
    'Super',
    'Meta',
  ])
  const hasModifier = parts.some((part) => modifiers.has(part))
  if (!hasModifier) return '快捷键必须包含修饰键（Ctrl / Alt / Shift / Super）'
  return undefined
}

/**
 * 注册失败文案。Alt+Space 需要额外解释：它是 Windows 的系统窗口菜单键，
 * 报「被占用」时如果不说明，用户只会以为 Aurora 坏了。
 */
export function conflictMessage(accelerator: string): string {
  if (accelerator.trim().toLowerCase() === 'alt+space') {
    return 'Alt+Space 是 Windows 系统窗口菜单键，通常已被系统占用；请在下方改为其他组合（如 Ctrl+Alt+A）'
  }
  return '该快捷键已被系统或其他程序占用，请换一个组合'
}
