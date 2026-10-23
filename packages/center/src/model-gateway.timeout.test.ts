import { describe, expect, it } from 'vitest'
import { createUpstreamAbort } from './model-gateway.js'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('createUpstreamAbort', () => {
  it('收到数据后改为空闲计时，长回复不被总时长掐断', async () => {
    const abort = createUpstreamAbort(30, 200)
    try {
      await sleep(10)
      abort.touch()
      // 总时长已超过建连预算（30ms），但距上次数据只有 100ms
      await sleep(100)
      expect(abort.signal.aborted).toBe(false)
      await sleep(250)
      expect(abort.signal.aborted).toBe(true)
    } finally {
      abort.dispose()
    }
  })

  it('建连阶段按 header 预算超时', async () => {
    const abort = createUpstreamAbort(20, 1000)
    try {
      await sleep(100)
      expect(abort.signal.aborted).toBe(true)
    } finally {
      abort.dispose()
    }
  })

  it('dispose 后不再超时', async () => {
    const abort = createUpstreamAbort(20, 20)
    abort.dispose()
    await sleep(80)
    expect(abort.signal.aborted).toBe(false)
  })
})
