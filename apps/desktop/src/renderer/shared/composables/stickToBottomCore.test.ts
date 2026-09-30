import { describe, expect, it } from 'vitest'
import {
  createStickToBottomCore,
  shouldSnapOnIntent,
  type StickIntentKind,
  type StickMetrics,
  type StickToBottomCore,
} from './stickToBottomCore.js'

/**
 * 跟随核心的测试夹具。
 *
 * 这里刻意**不碰 DOM**：`scrollTop` / `scrollHeight` / `clientHeight` 三个数字就足以表达
 * 本模块的全部语义（谁改了视口、谁被内容顶走了），而真实滚动条那套读数在 node 里既读不到、
 * 断言也容易被浏览器自身的夹取行为掩盖（把假 PASS 造出来的正是这种"看起来更真"的夹具）。
 *
 * `arrive` 就是浏览器的行为模型：改变 `scrollHeight`（内容长高）之后 `scrollTop` 保持不变，
 * 直到有人显式滚一下 —— 「跟丢」正是从这个差值里长出来的。
 */

const VIEWPORT = 600

interface Harness {
  core: StickToBottomCore
  /** 内容长高 / 变矮；`top` 给了就顺便把视口挪过去（模拟用户拖动滚动条） */
  arrive: (scrollHeight: number, top?: number) => void
  /** 真实用户输入（wheel / 滚条拖拽 / 翻页键）——程序滚动**不会**产生它 */
  intent: (kind?: StickIntentKind) => void
  /** 浏览器自己发出的 scroll 事件（程序滚动也会产生它） */
  browserScroll: () => void
  transitionEnd: () => void
  resize: () => void
  visibility: () => void
  /** 跑掉全部在途帧，返回本轮跑了多少帧 */
  runFrames: (limit?: number) => number
  /** 推进注入的单调时钟（只影响「真实输入窗口」与 `maxSettleMs` 兜底） */
  advance: (ms: number) => void
  maxScroll: () => number
  distance: () => number
  scrollTop: () => number
  scrollCalls: () => number
}

function createHarness(): Harness {
  let scrollHeight = 2000
  const clientHeight = VIEWPORT
  let scrollTop = 0

  let scrollCallback: (() => void) | null = null
  let intentCallback: ((kind: StickIntentKind) => void) | null = null
  let transitionCallback: (() => void) | null = null
  let resizeCallback: (() => void) | null = null
  let visibilityCallback: (() => void) | null = null

  const frames = new Map<number, () => void>()
  let nextHandle = 0
  let scrollCalls = 0
  /**
   * 注入的单调时钟。
   *
   * 默认**不自己走**（`advance` 才动）：帧循环里的 `maxSettleMs` 兜底若按真实时间流逝，
   * 测试就会变成一个"跑到超时就换个结果"的东西 —— 现有那批断言都建立在"时钟不动"上。
   */
  let clock = 0

  function clamp(top: number): number {
    const max = Math.max(0, scrollHeight - clientHeight)
    return Math.min(Math.max(0, top), max)
  }

  const metrics = (): StickMetrics => ({ scrollHeight, scrollTop, clientHeight })

  const core = createStickToBottomCore({
    getMetrics: metrics,
    scrollTo: (top) => {
      scrollCalls += 1
      scrollTop = clamp(top)
      // 浏览器在真实滚动后会派发 scroll 事件 —— 夹具如实模拟它，
      // 「程序滚动不得改变跟随状态」这条语义只有在这一步之后才真正被验证。
      scrollCallback?.()
    },
    requestFrame: (callback) => {
      nextHandle += 1
      frames.set(nextHandle, callback)
      return nextHandle
    },
    cancelFrame: (handle) => {
      frames.delete(handle)
    },
    events: {
      onScroll: (callback) => {
        scrollCallback = callback
      },
      onUserScrollIntent: (callback) => {
        intentCallback = callback
      },
      onTransitionEnd: (callback) => {
        transitionCallback = callback
      },
      onResize: (callback) => {
        resizeCallback = callback
      },
      onVisibility: (callback) => {
        visibilityCallback = callback
      },
      // 固定时钟：`maxSettleMs` 的兜底不该由真实时间决定，测试需要可控
      now: () => clock,
    },
  })

  core.start()
  return {
    core,
    arrive: (nextHeight, top) => {
      scrollHeight = nextHeight
      scrollTop = clamp(top === undefined ? scrollTop : top)
    },
    intent: (kind = 'wheel') => intentCallback?.(kind),
    browserScroll: () => scrollCallback?.(),
    transitionEnd: () => transitionCallback?.(),
    resize: () => resizeCallback?.(),
    visibility: () => visibilityCallback?.(),
    runFrames: (limit = 12) => {
      let ran = 0
      while (frames.size > 0 && ran < limit) {
        const callbacks = [...frames.values()]
        frames.clear()
        for (const callback of callbacks) callback()
        ran += 1
      }
      return ran
    },
    maxScroll: () => Math.max(0, scrollHeight - clientHeight),
    distance: () => scrollHeight - scrollTop - clientHeight,
    scrollTop: () => scrollTop,
    scrollCalls: () => scrollCalls,
    advance: (ms) => {
      clock += ms
    },
  }
}

describe('stickToBottomCore', () => {
  it('程序滚动触发的 scroll 事件不得改变跟随状态（「跟丢」的根因）', () => {
    const h = createHarness()
    h.arrive(3000)
    h.browserScroll()
    expect(h.core.isFollowing()).toBe(true)

    h.runFrames()
    // 视口在底部，程序滚动此刻又派发了一次 scroll —— 依旧不许把跟随关掉
    expect(h.core.isFollowing()).toBe(true)
    expect(h.distance()).toBe(0)
  })

  it('同一帧里内容又长高时，帧末读数已经真的到底（不留残差）', () => {
    const h = createHarness()
    h.arrive(3000)
    h.runFrames()
    expect(h.distance()).toBe(0)

    // 帧 A：对齐到当时的高度的**同一帧**里内容又长高 400px（tool 卡插入 / markdown 块）
    h.arrive(3400)
    h.core.onMutated()
    h.runFrames(1)
    expect(h.distance()).toBeLessThanOrEqual(1)
  })

  it('同一帧内多次 onMutated 只排一帧', () => {
    const h = createHarness()
    h.arrive(2600)
    const before = h.scrollCalls()
    h.core.onMutated()
    h.core.onMutated()
    h.core.onMutated()
    // 稳定需要「对齐帧 + 确认帧」两帧（自终止有一帧的确认余量），因此这里量的是
    // 「到稳定为止总共排了几帧」而不是「每次 onMutated 排了几帧」—— 后者由下面
    // 那条「同帧滚动次数」断言负责（三次 onMutated 不该产生三次对齐写入）。
    const ran = h.runFrames()
    expect(ran).toBeLessThanOrEqual(3)
    expect(h.distance()).toBe(0)
    expect(h.scrollCalls() - before).toBeLessThanOrEqual(3)
  })

  it('高度稳定后停止排帧（自终止），不留常驻 rAF', () => {
    const h = createHarness()
    h.arrive(2600)
    h.core.onMutated()
    const ran = h.runFrames(30)
    expect(ran).toBeLessThanOrEqual(4)
    expect(h.runFrames(30)).toBe(0)
  })

  it('真实用户输入 + 离底超过阈值 → 暂停跟随；程序滚动不得把它恢复', () => {
    const h = createHarness()
    h.arrive(3000)
    h.runFrames()
    expect(h.core.isFollowing()).toBe(true)

    // 用户上翻
    h.arrive(3000, 200)
    h.intent('wheel')
    expect(h.core.isFollowing()).toBe(false)

    // 后续的程序滚动 / scroll 事件一律不许恢复
    h.browserScroll()
    h.arrive(3400)
    h.core.onMutated()
    h.runFrames()
    expect(h.core.isFollowing()).toBe(false)
  })

  it('用户已经贴在底部继续滚滚轮时，跟随不被关掉', () => {
    const h = createHarness()
    h.arrive(3000)
    h.runFrames()
    h.intent('wheel')
    h.intent('key')
    expect(h.core.isFollowing()).toBe(true)
  })

  /**
   * 「滚不动」的回归防线（用户实测：模型答完后既翻不动历史、轨迹又没收起来）。
   *
   * 现场是**两次读数**：真实滚轮先到主线程，此刻浏览器（合成器线程先滚）还没把视口挪上去，
   * 读数是"仍在底部"；下一次读数（浏览器派发的 `scroll`）才带着"已经离底 240px"的事实。
   * 只看第一次 = 把"用户上滚"判成"用户还在底部继续滚"，随后那一轮对齐帧会把这次滚动
   * **原样抹掉** —— 于是每一次滚轮都被吞，界面永远钉在底部。
   */
  it('视口在底部时上滚：输入到达时读数还没挪，浏览器随后挪动 → 暂停跟随且不被拽回', () => {
    const h = createHarness()
    h.arrive(3000)
    h.runFrames()
    expect(h.core.isFollowing()).toBe(true)

    // ① 输入到达：读数还在底部，这一刻判不出"在翻历史"是正常的
    h.intent('wheel')
    expect(h.core.isFollowing()).toBe(true)
    const max = h.maxScroll()

    // ② 浏览器把视口挪上去并派发 scroll —— 这才是"人真的翻上去了"的事实
    h.arrive(3000, max - 240)
    h.browserScroll()
    expect(h.core.isFollowing()).toBe(false)

    // ③ 跟随既已暂停，就不许再有对齐帧把用户拽回底部
    h.runFrames()
    expect(h.scrollTop()).toBe(max - 240)
  })

  it('真实输入窗口之外，读数变化只当作「内容可能变了」（程序滚动仍不得改跟随）', () => {
    const h = createHarness()
    h.arrive(3000)
    h.runFrames()
    h.intent('wheel')
    h.advance(1000)
    h.arrive(3000, 100)
    h.browserScroll()
    expect(h.core.isFollowing()).toBe(true)
  })

  it('用户从历史滚回底部 → 恢复跟随（滞回），并滚到底', () => {
    const h = createHarness()
    h.arrive(3000)
    h.runFrames()
    h.arrive(3000, 100)
    h.intent('wheel')
    expect(h.core.isFollowing()).toBe(false)

    h.arrive(3000, h.maxScroll())
    h.intent('wheel')
    expect(h.core.isFollowing()).toBe(true)
    h.runFrames()
    expect(h.distance()).toBe(0)
  })

  it('接管后停在「没到底但离底不远」处不恢复跟随（不然会被下一条输出拽走）', () => {
    const h = createHarness()
    h.arrive(3000)
    h.runFrames()
    h.arrive(3000, 100)
    h.intent('wheel')
    expect(h.core.isFollowing()).toBe(false)

    // 用户下滚了一点点：仍在阈值之外（距底 80px > 24px）
    h.arrive(3000, h.maxScroll() - 80)
    h.intent('wheel')
    expect(h.core.isFollowing()).toBe(false)
  })

  it('接管期间内容增长不得改动 scrollTop（不许把用户拽走）', () => {
    const h = createHarness()
    h.arrive(3000)
    h.runFrames()
    h.arrive(3000, 400)
    h.intent('wheel')
    expect(h.core.isFollowing()).toBe(false)

    // 内容变高：scrollTop 留在原处（浏览器行为），引擎不得去动它
    h.arrive(5000)
    h.core.onMutated()
    h.runFrames()
    expect(h.scrollTop()).toBe(400)
    expect(h.core.isFollowing()).toBe(false)
  })

  it('内容缩到不足一屏时自动恢复跟随（「回到最新」不会永久挂着）', () => {
    const h = createHarness()
    h.arrive(3000)
    h.runFrames()
    h.arrive(3000, 800)
    h.intent('wheel')
    expect(h.core.isFollowing()).toBe(false)

    h.arrive(300)
    h.core.onMutated()
    h.runFrames()
    expect(h.core.isFollowing()).toBe(true)
  })

  it('stick() 之后即使内容持续增长也保持跟随', () => {
    const h = createHarness()
    h.arrive(3000)
    h.runFrames()
    h.arrive(3000, 50)
    h.intent('wheel')
    expect(h.core.isFollowing()).toBe(false)

    h.core.stick()
    expect(h.core.isFollowing()).toBe(true)
    for (let step = 1; step <= 20; step += 1) {
      h.arrive(3000 + step * 120)
      h.core.onMutated()
      h.runFrames()
    }
    expect(h.core.isFollowing()).toBe(true)
    expect(h.distance()).toBe(0)
  })

  it('窗口从隐藏恢复可见（visibility）时对齐到底', () => {
    const h = createHarness()
    h.arrive(4000)
    h.runFrames()
    // 窗口隐藏期间读数整体失效：视口被浏览器夹回顶部
    h.arrive(4000, 0)
    h.visibility()
    h.runFrames()
    expect(h.distance()).toBe(0)
  })

  // ────────── 真实输入窗口内的对齐静默（2026-10-01「滚轮滚不动」第二层根因） ──────────
  //
  // 上一条「两次读数」用例里，对齐帧排在 scroll **之后**才跑，抹不掉什么。真实浏览器里
  // 还有第二种时序：`stick()`（展开折叠体触发 restick）留下的结算帧与用户的滚轮**竞速** ——
  // 帧在意图与 scroll 之间插入执行，此刻 `following` 还没被窗口重判翻掉，对齐一次就把
  // 用户刚滚出去的视口按回底部，随后到来的 scroll 读到的又是"贴底"。小步长滚动
  // （触控板 / 高分辨率滚轮，单步 < 24px 阈值）连窗口重判都翻不了案 —— 逐次被吞。

  it('结算帧与上滚竞速：帧插在意图与 scroll 之间也不许抹掉滚动', () => {
    const h = createHarness()
    h.arrive(3000)
    h.runFrames()
    h.core.stick() // 模拟 restick()：展开轨迹后结算帧在途
    const max = h.maxScroll()

    // ① 真实输入先到，读数还在底部 → 判成「还在跟随」（这一刻判不出是正常的）
    h.intent('wheel')
    expect(h.core.isFollowing()).toBe(true)

    // ② 浏览器已把视口挪上去，scroll 事件还没派发 —— 在途结算帧此刻插进来跑
    h.arrive(3000, max - 240)
    h.runFrames(1)

    // ③ scroll 到达，窗口重判
    h.browserScroll()
    expect(h.core.isFollowing()).toBe(false)
    expect(h.scrollTop()).toBe(max - 240)
  })

  it('意图窗口期内排出的对齐帧不写 scrollTop（小步长上滚逐次被吞的根因）', () => {
    const h = createHarness()
    h.arrive(3000)
    h.runFrames()
    expect(h.distance()).toBe(0)

    // 贴底上滚 16px（< 24px 阈值）：窗口重判仍是「跟随」，但位移必须站着
    h.intent('wheel')
    const max = h.maxScroll()
    h.arrive(3000, max - 16)
    h.browserScroll()
    expect(h.core.isFollowing()).toBe(true)

    // 窗口期内（时钟未推进）排出的帧：不许把用户这 16px 抹回底部
    h.runFrames()
    expect(h.scrollTop()).toBe(max - 16)

    // 窗口过期后恢复常规语义：跟随态下内容变更照常对齐（此处距底仅 16px）
    h.advance(1000)
    h.core.onMutated()
    h.runFrames()
    expect(h.distance()).toBe(0)
  })
})

describe('shouldSnapOnIntent（吸底补齐的时机口径，2026-10-01 收窄）', () => {
  it('只在滚条释放与向下滚轮时补齐；上滚滚轮 / 按键 / 滚条按下不得补', () => {
    expect(shouldSnapOnIntent('pointer-release')).toBe(true)
    expect(shouldSnapOnIntent('wheel', 120)).toBe(true)
    expect(shouldSnapOnIntent('wheel', -120)).toBe(false)
    // 拿不到方向时保守不补：宁可少吸一次，不可吞一次上滚
    expect(shouldSnapOnIntent('wheel')).toBe(false)
    expect(shouldSnapOnIntent('key')).toBe(false)
    expect(shouldSnapOnIntent('pointer')).toBe(false)
  })
})
