import { describe, expect, it } from 'vitest'
import type { ClassificationRecord } from '@aurora/shared'
import { ClassificationQueue, type QueueJob, type QueueProgress } from './queue.js'

function job(name: string): QueueJob {
  return { path: `D:\\感知\\${name}`, fileName: name, ext: 'pdf', sizeBytes: 1 }
}

function record(name: string): ClassificationRecord {
  return {
    id: name,
    occurredAt: new Date(0).toISOString(),
    path: `D:\\感知\\${name}`,
    fileName: name,
    ext: 'pdf',
    sizeBytes: 1,
    subject: '数学',
    confidence: 1,
    reason: 'ok',
    source: 'rule',
  }
}

/** 手动控制 resolve 时机的处理器，用于观察并发度 */
function controllable() {
  const started: string[] = []
  const releases = new Map<string, () => void>()
  const handler = async (
    input: QueueJob,
    report: (progress: QueueProgress) => void,
  ): Promise<QueueProgress> => {
    started.push(input.fileName)
    report({ record: record(input.fileName), state: 'extracting' })
    await new Promise<void>((resolve) => releases.set(input.fileName, resolve))
    return { record: record(input.fileName), state: 'done' }
  }
  return { started, releases, handler }
}

describe('ClassificationQueue', () => {
  it('并发上限为 2，其余排队', async () => {
    const control = controllable()
    const queue = new ClassificationQueue({ handler: control.handler, concurrency: 2 })
    queue.enqueue(job('a.pdf'))
    queue.enqueue(job('b.pdf'))
    queue.enqueue(job('c.pdf'))
    await tick()
    expect(control.started).toEqual(['a.pdf', 'b.pdf'])
    expect(queue.running).toBe(2)
    expect(queue.depth).toBe(1)

    control.releases.get('a.pdf')?.()
    await tick(3)
    expect(control.started).toEqual(['a.pdf', 'b.pdf', 'c.pdf'])

    control.releases.get('b.pdf')?.()
    control.releases.get('c.pdf')?.()
    await queue.drain()
    expect(queue.running).toBe(0)
    expect(queue.depth).toBe(0)
  })

  it('同一路径重复入队被去重', async () => {
    const control = controllable()
    const queue = new ClassificationQueue({ handler: control.handler, concurrency: 1 })
    expect(queue.enqueue(job('a.pdf'))).toBe(true)
    expect(queue.enqueue(job('a.pdf'))).toBe(false)
    await tick()
    expect(control.started).toEqual(['a.pdf'])
    control.releases.get('a.pdf')?.()
    await queue.drain()
    // 完成后再次入队应当允许（不是"永久去重"）
    expect(queue.enqueue(job('a.pdf'))).toBe(true)
    await tick()
    control.releases.get('a.pdf')?.()
    await queue.drain()
  })

  it('处理器抛错不影响其它任务继续', async () => {
    const done: string[] = []
    const queue = new ClassificationQueue({
      concurrency: 1,
      handler: async (input) => {
        if (input.fileName === 'bad.pdf') throw new Error('boom')
        done.push(input.fileName)
        return { record: record(input.fileName), state: 'done' }
      },
    })
    queue.enqueue(job('bad.pdf'))
    queue.enqueue(job('good.pdf'))
    await queue.drain()
    expect(done).toEqual(['good.pdf'])
  })

  it('进度上报会转成事件（含队列深度与在途数）', async () => {
    const control = controllable()
    const queue = new ClassificationQueue({ handler: control.handler, concurrency: 1 })
    const events: Array<{ state: string; queueDepth: number; running: number }> = []
    queue.onEvent((event) =>
      events.push({ state: event.state, queueDepth: event.queueDepth, running: event.running }),
    )
    queue.enqueue(job('a.pdf'))
    queue.enqueue(job('b.pdf'))
    await tick()
    control.releases.get('a.pdf')?.()
    await tick(3)
    control.releases.get('b.pdf')?.()
    await queue.drain()

    expect(events.some((event) => event.state === 'extracting')).toBe(true)
    expect(events.some((event) => event.state === 'done')).toBe(true)
    // 第二个任务入队时深度为 1
    expect(events.some((event) => event.queueDepth === 1)).toBe(true)
  })

  it('事件监听器抛错不影响队列', async () => {
    const control = controllable()
    const queue = new ClassificationQueue({ handler: control.handler, concurrency: 1 })
    queue.onEvent(() => {
      throw new Error('listener boom')
    })
    queue.enqueue(job('a.pdf'))
    await tick()
    control.releases.get('a.pdf')?.()
    await queue.drain()
    expect(queue.running).toBe(0)
  })

  it('dispose 后不再接受新任务', async () => {
    const control = controllable()
    const queue = new ClassificationQueue({ handler: control.handler, concurrency: 1 })
    queue.dispose()
    expect(queue.enqueue(job('a.pdf'))).toBe(false)
  })

  it('并发参数下限为 1（避免 0 导致永不执行）', async () => {
    const control = controllable()
    const queue = new ClassificationQueue({ handler: control.handler, concurrency: 0 })
    queue.enqueue(job('a.pdf'))
    await tick()
    expect(control.started).toEqual(['a.pdf'])
    control.releases.get('a.pdf')?.()
    await queue.drain()
  })
})

function tick(times = 1): Promise<void> {
  let promise = Promise.resolve()
  for (let i = 0; i < times; i += 1)
    promise = promise.then(() => new Promise((r) => setTimeout(r, 5)))
  return promise
}
