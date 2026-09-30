/**
 * 「跟随最新」滚动（对话 / 日志类列表的自动滚到底）—— **Vue 薄壳**。
 *
 * 语义与判定逻辑全在 `stickToBottomCore.ts`（纯逻辑、零 DOM，可被 vitest 的 node 环境直接收单测）；
 * 这里只做浏览器侧的事：
 *
 * 1. **找滚动容器**：从内容根**向上**找第一个 `overflow-y: auto|scroll|overlay` 的祖先。
 *    交互窗的滚动容器是窗口自己的 `.thread`，`MessageList` 只是它的内容 —— 不要求调用方传 ref，
 *    窗口模板结构不用动。
 * 2. **接事件源**，并把"人真的在滚"与"读数变了"严格分开（`onScroll` vs `onUserScrollIntent`）：
 *    - `scroll`：读数可能变了。**程序自己滚出来的 scroll 事件也走这条**，
 *      所以它绝不能改变跟随状态 —— 旧实现正是在这里用「距底 > 24px」判定的，
 *      一次流式 delta 就能把跟随误关掉，此后所有输出都停在半路（用户报的「跟丢」）。
 *    - `wheel` / 滚条 `pointerdown` / 翻页键：**真实输入**，只有它们能关闭跟随，
 *      且引擎侧还有「实际离底超过阈值」这道正向确认（在底部继续滚滚轮不会误关）；
 *      判定是"当前位置"而不是"上滚还是下滚"，所以用户从历史滚回底部时跟随会恢复。
 *    - `ResizeObserver`（内容根 + 容器）：容器尺寸变化（窗口从隐藏到显示、用户缩放）。
 *    - `visibilitychange` / `focus`：窗口从隐藏恢复可见时 `scrollTop` 可能已被浏览器夹取。
 *    ⚠️ 只监听内容根尺寸是**不够的**：`.thread` 是定高 flex 列、`MessageList` 根节点带
 *    `min-height: 100%`，内容超过一屏后根节点盒子被钉在一屏高、多出来的部分作为**溢出**渲染
 *    —— 元素尺寸不再变化（见 core 文件头与 docs/07 §2.3），所以真正的信号是 DOM 变更。
 * 3. **三层自愈**（2026-09-30「跟丢」修复轮，每一层都对应实测到的真实失效形态）：
 *    ① `rebind()`：内容根 / 容器被 Vue 换掉之后重新解析并**重挂观察者与原生监听**
 *      （`wheel` / 滚条 / 翻页键 / `scroll`）—— 后者一度只写在注释里、实现里漏了，
 *      症状是"换容器之后收不到任何用户意图 = 滚不动"（2026-10-01 补齐）；
 *    ② `MutationObserver` 回调里核对 `isConnected`：盯住的节点已被摘走时立刻重绑；
 *    ③ **心跳兜底**（`startStructureGuard`）：上面两条都失灵时，每帧用两次属性读发现
 *      "内容变高 / 视口被挪"，直接把对齐补上。实测过"观察者既没断开、也没判成脱离文档、
 *      更没抛错，但回调就是不再触发"的形态 —— 纯事件驱动在它面前没有出路。
 */
import { onMounted, onUnmounted, ref } from 'vue'
import type { Ref } from 'vue'
import {
  createStickToBottomCore,
  shouldSnapOnIntent,
  type StickIntentKind,
} from './stickToBottomCore.js'

export interface StickToBottom {
  /** 当前是否处于「跟随最新」状态（`false` = 用户正在翻历史，渲染层据此显示回到最新入口） */
  following: Ref<boolean>
  /** 滚到底（`behavior` 默认瞬时；平滑滚动由调用方在点击入口处显式指定） */
  scrollToBottom: (behavior?: ScrollBehavior) => void
  /** 恢复跟随并滚到底 */
  stick: (behavior?: ScrollBehavior) => void
  /** 重读读数并对齐（窗口从隐藏恢复可见、容器尺寸变化、DOM 结构大改后调用） */
  refresh: () => void
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
 * 这个元素会不会消费上下键 / 空格（输入框、可编辑区、下拉）。
 * 用来把「把光标移进输入框」与「用键盘翻对话历史」分开 —— 前者不该暂停跟随。
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/** 会改变滚动位置、且属于「用户在翻页」的按键 */
const SCROLL_KEYS = new Set([
  'PageUp',
  'PageDown',
  'Home',
  'End',
  'ArrowUp',
  'ArrowDown',
  ' ',
  'Spacebar',
])

/**
 * 「已经贴底」的容差（px）：与引擎的 `threshold` 默认值同口径。
 * 一次真实滚动之后若落在这个范围内且处于跟随态，就把视口精确对齐到底（见 `snapIfNearBottom`）。
 */
const NEAR_BOTTOM_PX = 24

export function useStickToBottom(
  content: () => HTMLElement | null,
  options: StickToBottomOptions = {},
): StickToBottom {
  const following = ref(true)

  /** 观察中的内容根；每次 `rebind()` 之后都指向**当前**文档里的那个节点 */
  let contentEl: HTMLElement | null = null
  /** 上一次解析出的滚动容器；容器随内容根一起重建，所以同样按需重解析 */
  let scroller: HTMLElement | null = null
  let resizeObserver: ResizeObserver | null = null
  let mutationObserver: MutationObserver | null = null
  let core: ReturnType<typeof createStickToBottomCore> | null = null
  let disposed = false
  /** 两个观察者是否已经挂过（首次 `rebind()` 必须绑定，见那里的注释） */
  let observersAttached = false
  /** 心跳兜底：上一次的读数与在途帧（见 `startStructureGuard`） */
  let lastHeartbeatHeight = -1
  let lastHeartbeatTop = -1
  let guardHandle: number | null = null
  /** 引擎要求的 `scroll` 通知（由绑在容器上的原生监听转发） */
  let notifyScroll: (() => void) | null = null
  /** 引擎要求的"尺寸变化"通知（由 `rebind()` 里的 ResizeObserver 转发） */
  let notifyResize: (() => void) | null = null
  /**
   * 引擎给过来的「真实用户输入」回调。
   *
   * 存下来是为了 `rebind()`：滚动容器换掉之后原生监听必须重挂，而重挂需要这个回调 ——
   * 引擎的端口只在 `start()` 那一次被消费，之后拿不到第二次。
   * `wheelDeltaY` 只由 wheel 监听提供（其余 kind 为 `undefined`），供吸底补齐判方向。
   */
  let intentCallback: ((kind: StickIntentKind, wheelDeltaY?: number) => void) | null = null
  /**
   * 绑定在"滚动容器 / 窗口"上的原生监听。
   *
   * 之所以单列：容器会被 `rebind()` 换掉，而引擎创建时的订阅端口已经"用过"了 ——
   * 重新挂监听是这一层的事，卸载时统一收口（`onUnmounted`）。
   */
  const nativeSubscriptions: Array<() => void> = []

  /** 把引擎的跟随状态同步进 `ref`（引擎是唯一权威，渲染层只读它渲染「回到最新」入口） */
  function sync(): void {
    if (core === null) return
    const value = core.isFollowing()
    if (following.value !== value) following.value = value
  }

  /** 从内容根向上找滚动容器（找不到就返回 null，调用方静默降级：不滚动、不报错） */
  function findScroller(from: HTMLElement): HTMLElement | null {
    let node: HTMLElement | null = from.parentElement
    while (node !== null) {
      if (isScrollable(node)) return node
      node = node.parentElement
    }
    return null
  }

  /**
   * 引擎与渲染层共用的「当前滚动容器」：**现查**，不用缓存引用。
   *
   * 缓存过的引用会在 DOM 被重建后变成死节点（读数冻结、写 `scrollTop` 无效），
   * 而这类失效在界面上与"跟随被关掉"长得一模一样。现查的代价只是几次 `parentElement` 上溯。
   */
  function resolveScroller(): HTMLElement | null {
    const live = content()
    if (live === null) return scroller
    const found = findScroller(live)
    if (found !== null) scroller = found
    return found ?? scroller
  }

  /**
   * 跟随中且已经贴底（离底 ≤ 阈值）时，把视口精确对齐到底。
   *
   * 幂等、零成本（跟随态 + 已贴底才写）；用户离底时不动任何东西。
   */
  function snapIfNearBottom(): void {
    if (core === null || !core.isFollowing()) return
    const target = resolveScroller()
    if (target === null) return
    const distance = target.scrollHeight - target.scrollTop - target.clientHeight
    if (distance <= 0 || distance > NEAR_BOTTOM_PX) return
    target.scrollTo({ top: target.scrollHeight })
  }

  /**
   * 重新解析内容根与滚动容器，并把两个观察者挂到**新**节点上。
   *
   * 触发场景：`MessageList` 的根节点被 Vue 重建、窗口结构变化、以及"观察者静默挂在
   * 已脱离文档的旧节点上"这种自愈场景。引擎本身不用重建 —— 它的读数与写入都是**现查**
   * （见 `resolveScroller`），换掉这两个引用就等于换了数据源。
   */
  function rebind(): void {
    if (disposed) return
    const next = content()
    if (next === null) return
    const changed =
      observersAttached === false ||
      next !== contentEl ||
      scroller === null ||
      !scroller.isConnected ||
      !contentEl.isConnected
    contentEl = next
    scroller = findScroller(next)
    // ⚠️ 首次必须绑定：`observersAttached` 这个标记不能省 —— 挂载时 `contentEl` 刚被赋成
    // 同一个节点，只比对引用会判成"没变化"直接返回，于是**观察者一次都没挂上**
    //（2026-09-30 实测：`mutations` 恒为 0、此后 DOM 变更全收不到、滚动冻在那一刻）。
    if (!changed) return
    // 闭包里用常量而不是可变的 `contentEl`：观察者只管**这一次**绑定的那个节点，
    // 之后换节点是新开一个观察者（见上面 `disconnect()`），局部常量让这条语义更清楚。
    const observed = next
    resizeObserver?.disconnect()
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        notifyResize?.()
        core?.onMutated()
      })
      resizeObserver.observe(observed)
      if (scroller !== null) resizeObserver.observe(scroller)
    }
    mutationObserver?.disconnect()
    mutationObserver = new MutationObserver(() => {
      if (disposed) return
      // 观察的节点还活着吗？（脱离文档的节点永远不触发，也不会报错）
      if (observed.isConnected) {
        core?.onMutated()
        return
      }
      // 节点已被换掉：重新解析后再滚一次，这一轮的内容变更不丢
      rebind()
      core?.onMutated()
    })
    mutationObserver.observe(observed, { childList: true, characterData: true, subtree: true })
    observersAttached = true
    // 换容器必须连**原生监听**一起换（2026-10-01 补）：引擎的 `onUserScrollIntent` 端口只在
    // `core.start()` 那一次被消费，之后没有任何人会替我们重挂 —— 漏掉这一步的症状是
    // 「换了容器之后再也没人收得到用户意图」（wheel / 滚条 / 翻页键全哑），从界面上看就是
    // 「滚不动了」，而观察者、心跳、读数都还是好的，属于最难从现象反推的一类失效。
    // 这里与 `bindScroller` 的注释（「每次 `rebind()` 都重新挂一遍」）对齐 —— 那句话
    // 一直是**注释写了、实现漏了**（2026-09-30 就写在文档里，直到 2026-10-01 才补上实现）。
    if (intentCallback !== null) bindScroller(intentCallback)
    core?.refresh()
  }

  /**
   * 把原生监听挂到**当时的**滚动容器上。
   *
   * `wheel` / `pointerdown` / `keydown` 每次 `rebind()` 都重新挂一遍（旧的那条在
   * `nativeSubscriptions` 里收口）；`scroll` 这条转发给引擎 —— 引擎的订阅端口在
   * `createStickToBottomCore` 时就被消费掉了，之后换容器只能由这一层负责。
   *
   * ⚠️ 重挂的触发权在 `rebind()` 手里（它拿 `intentCallback` 再调一次这里）：这个函数
   * **不能**自己去订阅端口 —— 端口是"一次消费"的，第二次订阅拿不到回调。
   */
  function bindScroller(callback: (kind: StickIntentKind, wheelDeltaY?: number) => void): void {
    for (const unsubscribe of nativeSubscriptions.splice(0)) unsubscribe()
    const target = scroller
    if (target === null) return
    const onScroll = (): void => notifyScroll?.()
    // 滚轮：只认纵向（触控板横扫与对话区滚动无关）；方向交给吸底补齐判（见 onUserIntent）
    const wheel = (event: WheelEvent): void => {
      if (Math.abs(event.deltaY) < Math.abs(event.deltaX)) return
      callback('wheel', event.deltaY)
    }
    // 滚条拖拽：`clientX > clientWidth` 就是滚动条那条缝（本仓 `::-webkit-scrollbar`
    // 是 overlay 风格的 8px，不计入 `clientWidth`）
    const pointerDown = (event: PointerEvent): void => {
      if (event.clientX <= target.clientWidth) return
      callback('pointer')
    }
    const pointerUp = (event: PointerEvent): void => {
      if (event.clientX <= target.clientWidth) return
      // 拖动结束：位置可能刚落到阈值内，用一次意图重新判定（也可能恢复跟随）
      callback('pointer-release')
    }
    // 翻页键：焦点在输入框里时不算（那是在编辑正文，不是在翻历史）
    const keydown = (event: KeyboardEvent): void => {
      if (isEditableTarget(event.target) || !SCROLL_KEYS.has(event.key)) return
      callback('key')
    }
    target.addEventListener('scroll', onScroll, { passive: true })
    target.addEventListener('wheel', wheel, { passive: true })
    target.addEventListener('pointerdown', pointerDown, { passive: true })
    target.addEventListener('pointerup', pointerUp, { passive: true })
    target.addEventListener('keydown', keydown)
    nativeSubscriptions.push(() => {
      target.removeEventListener('scroll', onScroll)
      target.removeEventListener('wheel', wheel)
      target.removeEventListener('pointerdown', pointerDown)
      target.removeEventListener('pointerup', pointerUp)
      target.removeEventListener('keydown', keydown)
    })
  }

  /**
   * 结构巡检 + **心跳兜底**（「跟丢」的最后一道防线）。
   *
   * 2026-09-30 实测到的形态：`MutationObserver` 的回调**会停**。同一节点上另挂一个独立观察者
   * 能收到全部变更（实测 6/6），而应用自己那个既没被 `disconnect`、也没被判成脱离文档、
   * 更没有抛错 —— 信号就是不到。此时界面的样子是：内容一直在长、滚动条冻在那一刻。
   * 纯事件驱动在这一类失灵面前没有出路，所以这里再加一条**廉价心跳**：
   * 每帧只做两次属性读（布局已缓存时是常数级），发现内容变高就补一次对齐，
   * 于是"无论事件层怎么失灵，下一帧都会自我纠正"。
   *
   * ⚠️ **用户接管后心跳必须彻底安静**（这条踩过）：`scrollTop` 被用户改小也是"读数变了"，
   * 若无条件认作"内容变更"，就会给引擎排一帧 —— 那一帧读到「离底很远」，
   * 转身就把刚由 user intent 判定过的状态翻回"暂停"，于是**每一次用户滚动都会把跟随关掉**
   *（2026-09-30 实测：`chat.png` 的"程序化改小不得关闭跟随"与 burst 的持续跟随同时 FAIL）。
   * 所以：跟随态下才把 `scrollTop` 的变化当作内容变更；接管态下只更新基准。
   *
   * 顺带承担结构校对：引擎读到的容器必须是内容根当下的真实祖先，错位就重新绑定。
   */
  function startStructureGuard(): void {
    const step = (): void => {
      if (disposed) return
      guardHandle = window.requestAnimationFrame(step)
      const live = content()
      if (live === null) return
      const candidate = findScroller(live)
      if (!live.isConnected || candidate === null || candidate !== scroller) {
        rebind()
        return
      }
      const height = candidate.scrollHeight
      const top = candidate.scrollTop
      const heightChanged = height !== lastHeartbeatHeight
      const topChanged = top !== lastHeartbeatTop
      lastHeartbeatHeight = height
      lastHeartbeatTop = top
      // 接管态下用户自己滚出来的 `scrollTop` 变化不是"内容变更"：只更新基准、不驱动引擎
      const following = core?.isFollowing() ?? true
      if (!heightChanged && !(topChanged && following)) return
      core?.onMutated()
    }
    guardHandle = window.requestAnimationFrame(step)
  }

  onMounted(() => {
    const initial = content()
    if (initial === null) return
    contentEl = initial
    scroller = findScroller(initial)

    core = createStickToBottomCore({
      /**
       * 读数**每次都按 DOM 现查**：不直接用闭包里的 `scroller`，而是从内容根重新解析一次
       * —— 引擎的读数是整条跟随链的地基，它必须永远来自"此刻文档里的那个容器"，
       * 而不是某个可能已被换掉的引用。结构没变时这一步只是一次 `parentElement` 上溯。
       */
      getMetrics: () => {
        const resolved = resolveScroller()
        return {
          scrollHeight: resolved?.scrollHeight ?? 0,
          scrollTop: resolved?.scrollTop ?? 0,
          clientHeight: resolved?.clientHeight ?? 0,
        }
      },
      scrollTo: (top) => {
        // 同上：现查滚动容器，绝不对着已脱离文档的旧节点写 scrollTop
        resolveScroller()?.scrollTo({ top })
      },
      requestFrame: (callback) => window.requestAnimationFrame(callback),
      cancelFrame: (handle) => window.cancelAnimationFrame(handle),
      // 状态变化主动上报：引擎内部有三处会改它，靠渲染层轮询去同步既浪费又容易漏
      onFollowingChange: (value) => {
        following.value = value
      },
      ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
      events: {
        onScroll: (callback) => {
          notifyScroll = callback
          return () => {
            notifyScroll = null
          }
        },
        onUserScrollIntent: (callback) => {
          // 用户意图的统一入口（**只有真实输入会走到这里**）。引擎先开窗判定
          // （见 core 文件头 ①′），渲染层随后做自己的收尾 —— 跟随 ref 同步 +
          // **方向感知的吸底补齐**（`shouldSnapOnIntent`，2026-10-01 收窄）：
          // 引擎在「接管态」下不写 `scrollTop`，用户把滚动拖回底部、意图把跟随接回来之后，
          // 视口可能停在离底一小步处 —— 这条链由释放 / 向下滚轮之后的一次补齐闭合。
          // **向上滚轮绝不补**：输入到达那一刻读数还是"贴底"（合成器还没挪视口），
          // 无差别补齐等于把每次上滚预先吸回去，小步长滚轮逐次被吞（用户实测「无法用
          // 滚轮滚动」的根因之一）。
          // ⚠️⚠️ 这层包装**必须存在**：2026-09-30 的版本把意图直接喂给引擎，渲染层的
          // 收尾（含吸底补齐）是没人调用的死代码 —— lint 不在日常验证循环里，一直没暴露。
          // `rebind()` 重挂原生监听时拿的也是这个包装（`intentCallback`）。
          intentCallback = (kind, wheelDeltaY) => {
            callback(kind)
            sync()
            if (shouldSnapOnIntent(kind, wheelDeltaY)) snapIfNearBottom()
          }
          bindScroller(intentCallback)
          return () => {
            intentCallback = null
            for (const unsubscribe of nativeSubscriptions.splice(0)) unsubscribe()
          }
        },
        onTransitionEnd: (callback) => {
          const target = contentEl
          const listener = (): void => callback()
          target?.addEventListener('transitionend', listener)
          return () => target?.removeEventListener('transitionend', listener)
        },
        onResize: (callback) => {
          notifyResize = callback
          return () => {
            notifyResize = null
          }
        },
        onVisibility: (callback) => {
          const listener = (): void => {
            if (document.hidden === true) return
            callback()
          }
          document.addEventListener('visibilitychange', listener)
          window.addEventListener('focus', listener)
          return () => {
            document.removeEventListener('visibilitychange', listener)
            window.removeEventListener('focus', listener)
          }
        },
      },
    })

    // `transitionend` 与 `scroll` 的订阅挂在**创建时**的节点上；内容根被重建时这两条会失联 ——
    // 重建后真正兜住跟随的是 `rebind()` 的观察者与心跳巡检，不必为它们再写一套重挂逻辑。
    rebind()
    core.start()
    startStructureGuard()
    sync()
    // 挂载即定位到底（历史水合后打开会话不该停在顶部）
    core.stick()
    sync()
  })

  onUnmounted(() => {
    disposed = true
    core?.cancel()
    core = null
    if (guardHandle !== null) window.cancelAnimationFrame(guardHandle)
    guardHandle = null
    mutationObserver?.disconnect()
    mutationObserver = null
    resizeObserver?.disconnect()
    resizeObserver = null
    for (const unsubscribe of nativeSubscriptions.splice(0)) unsubscribe()
    contentEl = null
    scroller = null
  })

  function scrollToBottom(behavior: ScrollBehavior = 'auto'): void {
    const target = resolveScroller()
    if (target === null) return
    target.scrollTo({ top: target.scrollHeight, behavior })
  }

  function stick(behavior: ScrollBehavior = 'auto'): void {
    // 顺序要紧：先让引擎接管（它会在下一帧持续纠正），再按调用方要求的动效滚一次。
    // 平滑滚动由浏览器插值、会被随后的写入打断 —— 所以只在调用方显式要求时用它。
    core?.stick()
    sync()
    if (behavior !== 'auto') scrollToBottom(behavior)
  }

  function refresh(): void {
    rebind()
    core?.refresh()
    sync()
  }

  return { following, scrollToBottom, stick, refresh }
}
