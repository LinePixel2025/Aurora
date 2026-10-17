/**
 * 输入卡浮层的横向位置（2026-10-18，桌面与 Center Web 共用）。
 *
 * 浮层锚在 `.composer-box` 上（`position: relative`），但横向要贴住**触发它的按钮**：
 * 用户口径「弹出的弹窗应该在对应按钮的上方，而不是固定左边」。这里把「读触发按钮 /
 * 卡片矩形 → 调共享夹取函数」这段 DOM 逻辑收在一处，两端组件只传两个 getter。
 *
 * 为什么不在 CSS 里用 `left: var(...)` 写死：按钮在工具行里的位置由 flex 收缩（container
 * query 切 icon-only）决定，只有运行时才读得准；`nextTick` 后量一次、窗口 resize 再量一次即可
 *（浮层打开期间不会自己移动）。
 */
import { nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { clampComposerFlyoutLeft } from '../composerFlyout.js'

export interface ComposerFlyoutLeft {
  /** 相对 `.composer-box` 的 `left`（px），直接绑到浮层的 `:style` */
  left: Ref<number>
  /** 手动重算（切换「来源 / 模型」这类同一组件内的不同触发器时用） */
  update: () => void
}

export function useComposerFlyoutLeft(
  trigger: () => HTMLElement | null,
  open: () => boolean,
): ComposerFlyoutLeft {
  const left = ref(0)
  let listening = false

  const update = (): void => {
    const el = trigger()
    const box = el?.closest('.composer-box') ?? null
    if (el === null || box === null) return
    const triggerRect = el.getBoundingClientRect()
    const boxRect = box.getBoundingClientRect()
    const token = Number.parseFloat(
      getComputedStyle(box).getPropertyValue('--composer-flyout-width'),
    )
    const flyoutWidth = Number.isFinite(token) && token > 0 ? token : 320
    left.value = clampComposerFlyoutLeft({
      triggerLeft: triggerRect.left,
      boxLeft: boxRect.left,
      boxClientLeft: box.clientLeft,
      boxClientWidth: box.clientWidth,
      flyoutWidth,
    })
  }

  const onResize = (): void => update()
  const attach = (): void => {
    if (listening) return
    window.addEventListener('resize', onResize)
    listening = true
  }
  const detach = (): void => {
    if (!listening) return
    window.removeEventListener('resize', onResize)
    listening = false
  }

  watch(
    open,
    async (value) => {
      if (value) {
        await nextTick()
        update()
        attach()
      } else {
        detach()
      }
    },
    { immediate: true },
  )

  onBeforeUnmount(detach)

  return { left, update }
}
