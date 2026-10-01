/**
 * 「跟随最新」（自动滚到底）的**纯逻辑核心**。
 *
 * 为什么单独抽出来：滚动跟随的 bug 几乎全是**时序语义**类的（谁在什么时候改了跟随状态），
 * 而这类语义用 DOM 与真实滚动条去验最容易假 PASS。这里刻意**零 import、零 DOM**：
 * 读数、滚动、帧调度、事件订阅全部由调用方注入（端口），于是它能被 vitest 的 node 环境
 * 直接收单测（与 `useChatDeltaBuffer.ts` 同一套路，见 vitest.config.ts 的 include 注释）。
 * 浏览器侧的接线与生命周期在 `useStickToBottom.ts`（薄壳）。
 *
 * ───────────────────────── 两条核心语义（改实现时必须逐条保住） ─────────────────────────
 *
 * **① 跟随状态只由"真实用户意图"关闭，绝不由 scroll 事件关闭。**
 * 旧实现把「距底部 > 24px」直接写在 `scroll` 事件里：但 scroll 事件**无法区分**是用户滚的
 * 还是程序自己滚的。一次流式 delta 让内容长高 70px，程序在上一帧写下的 `scrollTop` 此刻
 * 读数就 > 24 —— 于是被误判成"用户接管"，此后所有输出都停在半路（用户报的「跟丢」）。
 * 更糟的是旧实现**没有自愈路径**：一旦被误判成 false，只有用户点「回到最新」或自己发消息才恢复。
 * 现在只有 wheel / 滚条拖拽 / 翻页键这类**真实输入**（`events.onUserScrollIntent`）才被当作
 * 用户意图，且仍需「实际距底 > threshold」这道**正向确认**才算接管（在底部继续滚滚轮不会误关）。
 *
 * **①′ 但"真实输入"与"读数"之间有一个时间差：窗口期内的读数必须重新判一次。**
 * 合成器线程先滚、主线程后收到输入事件（`passive: true` 的 wheel 尤其如此），输入到达那一刻
 * 读到的**仍是旧位置**：视口本来就贴在底部时，"用户上滚"会被判成"用户还在底部继续滚"，
 * 紧接着浏览器派发的 `scroll` 排出一帧对齐，把这次滚动**原样抹回底部** —— 每一次滚轮都被吞，
 * 界面上就是「模型答完后翻不动历史」（2026-10-01 用户实测）。因此真实输入会开启一个短窗口
 * （`DEFAULT_INTENT_WINDOW_MS`）：**窗口期内**的读数变化按当前位置重新判定跟随；窗口一过，
 * 读数变化退回"内容可能变了"的纯通知语义（①）。判定永远只由真实输入**发起** ——
 * 程序自己滚出来的读数变化开不了这个窗口。
 *
 * **①″ 真实输入窗口期内，对齐帧必须闭嘴。**
 * 窗口（①′）开着的时候，任何在途对齐帧都**不许写 `scrollTop`**：窗口的存在理由就是
 * "输入到达时的读数是旧的，浏览器马上要挪视口"。此刻一帧对齐（`following` 尚未被窗口
 * 重判翻掉）会抢在 `scroll` 之前把视口按回底部 —— 用户的滚动被抹掉，随后到来的 `scroll`
 * 读到的又是"贴底"，窗口重判翻不了案。`stick()`（展开折叠体触发的 `restick`）留下的结算帧
 * 与用户紧接着的上滚正是这样竞速的；小步长输入（触控板 / 高分辨率滚轮，单步 < 阈值）连
 * 重判都判不出去，逐次被吞，体感就是「滚轮滚不动」（2026-10-01 用户实测，回归防线
 * `stickToBottomCore.test.ts` 的两条竞速用例）。窗口收口（重判 / 过期）后对齐恢复常规语义。
 *
 * **② 内容变高后必须自愈到"真的到底"。**
 * `scrollTop = scrollHeight - clientHeight` 用的是**写那一刻**的读数：DOM 变更发生在布局之前，
 * 同一帧里内容可能又长了一截（一次 markdown 块 / 一张工具卡 70–500px）。因此每帧对齐后
 * **再校验一次读数**，仍有偏差就补帧（最多 `MAX_ALIGN_FRAMES`），而不是像旧实现那样
 * 「连续两帧 scrollHeight 不变就停」—— 那恰好会在内容持续增长时提前收工。
 *
 * 自终止：某帧既没对齐偏差、`scrollHeight` 也与上一帧相同 → 停止排帧；
 * 另有 `maxSettleMs`（缺省 1500ms，`now()` 注入）兜底，绝不留下常驻 rAF 空转。
 */

/** 一帧要读的滚动读数（`scrollTo` 之后重新调用它拿到**新**读数） */
export interface StickMetrics {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}

/** 用户意图的种类（只用来记日志/调试，语义一致：都表示"这是人在滚"） */
export type StickIntentKind = 'wheel' | 'pointer' | 'pointer-release' | 'key'

/**
 * 解除订阅的函数（`onXxx` 的返回值）；**摘订阅必须由订阅方负责**。
 *
 * 这里刻意不要求订阅方实现 off：Vue 的 `onUnmounted`、Electron 窗口销毁都是"进程内一次性的"，
 * 但渲染层组件会反复挂载（切会话、reload 探针），所以每个 `onXxx` 都得把
 * 「怎么摘」交回来，由 `cancel()` 统一调用 —— 不交回来的实现会在卸载后留下悬空订阅。
 */
export type StickUnsubscribe = () => void

/**
 * 事件源端口。**关键分工**：`onScroll` 只提供"读数可能变了"的通知，
 * `onUserScrollIntent` 才表示"人在滚" —— 两者混在一起就是本轮修复前的病根。
 */
export interface StickEvents {
  /**
   * 读数**可能**变了（程序滚动也会触发；真实滚动的 `scroll` 也走这条）。
   *
   * 它本身不表达"人在滚"，只有在 `onUserScrollIntent` 打开的真实输入窗口期内，
   * 才会被当作"人滚出来的位置"用来重判跟随（见文件头 ① / ①′）。
   */
  onScroll: (callback: () => void) => StickUnsubscribe | void
  onUserScrollIntent: (callback: (kind: StickIntentKind) => void) => StickUnsubscribe | void
  onTransitionEnd: (callback: () => void) => StickUnsubscribe | void
  onResize: (callback: () => void) => StickUnsubscribe | void
  onVisibility: (callback: () => void) => StickUnsubscribe | void
  /** 单调时钟（缺省 `Date.now`），只为 `maxSettleMs` 兜底服务 */
  now?: () => number
  /** 跟随循环的最长存活时间（缺省 1500ms）：兜底上限，防常驻 rAF */
  maxSettleMs?: number
}

export interface StickToBottomCoreOptions {
  getMetrics: () => StickMetrics
  scrollTo: (top: number) => void
  requestFrame: (callback: () => void) => number
  cancelFrame: (handle: number) => void
  events: StickEvents
  /**
   * 跟随状态发生变化时回调（只在**真的变了**时触发一次）。
   * 存在的理由：引擎内部有三处会改状态（用户意图关闭、贴底意图恢复、内容缩到不足一屏时恢复），
   * 让调用方每帧轮询 `isFollowing()` 去同步一个 `ref` 既浪费又容易漏 —— 状态变化主动上报更省心。
   */
  onFollowingChange?: (following: boolean) => void
  /** 距底部多少 px 以内仍算「在底部」（缺省 24，与思考块内跟随同口径） */
  threshold?: number
  /**
   * 「真实输入窗口」时长（缺省 250ms，见文件头 ①′）。
   * 只为可测性暴露：单测用注入时钟把它推过期，生产不传。
   */
  intentWindowMs?: number
}

export interface StickToBottomCore {
  /** 当前是否跟随最新（`false` = 用户正在翻历史，界面据此显示「回到最新」入口） */
  isFollowing: () => boolean
  /** 挂上事件订阅（幂等） */
  start: () => void
  /** 停掉跟随循环，**保留**订阅 */
  stop: () => void
  /** 停循环并摘掉全部订阅（组件卸载用） */
  cancel: () => void
  /**
   * **真实用户输入**到达时的重新判定（调用方在 wheel / 滚条拖拽 / 翻页键处调用）。
   *
   * 必须由调用方主动喂进来：程序滚动不产生这些事件，引擎自己**读不到**"人是否在滚"，
   * 这也正是它无法再用 `scroll` 事件判定跟随状态的原因。
   *
   * 实现上是**开一个短窗口 + 立刻判一次**：立刻那一判用的是输入到达时的读数（合成器可能
   * 还没把视口挪过去），窗口期内的读数变化会再判一次补上（见文件头 ①′）。
   */
  onUserIntent: (kind: StickIntentKind) => void
  /** DOM 增删 / 文本变更 / 尺寸变化 / 过渡结束的统一入口：合并到下一帧对齐一次 */
  onMutated: () => void
  /** 强制恢复跟随并滚到底（自己发消息 / 点「回到最新」） */
  stick: () => void
  /** 重读一次读数并按当前状态对齐（窗口从隐藏恢复可见、容器尺寸变化后调用） */
  refresh: () => void
}

/** 判定「在底部」的缺省阈值（px） */
const DEFAULT_THRESHOLD = 24

/**
 * 一帧里最多补几次对齐。
 *
 * 正常只要 1 次；给出余量是为了覆盖「写 `scrollTop` 的那一帧内容又长了一截」这类竞态。
 * 上限存在的意义是防死循环：真出现"每帧都在长高"的极端流式，下一帧的 mutation 信号会重新排帧，
 * 不需要在这里一直转。
 */
const MAX_ALIGN_FRAMES = 3

/** 缺省的跟随循环存活上限（ms）：上一轮 mutation 之后最多再跟这么久 */
const DEFAULT_MAX_SETTLE_MS = 1500

/** 判定「高度没变」的容差（px）：亚像素误差不该让我们多排一帧 */
const HEIGHT_EPSILON = 0.5

/** 判定「已经真的在底部」的容差（px） */
const ALIGN_EPSILON = 1

/**
 * 「真实输入窗口」的缺省时长（ms）：真实输入之后这段时间内的读数变化，按**当前位置**重新
 * 判定跟随（理由见文件头 ①′）。
 *
 * 为什么是 250ms 而不是"一次读数"：真实滚动会派发**不止一次** `scroll`（浏览器自身一次、
 * 壳层的「贴底修正」一次），把窗口做成"消费一次就关"会正好被前一次抵消掉（那一次的位置仍是
 * 底部，判完窗口就没了，真正的滚动读数反而落回①的纯通知语义）。时长只需覆盖"输入 → 合成器
 * 把视口挪过去 → 派发 scroll"这一两个帧（16–32ms），250ms 留足余量又不至于把用户之后的
 * 程序滚动误算成意图。
 */
const DEFAULT_INTENT_WINDOW_MS = 250

/**
 * 「贴底补齐」（薄壳的 `snapIfNearBottom`）该不该在这一记真实输入之后执行。
 *
 * 补齐的语义是「用户这记输入之后视口应当精确落在底部」——只有**朝底部去**的输入才成立：
 * 滚条拖拽释放（`pointer-release`）与向下滚轮（`deltaY > 0`）。
 * **向上滚轮绝不补**：输入到达那一刻读数还是"贴底"（合成器还没挪视口，见文件头 ①′），
 * 此刻补齐等于把用户即将发生的上滚预先吞掉 —— 小步长滚轮（触控板 / 高分辨率滚轮）
 * 逐次被吸回，体感就是「滚不动」。按键与滚条按下同理不补；拿不到方向时保守不补
 * （宁可少吸一次，不可吞一次上滚）。2026-10-01 收窄，此前是无差别补齐。
 */
export function shouldSnapOnIntent(kind: StickIntentKind, wheelDeltaY?: number): boolean {
  if (kind === 'pointer-release') return true
  return kind === 'wheel' && wheelDeltaY !== undefined && wheelDeltaY > 0
}

export function createStickToBottomCore(options: StickToBottomCoreOptions): StickToBottomCore {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD
  const intentWindowMs = options.intentWindowMs ?? DEFAULT_INTENT_WINDOW_MS
  const now = options.events.now ?? (() => Date.now())
  const maxSettleMs = options.events.maxSettleMs ?? DEFAULT_MAX_SETTLE_MS

  let following = true
  let started = false
  let frame: number | null = null
  /** 本帧已经补过几次对齐（0 = 这一帧还没开始处理） */
  let alignAttempts = 0
  /** 上一次帧处理时的 `scrollHeight`（`-1` = 还没量过） */
  let lastHeight = -1
  /** 连续「什么也没做」的帧数：够两帧就判定稳定并停止排帧 */
  let idleFrames = 0
  /** 跟随循环的存活截止时刻（0 = 没有在途循环） */
  let settleDeadline = 0
  /** 「真实输入窗口」的截止时刻（0 = 没有输入在窗口期内，见文件头 ①′） */
  let intentDeadline = 0
  /** 已挂上的订阅的"摘除"函数（`cancel()` 统一调用） */
  let subscriptions: StickUnsubscribe[] = []

  function metrics(): StickMetrics {
    return options.getMetrics()
  }

  function distanceToBottom(value: StickMetrics = metrics()): number {
    return value.scrollHeight - value.scrollTop - value.clientHeight
  }

  /**
   * 跟随状态的**唯一写入口**：三处会改它（用户意图关闭 / 贴底意图恢复 /
   * 内容缩到不足一屏时恢复），全部走这里，保证 `onFollowingChange` 只被调用一次且状态一致。
   */
  function setFollowing(next: boolean): void {
    if (following === next) return
    following = next
    options.onFollowingChange?.(next)
  }

  /**
   * 排一帧（同一帧内多次请求合并成一次）。
   *
   * **不在这里重置 `settleDeadline`**：上限的语义是「本轮（一次 mutation 之后）最多再跟多久」，
   * 每帧都续期等于没有上限，会退化成常驻 rAF。续期只发生在 `onMutated()` / `stick()`。
   */
  function schedule(): void {
    if (!started) return
    if (frame !== null) return
    frame = options.requestFrame(runFrame)
  }

  function cancelFrame(): void {
    if (frame === null) return
    options.cancelFrame(frame)
    frame = null
  }

  /** 把视口对齐到底；返回是否还有残留偏差（需要补帧） */
  function alignOnce(): { changed: boolean; needMore: boolean } {
    const before = metrics()
    const target = Math.max(0, before.scrollHeight - before.clientHeight)
    if (Math.abs(before.scrollTop - target) > ALIGN_EPSILON) {
      options.scrollTo(target)
    }
    // 写完立刻重读：同一帧里内容可能又长了一截，旧读数上的"到底"现在并不是底
    const after = metrics()
    const residual = distanceToBottom(after)
    return {
      changed: Math.abs(after.scrollHeight - before.scrollHeight) > HEIGHT_EPSILON,
      needMore: residual > ALIGN_EPSILON,
    }
  }

  function runFrame(): void {
    frame = null
    if (!started) return
    // 每帧重新给一份补帧额度：额度是「一帧内补几次」的防死循环，不是跨帧预算
    if (following) alignAttempts = 0

    // ①″（见文件头）：真实输入窗口期内绝不对齐 —— 输入读数是旧的，浏览器马上要挪视口，
    // 此刻一帧对齐就是与用户抢视口。窗口的收口（重判 / 过期）在 onScroll 与时钟里。
    const inIntentWindow = now() < intentDeadline

    let changed = false
    let needMore = false

    if (following && !inIntentWindow) {
      while (alignAttempts < MAX_ALIGN_FRAMES) {
        alignAttempts += 1
        const result = alignOnce()
        if (result.changed) changed = true
        needMore = result.needMore
        if (!needMore) break
      }
    } else {
      // 用户接管期间 / 意图窗口期内**只**观察高度变化，绝不改 `scrollTop`、
      // 也绝不因"位置靠底"自行恢复跟随。
      // 这里刻意不做"距底小于阈值就恢复"的位置判定：内容变高会把 `scrollTop` 留在原处，
      // 读数的「距底」随即变大 —— 拿位置当"用户回到底部"的判据会让跟随被悄悄续上，
      // 于是用户上翻读历史时被新一轮输出拽走。恢复跟随只有两条路：真实输入把滚动
      // 拖回底部（`onUserIntent`），或调用方 `stick()`。
      const value = metrics()
      changed = Math.abs(value.scrollHeight - lastHeight) > HEIGHT_EPSILON
      // 唯一的位置例外：内容缩到**不足一屏**（切会话 / 收起折叠体 / 清空）时没有可滚动距离，
      // 「暂停跟随」不再有意义，恢复跟随，免得「回到最新」胶囊永久挂在那里。
      if (value.scrollHeight <= value.clientHeight) setFollowing(true)
    }

    const value = metrics()
    const heightStable = Math.abs(value.scrollHeight - lastHeight) <= HEIGHT_EPSILON
    lastHeight = value.scrollHeight

    // 这一帧什么也没做且高度没变 → 计数；够两帧即判定稳定。
    // 注意判据是**这一帧的动作与高度**，不是"连续两帧高度相等"：内容持续增长时
    // 旧实现会在第 2 帧就收工，那正是「跟到一半就停」的第二个来源。
    idleFrames = !changed && !needMore && heightStable ? idleFrames + 1 : 0

    const expired = settleDeadline !== 0 && now() >= settleDeadline
    if (expired) {
      settleDeadline = 0
      idleFrames = 0
      lastHeight = -1
      alignAttempts = 0
      return
    }
    // 还在长高、或还没对齐到底 → 必须续帧（哪怕这一帧没有"做什么"）。
    // 旧实现的「连续两帧 scrollHeight 不变就停」恰好在这里收工，是「跟到一半就停」的第二个来源。
    if (needMore || changed) {
      idleFrames = 0
      schedule()
      return
    }
    if (idleFrames >= 2) {
      settleDeadline = 0
      idleFrames = 0
      lastHeight = -1
      alignAttempts = 0
      return
    }
    schedule()
  }

  /**
   * 真实用户输入（wheel / 滚条拖拽 / 翻页键）到达时的重新判定。
   *
   * **只有真实输入能走到这里** —— 程序滚动不会产生这些事件，这正是与旧实现的根本区别。
   * 判定是"当前位置"而不是"上滚还是下滚"（事件本身不带方向语义，读数才是事实）：
   * - 离底超过阈值 → 用户在翻历史，暂停跟随；
   * - 已经贴底（含"一直在底部继续滚滚轮"）→ 保持 / 恢复跟随。
   *
   * 中间那段"没到底但离底不远"落在 `following === false` 时**不恢复**：那多半是用户
   * 正在读最后一段，这时把跟随接回来会让下一条输出又一次把他拽走。
   */
  function onUserIntent(_kind: StickIntentKind): void {
    // 开窗（见文件头 ①′）：这一判用的是"输入到达那一刻"的读数，而合成器可能还没把视口挪过去；
    // 紧随其后的那几次读数变化才是事实，要靠窗口期内的重判补上。
    intentDeadline = now() + intentWindowMs
    setFollowing(distanceToBottom() <= threshold)
  }

  function stick(): void {
    setFollowing(true)
    // 程序化的「恢复跟随」压过在途的真实输入窗口：否则窗口期内下一次读数（对齐自己滚出来的
    // scroll）会拿旧位置把刚恢复的跟随又翻掉 —— `stick()` 的语义是"这一次必须跟"。
    intentDeadline = 0
    alignAttempts = 0
    idleFrames = 0
    lastHeight = -1
    // 强制贴底也是一次"新的内容到达"：续一轮跟随额度，直到真的稳定
    settleDeadline = now() + maxSettleMs
    const value = metrics()
    options.scrollTo(Math.max(0, value.scrollHeight - value.clientHeight))
    schedule()
  }

  function refresh(): void {
    // 从隐藏恢复可见 / 容器尺寸变化：读数可能整体失效（`scrollTop` 被夹、clientHeight 变了），
    // 处于跟随时直接再对齐一次；用户接管时不打扰。
    lastHeight = -1
    if (following) schedule()
  }

  function start(): void {
    if (started) return
    started = true
    /** 记下订阅的摘除函数；订阅方没返回摘除函数（例如本模块的测试夹具）时按"无需摘除"处理 */
    const keep = (dispose: StickUnsubscribe | void): void => {
      if (typeof dispose === 'function') subscriptions.push(dispose)
    }
    keep(
      options.events.onScroll(() => {
        // 窗口期内（刚刚发生过真实输入）：这次读数变化就是"人滚出来的位置" —— **先重判、再排帧**。
        // 顺序反了就会先排出一帧对齐、把用户刚滚出来的位置拽回底部，滚轮逐次被吞（见文件头 ①′）。
        if (now() < intentDeadline) setFollowing(distanceToBottom() <= threshold)
        // 窗口之外，scroll 事件**只**作为"读数变了"的通知：程序自己滚出来的事件也会走到这里，
        // 它绝不能改变跟随状态（这正是本轮修复的那条语义，见文件头 ①）。
        if (following) schedule()
      }),
    )
    keep(options.events.onUserScrollIntent(onUserIntent))
    keep(
      options.events.onTransitionEnd(() => {
        // 高度过渡在「DOM 变更那一帧」之后继续长高 / 缩短，前面几条信号都收不到
        onMutated()
      }),
    )
    keep(options.events.onResize(() => onMutated()))
    keep(options.events.onVisibility(() => refresh()))
    lastHeight = -1
    schedule()
  }

  function stop(): void {
    started = false
    cancelFrame()
    settleDeadline = 0
    intentDeadline = 0
    idleFrames = 0
    lastHeight = -1
    alignAttempts = 0
  }

  /**
   * 取消全部订阅并停掉循环（组件卸载用）。
   *
   * 与 `stop()` 的区别：`stop()` 只停循环、**保留订阅**（调用方会自行重挂，或本来就还活着）；
   * 卸载必须走这里，否则订阅还挂在 DOM 上，卸载后再来一次 scroll / resize 会对着
   * 已经取消的帧句柄排帧（轻则空转，重则报错）。
   */
  function cancel(): void {
    stop()
    subscriptions.forEach((dispose) => dispose())
    subscriptions = []
  }

  function onMutated(): void {
    // 新的内容到达 → 允许再补几次对齐（上一帧的补帧额度不能吃掉这一帧的），
    // 并续一轮跟随额度（上限服务的是"一次 mutation 之后最多再跟多久"）
    alignAttempts = 0
    idleFrames = 0
    settleDeadline = now() + maxSettleMs
    schedule()
  }

  return {
    isFollowing: () => following,
    start,
    stop,
    cancel,
    onUserIntent,
    onMutated,
    stick,
    refresh,
  }
}
