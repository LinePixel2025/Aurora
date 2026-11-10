/**
 * 临时对话框窗口几何（docs/14 §5.8）的纯函数。
 *
 * 与 `widget-layout.ts` 同一思路：不 import electron，尺寸夹取 / 居中都可以单测。
 */
import { PLUGIN_DIALOG_DEFAULT_SIZE, PLUGIN_DIALOG_SIZE_LIMITS } from '@aurora/shared'

export interface DialogArea {
  x: number
  y: number
  width: number
  height: number
}

export interface DialogSize {
  width: number
  height: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 清单 `defaultSize` → 实际窗口尺寸：夹到白名单范围，再夹到当前工作区。 */
export function resolveDialogSize(size: DialogSize | undefined, area: DialogArea): DialogSize {
  const width = size?.width ?? PLUGIN_DIALOG_DEFAULT_SIZE.width
  const height = size?.height ?? PLUGIN_DIALOG_DEFAULT_SIZE.height
  return {
    width: clamp(
      width,
      Math.min(PLUGIN_DIALOG_SIZE_LIMITS.minWidth, area.width),
      Math.min(PLUGIN_DIALOG_SIZE_LIMITS.maxWidth, area.width),
    ),
    height: clamp(
      height,
      Math.min(PLUGIN_DIALOG_SIZE_LIMITS.minHeight, area.height),
      Math.min(PLUGIN_DIALOG_SIZE_LIMITS.maxHeight, area.height),
    ),
  }
}

/** 在工作区水平 / 垂直居中（四舍五入到整数像素）。 */
export function centeredDialogBounds(size: DialogSize, area: DialogArea): DialogArea {
  const { width, height } = size
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  }
}
