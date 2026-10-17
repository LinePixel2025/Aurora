/**
 * 输入卡浮层的横向定位（2026-10-18，桌面与 Center Web 共用）。
 *
 * 浮层的锚点仍是整张 `.composer-box`（`position: relative`）：底边贴在卡片上方 6px，
 * 这样永远不会盖住工具行 / 卡内缩略图。横向则**贴住触发它的那枚按钮**，而不是固定
 * `left: 0` —— 用户口径「弹出的弹窗应该在对应按钮的上方，而不是固定左边」。
 *
 * 纯数值函数（不碰 DOM），两端各自把 `getBoundingClientRect()` / `clientWidth` 读进来：
 * - `triggerLeft` / `boxLeft` 是视口坐标，差值就是触发按钮相对卡片的横坐标；
 * - 减去 `boxClientLeft`（卡片左边框）才与 CSS `left` 的定位基准（padding box）一致；
 * - 右缘按实际可用宽度夹取：320px 的浮层在窄卡上会变成卡宽，`left` 不能为负或越界。
 */
export function clampComposerFlyoutLeft(input: {
  triggerLeft: number
  boxLeft: number
  boxClientLeft: number
  boxClientWidth: number
  flyoutWidth: number
}): number {
  const boxWidth = Math.max(0, input.boxClientWidth)
  const width = Math.min(Math.max(0, input.flyoutWidth), boxWidth)
  const raw = input.triggerLeft - input.boxLeft - input.boxClientLeft
  const max = Math.max(0, boxWidth - width)
  return Math.max(0, Math.min(Math.round(raw), max))
}
