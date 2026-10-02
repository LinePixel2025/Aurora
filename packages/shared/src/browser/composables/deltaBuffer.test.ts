import { describe, expect, it } from 'vitest'
import { createDeltaBuffer, type DeltaBatch } from './deltaBuffer.js'

/**
 * 假帧调度器：不真跑 rAF，把回调收起来由测试手动驱动 —— 单测要验的正是
 * 「一帧内怎么合并」「flush 之后帧回调还有没有效」这类时序语义。
 */
function createFakeScheduler() {
  const frames = new Map<number, () => void>()
  /**
   * 句柄 → 回调的**永久**记录：`cancelFrame` 只从 `frames` 摘，不从这里删。
   * 专门用来验「flush 已取消在途帧之后，那个陈旧回调若被触发也不该二次 apply」——
   * 若只从 `frames` 取，取消后根本取不到回调，断言会恒真（这条用例曾经就是这样空转的）。
   */
  const issued = new Map<number, () => void>()
  let nextHandle = 0
  return {
    scheduler: {
      requestFrame: (callback: () => void): number => {
        nextHandle += 1
        frames.set(nextHandle, callback)
        issued.set(nextHandle, callback)
        return nextHandle
      },
      cancelFrame: (handle: number): void => {
        frames.delete(handle)
      },
    },
    /** 在途帧数（断言「只排一帧」用） */
    pendingCount: (): number => frames.size,
    /** 跑掉全部在途帧（正常一次 rAF 的等价物） */
    runFrames: (): void => {
      const callbacks = [...frames.values()]
      frames.clear()
      for (const callback of callbacks) callback()
    },
    /** 最近一次排出的句柄（上面那些用例要拿到「真正排出来的那个」而不是写死 1） */
    lastHandle: (): number => nextHandle,
    /**
     * 绕过「已取消」直接触发某个历史回调：`cancelFrame` 摘掉的是 `frames`，
     * 而 `issued` 留着 —— 这正是「陈旧帧回调晚到」这一场景的等价物。
     */
    runIssued: (handle: number): void => {
      const callback = issued.get(handle)
      if (callback !== undefined) callback()
    },
  }
}

describe('createDeltaBuffer', () => {
  it('同一帧内同 key 的多次入队合并为一次 apply', () => {
    const applied: DeltaBatch<string>[][] = []
    const fake = createFakeScheduler()
    const buffer = createDeltaBuffer<string>((batch) => applied.push(batch), fake.scheduler)

    buffer.push('a', '一')
    buffer.push('a', '二')
    buffer.push('a', '三')
    expect(applied).toHaveLength(0)

    fake.runFrames()
    expect(applied).toHaveLength(1)
    expect(applied[0]).toEqual([{ key: 'a', values: ['一', '二', '三'] }])
  })

  it('不同 key 同帧合并为一次 apply，且按首次出现顺序排列', () => {
    const applied: DeltaBatch<string>[][] = []
    const fake = createFakeScheduler()
    const buffer = createDeltaBuffer<string>((batch) => applied.push(batch), fake.scheduler)

    buffer.push('b', 'b1')
    buffer.push('a', 'a1')
    buffer.push('b', 'b2')
    fake.runFrames()

    expect(applied).toHaveLength(1)
    expect(applied[0]).toEqual([
      { key: 'b', values: ['b1', 'b2'] },
      { key: 'a', values: ['a1'] },
    ])
  })

  it('flush() 立即 apply 且不等帧', () => {
    const applied: DeltaBatch<number>[][] = []
    const fake = createFakeScheduler()
    const buffer = createDeltaBuffer<number>((batch) => applied.push(batch), fake.scheduler)

    buffer.push('x', 1)
    buffer.flush()

    expect(applied).toEqual([[{ key: 'x', values: [1] }]])
    // flush 已取消在途帧：再跑一次帧循环也不该重复 apply
    fake.runFrames()
    expect(applied).toHaveLength(1)
  })

  it('flush() 之后陈旧帧回调再被触发也不会重复 apply', () => {
    const applied: DeltaBatch<number>[][] = []
    const fake = createFakeScheduler()
    const buffer = createDeltaBuffer<number>((batch) => applied.push(batch), fake.scheduler)

    buffer.push('x', 1)
    const handle = fake.lastHandle()
    buffer.flush()
    expect(applied).toHaveLength(1)

    // 绕过「回调已被 cancelFrame 摘掉」直接触发它：真正兜住这条的是 apply 前的空缓冲判定，
    // 而不是「回调找不到了」。此前这里写的是 runHandle(写死的 1)，取消后取不到回调，
    // 断言恒真、什么都没验到（2026-09-26 复核指出）。
    fake.runIssued(handle)
    expect(applied).toHaveLength(1)
  })

  it('连续 push 只排一帧', () => {
    const fake = createFakeScheduler()
    const buffer = createDeltaBuffer<string>(() => undefined, fake.scheduler)

    buffer.push('a', '1')
    buffer.push('b', '2')
    buffer.push('a', '3')
    expect(fake.pendingCount()).toBe(1)
  })

  it('apply 过程中再次 push 能排下一帧（帧回调先清句柄）', () => {
    const applied: DeltaBatch<string>[][] = []
    const fake = createFakeScheduler()
    // apply 回调里回写 buffer 自身：回调要等帧跑起来才会执行，此时 const 已经初始化完成
    const buffer = createDeltaBuffer<string>((batch) => {
      applied.push(batch)
      // 典型场景：apply 里发现还要补一段（例如工具结果拼接）
      if (applied.length === 1) buffer.push('later', '下一帧见')
    }, fake.scheduler)

    buffer.push('a', '1')
    fake.runFrames()
    expect(applied).toHaveLength(1)
    // apply 里的 push 必须排上了新帧，且这时候还没被 apply
    expect(fake.pendingCount()).toBe(1)
    expect(applied).toHaveLength(1)

    fake.runFrames()
    expect(applied).toHaveLength(2)
    expect(applied[1]).toEqual([{ key: 'later', values: ['下一帧见'] }])
  })

  it('句柄 0 也是合法句柄（不能用 0 表示「没有帧」）', () => {
    const applied: DeltaBatch<string>[][] = []
    const fake = createFakeScheduler()
    const buffer = createDeltaBuffer<string>((batch) => applied.push(batch), {
      requestFrame: () => 0,
      cancelFrame: (handle) => fake.scheduler.cancelFrame(handle),
    })

    buffer.push('a', '1')
    buffer.flush()
    expect(applied).toHaveLength(1)
  })

  it('dispose() 取消在途帧且不再 apply', () => {
    const applied: DeltaBatch<string>[][] = []
    const fake = createFakeScheduler()
    const buffer = createDeltaBuffer<string>((batch) => applied.push(batch), fake.scheduler)

    buffer.push('a', '1')
    expect(fake.pendingCount()).toBe(1)
    buffer.dispose()

    expect(fake.pendingCount()).toBe(0)
    fake.runFrames()
    expect(applied).toHaveLength(0)
    // dispose 之后即使再入队也不会被 apply 到旧组件上（帧仍会排出，但调用方已不再需要）
    buffer.flush()
    expect(applied).toHaveLength(0)
  })
})
