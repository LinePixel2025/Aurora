/**
 * 实测高度的展开 / 收起（配合全局 `.collapse-*` 过渡类使用，口径见 docs/07 §2.3 / §5.2）。
 *
 * 背景：全局 `.collapse-*` 用 `max-height` 做动画，**终点**决定观感。此前写死 `70vh`，
 * 而可见高度是 `min(内容高, max-height)` —— 展开体的真实内容只有约 140px（工具卡）
 * 与 220px（思考块），对 504px 的终点做动画时，全部可见位移被挤在时间轴的前一小段：
 * 展开表现为「飞快长满、然后空转」，收起表现为「先空转、末尾猛缩」，看起来就是乱跳。
 *
 * 这里只做一件事：在过渡**开始之前**把元素的内容高度写进 `--collapse-h`，
 * 让 `.collapse-enter-to` / `.collapse-leave-from` 的终点变成实测值。
 * 时序上是安全的：`before-enter` / `before-leave` 都在过渡类挂上之前触发，
 * 此时 `scrollHeight` 量到的就是内容的真实高度（`max-height: 0` 不会改变 `scrollHeight`）。
 *
 * 为什么用 CSS 变量，而不是直接动画 `height`：
 * - 不必在结束后把内联高度复位成 `auto` —— `after-enter` 一旦早于过渡结束就触发，
 *   元素会当场跳到全高，比原来的曲线更跳；
 * - 内容在动画期间继续长高（思考块正在流式就是这个场景）也不会被写死的高度截住；
 * - **没挂钩子的使用点自动回落 `70vh`**，与改前的行为逐字一致，因此可以逐个接线、
 *   不存在「CSS 改了但模板还没接」的破损中间态。
 *
 * 用法（两个事件必须成对挂上，只挂一个会得到「一个方向实测、另一个方向还是 70vh」）：
 * ```html
 * <script setup>
 * const { beforeEnter, beforeLeave } = useCollapseTransition()
 * </script>
 * <template>
 *   <Transition name="collapse" @before-enter="beforeEnter" @before-leave="beforeLeave">
 * ```
 */
export interface CollapseTransitionHooks {
  /** Vue `<Transition>` 的进入钩子：量出内容高度写进 `--collapse-h` */
  beforeEnter: (element: Element) => void
  /** Vue `<Transition>` 的离开钩子：同上（离开时元素还在自然高度，量到的是内容高度） */
  beforeLeave: (element: Element) => void
}

export function useCollapseTransition(): CollapseTransitionHooks {
  function measure(element: Element): void {
    if (!(element instanceof HTMLElement)) return
    element.style.setProperty('--collapse-h', `${element.scrollHeight}px`)
  }

  return { beforeEnter: measure, beforeLeave: measure }
}
