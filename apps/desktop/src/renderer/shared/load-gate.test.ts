/**
 * `createLoadGate` 的回归护栏（2026-10-10）。
 *
 * 钉住的是一条**真实故障过的竞态**：renderer 启动期"先 load 再 bind"会永久丢掉落在
 * 两者之间的 `mode:changed`；把顺序改成"先订阅、再加载"之后，**晚到的加载应答**
 * 又会盖掉早到的新广播。这里用可注入的 deferred promise 把两个方向都钉住 ——
 * 不需要 DOM、不需要 Electron。
 */
import { describe, expect, it } from 'vitest'
import { createLoadGate } from './load-gate.js'

/** 手动控制的 promise：测试自己决定"加载应答"什么时候到 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('createLoadGate', () => {
  it('首读期间没有推送 → 写入读到的值', () => {
    const gate = createLoadGate()
    const written: string[] = []
    const mark = gate.snapshot()
    expect(gate.write(mark, 'snapshot', (value) => written.push(value))).toBe(true)
    expect(written).toEqual(['snapshot'])
    expect(gate.pushes).toBe(0)
  })

  it('推送先到、应答后到 → 放弃这次读的写值（晚到的旧快照不许盖掉新广播）', async () => {
    const gate = createLoadGate()
    const written: string[] = []
    const pending = deferred<string>()

    // 先订阅（= bootstrapApp 的新顺序）：加载在途中推送到达
    const mark = gate.snapshot()
    const reading = pending.promise.then((value) =>
      gate.write(mark, value, (written_) => written.push(written_)),
    )
    gate.onPush()

    pending.resolve('stale-snapshot')
    const wrote = await reading

    expect(wrote).toBe(false)
    expect(written).toEqual([]) // 旧快照一次都没写进去
    expect(gate.pushes).toBe(1)
  })

  it('应答先到、推送后到 → 首读写值；随后的推送照常覆盖（正常路径不受影响）', () => {
    const gate = createLoadGate()
    const written: string[] = []

    const mark = gate.snapshot()
    expect(gate.write(mark, 'snapshot', (value) => written.push(value))).toBe(true)
    gate.onPush()
    written.push('broadcast') // 订阅回调自己写值

    expect(written).toEqual(['snapshot', 'broadcast'])
  })

  it('两次首读、期间有推送 → 只有"没被推送打断"的那次写值', () => {
    const gate = createLoadGate()
    const written: string[] = []

    const firstMark = gate.snapshot()
    gate.onPush()
    expect(gate.write(firstMark, 'stale', (value) => written.push(value))).toBe(false)

    const secondMark = gate.snapshot()
    expect(gate.write(secondMark, 'fresh', (value) => written.push(value))).toBe(true)

    expect(written).toEqual(['fresh'])
  })
})
