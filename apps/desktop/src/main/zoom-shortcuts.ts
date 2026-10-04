/** 窗口缩放快捷键的纯判定（Electron `before-input-event` 与单测共用）。 */

export type ZoomAction = 'in' | 'out' | 'reset'

export interface ZoomInputLike {
  type: string
  key: string
  code?: string
  control?: boolean
  meta?: boolean
  shift?: boolean
  alt?: boolean
}

/**
 * Windows 键盘上 `Ctrl + 加号` 实际常以 `Ctrl + Shift + =` 到达，
 * 因此不能只匹配 `key === '+'`；同时兼容数字小键盘。
 */
export function zoomActionForInput(input: ZoomInputLike): ZoomAction | undefined {
  if (input.type !== 'keyDown') return undefined
  if ((input.control !== true && input.meta !== true) || input.alt === true) return undefined

  const key = input.key.toLowerCase()
  const code = input.code ?? ''
  if (key === '0' || code === 'Digit0' || code === 'Numpad0') return 'reset'
  if (key === '-' || key === '_' || code === 'Minus' || code === 'NumpadSubtract') return 'out'
  if (
    key === '+' ||
    (key === '=' && input.shift === true) ||
    code === 'Equal' ||
    code === 'NumpadAdd'
  ) {
    return 'in'
  }
  return undefined
}
