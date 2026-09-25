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
 * ⚠️ **进入方向必须挂 `@enter`，绝不能挂 `@before-enter`** —— 这是踩过的坑：
 * Vue 的 `beforeEnter` 在元素**插入文档之前**调用（`mountElement` 里
 * `transition.beforeEnter(el)` 先于 `hostInsert(el, …)`），此刻元素是**游离的**，
 * `scrollHeight` 恒为 0。写进去就是 `--collapse-h: 0px`，起点与终点同为 0，
 * 整个 250ms 高度都是 0（只剩 opacity 在变、`overflow: hidden` 把内容全挡住），
 * 过渡类一摘再瞬跳到内容高度 —— 从「先猛长再空转」变成「冻结再瞬跳」，问题没解决反而更糟。
 * `enter` 由 post-render effect 在插入**之后**调用，且 `-enter-to` 还没挂上
 * （类交换在 `nextFrame` 的双 rAF 里），所以在这里写下的终点会被完整地过渡到。
 * 离开方向本来就成立：`beforeLeave` 时元素仍在文档里、而且是稳定布局。
 *
 * ⚠️ **进入方向还要「追」几帧，量一次不够**：`enter` 那一刻的布局未必是稳定布局。
 * 展开体一长高，滚动容器（`.thread`）可能**才**出现纵向滚动条 —— 本项目滚动条是 8px 的
 * 经典样式（`::-webkit-scrollbar { width: 8px }`），**占布局宽度**，于是内容区变窄、
 * 文本多折几行、内容更高（2026-09-26 实测：`enter` 时 401px，稳定后 467px）。
 * 终点停在旧值，过渡结束仍有一次 66px 瞬跳。因此进入方向逐帧重测到稳定为止：
 * CSS 过渡在被改终点时会**从当前值重新向新终点过渡**，视觉上仍是连续的一条曲线。
 * 终点只增不减也保证了单调：`max-height` 只做钳制，**偏高是安全的**（动画提前长满），
 * 偏低才会瞬跳。
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
import { onUnmounted } from 'vue'

/** 进入方向逐帧重测的帧数上限（≈400ms @60fps）：兜底，正常两三帧就收敛 */
const MAX_FOLLOW_FRAMES = 24

export interface CollapseTransitionHooks {
  /** 挂在 `@enter` 上（**不是** `@before-enter`，见上文）：追着布局把终点量到稳定 */
  enter: (element: Element) => void
  /** 挂在 `@before-leave` 上：离开时元素还在自然高度、布局已稳定，量一次就够 */
  beforeLeave: (element: Element) => void
}

export function useCollapseTransition(): CollapseTransitionHooks {
  const frameHandles = new Set<number>()

  /**
   * 量一次并写入变量；返回量到的高度（0 = 还没布局，调用方据此决定是否继续追）。
   * 元素尚未布局（父级 `display:none`、窗口隐藏）时**不写 0** —— 把终点钉成 0
   * 比不写更糟（起点终点同为 0 = 高度不动），宁可让缺省的 `70vh` 兜底。
   */
  function measureOnce(element: HTMLElement): number {
    const height = element.scrollHeight
    if (height <= 0) return 0
    element.style.setProperty('--collapse-h', `${height}px`)
    return height
  }

  function follow(element: Element): void {
    if (!(element instanceof HTMLElement)) return
    const node = element
    let last = -1
    let framesLeft = MAX_FOLLOW_FRAMES
    const step = (): void => {
      framesLeft -= 1
      const height = measureOnce(node)
      const stable = height > 0 && height === last
      last = height
      // 元素已被移出文档（卡片被收起 / 消息被换掉）或量稳了就停 —— 别对游离节点白跑帧
      if (stable || framesLeft <= 0 || !node.isConnected) return
      const handle = window.requestAnimationFrame(() => {
        frameHandles.delete(handle)
        step()
      })
      frameHandles.add(handle)
    }
    step()
  }

  function measure(element: Element): void {
    if (element instanceof HTMLElement) measureOnce(element)
  }

  onUnmounted(() => {
    for (const handle of frameHandles) window.cancelAnimationFrame(handle)
    frameHandles.clear()
  })

  return { enter: follow, beforeLeave: measure }
}
