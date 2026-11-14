/** 窗口缩放快捷键的纯判定（Electron `before-input-event` 与单测共用）。 */

export type ZoomAction = 'in' | 'out' | 'reset'

/** 全局缩放范围与步长（docs/07 §1）：0.5–3、步长 0.1，复位 1。 */
export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 3
export const ZOOM_STEP = 0.1

/**
 * 下一倍率（纯函数，单测覆盖）：步长 0.1 并 round 到 0.1 防浮点漂移
 * （1.1 + 0.1 这类累加不 round 会漂出 1.2000000000000002），clamp 到 [0.5, 3]。
 */
export function nextZoomFactor(current: number, action: ZoomAction): number {
  if (action === 'reset') return 1
  const base = Number.isFinite(current) ? current : 1
  const next = base + (action === 'in' ? ZOOM_STEP : -ZOOM_STEP)
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 10) / 10))
}

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
