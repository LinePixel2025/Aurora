/**
 * 实测高度的展开 / 收起（配合全局 `.collapse-*` 过渡类使用，口径见 docs/07 §2.3 / §5.2）。
 *
 * 背景：全局 `.collapse-*` 用 `max-height` 做动画，**终点**决定观感。此前写死 `70vh`，
 * 而可见高度是 `min(内容高, max-height)` —— 展开体的真实内容只有约 140px（工具卡）
 * 与 220px（思考块），对 504px 的终点做动画时，全部可见位移被挤在时间轴的前一小段：
 * 展开表现为「飞快长满、然后空转」，收起表现为「先空转、末尾猛缩」，看起来就是乱跳。
 *
 * 这里做的事：把元素的内容高度写进 `--collapse-h`，让 `.collapse-enter-to` /
 * `.collapse-leave-from` 的终点变成实测值。
 *
 * ⚠️ **进入方向必须挂 `@enter`，绝不能挂 `@before-enter`**：Vue 的 `beforeEnter` 在元素
 * **插入文档之前**调用（`mountElement` 里 `transition.beforeEnter(el)` 先于 `hostInsert(el, …)`），
 * 此刻元素是**游离的**、`scrollHeight` 恒为 0。写进去就是 `--collapse-h: 0px`，
 * 起点与终点同为 0，整个 250ms 高度都不动，过渡类一摘再瞬跳到内容高度。
 * `enter` 由 post-render effect 在插入**之后**调用，且 `-enter-to` 还没挂上
 * （类交换在 `nextFrame` 的双 rAF 里），所以在这里写下的终点会被完整地过渡到。
 *
 * ⚠️ **量之前必须把钳制临时摘掉**（本文件最容易写错的一处）：进入/离开的过渡类本身带着
 * `max-height: 0`（或等于当前终点），而展开体常常是 `display: flex; flex-direction: column`
 * 的列容器 —— 容器高度被钳住时 flex 会压缩**可收缩的子项**：唯一的滚动容器子项
 * （工具卡的 `.tool-args`，`overflow: auto`）的自动最小尺寸解析为 **0**，于是它从 79px 被压到
 * 13px，量出来比真实内容矮 66px（2026-09-26 实测 401 vs 467）。
 * 这个偏差在整个过渡期间**恒定不变**，所以「逐帧轮询直到连续两帧相等」也追不到它 ——
 * 松钳（Vue 摘掉过渡类）那一刻真实高度才会跳出来。因此这里在量之前把元素的内联
 * `max-height` 临时设成 `none`、量完立刻还原：两步在同一个 task 内完成、中间不落帧，视觉不闪。
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
 * const { enter, beforeLeave } = useCollapseTransition()
 * </script>
 * <template>
 *   <Transition name="collapse" @enter="enter" @before-leave="beforeLeave">
 * ```
 */
export interface CollapseTransitionHooks {
  /** 挂在 `@enter` 上（**不是** `@before-enter`，见上文） */
  enter: (element: Element) => void
  /** 挂在 `@before-leave` 上（此时元素仍在文档、布局已稳定，量一次就够） */
  beforeLeave: (element: Element) => void
}

export function useCollapseTransition(): CollapseTransitionHooks {
  /**
   * 量一次内容高度并写入 `--collapse-h`；返回量到的高度（0 = 还没布局）。
   *
   * 元素尚未布局（父级 `display:none`、窗口隐藏）时**不写 0** —— 把终点钉成 0
   * 比不写更糟（起点终点同为 0 = 高度不动），宁可让缺省的 `70vh` 兜底。
   */
  function measure(element: Element): void {
    if (!(element instanceof HTMLElement)) return
    const node = element

    // 摘钳制 → 量 → 还原，全部在同一个 task 内（中间不落帧，所以不会闪一下）
    const previous = node.style.maxHeight
    node.style.maxHeight = 'none'
    const height = node.scrollHeight
    if (previous === '') node.style.removeProperty('max-height')
    else node.style.maxHeight = previous

    if (height <= 0) return
    node.style.setProperty('--collapse-h', `${height}px`)
  }

  return { enter: measure, beforeLeave: measure }
}
