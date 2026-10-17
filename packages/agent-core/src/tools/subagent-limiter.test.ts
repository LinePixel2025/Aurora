/**
 * 子代理并发限流器的单测（docs/06 §19.5）。
 *
 * 断言只写**并发计数 / 排队与释放的先后**，不写“看起来快了一点”——后者会随机器负载抖，
 * 也证明不了限流真的生效。
 */
import { describe, expect, it } from 'vitest'
import { SUBAGENT_MAX_PARALLEL, createSubagentLimiter } from './subagent-limiter.js'

/** 用微任务观察“是否已发放”，避免依赖真实计时器 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('createSubagentLimiter', () => {
  it('默认上限是 3；同一会话第 4 个排队，释放一个后按 FIFO 补位', async () => {
    const limiter = createSubagentLimiter()
    expect(SUBAGENT_MAX_PARALLEL).toBe(3)

    const releases = [] as Array<() => void>
    for (let i = 0; i < SUBAGENT_MAX_PARALLEL; i += 1) {
      const release = await limiter.acquire('s', { write: false })
      expect(release).toBeTypeOf('function')
      releases.push(release as () => void)
    }
    expect(limiter.snapshot('s')).toEqual({
      active: SUBAGENT_MAX_PARALLEL,
      queued: 0,
      writeLocked: false,
    })

    let fourth: (() => void) | undefined
    const pending = limiter.acquire('s', { write: false }).then((release) => {
      fourth = release
      return release
    })
    await tick()
    expect(fourth).toBeUndefined()
    expect(limiter.snapshot('s').queued).toBe(1)

    releases[0]?.()
    await pending
    expect(fourth).toBeTypeOf('function')
    expect(limiter.snapshot('s')).toEqual({
      active: SUBAGENT_MAX_PARALLEL,
      queued: 0,
      writeLocked: false,
    })
    fourth?.()
    releases[1]?.()
    releases[2]?.()
    expect(limiter.snapshot('s')).toEqual({ active: 0, queued: 0, writeLocked: false })
  })

  it('写请求互斥：第二个写子代理排队；只读子代理可与写子代理并行', async () => {
    const limiter = createSubagentLimiter(3)

    const writer = await limiter.acquire('s', { write: true })
    expect(writer).toBeTypeOf('function')
    expect(limiter.snapshot('s').writeLocked).toBe(true)

    // 读请求排在写锁占着时也能拿槽位（active 1 < 3）
    const reader = await limiter.acquire('s', { write: false })
    expect(reader).toBeTypeOf('function')

    let secondWriter: (() => void) | undefined
    const pending = limiter.acquire('s', { write: true }).then((release) => {
      secondWriter = release
      return release
    })
    await tick()
    expect(secondWriter).toBeUndefined()
    expect(limiter.snapshot('s').queued).toBe(1)

    writer?.()
    await pending
    expect(secondWriter).toBeTypeOf('function')
    expect(limiter.snapshot('s').writeLocked).toBe(true)

    secondWriter?.()
    reader?.()
    expect(limiter.snapshot('s')).toEqual({ active: 0, queued: 0, writeLocked: false })
  })

  it('排队中被 abort：立刻返回 undefined、不留排队项，也不影响正在跑的槽位', async () => {
    const limiter = createSubagentLimiter(1)
    const holder = await limiter.acquire('s', { write: false })
    const controller = new AbortController()

    const pending = limiter.acquire('s', { write: false, signal: controller.signal })
    await tick()
    expect(limiter.snapshot('s')).toEqual({ active: 1, queued: 1, writeLocked: false })

    controller.abort()
    await expect(pending).resolves.toBeUndefined()
    expect(limiter.snapshot('s')).toEqual({ active: 1, queued: 0, writeLocked: false })

    holder?.()
    expect(limiter.snapshot('s')).toEqual({ active: 0, queued: 0, writeLocked: false })
  })

  it('已 abort 的信号：直接 undefined，不建状态', async () => {
    const limiter = createSubagentLimiter()
    const controller = new AbortController()
    controller.abort()
    await expect(
      limiter.acquire('s', { write: false, signal: controller.signal }),
    ).resolves.toBeUndefined()
    expect(limiter.snapshot('s')).toEqual({ active: 0, queued: 0, writeLocked: false })
  })

  it('会话隔离：一个会话占满不阻塞另一个会话', async () => {
    const limiter = createSubagentLimiter(1)
    const a = await limiter.acquire('a', { write: false })
    const b = await limiter.acquire('b', { write: false })
    expect(b).toBeTypeOf('function')
    a?.()
    b?.()
    expect(limiter.snapshot('a')).toEqual({ active: 0, queued: 0, writeLocked: false })
    expect(limiter.snapshot('b')).toEqual({ active: 0, queued: 0, writeLocked: false })
  })

  it('release 幂等：重复释放不会把 active 减成负数或重复放行', async () => {
    const limiter = createSubagentLimiter(1)
    const release = await limiter.acquire('s', { write: true })
    release?.()
    release?.()
    expect(limiter.snapshot('s')).toEqual({ active: 0, queued: 0, writeLocked: false })

    const again = await limiter.acquire('s', { write: true })
    expect(again).toBeTypeOf('function')
    again?.()
  })
})
