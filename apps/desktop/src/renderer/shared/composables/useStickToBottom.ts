/**
 * 「跟随最新」滚动（对话 / 日志类列表的自动滚底）。
 *
 * 背景：交互窗的**滚动容器是窗口自己的 `.thread`**（`overflow-y: auto`），
 * `MessageList` 只是它的内容；渲染层此前没有任何滚动代码，于是新消息与流式增量
 * 都停在原地、必须用户自己往下拉。
 *
 * 设计取舍：
 * - **滚动容器由内容向上查找**（第一个 `overflow-y: auto|scroll` 的祖先），
 *   不要求调用方传 ref：窗口模板结构不变、`MessageList` 的 props / 插槽契约保持原样。
 * - **三条信号合并到"每帧最多滚一次"**（`schedule()` / `settle()` + `requestAnimationFrame`）：
 *   1. `MutationObserver`（subtree 的 `childList` / `characterData`）—— 新消息、流式文本、
 *      工具卡片都是 DOM 变更，这是**唯一在交互窗里也成立**的信号；
 *   2. `ResizeObserver`（内容根 + 滚动容器）—— 覆盖容器尺寸变化（窗口从隐藏到显示、用户缩放）；
 *   3. `transitionend`（内容根，靠冒泡覆盖全部后代，2026-09 新增）—— 展开 / 收起工具卡与
 *      思考块走的是 CSS `height` 过渡，它在「DOM 变更那一帧」之后**继续**长高或缩短，
 *      前两条信号都收不到；收到信号后由 `settle()` 逐帧核对到高度稳定为止。
 *
 *   ⚠️ **只监听内容元素的高度是不够的**（实测踩过）：交互窗的 `.thread` 是定高 flex 列，
 *   `MessageList` 的根节点带 `min-height: 100%`，内容一旦超过一屏，根节点的盒子就被
 *   钉在一屏高、多出来的部分作为**溢出**渲染 —— 元素尺寸不再变化，`ResizeObserver` 收不到信号
 *   （普通块级容器里的同类列表会跟着长高，看起来正常，所以这个信号本身就不可靠）。
 *   因此必须以 DOM 变更为准。
 * - **用户意图优先**：用户主动上滚（离底部超过 `threshold`）即暂停跟随，
 *   否则回看历史时会被流式输出一次次拽回底部；`stick()` 用来表达"强制回到底部"
 *   （自己发消息 / 点「回到最新」）。
 */
import { onMounted, onUnmounted, ref } from 'vue'
import type { Ref } from 'vue'

export interface StickToBottom {
  /** 当前是否处于「跟随最新」状态（`false` = 用户正在翻历史，渲染层据此显示回到最新入口） */
  following: Ref<boolean>
  /** 滚到底（`behavior` 默认瞬时；平滑滚动由调用方在点击入口处显式指定） */
  scrollToBottom: (behavior?: ScrollBehavior) => void
  /** 恢复跟随并滚到底 */
  stick: (behavior?: ScrollBehavior) => void
}

export interface StickToBottomOptions {
  /** 距底部多少 px 以内仍算「在底部」（默认 24，覆盖亚像素误差与最后一行折行） */
  threshold?: number
}

/** 能滚动的内容祖先：`overflow-y` 为这三个值之一 */
function isScrollable(node: HTMLElement): boolean {
  const overflowY = window.getComputedStyle(node).overflowY
  return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay'
}

/**
 * 高度过渡后「继续跟随」的帧数上限（≈400ms @60fps）。
 * 取在最大时长令牌（350ms）之上，保证过渡结束后还能多跟几帧；
 * 这只是兜底 —— 正常路径由「连续两帧 `scrollHeight` 不变」自终止。
 */
const MAX_SETTLE_FRAMES = 24

export function useStickToBottom(
  content: () => HTMLElement | null,
  options: StickToBottomOptions = {},
): StickToBottom {
  const threshold = options.threshold ?? 24
  const following = ref(true)

  let scroller: HTMLElement | null = null
  let contentEl: HTMLElement | null = null
  let resizeObserver: ResizeObserver | null = null
  let mutationObserver: MutationObserver | null = null
  let frame: number | null = null
  /** 过渡后自终止跟随：已排的帧 / 剩余帧数 / 上一帧的 `scrollHeight` */
  let settleHandle: number | null = null
  let settleFramesLeft = 0
  let settleLastHeight = -1

  /** 距底部的像素距离；容器还没接上时按「在底部」处理 */
  function distanceToBottom(): number {
    if (scroller === null) return 0
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
  }

  /**
   * 用户滚动 → 重新判定是否跟随。
   *
   * 程序触发的滚动（下面 `scrollToBottom`）也会走到这里，但那时距离为 0，
   * 判定结果仍是"跟随"，不会自己把自己关掉。
   */
  function onScroll(): void {
    following.value = distanceToBottom() <= threshold
  }

  function scrollToBottom(behavior: ScrollBehavior = 'auto'): void {
    if (scroller === null) return
    scroller.scrollTo({ top: scroller.scrollHeight, behavior })
  }

  function stick(behavior: ScrollBehavior = 'auto'): void {
    following.value = true
    scrollToBottom(behavior)
  }

  /**
   * 内容或容器变了的统一入口：合并到**下一帧**滚一次。
   *
   * 走 `requestAnimationFrame` 而不是立即滚，有两个原因：
   * 一次流式 delta 会触发多条 MutationObserver 记录，逐条滚是白做功；
   * 且 DOM 变更发生在布局之前，等一帧拿到的 `scrollHeight` 才是最终值。
   */
  function schedule(): void {
    if (frame !== null) return
    frame = window.requestAnimationFrame(() => {
      frame = null
      if (following.value) {
        scrollToBottom()
        return
      }
      // 内容缩到不足一屏（切会话 / 清空 / 收起工具卡片）时没有可滚动的距离，
      // 「回到最新」就没有意义了 —— 恢复跟随，避免按钮永久挂在那里。
      // 注意：用户真的在翻历史时距离远大于阈值，不会被这条误清。
      if (distanceToBottom() <= threshold) following.value = true
    })
  }

  /**
   * 高度过渡结束后继续跟随，直到高度真的不动为止。
   *
   * 为什么需要它：展开 / 收起工具卡与思考块走的是 CSS `height` 过渡，它在「DOM 变更那一帧」
   * 之后**继续**长高或缩短，而 `MutationObserver` / `ResizeObserver` 都收不到（内容根带
   * `min-height: 100%`，尺寸信号本就不可靠，见文件头注释）—— 结果是动画还在动、滚动条已经
   * 停在半路。`transitionend` 只报「某一段过渡结束」，而高度变化可能由多段过渡串联
   * （展开体里还有别的过渡），所以收到信号后**逐帧核对** `scrollHeight`：
   * 只要还在变就继续滚，连续两帧不变即停。
   *
   * 帧数上限是兜底：宁可少跟几帧，也不要留下一个常驻的 rAF 空转。
   * `following` 每帧都重新判断，所以用户在过渡期间上滚接管仍然有效。
   */
  function settle(): void {
    settleFramesLeft = MAX_SETTLE_FRAMES
    if (settleHandle !== null) return
    settleLastHeight = -1
    const step = (): void => {
      settleHandle = null
      if (settleFramesLeft <= 0 || scroller === null) return
      settleFramesLeft -= 1
      const height = scroller.scrollHeight
      const stable = height === settleLastHeight
      settleLastHeight = height
      if (following.value) scrollToBottom()
      if (stable) return
      settleHandle = window.requestAnimationFrame(step)
    }
    settleHandle = window.requestAnimationFrame(step)
  }

  function onTransitionEnd(): void {
    settle()
  }

  function findScroller(): HTMLElement | null {
    let node = content()?.parentElement ?? null
    while (node !== null) {
      if (isScrollable(node)) return node
      node = node.parentElement
    }
    return null
  }

  onMounted(() => {
    contentEl = content()
    scroller = findScroller()
    // 结构以后若改成 `MessageList` 自带滚动容器，这里找不到祖先就静默降级（不滚动、不报错）
    if (contentEl === null || scroller === null) return
    scroller.addEventListener('scroll', onScroll, { passive: true })
    resizeObserver = new ResizeObserver(schedule)
    resizeObserver.observe(contentEl)
    // 容器自身尺寸变化（窗口从隐藏到显示、用户缩放窗口）同样要跟到底
    resizeObserver.observe(scroller)
    mutationObserver = new MutationObserver(schedule)
    mutationObserver.observe(contentEl, { childList: true, characterData: true, subtree: true })
    // 第三条信号：高度过渡的结束瞬间（`transitionend` 会从后代冒泡上来，一次监听覆盖全部子元素）
    contentEl.addEventListener('transitionend', onTransitionEnd)
    scrollToBottom()
  })

  onUnmounted(() => {
    scroller?.removeEventListener('scroll', onScroll)
    contentEl?.removeEventListener('transitionend', onTransitionEnd)
    resizeObserver?.disconnect()
    mutationObserver?.disconnect()
    resizeObserver = null
    mutationObserver = null
    if (frame !== null) window.cancelAnimationFrame(frame)
    frame = null
    if (settleHandle !== null) window.cancelAnimationFrame(settleHandle)
    settleHandle = null
    settleFramesLeft = 0
    contentEl = null
    scroller = null
  })

  return { following, scrollToBottom, stick }
}
