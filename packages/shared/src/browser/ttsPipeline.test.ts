import { describe, expect, it } from 'vitest'
import { runTtsPipeline, type TtsPipelineAudio, type TtsPipelineBackend } from './ttsPipeline.js'

const AUDIO: TtsPipelineAudio = { audioBase64: 'QQ==', mimeType: 'audio/mpeg' }

/** 手动控制的 Promise：resolve / reject 由用例决定时机。 */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (e: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface Harness {
  backend: TtsPipelineBackend
  synthesizeCalls: string[]
  playCalls: TtsPipelineAudio[]
  startedCalls: number
  stopCalls: number
  /** 每次 synthesize 的控制柄（按调用顺序） */
  synDefs: Array<ReturnType<typeof deferred<TtsPipelineAudio>>>
  /** 每次 play 的控制柄 */
  playDefs: Array<ReturnType<typeof deferred<void>>>
  /** 在途合成数（断言「最多 1 个」用） */
  inFlight: () => number
}

function harness(): Harness {
  const synthesizeCalls: string[] = []
  const playCalls: TtsPipelineAudio[] = []
  const synDefs: Array<ReturnType<typeof deferred<TtsPipelineAudio>>> = []
  const playDefs: Array<ReturnType<typeof deferred<void>>> = []
  let startedCalls = 0
  let stopCalls = 0
  let active = 0
  let maxActive = 0
  const backend: TtsPipelineBackend = {
    synthesize: (text) => {
      synthesizeCalls.push(text)
      active += 1
      maxActive = Math.max(maxActive, active)
      const def = deferred<TtsPipelineAudio>()
      synDefs.push(def)
      // 用双回调 then 计数（finally 会派生一个无人接的拒绝 Promise → unhandled rejection）
      void def.promise.then(
        () => {
          active -= 1
        },
        () => {
          active -= 1
        },
      )
      return def.promise
    },
    play: (audio, onStarted) => {
      playCalls.push(audio)
      const def = deferred<void>()
      playDefs.push(def)
      // 真正开始播放：微任务里回调 onStarted（模拟 element.play() 的异步）
      queueMicrotask(() => {
        startedCalls += 1
        onStarted?.()
      })
      return def.promise
    },
    stop: () => {
      stopCalls += 1
      // stop 让在途播放尽快 resolve（与真实后端一致）
      const last = playDefs[playDefs.length - 1]
      last?.resolve()
    },
  }
  return {
    backend,
    synthesizeCalls,
    playCalls,
    get startedCalls() {
      return startedCalls
    },
    get stopCalls() {
      return stopCalls
    },
    synDefs,
    playDefs,
    inFlight: () => maxActive,
  }
}

/** 让出事件循环，把已 resolve 的微任务链跑完。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

describe('runTtsPipeline（分块边播边取，docs/06 §13.8）', () => {
  it('空块数组直接 resolve，不调合成', async () => {
    const h = harness()
    await runTtsPipeline([], h.backend, () => false)
    expect(h.synthesizeCalls).toEqual([])
  })

  it('顺序播放 + 播放期间预取下一块（合成与播放重叠）', async () => {
    const h = harness()
    const done = runTtsPipeline(['一', '二', '三'], h.backend, () => false)
    await flush()
    // 块 0 合成中
    expect(h.synthesizeCalls).toEqual(['一'])
    h.synDefs[0]!.resolve(AUDIO)
    await flush()
    // 块 0 开播的同时块 1 已在合成（预取重叠）
    expect(h.playCalls).toHaveLength(1)
    expect(h.synthesizeCalls).toEqual(['一', '二'])
    h.synDefs[1]!.resolve(AUDIO)
    h.playDefs[0]!.resolve()
    await flush()
    expect(h.playCalls).toHaveLength(2)
    expect(h.synthesizeCalls).toEqual(['一', '二', '三'])
    h.synDefs[2]!.resolve(AUDIO)
    h.playDefs[1]!.resolve()
    await flush()
    expect(h.playCalls).toHaveLength(3)
    h.playDefs[2]!.resolve()
    await done
    // 同一时刻最多 1 个在途合成
    expect(h.inFlight()).toBe(1)
  })

  it('onFirstPlay 只在首块开播时回调一次', async () => {
    const h = harness()
    let firstPlay = 0
    const done = runTtsPipeline(['一', '二'], h.backend, () => false, {
      onFirstPlay: () => {
        firstPlay += 1
      },
    })
    await flush()
    expect(firstPlay).toBe(0) // 还在合成
    h.synDefs[0]!.resolve(AUDIO)
    await flush()
    expect(firstPlay).toBe(1)
    h.synDefs[1]!.resolve(AUDIO)
    h.playDefs[0]!.resolve()
    await flush()
    expect(firstPlay).toBe(1) // 第二块不回调
    h.playDefs[1]!.resolve()
    await done
  })

  it('首块合成失败：立即抛错，不播放', async () => {
    const h = harness()
    const done = runTtsPipeline(['一', '二'], h.backend, () => false)
    await flush()
    h.synDefs[0]!.reject(new Error('合成失败'))
    await expect(done).rejects.toThrow('合成失败')
    expect(h.playCalls).toHaveLength(0)
    // 失败后不再预取第二块
    expect(h.synthesizeCalls).toEqual(['一'])
  })

  it('后块合成失败：当前块播完才抛错（不打断正在播放的声音）', async () => {
    const h = harness()
    const done = runTtsPipeline(['一', '二', '三'], h.backend, () => false)
    await flush()
    h.synDefs[0]!.resolve(AUDIO)
    await flush()
    // 块 0 播放中，块 1 预取失败
    h.synDefs[1]!.reject(new Error('第二块失败'))
    await flush()
    // 块 0 仍在播放，错误尚未抛出
    expect(h.playCalls).toHaveLength(1)
    let settled = false
    void done.catch(() => {
      settled = true
    })
    await flush()
    expect(settled).toBe(false)
    // 块 0 播完 → 这时才抛错
    h.playDefs[0]!.resolve()
    await expect(done).rejects.toThrow('第二块失败')
    expect(h.playCalls).toHaveLength(1)
  })

  it('播放失败：抛错并调 stop', async () => {
    const h = harness()
    const done = runTtsPipeline(['一'], h.backend, () => false)
    await flush()
    h.synDefs[0]!.resolve(AUDIO)
    await flush()
    h.playDefs[0]!.reject(new Error('播放被阻止'))
    await expect(done).rejects.toThrow('播放被阻止')
    expect(h.stopCalls).toBe(1)
  })

  it('取消：在途播放停止后不再合成后续块', async () => {
    const h = harness()
    let cancelled = false
    const done = runTtsPipeline(['一', '二', '三'], h.backend, () => cancelled)
    await flush()
    h.synDefs[0]!.resolve(AUDIO)
    await flush()
    expect(h.synthesizeCalls).toEqual(['一', '二']) // 块 1 已预取
    cancelled = true
    h.backend.stop() // 结束在途播放
    await done // 正常 resolve，不抛错
    expect(h.playCalls).toHaveLength(1)
    // 块 1 的预取回包被丢弃，块 2 不再合成
    h.synDefs[1]!.resolve(AUDIO)
    await flush()
    expect(h.synthesizeCalls).toEqual(['一', '二'])
  })

  it('开始前已取消：不调合成', async () => {
    const h = harness()
    await runTtsPipeline(['一'], h.backend, () => true)
    expect(h.synthesizeCalls).toEqual([])
  })
})
